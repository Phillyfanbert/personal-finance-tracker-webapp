// ============================================================================
// Credit-card billing cycle math. Pure and unit-testable, same style as
// budgets.js/payoff.js/networth.js - no DOM, no sb.from() calls.
//
// The rule this module exists to encode, because getting it wrong is the
// single most common misunderstanding about credit cards: interest is NOT a
// late-payment penalty. It is governed by the grace period.
//
//   paid the statement balance IN FULL by the due date -> no interest at all
//   paid at least the minimum but less than the full   -> interest accrues on
//                                                          the remainder, even
//                                                          though nothing was
//                                                          late and no fee is
//                                                          charged
//   paid less than the minimum                         -> interest AND a late
//                                                          fee, plus a
//                                                          possible penalty
//                                                          APR and (after 30+
//                                                          days) a credit-
//                                                          report mark
//
// So paying the minimum does not "hold off" interest - it only keeps the
// account current. That is why minimumPayment is used solely to decide
// whether a late fee applies, and never to reduce the interest estimate.
//
// Everything is measured against the STATEMENT balance, never the live
// balance: the live balance moves with every new charge, so comparing
// payments against it would report a fully-paid card as underpaid the moment
// anything new was swiped.
// ============================================================================

const r2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);

// A cycle day is a day-of-month (1-31) that has to survive landing in a
// short month - a statement that closes on the 31st closes on the 28th in
// February, it does not roll into March. Building a Date with day 31 in a
// 30-day month silently overflows to the next month, which is exactly the
// class of bug already found once in this repo's subscription renewal math,
// so the day is clamped to the month's real length instead.
function dateOnDay(year, monthIndex, day) {
  const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDayOfMonth)));
}

/**
 * The cycle currently being judged: the most recent statement close on or
 * before `today`, and the payment due date that follows it.
 * @param {number} statementDay day of month the statement closes (1-31)
 * @param {number} dueDay day of month payment is due (1-31)
 * @param {Date} today
 * @returns {{statementDate: string, dueDate: string}|null}
 */
export function cycleDates(statementDay, dueDay, today = new Date()) {
  if (!statementDay || !dueDay) return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  let statement = dateOnDay(y, m, statementDay);
  if (statement > today) statement = dateOnDay(y, m - 1, statementDay);
  // The due date is the next occurrence of dueDay strictly after the close,
  // which lands in the following month whenever dueDay <= statementDay (the
  // usual shape of a real card: closes the 5th, due the 2nd of next month).
  let due = dateOnDay(statement.getUTCFullYear(), statement.getUTCMonth(), dueDay);
  if (due <= statement) {
    due = dateOnDay(statement.getUTCFullYear(), statement.getUTCMonth() + 1, dueDay);
  }
  return { statementDate: iso(statement), dueDate: iso(due) };
}

/**
 * Total of payments made against this liability since its statement closed.
 * `activity` is account_activity rows; only liability_payment rows for this
 * liability count, and only those dated after the statement close - an
 * earlier payment settled a previous cycle.
 */
export function paidSinceStatement(activity, liabilityId, statementDate, today = new Date()) {
  const todayStr = iso(today);
  return r2(
    activity
      .filter((a) => a.kind === "liability_payment" && a.liability_id === liabilityId)
      .filter((a) => a.occurred_at > statementDate && a.occurred_at <= todayStr)
      .reduce((sum, a) => sum + Math.abs(Number(a.amount || 0)), 0)
  );
}

/**
 * Where this card stands in its current cycle.
 *
 * `state` is one of:
 *   no_cycle        - no statement/due day recorded, nothing to judge
 *   no_statement    - cycle days set but no statement balance entered yet
 *   paid_in_full    - statement balance covered, grace period intact
 *   due_soon        - still before the due date with a balance outstanding
 *   carrying_balance- past due, at least the minimum paid, interest accruing
 *   missed_minimum  - past due, under the minimum, interest plus a late fee
 *
 * interestEstimate is the remainder times the monthly periodic rate
 * (APR / 12). A real issuer computes interest on an average daily balance
 * across the whole cycle, so this is deliberately labelled an estimate
 * everywhere it surfaces - it is the right order of magnitude and the right
 * direction, not a figure to reconcile a statement against.
 */
export function cycleStatus(liability, activity, today = new Date()) {
  const dates = cycleDates(liability.statement_day, liability.due_day, today);
  if (!dates) return { state: "no_cycle" };

  const { statementDate, dueDate } = dates;
  const statementBalance =
    liability.last_statement_balance != null ? Number(liability.last_statement_balance) : null;
  // A statement balance from an older cycle cannot judge this one.
  const staleStatement =
    !liability.last_statement_date || liability.last_statement_date < statementDate;
  if (statementBalance == null || staleStatement) {
    return { state: "no_statement", statementDate, dueDate };
  }

  const paid = paidSinceStatement(activity, liability.id, statementDate, today);
  const remaining = r2(Math.max(0, statementBalance - paid));
  const apr = liability.interest_rate != null ? Number(liability.interest_rate) : null;
  const interestEstimate = apr != null && remaining > 0 ? r2(remaining * (apr / 100 / 12)) : null;
  const minimum = liability.minimum_payment != null ? Number(liability.minimum_payment) : null;
  const todayStr = iso(today);
  const pastDue = todayStr > dueDate;

  const base = { statementDate, dueDate, statementBalance, paid, remaining, interestEstimate, minimum };

  if (remaining <= 0) return { ...base, state: "paid_in_full", interestEstimate: null };
  if (!pastDue) {
    const daysUntilDue = Math.round(
      (new Date(dueDate + "T00:00:00Z") - new Date(todayStr + "T00:00:00Z")) / 86400000
    );
    return { ...base, state: "due_soon", daysUntilDue };
  }
  // Past the due date with something still outstanding. Interest applies
  // either way from here; the minimum only decides the late fee.
  if (minimum != null && paid < minimum) return { ...base, state: "missed_minimum" };
  return { ...base, state: "carrying_balance" };
}
