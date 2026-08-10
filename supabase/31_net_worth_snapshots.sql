-- Net worth trend chart. Unlike per-account balance history
-- (accountHistory.js), net worth can't be reconstructed purely from
-- expenses/account_activity - a STANDALONE asset/liability (investment,
-- property, vehicle, retirement types, standalone loans) has no delta
-- trail at all, since editing one writes straight to value/balance with
-- no account_activity row (only account-linked ones get that). A real
-- snapshot table is genuinely necessary here, unlike per-account balance
-- history's case.
--
-- Populated client-side, once per calendar day, on app load
-- (snapshotNetWorthIfNeeded, app.js) - no cron/server trigger exists for
-- a static PWA, so "the user opened the app today" is what drives a
-- snapshot. This means a day the app was never opened has no snapshot -
-- an honest gap rather than a fabricated backfilled value, consistent
-- with this app's general preference for explicit real data over guesses.
create table if not exists net_worth_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  snapshot_date  date not null,
  assets_total   numeric(14,2) not null,
  liabilities_total numeric(14,2) not null,
  net_worth      numeric(14,2) not null,
  created_at     timestamptz default now(),
  unique (user_id, snapshot_date)
);
create index if not exists net_worth_snapshots_user_date_idx on net_worth_snapshots (user_id, snapshot_date);

alter table net_worth_snapshots enable row level security;
drop policy if exists "own net_worth_snapshots" on net_worth_snapshots;
create policy "own net_worth_snapshots" on net_worth_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
