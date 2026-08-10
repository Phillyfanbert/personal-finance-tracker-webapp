// ============================================================================
// CSV expense-history import. Pure, unit-testable - same style as
// budgets.js/investments.js. Actual file reading and PapaParse invocation
// live in app.js (DOM/File API work); this module only turns already-
// parsed rows into normalized expense objects, plus the small heuristics
// (column guessing, sign convention, duplicate flagging) that benefit from
// being tested against constructed fixtures before ever touching real data.
//
// Deliberately conservative on dates: a wrong guess on a financial date is
// worse than refusing to import that row, so parseFlexibleDate only
// recognizes ISO (YYYY-MM-DD) and US slash (M/D/YYYY or M/D/YY) formats -
// no native Date() fallback, which parses inconsistently across formats/
// locales and can silently produce a wrong date instead of failing loudly.
// ============================================================================

/** @returns {string|null} "YYYY-MM-DD", or null if unrecognized/invalid. */
export function parseFlexibleDate(str) {
  const s = (str || "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return isValidYmd(y, m, d) ? `${y}-${m}-${d}` : null;
  }

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    // 2-digit year pivot: this app is for recent expense history, not
    // decades-old records, so treat every 2-digit year as 20YY.
    if (y.length === 2) y = "20" + y;
    m = m.padStart(2, "0");
    d = d.padStart(2, "0");
    return isValidYmd(y, m, d) ? `${y}-${m}-${d}` : null;
  }

  return null;
}
function isValidYmd(y, m, d) {
  const mi = Number(m), di = Number(d);
  return mi >= 1 && mi <= 12 && di >= 1 && di <= 31;
}

/**
 * Handles "$1,234.56", "(123.45)" (accounting negative notation), and a
 * plain "-123.45" - returns null (not 0) for anything that isn't a real
 * number, so a garbage cell skips the row rather than importing $0.
 * @returns {number|null}
 */
export function parseAmount(str) {
  const s = (str || "").trim();
  if (!s) return null;
  const negParens = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negParens ? -Math.abs(n) : n;
}

const FIELD_KEYWORDS = {
  dateCol: ["date", "transaction date", "posted date", "posting date"],
  amountCol: ["amount", "debit", "amount debited", "value"],
  descCol: ["description", "merchant", "payee", "name", "memo", "original description"],
  categoryCol: ["category"],
};

/**
 * Best-guess header -> column-index mapping from common export header
 * names. A field stays null if nothing matches - the mapping UI shows
 * that as unset rather than silently guessing wrong. Never assigns the
 * same column to two fields.
 * @param {string[]} headers
 * @returns {{dateCol:number|null, amountCol:number|null, descCol:number|null, categoryCol:number|null}}
 */
export function guessColumnMapping(headers) {
  const lower = headers.map((h) => (h || "").toLowerCase().trim());
  const used = new Set();
  const mapping = { dateCol: null, amountCol: null, descCol: null, categoryCol: null };
  for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
    const idx = lower.findIndex((h, i) => !used.has(i) && keywords.some((k) => h === k || h.includes(k)));
    if (idx !== -1) { mapping[field] = idx; used.add(idx); }
  }
  return mapping;
}

/**
 * Most bank/Mint-style exports show a spent amount as negative; a few show
 * it as a plain positive "Debit" column. If most parsed amounts in this
 * file are negative, assume "negative = spent" so the sign gets flipped to
 * this app's positive-expense convention. Always shown as an overridable
 * checkbox in the UI, never applied silently.
 * @param {string[][]} rows raw rows (not yet normalized)
 * @param {{amountCol:number|null}} mapping
 */
export function guessSignConvention(rows, mapping) {
  if (mapping.amountCol == null) return false;
  let negatives = 0, total = 0;
  for (const row of rows) {
    const n = parseAmount(row[mapping.amountCol]);
    if (n == null) continue;
    total++;
    if (n < 0) negatives++;
  }
  return total > 0 && negatives / total > 0.5;
}

/**
 * One raw CSV row + the confirmed column mapping -> a normalized expense,
 * or null if the date/amount don't parse (skipped, not guessed).
 * @param {string[]} rawRow
 * @param {{dateCol:number|null, amountCol:number|null, descCol:number|null, categoryCol:number|null}} mapping
 * @param {{flipSign?: boolean}} [options]
 */
export function normalizeRow(rawRow, mapping, { flipSign = false } = {}) {
  if (mapping.dateCol == null || mapping.amountCol == null) return null;
  const occurred_at = parseFlexibleDate(rawRow[mapping.dateCol]);
  let amount = parseAmount(rawRow[mapping.amountCol]);
  if (occurred_at == null || amount == null) return null;
  if (flipSign) amount = -amount;
  // This app's expenses.amount is always a positive spend - the sign
  // convention is fully resolved by flipSign above, not left ambiguous.
  amount = Math.abs(amount);
  const description = mapping.descCol != null ? (rawRow[mapping.descCol] || "").trim() || null : null;
  const category = mapping.categoryCol != null ? (rawRow[mapping.categoryCol] || "").trim() || null : null;
  return { occurred_at, amount, description, category };
}

/**
 * Same date + amount (within a cent) + a case-insensitive description/
 * merchant match against an already-loaded expense - flagged for the user
 * to review, never auto-dropped, since a false positive silently skipping
 * a real expense would be worse than a false positive the user un-checks.
 * @param {{occurred_at:string, amount:number, description:string|null}} row
 * @param {object[]} existingExpenses rows from the `expenses` table
 */
export function isLikelyDuplicate(row, existingExpenses) {
  const desc = (row.description || "").toLowerCase().trim();
  return existingExpenses.some((e) =>
    e.occurred_at === row.occurred_at &&
    Math.abs(Number(e.amount) - row.amount) < 0.01 &&
    (e.description || e.merchant || "").toLowerCase().trim() === desc
  );
}
