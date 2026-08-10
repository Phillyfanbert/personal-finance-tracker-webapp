#!/usr/bin/env node
// ============================================================================
// Mock Gemma endpoint - stands in for Ollama while the home machine isn't set
// up (README §3.6). Dependency-free. Mimics Ollama's /api/generate:
// accepts { model, prompt, format:"json" } and returns { response:"<json>" }.
//
// Run:   node tools/mock-gemma-server.js         (listens on :11434)
// Point config.js GEMMA_ENDPOINT at http://localhost:11434/api/generate
//
// It does a deterministic best-effort parse of the free text so you can
// exercise the full client → validate → confirm flow locally.
// ============================================================================
const http = require("http");

const PORT = process.env.PORT || 11434;

const KEYWORDS = {
  chipotle: "Food", lunch: "Food", dinner: "Food", coffee: "Food", starbucks: "Food",
  groceries: "Food", uber: "Transport", lyft: "Transport", gas: "Transport",
  netflix: "Subscriptions", spotify: "Subscriptions", gym: "Subscriptions",
  amazon: "Shopping", target: "Shopping", rent: "Housing", pharmacy: "Health",
};

// Pull the original text out of the prompt (client sends: Text: "<json-encoded>")
function textFromPrompt(prompt) {
  const m = /Text:\s*(.*)$/s.exec(prompt || "");
  if (!m) return prompt || "";
  try { return JSON.parse(m[1].trim()); } catch { return m[1].trim(); }
}

function fakeParse(text, today) {
  const lower = (text || "").toLowerCase();
  const amt = (text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/) || [])[1];
  let payment = null;
  if (/\bcredit\b/.test(lower)) payment = "credit";
  else if (/\bdebit\b/.test(lower)) payment = "debit";
  else if (/\bcash\b/.test(lower)) payment = "cash";
  let category = null, merchant = null;
  for (const [kw, cat] of Object.entries(KEYWORDS)) {
    if (lower.includes(kw)) { category = cat; merchant = kw[0].toUpperCase() + kw.slice(1); break; }
  }
  return {
    amount: amt ? parseFloat(amt) : null,
    merchant,
    category,
    payment_type: payment,
    occurred_at: today,
  };
}

const server = http.createServer((req, res) => {
  // CORS so a browser PWA can call it (real Ollama: set OLLAMA_ORIGINS).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let prompt = "";
    try { prompt = JSON.parse(body || "{}").prompt || ""; } catch {}
    // Honor the "Today is YYYY-MM-DD" instruction the client sends (a real model would).
    const todayInPrompt = (/Today is (\d{4}-\d{2}-\d{2})/.exec(prompt) || [])[1];
    const today = todayInPrompt || new Date().toISOString().slice(0, 10);
    const parsed = fakeParse(textFromPrompt(prompt), today);
    // Ollama nests the model output as a JSON *string* in `response`.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "gemma-mock", response: JSON.stringify(parsed), done: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Mock Gemma listening on http://localhost:${PORT}/api/generate`);
});
