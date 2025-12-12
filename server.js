import express from "express";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 10000;

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

app.get("/", (req, res) => {
  res.json({ ok: true, service: "yahoo-finance-proxy" });
});

const quoteProxy = createProxyMiddleware({
  target: "https://query1.finance.yahoo.com",
  changeOrigin: true,
  pathRewrite: { "^/yahoo/quote": "/v7/finance/quote" },
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader("User-Agent", "Mozilla/5.0 (Render Yahoo Proxy)");
    proxyReq.setHeader("Accept", "application/json,text/plain,*/*");
  }
});

const optionsProxy = createProxyMiddleware({
  target: "https://query2.finance.yahoo.com",
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/yahoo\/options/, "/v7/finance/options"),
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader("User-Agent", "Mozilla/5.0 (Render Yahoo Proxy)");
    proxyReq.setHeader("Accept", "application/json,text/plain,*/*");
  }
});

app.use("/yahoo/quote", quoteProxy);
app.use("/yahoo/options", optionsProxy);

app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("Proxy error:", err);
  res.status(502).json({ error: "Bad gateway", detail: String(err?.message || err) });
});

app.listen(PORT, () => {
  console.log(`Yahoo proxy listening on ${PORT}`);
});
