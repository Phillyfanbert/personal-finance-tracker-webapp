-- Daily general market news digest + overall sentiment - genuinely
-- separate from market_index_findings (per-symbol index levels) and
-- distinct from a per-stock "why did this move" explanation
-- (asset_price_findings.explanation). The headlines are always read and
-- written together as one cohesive set (no independent per-headline
-- filtering, status, or expiry), so this is stored as one row per run
-- with the headline list as jsonb rather than normalized to one row per
-- headline the way market_index_findings does per-symbol - the first
-- jsonb column in this schema, a deliberate fit for this shape rather
-- than precedent-setting for everything else.
--
-- Same free (no-card) Tavily+Gemini pipeline as the rest of live pricing
-- (tools/price-agent.js), gated by the same PRICE_FINDINGS_ENABLED flag.
-- Insert-only with expires_at, mirroring market_index_findings/
-- asset_price_findings - NOT upsert-per-run like agent_run_status, since
-- a news digest has real value as history, unlike run metadata where only
-- "how fresh is this right now" matters.
--
-- sentiment is a plain read of what the day's real news coverage says,
-- grounded in the actual headlines/URLs stored alongside it - never
-- treated as a prediction or a recommendation (enforced in the
-- extraction prompt itself, not just the UI copy).
create table if not exists market_news_findings (
  id                uuid primary key default gen_random_uuid(),
  headlines         jsonb not null default '[]'::jsonb,  -- [{ "title": text, "url": text, "source": text|null }, ...] (up to 5)
  sentiment         text check (sentiment in ('bullish','neutral','bearish')),
  sentiment_reason  text,
  source_query      text,
  confidence        numeric(3,2),
  extracted_by      text default 'gemini',
  found_at          timestamptz default now(),
  expires_at        timestamptz default (now() + interval '2 days')
);
create index if not exists market_news_findings_found_at_idx on market_news_findings (found_at desc);

-- Not user-owned data - a day's market news is the same fact for every
-- signed-in user, same reasoning market_index_findings already uses.
-- Both grants written from the start, per the durable rule
-- 47_fix_missing_service_role_grants.sql established: RLS alone is never
-- sufficient, a new table needs an explicit grant for every role that
-- touches it.
grant select on market_news_findings to authenticated;
grant select, insert, update, delete on market_news_findings to service_role;

alter table market_news_findings enable row level security;
drop policy if exists "read market_news_findings" on market_news_findings;
create policy "read market_news_findings" on market_news_findings
  for select using (auth.role() = 'authenticated');
