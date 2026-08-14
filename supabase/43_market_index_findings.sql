-- Daily market-index overview (S&P 500, NASDAQ, ...) - genuinely NOT tied
-- to anything a user owns, unlike asset_price_findings (always matched
-- against a user's own assets.price_symbol). Same dormant SearXNG+Gemma
-- pipeline (tools/price-agent.js), same $0-constraint reasoning
-- (26_asset_price_findings.sql) - a separate table rather than reusing
-- asset_price_findings because an index level has no owner and is always
-- the same fixed handful of symbols across every user (see MARKET_INDEXES,
-- app.js), not derived from anyone's assets.price_symbol. Column shape
-- deliberately mirrors asset_price_findings so tools/price-agent.js can
-- reuse its existing processSymbol()/findExplanation() pipeline unchanged,
-- just writing to this table instead for a fixed index watchlist.
create table if not exists market_index_findings (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null,                 -- 'S&P 500', 'NASDAQ Composite', ...
  price         numeric(14,4),
  currency      text default 'USD',
  url           text,
  source_query  text,
  raw_snippet   text,
  confidence    numeric(3,2),
  extracted_by  text default 'gemma',
  explanation   text,
  status        text check (status in ('candidate','verified','rejected')) default 'candidate',
  found_at      timestamptz default now(),
  expires_at    timestamptz default (now() + interval '2 days')
);
create index if not exists market_index_findings_symbol_status_idx on market_index_findings (symbol, status);

grant select on market_index_findings to authenticated;

alter table market_index_findings enable row level security;
drop policy if exists "read market_index_findings" on market_index_findings;
create policy "read market_index_findings" on market_index_findings
  for select using (auth.role() = 'authenticated' and status <> 'rejected');
