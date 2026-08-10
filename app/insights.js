// ============================================================================
// Interactive spending Q&A - context builder (pure, unit-testable).
// Builds a compact summary of the signed-in user's own data to hand to
// Gemma alongside their question. Capped so prompts stay small and fast on
// a local model - not a privacy boundary, since this only ever goes to the
// user's own self-hosted Gemma (app/gemma.js).
// ============================================================================
import { lastMonths, monthlyTotals, sumBy } from "./charts.js";
import { monthlyAmount, totalMonthly } from "./subscriptions.js";

const MAX_TRANSACTIONS = 150;

// Only the fields actually useful for reasoning about spending/saving
// advice - deal-eligibility flags (military, employer, ...) live in
// discounts.js instead, since they answer a different question ("what
// discount am I eligible for") than this one ("should I pay down debt or
// save?").
function profileContext(profile) {
  if (!profile) return null;
  const { employment_status, housing_status, household_size, dependents, financial_goals } = profile;
  if (!employment_status && !housing_status && !household_size && !dependents && !financial_goals) return null;
  return { employment_status, housing_status, household_size, dependents, financial_goals };
}

/** Build the context object sent to Gemma for a spending question. */
export function buildQaContext(expenses, subscriptions, months = 6, profile = null) {
  const recentMonths = lastMonths(months);
  const since = recentMonths[0] + "-01";
  const inRange = expenses.filter((e) => (e.occurred_at || "") >= since);

  const categoryTotals = {};
  for (const ym of recentMonths) {
    for (const { label, value } of sumBy(inRange, "category", ym)) {
      categoryTotals[label] = Math.round(((categoryTotals[label] || 0) + value) * 100) / 100;
    }
  }

  const totalsArr = monthlyTotals(inRange, recentMonths);
  const monthlyTotalsMap = Object.fromEntries(recentMonths.map((m, i) => [m, totalsArr[i]]));

  const transactions = inRange.slice(0, MAX_TRANSACTIONS).map((e) => ({
    date: e.occurred_at,
    amount: Number(e.amount),
    category: e.category || null,
    description: e.description || e.merchant || null,
    payment_type: e.payment_type || null,
  }));

  const activeSubs = subscriptions.filter((s) => s.is_active).map((s) => ({
    name: s.name,
    monthly: Math.round(monthlyAmount(s) * 100) / 100,
    next_renewal: s.next_renewal || null,
  }));

  return {
    months_covered: recentMonths,
    monthly_totals: monthlyTotalsMap,
    category_totals: categoryTotals,
    active_subscriptions: activeSubs,
    subscriptions_monthly_total: totalMonthly(subscriptions),
    transactions,
    transactions_truncated: inRange.length > MAX_TRANSACTIONS,
    profile: profileContext(profile),
  };
}
