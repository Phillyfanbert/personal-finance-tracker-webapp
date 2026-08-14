// ============================================================================
// Liability payoff projection. Pure,
// unit-testable - same style as depreciation.js/networth.js. Uses the
// interest_rate/minimum_payment fields liabilities have always stored but
// never actually used in any calculation until now.
// ============================================================================

/**
 * Target date `months` months from `date`, day-of-month clamped to the
 * target month's actual length - same overflow-safe logic
 * subscriptions.js's advanceRenewal() already uses for a single month/
 * year, generalized to an arbitrary month count here.
 */
function addMonthsISO(date, months) {
  const day = date.getDate();
  let targetMonth = date.getMonth() + 1 + months; // 1-indexed, pre-carry
  let targetYear = date.getFullYear() + Math.floor((targetMonth - 1) / 12);
  targetMonth = ((targetMonth - 1) % 12) + 1;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

const MAX_MONTHS = 1200; // 100 years - a sane cap so a too-small payment can't loop forever

/**
 * Month-by-month amortization simulation rather than a closed-form
 * formula - simpler to reason about and to test exhaustively, and it
 * naturally handles a partial final payment correctly instead of needing
 * a separate correction term.
 *
 * @param {number} balance current amount owed
 * @param {number|null} annualRatePct e.g. 19.99 for 19.99% APR, stored
 *   exactly as the user types it (not a 0-1 fraction) - null/0 means
 *   interest-free
 * @param {number} monthlyPayment
 * @returns {null} if monthlyPayment isn't a usable positive number
 * @returns {{months:0, totalInterest:0, totalPaid:0, payoffDate:string}}
 *   if balance is already <= 0
 * @returns {{neverPaysOff:true}} if the payment doesn't even cover a
 *   single period's interest, so the balance would grow forever
 * @returns {{months, totalInterest, totalPaid, payoffDate}} otherwise
 */
export function payoffProjection(balance, annualRatePct, monthlyPayment, today = new Date()) {
  const bal = Number(balance);
  const pay = Number(monthlyPayment);
  if (!Number.isFinite(bal) || bal <= 0) {
    return { months: 0, totalInterest: 0, totalPaid: 0, payoffDate: addMonthsISO(today, 0) };
  }
  if (!Number.isFinite(pay) || pay <= 0) return null;

  const r = Number.isFinite(annualRatePct) && annualRatePct > 0 ? annualRatePct / 100 / 12 : 0;
  if (r > 0 && pay <= bal * r) return { neverPaysOff: true };

  let remaining = bal;
  let totalInterest = 0;
  let months = 0;
  while (remaining > 0.005 && months < MAX_MONTHS) {
    const interest = remaining * r;
    totalInterest += interest;
    remaining = remaining + interest - pay;
    months++;
  }
  if (remaining > 0.005) return { neverPaysOff: true };

  return {
    months,
    totalInterest: Math.round(totalInterest * 100) / 100,
    totalPaid: Math.round((bal + totalInterest) * 100) / 100,
    payoffDate: addMonthsISO(today, months),
  };
}
