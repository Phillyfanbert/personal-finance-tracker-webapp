-- Every base table in public had zero SELECT/INSERT/UPDATE/DELETE granted
-- to service_role - only REFERENCES/TRIGGER/TRUNCATE, which do nothing for
-- normal server-side script use. Found live 2026-08-14 when deal-agent.js
-- (a real service_role-authenticated script) got a genuine Postgres
-- "permission denied for table subscriptions" (error 42501) on its very
-- first real production run - not an RLS denial, a missing base grant, the
-- same category of bug 44_fix_missing_grants.sql already fixed for
-- authenticated on a handful of tables. service_role bypasses RLS by
-- design (every server-side script in this repo - deal-agent.js,
-- price-agent.js, embed-expenses.js, monthly-report.js - depends on this
-- to read/write across all users' data), so granting broad CRUD here is
-- safe and matches its intended purpose; the role is never exposed
-- client-side, only ever read from a gitignored env file on the server
-- machine.
--
-- This means every server-side script in this repo has likely never
-- actually been able to read or write anything in production before this
-- migration, regardless of which script or which table - not a
-- table-specific gap.
grant select, insert, update, delete on public.account_activity to service_role;
grant select, insert, update, delete on public.accounts to service_role;
grant select, insert, update, delete on public.asset_price_findings to service_role;
grant select, insert, update, delete on public.assets to service_role;
grant select, insert, update, delete on public.budgets to service_role;
grant select, insert, update, delete on public.category_rules to service_role;
grant select, insert, update, delete on public.deal_findings to service_role;
grant select, insert, update, delete on public.expense_embeddings to service_role;
grant select, insert, update, delete on public.expenses to service_role;
grant select, insert, update, delete on public.investment_targets to service_role;
grant select, insert, update, delete on public.liabilities to service_role;
grant select, insert, update, delete on public.market_index_findings to service_role;
grant select, insert, update, delete on public.net_worth_snapshots to service_role;
grant select, insert, update, delete on public.portfolio_snapshots to service_role;
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.service_domains to service_role;
grant select, insert, update, delete on public.spending_insights to service_role;
grant select, insert, update, delete on public.subscription_catalog to service_role;
grant select, insert, update, delete on public.subscriptions to service_role;
