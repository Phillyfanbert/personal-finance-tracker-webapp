-- ============================================================================
-- Account activity log: non-expense money movements (asset balance
-- adjustments, liability payments) so the Log page's Recent Transactions
-- list can show them alongside real expenses. Deliberately separate from
-- `expenses` - the Reports "Monthly Expense Log" reads `expenses` only and
-- must stay that way (spending log, not every balance change).
-- Standard per-user RLS, same pattern as assets/liabilities.
-- ============================================================================
create table if not exists account_activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('asset_adjust','liability_payment')),
  description text not null,
  amount      numeric(12,2) not null,
  occurred_at date not null default current_date,
  created_at  timestamptz default now()
);

grant select, insert, update, delete on account_activity to authenticated;

alter table account_activity enable row level security;
drop policy if exists "own account_activity" on account_activity;
create policy "own account_activity" on account_activity
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_account_activity_user_date on account_activity (user_id, occurred_at);
