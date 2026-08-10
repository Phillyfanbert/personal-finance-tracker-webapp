-- Live-priced asset values, built on the same dormant SearXNG+Gemma
-- pipeline as F6's deal_findings (04_deal_findings.sql)
-- rather than a paid price API, per explicit user choice - the $0/no-card
-- constraint (README 1.4) rules out virtually every real market-data API.
--
-- price_symbol is new: without it there's nothing well-defined to search
-- for - a brokerage/crypto/retirement asset today is just a free-text name
-- and a manually-entered dollar value, no ticker/symbol concept existed at
-- all before this. Optional, no CHECK tying it to a specific type, same
-- looseness maturity_date/purchase_price already have for their own types.
alter table assets add column if not exists price_symbol text;

-- Same trust-tier shape as deal_findings: no user_id (a symbol's price is
-- a public fact, not user-specific - matched client-side against each
-- user's own assets.price_symbol, same as deal_findings matches services),
-- candidate/verified/rejected status, RLS read-only for authenticated
-- users, no insert/update/delete policy so only the agent's service_role
-- key (never shipped in the PWA) can write. expires_at is much shorter
-- than deal_findings' 14 days - a stock/crypto price goes stale in hours,
-- not weeks.
create table if not exists asset_price_findings (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null,                 -- 'AAPL', 'BTC', 'VTSAX'
  price         numeric(14,4),
  currency      text default 'USD',
  url           text,                          -- source page (provenance)
  source_query  text,                          -- the search query used
  raw_snippet   text,                          -- text the price came from (for human review)
  confidence    numeric(3,2),                  -- 0..1 from the extractor
  extracted_by  text default 'gemma',
  status        text check (status in ('candidate','verified','rejected')) default 'candidate',
  found_at      timestamptz default now(),
  expires_at    timestamptz default (now() + interval '2 days')
);
create index if not exists asset_price_findings_symbol_status_idx on asset_price_findings (symbol, status);

grant select on asset_price_findings to authenticated;

alter table asset_price_findings enable row level security;
drop policy if exists "read asset_price_findings" on asset_price_findings;
create policy "read asset_price_findings" on asset_price_findings
  for select using (auth.role() = 'authenticated' and status <> 'rejected');
