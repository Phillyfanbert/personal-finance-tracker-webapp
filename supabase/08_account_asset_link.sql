-- ============================================================================
-- Optional link from an Account (payment method) to an Asset (net-worth item).
-- Lets the app know which asset a non-credit expense should be deducted
-- from, e.g. the "Chase Checking" account -> the "Chase Checking" asset.
-- Nullable: an account with no linked asset just means expenses tagged with
-- it never touch net worth (unchanged prior behavior).
-- ============================================================================
alter table accounts add column if not exists linked_asset_id uuid references assets(id) on delete set null;
