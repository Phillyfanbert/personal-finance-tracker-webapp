// ============================================================================
// Cash flow forecast (Reports page). Pure, unit-testable - the
// forward-projecting mirror of accountHistory.js's buildBalanceHistory(),
// which walks BACKWARD from today through known past deltas. This walks
// FORWARD from today through known FUTURE scheduled events only (upcoming
// subscription charges via advanceRenewal(), upcoming income deposits via
// advanceIncomeDate()) - deliberately no blended "average recent spending"
// estimate. A forecast built only from real scheduled items is honest
// about what it actually knows; blending in a spending average would make
// the line look more predictive than this app should claim to be, the
// same restraint held everywhere else in this app (never a fabricated
// number, never advice). Returns the same [{date, balance}] shape
// buildBalanceHistory() does, so it drops straight into renderLineChart()
// unchanged. Imports advanceRenewal/advanceIncomeDate directly rather than
// taking them as parameters - matches insights.js's own established
// pattern of cross-importing pure helpers from other logic modules.
// ============================================================================
import { advanceRenewal } from "./subscriptions.js";
import { advanceIncomeDate } from "./income.js";

const r2 = (n) => Math.round(n * 100) / 100;
const MAX_OCCURRENCES = 36; // same defensive cap autoLogDueSubscriptions/autoLogDueIncome use

/**
 * @param {object} account
 * @param {number} currentBalance
 * @param {object[]} subscriptions - active ones tied to this account subtract
 * @param {object[]} incomeSources - active ones tied to this account add
 * @param {number} days how far forward to project (default 30)
 */
export function forecastCashFlow(account, currentBalance, subscriptions, incomeSources, days, today = new Date()) {
  const windowDays = days || 30;
  const todayStr = today.toISOString().slice(0, 10);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + windowDays);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const deltasByDate = new Map();
  // Today's own already-happened activity is already reflected in
  // currentBalance (autoLogDueSubscriptions/autoLogDueIncome already ran
  // by the time this forecast is computed) - only genuinely future dates
  // count, so this rejects <= today, not just < today.
  const add = (date, delta) => {
    if (!date || date <= todayStr || date > horizonStr) return;
    deltasByDate.set(date, (deltasByDate.get(date) || 0) + delta);
  };

  for (const sub of subscriptions) {
    if (!sub.is_active || !sub.next_renewal || sub.account_id !== account.id) continue;
    let renewal = sub.next_renewal;
    let occurrences = 0;
    while (renewal <= horizonStr && occurrences < MAX_OCCURRENCES) {
      add(renewal, -Number(sub.amount));
      const next = advanceRenewal(renewal, sub.billing_cycle);
      if (next === renewal) break; // 'other' cycle never advances - avoid looping forever
      renewal = next;
      occurrences++;
    }
  }

  for (const src of incomeSources) {
    if (!src.is_active || !src.next_expected || src.account_id !== account.id) continue;
    let expected = src.next_expected;
    let occurrences = 0;
    while (expected <= horizonStr && occurrences < MAX_OCCURRENCES) {
      add(expected, Number(src.amount));
      if (src.cadence === "one_time") break; // never advances
      expected = advanceIncomeDate(expected, src.cadence, src.semimonthly_day_1, src.semimonthly_day_2);
      occurrences++;
    }
  }

  const datesAscending = [...deltasByDate.keys()].sort();
  let running = Number(currentBalance);
  const points = [{ date: todayStr, balance: r2(running) }];
  for (const date of datesAscending) {
    running += deltasByDate.get(date);
    points.push({ date, balance: r2(running) });
  }
  return points;
}
