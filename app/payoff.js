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
const PAYOFF_EPSILON = 0.005; // a balance this close to $0 counts as paid off, floating-point slack

/** e.g. 19.99 (APR %) -> its monthly decimal rate; null/0/non-finite -> interest-free (0). */
function monthlyRateFromApr(annualRatePct) {
  return Number.isFinite(annualRatePct) && annualRatePct > 0 ? annualRatePct / 100 / 12 : 0;
}

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

  const r = monthlyRateFromApr(annualRatePct);
  if (r > 0 && pay <= bal * r) return { neverPaysOff: true };

  let remaining = bal;
  let totalInterest = 0;
  let months = 0;
  while (remaining > PAYOFF_EPSILON && months < MAX_MONTHS) {
    const interest = remaining * r;
    totalInterest += interest;
    remaining = remaining + interest - pay;
    months++;
  }
  if (remaining > PAYOFF_EPSILON) return { neverPaysOff: true };

  return {
    months,
    totalInterest: Math.round(totalInterest * 100) / 100,
    totalPaid: Math.round((bal + totalInterest) * 100) / 100,
    payoffDate: addMonthsISO(today, months),
  };
}

// ---- Multi-debt payoff strategy comparison (avalanche vs. snowball) ------
// payoffProjection() above is a closed loop with no per-month hook - it
// can't redirect one debt's freed-up minimum payment into another once
// paid off, which is the entire mechanic that makes avalanche/snowball
// ordering matter at all. At $0 extra, every debt just pays off
// independently at its own pace and both orderings produce identical
// results - the comparison only diverges once there's a shared
// extra/freed-up pool to redirect, so this is a genuinely different
// simulation, not a thin wrapper around the function above. The shared
// per-period interest math (monthlyRateFromApr, MAX_MONTHS,
// PAYOFF_EPSILON) is still reused rather than duplicated.

/**
 * Same gating payoffLine() (app.js) already applies per-debt on the
 * Liabilities card - this comparison never includes a debt today's card
 * wouldn't even show a payoff line for. An active HELOC draw period is
 * interest-only by design (see GRACE_PERIOD_LIABILITY_TYPES's own
 * reasoning) - including it here would misrepresent it as being paid
 * down when draw-period payments don't touch principal.
 */
function isEligibleForComparison(debt, today) {
  if (debt.interest_rate == null || debt.minimum_payment == null) return false;
  if (!(Number(debt.balance) > 0)) return false;
  if (debt.type === "heloc" && debt.draw_period_end) {
    const todayStr = today.toISOString().slice(0, 10);
    if (debt.draw_period_end >= todayStr) return false;
  }
  return true;
}

function simulateStrategy(debts, extraMonthly, comparator) {
  const ordered = [...debts].sort(comparator).map((d) => ({
    balance: Number(d.balance),
    r: monthlyRateFromApr(Number(d.interest_rate)),
    minimum: Number(d.minimum_payment),
  }));
  let totalInterest = 0;
  let months = 0;

  while (ordered.some((d) => d.balance > PAYOFF_EPSILON) && months < MAX_MONTHS) {
    months++;
    // Interest accrues on every still-open debt before any payment, same
    // order payoffProjection() uses for a single debt.
    for (const d of ordered) {
      if (d.balance <= PAYOFF_EPSILON) continue;
      const interest = d.balance * d.r;
      totalInterest += interest;
      d.balance += interest;
    }
    // Every debt's own minimum first - a debt already paid off has its
    // minimum roll forward into this month's leftover pool instead
    // (permanently freed, not just this once).
    let leftover = Number(extraMonthly) || 0;
    for (const d of ordered) {
      if (d.balance <= PAYOFF_EPSILON) {
        leftover += d.minimum;
        continue;
      }
      const pay = Math.min(d.minimum, d.balance);
      d.balance -= pay;
      leftover += d.minimum - pay; // only nonzero on a debt's final, partial month
    }
    // The whole leftover pool goes to whichever still-open debt sorts
    // first, cascading to the next one if it's enough to finish the
    // first (so a large extra payment doesn't get "stuck" behind a
    // near-zero debt).
    for (const d of ordered) {
      if (leftover <= 0) break;
      if (d.balance <= PAYOFF_EPSILON) continue;
      const pay = Math.min(leftover, d.balance);
      d.balance -= pay;
      leftover -= pay;
    }
  }

  if (ordered.some((d) => d.balance > PAYOFF_EPSILON)) return { neverPaysOff: true };
  return { months, totalInterest: Math.round(totalInterest * 100) / 100 };
}

/**
 * Compares avalanche (highest interest rate first) vs. snowball (smallest
 * balance first) payoff order across every eligible debt at once, given a
 * shared monthly "extra toward debt" amount. Purely informational - shows
 * the real math for both orders side by side, never states which to pick
 * (the same boundary the Investments tab's allocation calculator already
 * holds for what to buy).
 * @param {object[]} debts rows from the `liabilities` table
 * @param {number} extraMonthly additional amount beyond every debt's own
 *   minimum, redirected to the highest-priority remaining debt each month
 * @returns {{avalanche, snowball, excludedCount}} - avalanche/snowball are
 *   each either {months, totalInterest} or {neverPaysOff: true};
 *   excludedCount is how many debts were left out (missing rate/minimum,
 *   already at $0, or an in-draw-period HELOC) so the UI can say so
 *   rather than silently showing fewer debts than the user has.
 */
export function compareDebtStrategies(debts, extraMonthly = 0, today = new Date()) {
  const eligible = debts.filter((d) => isEligibleForComparison(d, today));
  const excludedCount = debts.length - eligible.length;
  if (!eligible.length) return { avalanche: null, snowball: null, excludedCount };

  const avalanche = simulateStrategy(eligible, extraMonthly, (a, b) => b.r - a.r);
  const snowball = simulateStrategy(eligible, extraMonthly, (a, b) => a.balance - b.balance);
  return { avalanche, snowball, excludedCount };
}
