-- One row per symbol per trading day, retained indefinitely - the durable
-- price history the Investments tab's per-symbol charts need.
--
-- Genuinely a different concept from asset_price_findings/
-- market_index_findings, which are an insert-only stream of individual
-- observations bounded by expires_at (found_at + 2 days) and purged by
-- price-agent.js's purgeExpiredFindings(). That purge is correct for a
-- stream - every reader already filters on expires_at - but it means no
-- price history older than 48 hours can survive there, which is exactly
-- what a 1M/6M/1Y chart needs. This table is the rollup that outlives it,
-- and is deliberately NOT in PURGEABLE_TABLES.
--
-- Costs nothing extra to populate: Finnhub's /quote response already
-- carries o/h/l/c/pc on every call the agent makes, and validateFinnhubQuote()
-- was keeping only `c` and discarding a complete daily candle ~2,300 times
-- a day. /stock/candle (the real historical endpoint) is premium and 403s
-- on a free key, so accumulating our own is the only $0 route to this.
--
-- Not user-scoped, same reasoning as market_index_findings
-- (43_market_index_findings.sql): a symbol's price on a given day is a
-- public fact with no owner, identical for every user, never derived from
-- anyone's own assets.
create table if not exists daily_prices (
  symbol         text not null,
  -- The TRADING day, derived from Finnhub's own quote timestamp in
  -- America/New_York - never the server's current date. A run on Saturday
  -- gets Friday's still-current quote back, and keying that to "today"
  -- would invent a weekend candle that never traded.
  trade_date     date not null,
  open           numeric(14,4),
  high           numeric(14,4),
  low            numeric(14,4),
  -- The only guaranteed column: `o`/`h`/`l` can be absent or zero on a
  -- thinly traded symbol, and rows backfilled from the findings stream
  -- below have a close and nothing else.
  close          numeric(14,4) not null,
  previous_close numeric(14,4),
  updated_at     timestamptz default now(),
  -- Upsert target: every run re-writes the current day's row, so `close`
  -- tracks the latest price and settles on the real close once the
  -- session ends. Finnhub maintains h/l as running day extremes itself,
  -- so no aggregation is needed on our side.
  primary key (symbol, trade_date)
);

create index if not exists daily_prices_symbol_date_idx on daily_prices (symbol, trade_date desc);

grant select on daily_prices to authenticated;
-- Both roles explicitly - neither is automatic, and missing grants have
-- caused two separate real production failures here already
-- (44_fix_missing_grants.sql, 47_fix_missing_service_role_grants.sql).
grant select, insert, update, delete on daily_prices to service_role;

alter table daily_prices enable row level security;
drop policy if exists "read daily_prices" on daily_prices;
create policy "read daily_prices" on daily_prices
  for select using (auth.role() = 'authenticated');

-- Seed from the intraday findings still inside the 2-day window, so the
-- chart starts with real history instead of nothing. Close only: those
-- rows never carried o/h/l, which is the whole reason this table exists.
-- Weekends are excluded (isodow 6/7) to match the agent's own behavior -
-- a Saturday finding is just Friday's close fetched again, not a real
-- trading day. Market holidays aren't filtered here; a handful of flat
-- backfilled days is a fair trade against hardcoding a holiday list that
-- would go stale, the same call marketStatus() already makes.
insert into daily_prices (symbol, trade_date, close)
select distinct on (symbol, (found_at at time zone 'America/New_York')::date)
  symbol,
  (found_at at time zone 'America/New_York')::date as trade_date,
  price
from (
  select symbol, found_at, price from market_index_findings
  where price is not null and extracted_by = 'finnhub'
  union all
  select symbol, found_at, price from asset_price_findings
  where price is not null and extracted_by = 'finnhub'
) s
where extract(isodow from (found_at at time zone 'America/New_York')) < 6
order by symbol, (found_at at time zone 'America/New_York')::date, found_at desc
on conflict (symbol, trade_date) do nothing;
