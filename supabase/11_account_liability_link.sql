-- ============================================================================
-- Optional link from a credit Account to a Liability (tracked debt) - the
-- credit-side mirror of accounts.linked_asset_id. A credit-card charge
-- tagged with a linked account now accumulates onto that card's running
-- balance instead of only showing as a monthly expense figure.
-- ============================================================================
alter table accounts add column if not exists linked_liability_id uuid references liabilities(id) on delete set null;
