-- Vehicle depreciation (a straight-line estimate -
-- a formula, not a search agent). All nullable - an asset with no
-- purchase info just keeps behaving as it does today (a static,
-- manually-set value). Net worth uses the live-computed estimate when
-- all three are present (effectiveAssetValue, app/depreciation.js), not
-- the stored value column, per explicit user confirmation - no "sync
-- now" step, no periodic write-back.
alter table assets add column if not exists purchase_price numeric(12,2);
alter table assets add column if not exists purchase_date date;
alter table assets add column if not exists depreciation_rate numeric(5,4); -- e.g. 0.15 = 15%/year
