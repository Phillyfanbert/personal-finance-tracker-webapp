-- ============================================================================
-- Assets + liabilities (net-worth overview on the Log page).
-- Standard per-user RLS, same pattern as accounts/expenses/subscriptions -
-- this is personal financial data, owned and readable only by its user.
-- ============================================================================
create table if not exists assets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,                 -- 'Chase Checking', 'Vanguard Brokerage', 'Honda Civic'
  type        text not null check (type in ('cash','bank','investment','property','vehicle','other')),
  value       numeric(12,2) not null,
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- "liabilities" here means tracked debts (credit cards, loans, mortgages) -
-- the OTHER kind of liability, distinct from subscriptions/expenses which
-- are computed live from their own tables on the Log page, not stored here.
create table if not exists liabilities (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name              text not null,           -- 'Chase Sapphire', 'Student Loan'
  type              text not null check (type in ('credit_card','loan','mortgage','other')),
  balance           numeric(12,2) not null,
  interest_rate     numeric(5,2),            -- APR %, optional
  minimum_payment   numeric(12,2),           -- optional
  due_date          date,                    -- optional next payment due date
  notes             text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

grant select, insert, update, delete on assets, liabilities to authenticated;

alter table assets enable row level security;
drop policy if exists "own assets" on assets;
create policy "own assets" on assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table liabilities enable row level security;
drop policy if exists "own liabilities" on liabilities;
create policy "own liabilities" on liabilities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
