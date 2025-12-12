import express from "express";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 10000;

/**
 * CORS:
 * - ALLOWED_ORIGINS="*" (default)
 * - or "https://your-static-site.onrender.com,https://yourdomain.com"
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 1 && allowed[0] === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

app.use(morgan("tiny"));
app.use(corsMiddleware);
app.disable("x-powered-by");

/**
 * Cache controls
 * CACHE_TTL_MS: fresh cache TTL
 * STALE_TTL_MS: how long we will serve stale cache on upstream errors (429/5xx)
 */
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000); // default 2 minutes
const STALE_TTL_MS = Number(process.env.STALE_TTL_MS || 900_000); // default 15 minutes

/**
 * Cache entry:
 * - expiresAt: fresh until this time
 * - staleUntil: can be served on errors until this time
 */
const cache = new Map(); // key -> { expiresAt, staleUntil, status, headers, bodyText, storedAt }
const inflight = new Map(); // key -> Promise (request coalescing)

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  return v;
}

function cacheSet(key, status, headersObj, bodyText) {
  const now = Date.now();
  cache.set(key, {
    storedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    staleUntil: now + STALE_TTL_MS,
    status,
    headers: headersObj,
    bodyText,
  });
}

function isFresh(entry) {
  return entry && Date.now() <= entry.expiresAt;
}

function isStaleOk(entry) {
  return entry && Date.now() <= entry.staleUntil;
}

/**
 * Fetch with limited retry/backoff for 429/5xx.
 * IMPORTANT: Keep retries low to avoid amplifying rate limits.
 */
async function fetchWithRetry(url, { tries = 2 } = {}) {
  let lastErr;

  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
        "Connection": "keep-alive",
      },
    });

    if (res.ok) return res;

    // Retry only on 429 or 5xx
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(10_000, Number(retryAfter) * 1000)
        : Math.min(10_000, 500 * Math.pow(2, i)); // 500ms, 1s...

      await new Promise((r) => setTimeout(r, waitMs));
      lastErr = new Error(`Upstream ${res.status} for ${url}`);
      lastErr.status = res.status;
      continue;
    }

    const text = await res.text().catch(() => "");
    const err = new Error(
      `Upstream error ${res.status} for ${url}: ${text.slice(0, 200)}`
    );
    err.status = res.status;
    throw err;
  }

  throw lastErr || new Error("Upstream fetch failed");
}

/**
 * Cached forward with:
 * - fresh cache return
 * - request coalescing
 * - stale-on-error (429/5xx): serve last cached response if available
 */
async function cachedForward(req, res, upstreamUrl) {
  const key = upstreamUrl;
  const entry = cacheGet(key);

  // 1) If fresh, serve immediately
  if (isFresh(entry)) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    res.setHeader("Content-Type", entry.headers["content-type"] || "application/json");
    return res.status(entry.status).send(entry.bodyText);
  }

  // 2) If someone else is already fetching this key, await it (coalescing)
  if (inflight.has(key)) {
    try {
      await inflight.get(key);
      const after = cacheGet(key);
      if (after) {
        res.setHeader("X-Cache", "HIT-AFTER-WAIT");
        res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
        res.setHeader("Content-Type", after.headers["content-type"] || "application/json");
        return res.status(after.status).send(after.bodyText);
      }
      // fallthrough if somehow cache not set
    } catch {
      // fallthrough to stale-on-error below
    }
  }

  // 3) Make upstream request (single flight per key)
  const p = (async () => {
    const upstreamRes = await fetchWithRetry(upstreamUrl, { tries: 2 });
    const bodyText = await upstreamRes.text();

    const headersObj = {
      "content-type": upstreamRes.headers.get("content-type") || "application/json",
    };

    cacheSet(key, upstreamRes.status, headersObj, bodyText);
  })();

  inflight.set(key, p);

  try {
    await p;
    const fresh = cacheGet(key);

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    res.setHeader("Content-Type", fresh?.headers["content-type"] || "application/json");
    return res.status(fresh?.status || 200).send(fresh?.bodyText || "{}");
  } catch (e) {
    // 4) Stale-on-error: If upstream failed (especially 429), serve stale cache if allowed
    const still = cacheGet(key);

    const upstreamStatus = e?.status;
    const isRateLimitOr5xx =
      upstreamStatus === 429 || (upstreamStatus >= 500 && upstreamStatus <= 599) || !upstreamStatus;

    if (isRateLimitOr5xx && isStaleOk(still)) {
      res.setHeader("X-Cache", "STALE");
      res.setHeader("X-Upstream-Error", String(upstreamStatus || "unknown"));
      res.setHeader("Cache-Control", `public, max-age=0, stale-while-revalidate=${Math.floor(STALE_TTL_MS / 1000)}`);
      res.setHeader("Content-Type", still.headers["content-type"] || "application/json");
      return res.status(still.status).send(still.bodyText);
    }

    console.error("Proxy error:", e);
    return res.status(502).json({
      error: "Bad gateway",
      detail: String(e?.message || e),
      upstreamStatus: upstreamStatus ?? null,
      hint: "Yahoo is rate-limiting this server. Increase CACHE_TTL_MS and reduce client request frequency.",
    });
  } finally {
    inflight.delete(key);
  }
}

/**
 * Routes
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "yahoo-finance-proxy",
    cache_ttl_ms: CACHE_TTL_MS,
    stale_ttl_ms: STALE_TTL_MS,
  });
});

// Quote: /yahoo/quote?symbols=AAPL,MSFT
app.get("/yahoo/quote", async (req, res) => {
  const qs = req.originalUrl.split("?")[1] || "";
  const upstream = `https://query2.finance.yahoo.com/v7/finance/quote?${qs}`;
  return cachedForward(req, res, upstream);
});

// Options: /yahoo/options/AAPL or /yahoo/options/AAPL?date=...
app.get("/yahoo/options/:symbol", async (req, res) => {
  const symbol = encodeURIComponent(req.params.symbol || "");
  const qs = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  const upstream = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}${qs}`;
  return cachedForward(req, res, upstream);
});

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Yahoo proxy listening on ${PORT}`);
});
