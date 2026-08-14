// ============================================================================
// Deterministic keyword categorization (README §3.5, layer 1).
// Always-on, free, offline-tolerant. Gemma enrichment (Phase 3) layers on top.
//
// Order: user-specific rules (from category_rules table) win over the built-in
// default map. The app passes userRules in; this module stays pure/testable.
// ============================================================================

// Keys here are kept plain words/phrases ([A-Za-z0-9] and internal spaces
// only) for readability, not because matchesKeyword below requires it - it
// uses a lookaround, not \b, specifically so a keyword CAN safely start or
// end with a symbol if one is ever genuinely needed. Multi-word phrases
// ("taco bell") work as a single unit, matched only when both words appear
// together in that order.
const DEFAULT_RULES = {
  // Food
  chipotle: "Food", mcdonald: "Food", starbucks: "Food", coffee: "Food",
  lunch: "Food", dinner: "Food", breakfast: "Food", brunch: "Food",
  grubhub: "Food", doordash: "Food", ubereats: "Food", postmates: "Food",
  restaurant: "Food", groceries: "Food", grocery: "Food", wholefoods: "Food",
  trader: "Food", safeway: "Food", kroger: "Food", publix: "Food",
  albertsons: "Food", aldi: "Food", vons: "Food", ralphs: "Food",
  instacart: "Food", wendy: "Food", burgerking: "Food", tacobell: "Food",
  kfc: "Food", dominos: "Food", pizzahut: "Food", papajohn: "Food",
  chickfila: "Food", panera: "Food", dunkin: "Food", wingstop: "Food",
  popeyes: "Food", sushi: "Food", bakery: "Food", deli: "Food",
  diner: "Food", cafe: "Food", brewery: "Food", bagel: "Food",
  pizza: "Food", burger: "Food", taco: "Food", sandwich: "Food",
  takeout: "Food", fivebelow: "Food",
  // Transport
  uber: "Transport", lyft: "Transport", gas: "Transport", shell: "Transport",
  chevron: "Transport", metro: "Transport", transit: "Transport",
  parking: "Transport", flight: "Transport", airline: "Transport",
  exxon: "Transport", mobil: "Transport", arco: "Transport",
  marathon: "Transport", sunoco: "Transport", valero: "Transport",
  citgo: "Transport", texaco: "Transport", chargepoint: "Transport",
  evgo: "Transport", toll: "Transport", tolls: "Transport",
  taxi: "Transport", amtrak: "Transport", train: "Transport",
  hertz: "Transport", avis: "Transport", zipcar: "Transport",
  greyhound: "Transport", bart: "Transport", caltrain: "Transport",
  // Subscriptions
  netflix: "Subscriptions", spotify: "Subscriptions", youtube: "Subscriptions",
  hulu: "Subscriptions", disney: "Subscriptions", adobe: "Subscriptions",
  icloud: "Subscriptions", prime: "Subscriptions", "hbo": "Subscriptions",
  patreon: "Subscriptions", notion: "Subscriptions", gym: "Subscriptions",
  applemusic: "Subscriptions", appletv: "Subscriptions", peacock: "Subscriptions",
  paramount: "Subscriptions", crunchyroll: "Subscriptions", audible: "Subscriptions",
  kindle: "Subscriptions", dropbox: "Subscriptions", googleone: "Subscriptions",
  onedrive: "Subscriptions", canva: "Subscriptions", chatgpt: "Subscriptions",
  openai: "Subscriptions", claude: "Subscriptions", github: "Subscriptions",
  slack: "Subscriptions", zoom: "Subscriptions", linkedin: "Subscriptions",
  xbox: "Subscriptions", playstation: "Subscriptions", twitch: "Subscriptions",
  discord: "Subscriptions", planetfitness: "Subscriptions", equinox: "Subscriptions",
  peloton: "Subscriptions", masterclass: "Subscriptions", skillshare: "Subscriptions",
  coursera: "Subscriptions", headspace: "Subscriptions", calm: "Subscriptions",
  nytimes: "Subscriptions", wsj: "Subscriptions",
  // Shopping
  amazon: "Shopping", target: "Shopping", walmart: "Shopping",
  costco: "Shopping", bestbuy: "Shopping", ebay: "Shopping", etsy: "Shopping",
  ikea: "Shopping", homedepot: "Shopping", lowes: "Shopping", macys: "Shopping",
  nordstrom: "Shopping", tjmaxx: "Shopping", marshalls: "Shopping", ross: "Shopping",
  kohls: "Shopping", gap: "Shopping", oldnavy: "Shopping", zara: "Shopping",
  sephora: "Shopping", ulta: "Shopping", nike: "Shopping", adidas: "Shopping",
  wayfair: "Shopping", michaels: "Shopping", petco: "Shopping", petsmart: "Shopping",
  chewy: "Shopping",
  // Utilities / Housing
  electric: "Utilities", water: "Utilities", internet: "Utilities",
  comcast: "Utilities", verizon: "Utilities", att: "Utilities",
  rent: "Housing", mortgage: "Housing", pge: "Utilities", coned: "Utilities",
  xfinity: "Utilities", spectrum: "Utilities", tmobile: "Utilities",
  sprint: "Utilities", cricket: "Utilities", mintmobile: "Utilities",
  wifi: "Utilities", cable: "Utilities", sewer: "Utilities", hoa: "Housing",
  electricity: "Utilities", propane: "Utilities",
  // Health
  pharmacy: "Health", cvs: "Health", walgreens: "Health", doctor: "Health",
  dentist: "Health", dental: "Health", hospital: "Health", clinic: "Health",
  urgentcare: "Health", optometrist: "Health", vision: "Health",
  chiropractor: "Health", therapist: "Health", therapy: "Health",
  copay: "Health", prescription: "Health", riteaid: "Health",
  labcorp: "Health", orthodontist: "Health", vet: "Health", veterinary: "Health",
  // Entertainment (previously had zero default keywords at all)
  movie: "Entertainment", movies: "Entertainment", cinema: "Entertainment",
  amc: "Entertainment", regal: "Entertainment", theater: "Entertainment",
  theatre: "Entertainment", concert: "Entertainment", ticketmaster: "Entertainment",
  stubhub: "Entertainment", museum: "Entertainment", zoo: "Entertainment",
  aquarium: "Entertainment", sixflags: "Entertainment", bowling: "Entertainment",
  arcade: "Entertainment", golf: "Entertainment", karaoke: "Entertainment",
  comedy: "Entertainment", festival: "Entertainment",
};

