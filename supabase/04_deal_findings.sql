-- ============================================================================
-- Live deal discovery - a background search agent.
-- Run this after 01-03. Optional: the app works fine with this table empty
-- or unapplied until the home-machine search agent exists (Phase B/C).
--
-- Separate trust tier from subscription_catalog: machine-found, not curated.
-- No user_id - a deal ("Spotify student = $5.99") is a public fact, matched
-- to the user client-side against their own subscriptions.
-- ============================================================================
create table if not exists deal_findings (
  id            uuid primary key default gen_random_uuid(),
  service       text not null,                 -- 'Spotify'
  plan_type     text,                          -- 'student'|'annual'|'family'|'individual'
  price         numeric(12,2),
  currency      text default 'USD',
  eligibility   text,                          -- 'verified student', ...
  url           text,                          -- source page (provenance)
  source_query  text,                          -- the search query used
  raw_snippet   text,                          -- text the price came from (for human review)
  confidence    numeric(3,2),                  -- 0..1 from the extractor
  extracted_by  text default 'gemma',
  status        text check (status in ('candidate','verified','rejected')) default 'candidate',
  found_at      timestamptz default now(),
  expires_at    timestamptz default (now() + interval '14 days')  -- findings age out
);
create index if not exists deal_findings_service_status_idx on deal_findings (service, status);

grant select on deal_findings to authenticated;

alter table deal_findings enable row level security;
drop policy if exists "read deal_findings" on deal_findings;
create policy "read deal_findings" on deal_findings
  for select using (auth.role() = 'authenticated' and status <> 'rejected');
-- No insert/update/delete policy → the anon/PWA client can never write.
-- Only the home-machine agent, using the service_role key (never shipped in
-- the PWA), can write findings - bypasses RLS by design, server-side only.
