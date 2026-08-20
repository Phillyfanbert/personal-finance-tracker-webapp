#!/usr/bin/env node
// ============================================================================
// Auth-gated reverse proxy in front of Ollama. Ollama has no built-in request
// auth, and the Cloudflare Tunnel exposing it is a "quick tunnel" (no owned
// domain, so no Cloudflare Access policy is possible either - see this repo's
// $0 constraint) - without this, anyone who finds the tunnel URL (it's baked
// into this app's own public app/config.js, or discoverable by scanning
// *.trycloudflare.com) could send arbitrary requests to the home GPU for free.
//
// Run on the SAME machine as Ollama, listening on GEMMA_PROXY_PORT (default
// 11435) and forwarding to OLLAMA_URL (default http://localhost:11434). Point
// the Cloudflare Tunnel at this port instead of Ollama's port directly.
//
// Requires header "X-Gemma-Key: <GEMMA_PROXY_SECRET>" on every request, else
// 401. app/gemma.js sends this from APP_CONFIG.GEMMA_AUTH_KEY - which means
// the key still ships inside this app's public client-side config.js, same as
// GEMMA_ENDPOINT itself (the browser calls Gemma directly, no server-side
// proxy of ours sits between it and here). This raises the bar from "anyone
// who finds the bare tunnel URL" (zero auth at all) to "anyone who reads this
// app's own public source" - it does not hide the key from someone who
// deliberately inspects the app's own code, the same "safe to expose, not a
// secret" honesty caveat this app already states for the Supabase anon key.
//
// Run:   GEMMA_PROXY_SECRET=<random> node tools/gemma-auth-proxy.js
// ============================================================================
const http = require("http");

const PORT = process.env.GEMMA_PROXY_PORT || 11435;
const OLLAMA_URL = new URL(process.env.OLLAMA_URL || "http://localhost:11434");
const SECRET = process.env.GEMMA_PROXY_SECRET;

if (!SECRET) {
  console.error("Missing GEMMA_PROXY_SECRET - refusing to start unauthenticated.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gemma-Key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.headers["x-gemma-key"] !== SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  const upstream = http.request(
    {
      hostname: OLLAMA_URL.hostname,
      port: OLLAMA_URL.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: OLLAMA_URL.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unreachable", detail: err.message }));
  });
  req.pipe(upstream);
});

server.listen(PORT, () => {
  console.log(`Gemma auth proxy listening on http://localhost:${PORT}, forwarding to ${OLLAMA_URL.origin}`);
});
