// ============================================================================
// Deterministic keyword categorization (README §3.5, layer 1).
// Always-on, free, offline-tolerant. Gemma enrichment (Phase 3) layers on top.
//
// Order: user-specific rules (from category_rules table) win over the built-in
// default map. The app passes userRules in; this module stays pure/testable.
// ============================================================================

const DEFAULT_RULES = {
  // Food
  chipotle: "Food", mcdonald: "Food", starbucks: "Food", coffee: "Food",
  lunch: "Food", dinner: "Food", breakfast: "Food", grubhub: "Food",
  doordash: "Food", ubereats: "Food", restaurant: "Food", groceries: "Food",
  grocery: "Food", wholefoods: "Food", trader: "Food", safeway: "Food",
  // Transport
  uber: "Transport", lyft: "Transport", gas: "Transport", shell: "Transport",
  chevron: "Transport", metro: "Transport", transit: "Transport",
  parking: "Transport", flight: "Transport", airline: "Transport",
  // Subscriptions
  netflix: "Subscriptions", spotify: "Subscriptions", youtube: "Subscriptions",
  hulu: "Subscriptions", disney: "Subscriptions", adobe: "Subscriptions",
  icloud: "Subscriptions", prime: "Subscriptions", "hbo": "Subscriptions",
  patreon: "Subscriptions", notion: "Subscriptions", gym: "Subscriptions",
  // Shopping
  amazon: "Shopping", target: "Shopping", walmart: "Shopping",
  costco: "Shopping", bestbuy: "Shopping",
  // Utilities / Bills
  electric: "Utilities", water: "Utilities", internet: "Utilities",
  comcast: "Utilities", verizon: "Utilities", att: "Utilities",
  rent: "Housing", mortgage: "Housing",
  // Health
  pharmacy: "Health", cvs: "Health", walgreens: "Health", doctor: "Health",
};

/**
 * @param {string} text  raw expense text (already includes merchant/desc)
 * @param {Object} [userRules]  map of keyword -> category from category_rules
 * @returns {string|null}  matched category, or null if nothing matched
 */
export function categorize(text, userRules = {}) {
  if (!text) return null;
  const t = text.toLowerCase();
  // User rules take precedence.
  for (const [kw, cat] of Object.entries(userRules)) {
    if (kw && t.includes(kw.toLowerCase())) return cat;
  }
  for (const [kw, cat] of Object.entries(DEFAULT_RULES)) {
    if (t.includes(kw)) return cat;
  }
  return null;
}

/**
 * Very small free-text pre-parser used before Gemma exists (README §3.6 fallback).
 * Extracts a leading/embedded dollar amount and a payment-type hint.
 * Everything unparsed stays in raw_input for the user to confirm.
 * e.g. "$14 lunch chipotle debit" -> {amount:14, payment_type:'debit', rest:'lunch chipotle'}
 */
export function quickParse(text) {
  const out = { amount: null, payment_type: null, rest: text || "" };
  if (!text) return out;
  const amtMatch = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (amtMatch) out.amount = parseFloat(amtMatch[1]);
  const lower = text.toLowerCase();
  if (/\bcredit\b/.test(lower)) out.payment_type = "credit";
  else if (/\bdebit\b/.test(lower)) out.payment_type = "debit";
  else if (/\bcash\b/.test(lower)) out.payment_type = "cash";
  out.rest = text
    .replace(/\$?\s*\d+(?:\.\d{1,2})?/, "")
    .replace(/\b(credit|debit|cash)\b/i, "")
    .trim();
  return out;
}

export const CATEGORIES = [
  "Food", "Transport", "Subscriptions", "Shopping",
  "Utilities", "Housing", "Health", "Entertainment", "Other",
];
