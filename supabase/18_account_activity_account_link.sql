-- ============================================================================
-- account_activity never recorded WHICH account a balance change applied
-- to, only a human-readable description - so filtering Recent Transactions
-- by a specific account (app.js) could never surface a manual balance
-- adjustment or a liability payment, even though it obviously happened on
-- that account. Found live: adjusting Cash's balance, then filtering
-- Recent Transactions to the Cash account, showed nothing.
--
-- account_id is the account whose own balance directly changed:
--   - asset_adjust: the account being adjusted (single account, no
--     ambiguity).
--   - liability_payment: the asset's account - the source the money
--     actually left, mirroring how expenses.account_id already means
--     "the account used to make this happen."
-- related_account_id is only ever set for liability_payment, and only
-- when the liability being paid down is itself account-linked (a credit
-- card, not a standalone Loan/Mortgage/Other) - so paying off a credit
-- card shows up when filtering by either the funding account or the card
-- itself. Both set null (not delete) if the referenced account is later
-- removed, same as expenses.account_id already does.
-- ============================================================================
alter table account_activity add column if not exists account_id uuid references accounts(id) on delete set null;
alter table account_activity add column if not exists related_account_id uuid references accounts(id) on delete set null;

create index if not exists idx_account_activity_account on account_activity (account_id);
