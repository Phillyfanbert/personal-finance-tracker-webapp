-- Per-category budgets. A single ongoing monthly limit per category, not
-- a per-month-varying budget -
-- the simpler "I want to spend no more than $X/month on Food" model,
-- applied every month until changed, matching how most simple budgeting
-- tools work. unique(user_id, category) - at most one budget per category.
create table if not exists budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  category      text not null,
  monthly_limit numeric(12,2) not null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (user_id, category)
);

alter table budgets enable row level security;
drop policy if exists "own budgets" on budgets;
create policy "own budgets" on budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- touch_updated_at() already exists (25_touch_updated_at_trigger.sql).
drop trigger if exists budgets_touch_updated_at on budgets;
create trigger budgets_touch_updated_at
  before update on budgets
  for each row execute function touch_updated_at();
