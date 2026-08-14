// ============================================================================
// Per-category budgets. Pure,
// unit-testable - same style as networth.js/depreciation.js.
// ============================================================================

const r2 = (n) => Math.round(n * 100) / 100;

// A category counts as "approaching" its budget at 90% spent, not just
// once actually over - gives a real heads-up while there's still room to
// adjust, rather than only flagging it after the fact.
export const WARN_THRESHOLD_PCT = 90;

/**
 * Combines each budget with the selected month's actual spend for that
 * category (from charts.js's sumBy(expenses, "category", ym), passed in
 * rather than recomputed here so this stays pure/decoupled from the
 * expenses array). Sorted by percent-used descending, so the closest-to-
 * (or most-over-)budget category surfaces first.
 * @param {object[]} budgets rows from the `budgets` table
 * @param {{label:string, value:number}[]} spendByCategory from sumBy()
 */
export function budgetStatus(budgets, spendByCategory) {
  const spendMap = new Map(spendByCategory.map((s) => [s.label, s.value]));
  return budgets
    .map((b) => {
      const spent = r2(spendMap.get(b.category) || 0);
      const limit = Number(b.monthly_limit);
      const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      const over = spent > limit;
      return { category: b.category, limit, spent, pct, over, warn: over || pct >= WARN_THRESHOLD_PCT };
    })
    .sort((a, b) => b.pct - a.pct);
}
