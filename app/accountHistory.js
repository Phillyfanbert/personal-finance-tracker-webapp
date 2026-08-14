// ============================================================================
// Per-account balance history.
// Pure, unit-testable. No new table/migration: every balance change an
// account has ever had is already fully reconstructable from `expenses` +
// `account_activity`, since this app's whole asset/liability-delta model
// already requires every mutation to be a real, dated row - so
// walking backward from the current balance recovers the exact history
// rather than needing a separate snapshot table to duplicate it.
// ============================================================================

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Reconstructs a day-by-day balance series for one account, working
 * backward from its current balance. Covers every path a balance can move
 * through today:
 *  - `expenses` against this account (asset: -amount, liability: +amount)
 *  - `asset_adjust` activity on this account (already a signed delta)
 *  - `liability_payment` activity where this account funded the payment
 *    (-amount, money left an asset account) or was the debt paid down
 *    (-amount, less owed on a liability account) - never both for the same
 *    row, since a funding account is always asset-linked and a debt
 *    account is always liability-linked.
 * A standalone liability (no linked account, manual "Owed" editing) never
 * reaches this function at all - it isn't in `accounts`, so it's out of
 * scope for a per-*account* history by construction.
 *
 * @returns [{date, balance}, ...] ascending, one point per date that had
 *   activity, plus a trailing "today" point if the most recent activity
 *   wasn't today (so the series visibly reaches the present).
 */
export function buildBalanceHistory(account, currentBalance, expenses, accountActivity, today = new Date()) {
  const isAsset = !!account.linked_asset_id;
  const isLiability = !!account.linked_liability_id;
  const deltasByDate = new Map();
  const add = (date, delta) => {
    if (!date) return;
    deltasByDate.set(date, (deltasByDate.get(date) || 0) + delta);
  };

  if (isAsset || isLiability) {
    for (const e of expenses) {
      if (e.account_id !== account.id) continue;
      add(e.occurred_at, isAsset ? -Number(e.amount) : Number(e.amount));
    }
    for (const a of accountActivity) {
      if (a.kind === "asset_adjust" && a.account_id === account.id) {
        add(a.occurred_at, Number(a.amount));
      } else if (a.kind === "liability_payment") {
        if (a.account_id === account.id) add(a.occurred_at, -Number(a.amount)); // funded from here
        if (a.related_account_id === account.id) add(a.occurred_at, -Number(a.amount)); // debt paid down
      }
    }
  }

  const datesDescending = [...deltasByDate.keys()].sort().reverse();
  const todayStr = today.toISOString().slice(0, 10);
  let running = Number(currentBalance);
  const points = [];
  if (!datesDescending.length || datesDescending[0] !== todayStr) points.push({ date: todayStr, balance: r2(running) });
  for (const date of datesDescending) {
    points.push({ date, balance: r2(running) });
    running -= deltasByDate.get(date);
  }
  return points.reverse();
}
