-- Target-allocation calculator (Investments tab) - a self-set target mix
-- the app measures the user's actual holdings against, same shape budgets
-- (32_budgets.sql) already uses for "set a per-category limit, show
-- current vs. target." Deliberately just a calculator: nothing here ever
-- feeds a "buy this" recommendation - target_percent and the current
-- allocation are only ever shown back to the user as numbers, per an
-- explicit decision not to build personalized investment advice.
create table if not exists investment_targets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  bucket         text not null,
  target_percent numeric(5,2) not null,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (user_id, bucket)
);

alter table investment_targets enable row level security;
drop policy if exists "own investment_targets" on investment_targets;
create policy "own investment_targets" on investment_targets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- touch_updated_at() already exists (25_touch_updated_at_trigger.sql).
drop trigger if exists investment_targets_touch_updated_at on investment_targets;
create trigger investment_targets_touch_updated_at
  before update on investment_targets
  for each row execute function touch_updated_at();

-- Purely a reference label the user sets for themselves (e.g. "Aggressive"/
-- "Moderate"/"Conservative") - no calculation anywhere reads this column,
-- same advice-free boundary as investment_targets above. Free text, no
-- CHECK constraint, consistent with this app's other free-typed labels.
alter table profiles add column if not exists risk_label text;
