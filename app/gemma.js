// ============================================================================
// Gemma natural-language parsing client (README §3.6, Phase 3).
// Best-effort enrichment: the app stays fully usable with keyword parsing when
// the home machine (Ollama + Cloudflare Tunnel) is asleep or unreachable.
//
// Contract: we POST to an Ollama-compatible /api/generate endpoint with
// `format: "json"`, which returns { response: "<json string>" }. We also
// tolerate an endpoint that returns the parsed object directly.
// ============================================================================
import { CATEGORIES } from "./categorize.js";

const PAYMENTS = ["credit", "debit", "cash"];

/** Build the strict-JSON extraction prompt sent to Gemma. */
export function buildPrompt(text, today) {
  return [
    "You extract a single expense from casual text. Respond with ONLY a JSON object,",
    "no prose, no code fences. Use this exact shape:",
    '{ "amount": number, "merchant": string, "category": string,',
    '  "payment_type": "credit"|"debit"|"cash"|null, "occurred_at": "YYYY-MM-DD" }',
    `Choose category from: ${CATEGORIES.join(", ")}.`,
    `If a field is unknown use null (for occurred_at default to "${today}").`,
    `Today is ${today}.`,
    `Text: ${JSON.stringify(text)}`,
  ].join("\n");
}

/** Validate & coerce a raw parsed object into our normalized expense shape, or null. */
export function validateParsed(raw, today) {
  if (!raw || typeof raw !== "object") return null;

  const amount = Number(raw.amount);
  const out = {
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null,
    merchant: typeof raw.merchant === "string" && raw.merchant.trim() ? raw.merchant.trim() : null,
    category: null,
    payment_type: null,
    occurred_at: today,
  };

  if (typeof raw.category === "string") {
    // Case-insensitive match to a known category; otherwise keep the label as-is.
    const hit = CATEGORIES.find((c) => c.toLowerCase() === raw.category.toLowerCase());
    out.category = hit || raw.category.trim() || null;
  }
  if (typeof raw.payment_type === "string" && PAYMENTS.includes(raw.payment_type.toLowerCase())) {
    out.payment_type = raw.payment_type.toLowerCase();
  }
  if (typeof raw.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.occurred_at)) {
    out.occurred_at = raw.occurred_at;
  }

  // Must extract at least an amount to be useful.
  return out.amount !== null ? out : null;
}

/** Pull a JSON object out of an Ollama response (which nests it as a string). */
function extractPayload(data) {
  if (data && typeof data === "object" && "response" in data) {
    try { return JSON.parse(data.response); } catch { return null; }
  }
  return data; // endpoint returned the object directly
}

/**
 * Parse free text via Gemma. Resolves to a normalized expense object, or throws
 * (caller falls back to keyword parsing). Times out so it never blocks the UI.
 * @param {string} text
 * @param {{endpoint:string, model?:string, timeoutMs?:number, today?:string}} opts
 */
export async function parseWithGemma(text, opts = {}) {
  const { endpoint, model = "gemma", timeoutMs = 4000 } = opts;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  if (!endpoint) throw new Error("Gemma endpoint not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: buildPrompt(text, today), stream: false, format: "json" }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
    const payload = extractPayload(await res.json());
    const parsed = validateParsed(payload, today);
    if (!parsed) throw new Error("Gemma returned an unusable shape");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Interactive spending Q&A ----------------------------------------------
// Separate contract from parseWithGemma above: the answer is free text, not
// strict JSON, so no format:"json" here - Ollama returns { response: "..." }
// with a plain-text answer instead of a JSON string to parse.

/** Build the free-text Q&A prompt sent to Gemma. */
export function buildQaPrompt(question, context) {
  return [
    "You are a personal finance assistant. Answer the question using ONLY",
    "the JSON data below, which is the user's own spending data plus",
    "optional profile context (employment, housing, household size,",
    "dependents, financial goals) if they've filled it in. If the data",
    "doesn't contain enough to answer, say so plainly instead of guessing.",
    "Be concise - a few sentences or a short list. Use $ for dollar amounts.",
    "",
    `Data: ${JSON.stringify(context)}`,
    "",
    `Question: ${question}`,
  ].join("\n");
}

/**
 * Ask Gemma a free-text question about the given context. Resolves to the
 * plain-text answer, or throws (caller shows a friendly error).
 */
export async function askGemma(question, context, opts = {}) {
  const { endpoint, model = "gemma", timeoutMs = 20000 } = opts;
  if (!endpoint) throw new Error("Gemma endpoint not configured");
  if (!question || !question.trim()) throw new Error("Ask a question first");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: buildQaPrompt(question, context), stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
    const data = await res.json();
    const text = typeof data.response === "string" ? data.response.trim() : "";
    if (!text) throw new Error("Gemma returned an empty answer");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
