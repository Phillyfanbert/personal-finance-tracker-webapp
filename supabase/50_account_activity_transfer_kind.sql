-- Adds 'transfer' to account_activity's allowed kinds - moving money
-- between two of the user's own asset-backed accounts (Checking ->
-- Savings, etc.), a genuinely new first-class action distinct from every
-- existing kind: not an expense, not a liability payment (both assets on
-- either side, no liability involved), not a manual correction. Same
-- drop/re-add pattern 39_account_activity_kinds.sql and
-- 42_contribution_tracking.sql already established for adding a kind.
--
-- account_id (existing column) is the funding/"from" side, related_account_id
-- (existing column) is the "to" side - mirrors exactly how liability_payment
-- already uses account_id = funding account / related_account_id = the
-- liability's own account, so recentTransactions()'s existing account
-- filter (which already matches on either column) picks up a transfer
-- for both accounts involved with no code changes needed there.
alter table account_activity drop constraint account_activity_kind_check;
alter table account_activity add constraint account_activity_kind_check
  check (kind in ('asset_adjust','liability_payment','owed_adjust','account_created','contribution','transfer'));
