-- Real bug found live: budgets, investment_targets, net_worth_snapshots,
-- and portfolio_snapshots all have a correct "for all using (auth.uid() =
-- user_id)" RLS policy, but were NEVER GRANTed base SELECT/INSERT/UPDATE/
-- DELETE privileges to the authenticated role at all (unlike account_
-- activity/assets/accounts/expenses/liabilities/subscriptions/profiles/
-- category_rules, which do have these). RLS only restricts which ROWS a
-- role can see/touch on top of privileges it already has - it never
-- grants privileges by itself. Without the base grant, every operation on
-- these 4 tables was denied by Postgres before RLS was ever evaluated
-- (a real "permission denied for table X" error, not a validation
-- message), and a SELECT failure was silently swallowed by app.js's
-- `const { data } = await sb.from(...).select(...)` (error ignored,
-- data defaults to null -> []), so the tables looked merely "empty," not
-- broken. This means the Investments tab's target-allocation save (user-
-- reported), its Value-over-time chart (portfolio_snapshots), the Reports
-- page's net-worth trend chart (net_worth_snapshots), and the whole
-- Budgets card have likely never actually worked end-to-end for the real
-- signed-in user since each was introduced (migrations 31, 32, 35, 36) -
-- exactly the kind of gap this repo's own "not verified against a real
-- signed-in session" caveat exists to flag. Not clear why these 4 never
-- got the grant other tables have; going forward every new user-owned
-- table's migration must include an explicit grant, not assume a default.
grant select, insert, update, delete on budgets to authenticated;
grant select, insert, update, delete on investment_targets to authenticated;
grant select, insert, update, delete on net_worth_snapshots to authenticated;
grant select, insert, update, delete on portfolio_snapshots to authenticated;
