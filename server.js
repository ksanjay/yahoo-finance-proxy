import express from "express";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 10000;

// --- CORS (same behavior as before) ---
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
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

// --- Tiny in-memory cache (per Render instance) ---
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30_000); // 30s default
const cache = new Map(); // key -> { expiresAt, status, headers, bodyText }

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    cache.delete(key);
    return null;
  }
  return v;
}

function cacheSet(key, status, headersObj, bodyText) {
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    status,
    headers: headersObj,
    bodyText
  });
}

// --- fetch with backoff for 429/5xx ---
async function fetchWithRetry(url, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Render Yahoo Proxy; cached)",
        "Accept": "application/json,text/plain,*/*"
      }
    });

    // success
    if (res.ok) return res;

    // handle 429 / transient issues
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(10_000, Number(retryAfter) * 1000)
        : Math.min(10_000, 500 * Math.pow(2, i)); // 0.5s, 1s, 2s...

      await new Promise(r => setTimeout(r, waitMs));
      lastErr = new Error(`Upstream ${res.status} for ${url}`);
      continue;
    }

    // non-retryable
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream error ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  throw lastErr || new Error("Upstream fetch failed");
}

// helper: forward response but also cache
async function cachedForward(req, res, upstreamUrl) {
  const cacheKey = upstreamUrl; // include querystring
  const cached = cacheGet(cacheKey);

  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    res.status(cached.status);
    res.setHeader("Content-Type", cached.headers["content-type"] || "application/json");
    return res.send(cached.bodyText);
  }

  try {
    const upstreamRes = await fetchWithRetry(upstreamUrl, { tries: 3 });
    const bodyText = await upstreamRes.text();

    // Save minimal headers you care about
    const headersObj = {
      "content-type": upstreamRes.headers.get("content-type") || "application/json"
    };
    cacheSet(cacheKey, upstreamRes.status, headersObj, bodyText);

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    res.setHeader("Content-Type", headersObj["content-type"]);
    return res.status(upstreamRes.status).send(bodyText);
  } catch (e) {
    console.error("Proxy error:", e);
    return res.status(502).json({ error: "Bad gateway", detail: String(e.message || e) });
  }
}

// --- Routes ---
app.get("/", (req, res) => {
  res.json({ ok: true, service: "yahoo-finance-proxy", cache_ttl_ms: CACHE_TTL_MS });
});

// /yahoo/quote?symbols=AAPL,MSFT
app.get("/yahoo/quote", async (req, res) => {
  const qs = req.originalUrl.split("?")[1] || "";
  const upstream = `https://query1.finance.yahoo.com/v7/finance/quote?${qs}`;
  return cachedForward(req, res, upstream);
});

// /yahoo/options/AAPL?date=...
app.get("/yahoo/options/:symbol", async (req, res) => {
  const symbol = encodeURIComponent(req.params.symbol || "");
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}${qs}`;
  return cachedForward(req, res, upstream);
});

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));

app.listen(PORT, () => {
  console.log(`Yahoo proxy listening on ${PORT}`);
});
