-- ============================================================================
-- Grants - run SECOND, between 01_schema.sql and 02_rls.sql.
-- Needed because "auto-expose new tables" is disabled on this project, so
-- tables aren't reachable via the Data API until explicitly granted.
-- RLS (02_rls.sql) still controls WHICH rows each user sees.
-- ============================================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete
  on profiles, accounts, expenses, category_rules, subscriptions
  to authenticated;
grant select on subscription_catalog to authenticated;