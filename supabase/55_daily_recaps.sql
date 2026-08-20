-- One stored recap per trading day: the day's biggest movers, each with a
-- real, linked headline, plus market breadth and the index proxies' moves.
--
-- Stage 1 of the daily-recap feature and deliberately ZERO-LLM: every
-- number comes from daily_prices (54_daily_prices.sql) and every headline
-- from Finnhub's free /company-news output already stored on
-- market_index_findings.headlines. Nothing here touches Gemini, so unlike
-- market_news_findings - which has never held a single row, because its
-- one Gemini call always lost the race for a 20-request DAILY quota shared
-- with deal-agent - this cannot be rate-limited out of existence.
--
-- `summary` is the seam for stage 2: one batched Gemini call, after close,
-- reading the movers and headlines below to write a short synthesis. It
-- stays null until then, and the card renders fully without it. That
-- ordering is the point - the fragile dependency becomes an optional
-- enhancement on top of a complete recap, rather than the thing the whole
-- card depends on.
--
-- Why a stored snapshot rather than computing this client-side: the
-- headlines live on the findings tables, which purgeExpiredFindings()
-- trims to 48 hours. Without capturing them per day here, a recap older
-- than two days could never show its own sources again.
--
-- Not user-scoped, same reasoning as daily_prices/market_index_findings: a
-- day's market activity is a public fact with no owner. Never purged.
create table if not exists daily_recaps (
  -- One row per trading day, upserted rather than appended, so a re-run
  -- (or stage 2 adding `summary` later the same day) refines the existing
  -- row instead of creating a second recap for one date.
  trade_date   date primary key,
  -- [{symbol, close, change, change_pct, headline: {title, url, source}|null}]
  -- Read and written as one cohesive set, never filtered per-element, which
  -- is the same test market_news_findings.headlines already passes for
  -- being a reasonable jsonb column rather than a child table.
  movers       jsonb not null,
  -- {up, down, flat, total} across the tracked movers watchlist.
  breadth      jsonb,
  -- [{symbol, change_pct}] for the index ETF proxies (SPY/DIA/QQQ/IWM).
  index_moves  jsonb,
  -- Stage 2 only. Null for every stage-1 row.
  summary      text,
  -- 'rollup' for zero-LLM stage 1; stage 2 writes 'rollup+gemini' so a row
  -- always states honestly how it was produced.
  generated_by text not null default 'rollup',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists daily_recaps_date_idx on daily_recaps (trade_date desc);

grant select on daily_recaps to authenticated;
-- Both roles explicitly - neither is automatic, and missing grants have
-- caused two separate real production failures here already.
grant select, insert, update, delete on daily_recaps to service_role;

alter table daily_recaps enable row level security;
drop policy if exists "read daily_recaps" on daily_recaps;
create policy "read daily_recaps" on daily_recaps
  for select using (auth.role() = 'authenticated');

-- The recap runs as its own scheduled job (weekdays after the close), so
-- it needs its own agent_run_status row - without this the existing CHECK
-- rejects the write and every run would look silently statusless.
alter table agent_run_status drop constraint if exists agent_run_status_agent_check;
alter table agent_run_status add constraint agent_run_status_agent_check
  check (agent in ('deal-agent', 'price-agent', 'price-agent-fast', 'daily-recap'));
