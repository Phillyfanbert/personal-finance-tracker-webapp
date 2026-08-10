-- ============================================================================
-- Personal Expense Tracker - Phase 0 Row-Level Security  (README §3.3 / §3.4)
-- Run this SECOND, after 01_schema.sql.
--
-- This is THE privacy core. With RLS off, anyone holding your project URL +
-- public anon key can read every row. Default to deny; allow only own rows.
-- Safe to re-run: policies are dropped-if-exists before create.
-- ============================================================================

-- 1. Enable RLS on every user-owned table -----------------------------------
alter table profiles       enable row level security;
alter table accounts       enable row level security;
alter table expenses       enable row level security;
alter table category_rules enable row level security;
alter table subscriptions  enable row level security;
alter table subscription_catalog enable row level security;

-- 2. Own-row policies --------------------------------------------------------
-- Profiles: the row's id IS the user id.
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- All other user tables: match on user_id.
drop policy if exists "own accounts" on accounts;
create policy "own accounts" on accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own expenses" on expenses;
create policy "own expenses" on expenses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rules" on category_rules;
create policy "own rules" on category_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions" on subscriptions;
create policy "own subscriptions" on subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Catalog is shared reference data: readable by any signed-in user,
-- writable by nobody via the API (no insert/update/delete policy = denied).
drop policy if exists "read catalog" on subscription_catalog;
create policy "read catalog" on subscription_catalog
  for select using (auth.role() = 'authenticated');

-- 3. Auto-create a profile row on sign-up ------------------------------------
-- Trigger on auth.users so every new user gets a matching profiles row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- RLS rules to live by (README §3.3):
--   * The service_role key bypasses RLS entirely - keep it SERVER-SIDE ONLY,
--     never in the PWA. The PWA uses only the anon key.
--   * "using" filters visible rows; "with check" validates inserts/updates -
--     both are set above.
--   * Test with TWO accounts before trusting it (see SETUP.md §6).
-- ============================================================================
