-- ============================================================================
-- F6 stretch - official-domain allowlist for the live deal-search agent
-- (an allowlist-first design decision).
--
-- Pure operational config for the home-machine agent - the PWA never reads
-- this table. RLS is enabled with NO policies at all (default deny), so even
-- authenticated app users get zero rows; only the agent's service_role key
-- (bypasses RLS, home machine only, never shipped in the PWA) can read/write.
--
-- Maintenance model: one row per service the agent is allowed to search for.
-- A service in the subscription watchlist with no row here is skipped by the
-- agent (logged, not guessed) - add a row here when you see that happen.
-- ============================================================================
create table if not exists service_domains (
  service   text primary key,          -- must match subscription_catalog.service exactly
  domains   text[] not null,           -- one or more official domains, e.g. '{spotify.com}'
  notes     text,
  created_at timestamptz default now()
);

alter table service_domains enable row level security;
-- Deliberately no policies - default deny for anon and authenticated alike.
-- Only service_role (bypasses RLS) touches this table.

-- Seed the services already in 03_seed.sql's subscription_catalog.
insert into service_domains (service, domains) values
  ('Spotify',        '{spotify.com}'),
  ('YouTube Premium', '{youtube.com}'),
  ('Adobe CC',        '{adobe.com}'),
  ('Netflix',         '{netflix.com}'),
  ('iCloud+',         '{apple.com}'),
  ('Amazon Prime',    '{amazon.com}')
on conflict (service) do nothing;
