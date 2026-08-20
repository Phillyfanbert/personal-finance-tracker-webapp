-- Tracks the outcome of the LAST run of each server-side search agent
-- (deal-agent.js, price-agent.js) so the client can show a freshness
-- indicator and a clear warning when a run degraded from a rate limit or
-- other API failure. Before this, that information only ever existed in a
-- plain-text log file on the server machine
-- (/tmp/com.deal-agent.weekly.log etc, set by tools/setup-server-machine.sh)
-- that only someone with SSH access to that machine could ever see -
-- invisible to any other signed-in user of the app. One row per agent,
-- upserted every run (not an insert-only history table like
-- asset_price_findings - the UI only needs "how fresh is this right now,"
-- not a run history).
create table if not exists agent_run_status (
  agent              text primary key check (agent in ('deal-agent', 'price-agent')),
  status             text not null check (status in ('ok', 'degraded', 'failed')),
  detail             text,              -- short human-readable reason, only set when degraded/failed
  queries_attempted  integer,
  queries_failed     integer,
  ran_at             timestamptz not null default now()
);

-- Not user-owned data - a run's outcome is the same fact for every signed-
-- in user, same reasoning market_index_findings already uses. Read-only
-- for authenticated; only service_role writes it.
grant select on agent_run_status to authenticated;
grant select, insert, update, delete on agent_run_status to service_role;

alter table agent_run_status enable row level security;
drop policy if exists "read agent_run_status" on agent_run_status;
create policy "read agent_run_status" on agent_run_status
  for select using (auth.role() = 'authenticated');
