-- ============================================================================
-- Mirrors accounts_one_cash_per_user (09_cash_account.sql): the Cash asset
-- is auto-created by ensureCashAccount() and adjusted via the Cash +/-
-- panel, never manually added. This is the DB-level backstop against a
-- second "Cash" asset being created through the Assets form.
-- ============================================================================
create unique index if not exists assets_one_cash_per_user
  on assets (user_id)
  where type = 'cash';
