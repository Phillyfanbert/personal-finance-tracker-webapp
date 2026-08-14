-- ============================================================================
-- Per-ticker holdings inside an investment account.
--
-- Until now one asset row WAS one holding, and price_symbol/quantity were
-- only reachable from the standalone-asset form - so an investment account
-- created from the Accounts card (a Brokerage, a Roth IRA) had no way to
-- record which stocks were actually bought in it. The account tracked a
-- single blended dollar value and nothing else.
--
-- Rather than a separate holdings table, a holding is still an `assets` row;
-- it just points at the account's own asset via parent_asset_id. That keeps
-- every existing code path working unchanged (a standalone ticker-tracked
-- asset simply has a null parent, exactly as before) and means the
-- Investments tab's gain/loss, day-change and allocation math in
-- investments.js needs no new data source - it already reads assets with a
-- price_symbol set.
--
-- The rule that makes this safe against double-counting net worth: a child
-- holding's value is NEVER counted on its own. app.js excludes any asset
-- with a parent_asset_id from the net-worth total and from the Assets card,
-- and instead keeps the parent's `value` maintained as the sum of its
-- holdings. So the account is worth what its positions are worth, counted
-- exactly once. Removing that exclusion would silently double every
-- invested dollar.
--
-- on delete cascade: deleting the account's asset deletes its holdings with
-- it. A holding has no meaning without the account it sits in, and leaving
-- orphans behind would resurrect the "asset that belongs to nothing" bug
-- 13_delete_asset_with_account.sql already had to fix once.
-- ============================================================================
alter table assets add column if not exists parent_asset_id uuid
  references assets(id) on delete cascade;

create index if not exists idx_assets_parent on assets (parent_asset_id);
