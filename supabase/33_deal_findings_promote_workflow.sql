-- Review/promote workflow (Profile & Discount
-- Discovery feature). Both tables
-- were deliberately read-only from the client until now (see
-- 02_rls.sql/04_deal_findings.sql's own comments: "writable by nobody via
-- the API", "no insert/update/delete policy -> the anon/PWA client can
-- never write") - this is that comment becoming outdated on purpose, the
-- exact evolution the proposal doc's own Phase E already described:
-- "A future review screen lets the user promote a good finding into the
-- curated catalog."
--
-- Neither table has a user_id column (both are genuinely shared/global
-- reference data, not per-user), so these policies apply to any
-- authenticated user of the app, same shape subscription_catalog's
-- existing read policy already has - acceptable for this app's small,
-- trusted ~2-user scope.
drop policy if exists "promote to catalog" on subscription_catalog;
create policy "promote to catalog" on subscription_catalog
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "review deal_findings" on deal_findings;
create policy "review deal_findings" on deal_findings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
