-- ============================================================================
-- Contribution-limit tracking for investment accounts (docs/bank-account-
-- types-research.md §9b.6).
--
-- 'contribution' - a new account_activity kind for money added to an
-- investment account that the user explicitly logged as a contribution
-- (not a market gain, not a correction) - the distinction the app
-- previously had no way to make at all. Deliberately separate from
-- 'asset_adjust': that kind already means "the balance changed," with no
-- opinion on why, and retrofitting a "was this a contribution" flag onto
-- it would have meant walking every existing asset_adjust reader to handle
-- a new optional meaning. amount is a plain positive number - a
-- contribution only ever adds money in, unlike asset_adjust's signed delta
-- (which also has to represent taking money out or a direct "set").
--
-- asset_id - the actual gap this closes. account_activity was built around
-- `accounts` (account_id/related_account_id), but most investment assets in
-- this app are STANDALONE (STANDALONE_ONLY_ASSET_CATEGORIES, app.js) - no
-- linked account at all, so account_id has nothing to point at. Without
-- asset_id there would be no way to know WHICH investment asset a
-- contribution belongs to, and therefore no way to sum this year's
-- contributions per account for the limit check this whole migration
-- exists for. Sets null (not delete) if the asset is later removed, same
-- pattern every other FK on this table already uses - a contribution
-- that's no longer attributable to anything simply stops counting toward
-- any limit, it doesn't need to vanish from history.
-- ============================================================================
alter table account_activity drop constraint account_activity_kind_check;
alter table account_activity add constraint account_activity_kind_check
  check (kind in ('asset_adjust','liability_payment','owed_adjust','account_created','contribution'));

alter table account_activity add column if not exists asset_id uuid references assets(id) on delete set null;

create index if not exists idx_account_activity_asset on account_activity (asset_id);
