-- Investments tab trend chart. Same reasoning as net_worth_snapshots
-- (31_net_worth_snapshots.sql) - a static PWA has no cron/server trigger,
-- so a snapshot only ever happens because the app was actually opened
-- that day (snapshotPortfolioIfNeeded, app.js). A day it wasn't opened
-- just has no row - an honest gap, not a fabricated backfill. Kept as its
-- own table rather than folded into net_worth_snapshots since it tracks a
-- different, narrower concept (investments only, plus cost basis, which
-- net worth has no use for) and every existing net_worth_snapshots reader
-- (including the "download all my data" export) shouldn't have to learn
-- about an unrelated investments-only field.
create table if not exists portfolio_snapshots (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  snapshot_date    date not null,
  total_value      numeric(14,2) not null,
  total_cost_basis numeric(14,2) not null,
  created_at       timestamptz default now(),
  unique (user_id, snapshot_date)
);
create index if not exists portfolio_snapshots_user_date_idx on portfolio_snapshots (user_id, snapshot_date);

alter table portfolio_snapshots enable row level security;
drop policy if exists "own portfolio_snapshots" on portfolio_snapshots;
create policy "own portfolio_snapshots" on portfolio_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
