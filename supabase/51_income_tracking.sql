-- Recurring income source tracking - a genuinely new concept, the app
-- previously had zero income tracking at all (only expenses and account
-- balances). Shaped closely like `subscriptions` on purpose (source/
-- amount/cadence/account_id/next_expected/is_active/notes), same "a
-- recurring definition, confirmed into a real logged event when due" split
-- autoLogDueSubscriptions() already established - see autoLogDueIncome()
-- (app.js) and advanceIncomeDate() (app/income.js) for the logging side.
--
-- cadence intentionally does NOT reuse subscriptions.billing_cycle's values
-- (monthly/quarterly/semiannual/annual/other) - real paycheck cadences are
-- a different domain (weekly/biweekly are fixed day-count intervals, not
-- calendar-month cycles). semimonthly is its own special case: two FIXED
-- calendar days per month (e.g. 1st & 15th), not a fixed day-count
-- interval the way biweekly is - resolved directly with the user before
-- building this, rather than assuming a simpler "every ~15 days"
-- approximation, since that would drift off the real payday over time.
-- semimonthly_day_1/2 are only used when cadence = 'semimonthly'; a value
-- of 29/30/31 clamps to the real last day of a shorter month, same
-- convention addMonthsISO() (payoff.js) already uses.
create table if not exists income (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users on delete cascade,
  source              text not null,
  amount              numeric(12,2) not null,
  cadence             text not null default 'monthly'
                       check (cadence in ('weekly','biweekly','semimonthly','monthly','annual','one_time')),
  semimonthly_day_1   integer check (semimonthly_day_1 between 1 and 31),
  semimonthly_day_2   integer check (semimonthly_day_2 between 1 and 31),
  account_id          uuid references accounts(id) on delete set null,
  next_expected       date,
  is_active           boolean not null default true,
  notes               text,
  created_at          timestamptz default now()
);

-- Both grants required from the start, per the durable rule
-- 44_fix_missing_grants.sql/47_fix_missing_service_role_grants.sql
-- established (RLS alone is never sufficient - two real production bugs
-- came from skipping one or the other).
grant select, insert, update, delete on income to authenticated;
grant select, insert, update, delete on income to service_role;

alter table income enable row level security;
drop policy if exists "income owner" on income;
create policy "income owner" on income for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Adds 'income' to account_activity's allowed kinds - a received paycheck
-- gets logged here (applyAssetDelta(+1) + logActivity("income", ...)),
-- distinct from asset_adjust for the same reason 'contribution' already
-- is (42_contribution_tracking.sql): so "real income received" can be
-- told apart from a market gain or a manual correction, which matters for
-- an accurate income-vs-expense report and savings rate.
alter table account_activity drop constraint account_activity_kind_check;
alter table account_activity add constraint account_activity_kind_check
  check (kind in ('asset_adjust','liability_payment','owed_adjust','account_created','contribution','transfer','income'));
