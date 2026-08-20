// ============================================================================
// Subscriptions logic (README §3.7, Phase 2 / F5).
// Pure, unit-testable helpers. UI wiring lives in app.js.
// ============================================================================

/** Normalize a subscription's charge to a monthly-equivalent dollar amount. */
export function monthlyAmount(sub) {
  const amt = Number(sub.amount || 0);
  switch (sub.billing_cycle) {
    case "annual": return amt / 12;
    case "semiannual": return amt / 6;
    case "quarterly": return amt / 3;
    case "monthly": return amt;
    default: return amt; // 'other' - treat the stored amount as monthly
  }
}

/** Total monthly-equivalent spend across active subscriptions. */
export function totalMonthly(subs) {
  return Math.round(
    subs.filter((s) => s.is_active).reduce((sum, s) => sum + monthlyAmount(s), 0) * 100
  ) / 100;
}

/** Whole days from `today` until an ISO date string (negative = past due). */
export function daysUntil(isoDate, today = new Date()) {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00");
  const t = new Date(today.toISOString().slice(0, 10) + "T00:00:00");
  return Math.round((d - t) / 86400000);
}

/**
 * Active subscriptions renewing within `withinDays` (incl. overdue),
 * sorted soonest-first. Each item gets a `days` field.
 */
export function upcomingRenewals(subs, withinDays = 30, today = new Date()) {
  return subs
    .filter((s) => s.is_active && s.next_renewal)
    .map((s) => ({ ...s, days: daysUntil(s.next_renewal, today) }))
    .filter((s) => s.days !== null && s.days <= withinDays)
    .sort((a, b) => a.days - b.days);
}

/** Friendly renewal label from a day delta. */
export function renewalLabel(days) {
  if (days === null || days === undefined) return "";
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

/**
 * Next renewal date after paying, one billing cycle forward from the
 * subscription's own next_renewal (not from today - paying late shouldn't
 * shift the schedule). 'other' has no defined interval, so it's left
 * unchanged rather than guessed; the user updates it manually.
 *
 * Built from the y/m/d parts directly rather than Date#setMonth, which
 * overflows into the following month for day-of-month values that don't
 * exist in the target month (Jan 31 + 1 month lands on Mar 3, not Feb 28).
 * Clamping the day to the target month's actual length avoids that -
 * also needed for annual on leap-day subscriptions (Feb 29 -> Feb 28).
 *
 * A single month-count-based formula covers all four defined cycles
 * (monthly=1, quarterly=3, semiannual=6, annual=12) rather than
 * special-casing each - verified equivalent to the original monthly/
 * annual-only branches before quarterly/semiannual were added.
 */
export function advanceRenewal(isoDate, billingCycle) {
  if (!isoDate) return isoDate;
  const monthsToAdd = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[billingCycle];
  if (!monthsToAdd) return isoDate;
  const [y, m, day] = isoDate.split("-").map(Number);
  let targetMonth = m + monthsToAdd; // 1-indexed, pre-carry
  const targetYear = y + Math.floor((targetMonth - 1) / 12);
  targetMonth = ((targetMonth - 1) % 12) + 1;
  // New Date(y, m, 0) is day 0 of 1-indexed month m, i.e. the last day of
  // the *previous* 0-indexed month - which, since targetMonth is already
  // 1-indexed, is exactly the last day of targetMonth itself.
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

// Duplicated from discounts.js's matchService rather than imported, since
// discounts.js already imports monthlyAmount from this file - importing it
// back would be circular.
function looseNameMatch(a, b) {
  const x = (a || "").toLowerCase().trim();
  const y = (b || "").toLowerCase().trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// 'weekly'/'biweekly' still aren't valid subscriptions.billing_cycle
// values - those map to the existing 'other' cycle, same as a user
// picking "Other" manually today. Quarterly/semiannual are real values
// now (30_quarterly_semiannual_billing_cycle.sql).
const INTERVAL_BUCKETS = [
  { cycle: "other", label: "~7 days", days: 7, tolerance: 2 },
  { cycle: "other", label: "~14 days", days: 14, tolerance: 3 },
  { cycle: "monthly", label: "month", days: 30, tolerance: 4 },
  { cycle: "quarterly", label: "~3 months", days: 91, tolerance: 8 },
  { cycle: "semiannual", label: "~6 months", days: 182, tolerance: 10 },
  { cycle: "annual", label: "year", days: 365, tolerance: 15 },
];

function matchInterval(gaps) {
  return INTERVAL_BUCKETS.find((b) => gaps.every((g) => Math.abs(g - b.days) <= b.tolerance)) || null;
}

/**
 * Finds expenses that look like an untracked recurring bill: same
 * merchant text + exact same amount, appearing on a consistent interval,
 * and not already matching an active subscription. Read-only - never
 * writes anything, the caller decides whether to act on a candidate.
 *
 * Requires 3+ occurrences (2 consistent gaps), not just a pair, so one
 * coincidental repeat doesn't trigger a false positive - the same
 * "verify against real edge cases" caution that caught the bank-name
 * matching bug found during testing. Amount must match exactly rather than
 * fuzzily, since most real bills charge the same amount every cycle
 * (researched against real billing-cycle conventions).
 *
 * No persisted "dismiss": a candidate simply stops appearing once its
 * most recent occurrence is more than 1.5x the detected interval old (the
 * pattern went stale on its own) or once a matching active subscription
 * exists - the same no-dismiss-needed shape studentUpsell() already uses.
 */
export function detectRecurringExpenses(expenses, subscriptions, today = new Date()) {
  const groups = new Map();
  for (const e of expenses) {
    const merchantText = (e.description || e.merchant || "").trim();
    const amount = Number(e.amount);
    if (!merchantText || !e.occurred_at || !Number.isFinite(amount) || amount <= 0) continue;
    const key = merchantText.toLowerCase() + "|" + amount.toFixed(2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const activeSubNames = subscriptions.filter((s) => s.is_active).map((s) => s.name);
  const todayMs = new Date(today.toISOString().slice(0, 10) + "T00:00:00").getTime();
  const candidates = [];

  for (const rows of groups.values()) {
    if (rows.length < 3) continue;
    const sorted = [...rows].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const d1 = new Date(sorted[i - 1].occurred_at + "T00:00:00").getTime();
      const d2 = new Date(sorted[i].occurred_at + "T00:00:00").getTime();
      gaps.push(Math.round((d2 - d1) / 86400000));
    }
    const bucket = matchInterval(gaps);
    if (!bucket) continue;

    const latest = sorted[sorted.length - 1];
    const daysSinceLast = Math.round((todayMs - new Date(latest.occurred_at + "T00:00:00").getTime()) / 86400000);
    if (daysSinceLast > bucket.days * 1.5) continue;

    const merchantText = (latest.description || latest.merchant || "").trim();
    if (activeSubNames.some((name) => looseNameMatch(merchantText, name))) continue;

    candidates.push({
      merchant: merchantText,
      amount: Number(latest.amount),
      category: latest.category || null,
      accountId: latest.account_id || null,
      occurrenceCount: sorted.length,
      suggestedCycle: bucket.cycle,
      cycleLabel: bucket.label,
      lastOccurredAt: latest.occurred_at,
    });
  }

  return candidates.sort((a, b) => b.lastOccurredAt.localeCompare(a.lastOccurredAt));
}