// Escapes regex metacharacters in a keyword before it goes into a \b...\b
// pattern below - required for DEFAULT_RULES' own sake (a future keyword
// like "paramount+" would otherwise break the regex, not just mismatch),
// and non-negotiable for a user-learned keyword (learnKeyword, app.js),
// which comes from real typed text the app has no control over and could
// contain anything.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-word match, not "appears anywhere as a substring" - "att" (AT&T)
// used to match inside "attend", "battery", any word merely containing
// those three letters, which is the bug this replaces.
//
// Lookaround, not \b: \b requires an actual word/non-word TRANSITION on
// each side, which silently breaks for a keyword that itself starts or
// ends with a non-word character - "c++" would never satisfy a trailing
// \b even standing perfectly alone ("c++ conference"), since both the
// keyword's own last character and the following space are non-word, so
// there's no transition to match. Caught by testing a constructed
// metacharacter keyword, not by reasoning about \b in the abstract.
// (?<![a-z0-9]) / (?![a-z0-9]) instead assert something about the
// SURROUNDING text - "not a letter or digit" - regardless of what the
// keyword's own edges look like, which is what "stands alone" actually
// means here. DEFAULT_RULES' keys are still kept word-shaped (see its own
// header comment) for readability, not because this function requires it.
function matchesKeyword(text, kw) {
  if (!kw) return false;
  const escaped = escapeRegex(kw);
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

/**
 * @param {string} text  raw expense text (already includes merchant/desc)
 * @param {Object} [userRules]  map of keyword -> category from category_rules
 * @returns {string|null}  matched category, or null if nothing matched
 */
export function categorize(text, userRules = {}) {
  if (!text) return null;
  // User rules take precedence - a correction you've made should always
  // beat the built-in guess for the same word, which is also why it's
  // checked first rather than after.
  for (const [kw, cat] of Object.entries(userRules)) {
    if (matchesKeyword(text, kw)) return cat;
  }
  for (const [kw, cat] of Object.entries(DEFAULT_RULES)) {
    if (matchesKeyword(text, kw)) return cat;
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
