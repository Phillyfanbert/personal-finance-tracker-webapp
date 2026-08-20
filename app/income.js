// ============================================================================
// Recurring income date-stepping. Pure, unit-testable - same style as
// subscriptions.js/payoff.js. Deliberately its own small clamped-month-add
// implementation rather than importing payoff.js's addMonthsISO or
// subscriptions.js's advanceRenewal - those two already coexist as
// separate near-duplicates for the same reason (each module stays
// self-contained rather than cross-importing across unrelated domains),
// and income cadences (weekly/biweekly's fixed day-count shape,
// semimonthly's two-fixed-calendar-day shape) don't map cleanly onto
// either existing function's parameters anyway.
// ============================================================================

/** Last real day of the given year/1-indexed-month, for clamping. */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Steps `isoDate` forward one income cadence.
 *  - weekly/biweekly: a plain fixed day-count addition (+7/+14) - no
 *    month-length ambiguity, unlike every other cadence here.
 *  - monthly/annual: clamps the day-of-month to the target month's real
 *    length, the same overflow-safe logic payoff.js's addMonthsISO/
 *    subscriptions.js's advanceRenewal both already use (Jan 31 + 1 month
 *    lands on Feb 28, not Mar 3).
 *  - semimonthly: genuinely different in kind, not just degree - real
 *    semimonthly pay is two FIXED calendar days per month (e.g. the 1st
 *    and 15th), not a ~15-day interval, which would slowly drift off the
 *    real payday over calendar months of different lengths. Steps to
 *    whichever of the two anchors comes next after isoDate, wrapping to
 *    next month's earlier anchor once isoDate is at or past both of this
 *    month's (clamped) anchors. Returns isoDate unchanged if either
 *    anchor is missing - not fully configured yet.
 *  - one_time: never advances (no defined next occurrence) - returned
 *    unchanged, same as advanceRenewal's 'other' handling.
 */
export function advanceIncomeDate(isoDate, cadence, semimonthlyDay1 = null, semimonthlyDay2 = null) {
  if (!isoDate) return isoDate;
  const [y, m, day] = isoDate.split("-").map(Number);

  if (cadence === "weekly" || cadence === "biweekly") {
    const days = cadence === "weekly" ? 7 : 14;
    const d = new Date(y, m - 1, day);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  if (cadence === "semimonthly") {
    if (!semimonthlyDay1 || !semimonthlyDay2) return isoDate;
    const anchors = [semimonthlyDay1, semimonthlyDay2].sort((a, b) => a - b);
    for (const anchor of anchors) {
      const clamped = Math.min(anchor, lastDayOfMonth(y, m));
      if (clamped > day) return `${y}-${String(m).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
    }
    // Past both of this month's anchors - wrap to next month's earlier one.
    let targetMonth = m + 1;
    const targetYear = y + Math.floor((targetMonth - 1) / 12);
    targetMonth = ((targetMonth - 1) % 12) + 1;
    const clamped = Math.min(anchors[0], lastDayOfMonth(targetYear, targetMonth));
    return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  }

  const monthsToAdd = { monthly: 1, annual: 12 }[cadence];
  if (!monthsToAdd) return isoDate; // one_time - never advances
  let targetMonth = m + monthsToAdd;
  const targetYear = y + Math.floor((targetMonth - 1) / 12);
  targetMonth = ((targetMonth - 1) % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}
