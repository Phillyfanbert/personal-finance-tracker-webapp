-- ============================================================================
-- Personal Expense Tracker - Phase 0 Schema
-- Run this FIRST in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Mirrors README §3.2. Safe to re-run: uses "if not exists" where possible.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto; Supabase enables it by default, but be safe.
create extension if not exists pgcrypto;

-- PROFILES: one row per user, keyed to the auth user id --------------------
create table if not exists profiles (
  id              uuid primary key references auth.users on delete cascade,
  display_name    text,
  status          text check (status in ('working','student','other')) default 'other',
  school          text,
  graduation_year int,
  notes           text,
  created_at      timestamptz default now()
);

-- ACCOUNTS: payment sources (Chase checking, Amex, cash, ...) ---------------
create table if not exists accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  type        text check (type in ('checking','credit','debit','cash','other')) not null,
  last_four   text,
  created_at  timestamptz default now()
);

-- EXPENSES ------------------------------------------------------------------
create table if not exists expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  amount        numeric(12,2) not null,
  currency      text default 'USD',
  description   text,
  merchant      text,
  category      text,
  payment_type  text check (payment_type in ('credit','debit','cash')),
  account_id    uuid references accounts on delete set null,
  occurred_at   date not null default current_date,
  raw_input     text,                  -- original natural-language text
  source        text default 'manual', -- 'manual' | 'parsed'
  created_at    timestamptz default now()
);

-- CATEGORY RULES: learned from user corrections (keyword -> category) --------
create table if not exists category_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  keyword    text not null,
  category   text not null,
  created_at timestamptz default now(),
  unique (user_id, keyword)
);

-- SUBSCRIPTIONS -------------------------------------------------------------
create table if not exists subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  name          text not null,
  amount        numeric(12,2) not null,
  billing_cycle text check (billing_cycle in ('monthly','annual','other')) default 'monthly',
  account_id    uuid references accounts on delete set null,
  next_renewal  date,
  is_active     boolean default true,
  notes         text,
  created_at    timestamptz default now()
);

-- SUBSCRIPTION CATALOG: shared reference data powering discount discovery ----
create table if not exists subscription_catalog (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,          -- 'Spotify'
  plan_type   text not null,          -- 'student' | 'annual' | 'family' | 'individual'
  price       numeric(12,2),
  eligibility text,                   -- 'verified student', 'up to 6 members', ...
  url         text,
  notes       text,
  unique (service, plan_type)         -- lets 03_seed's ON CONFLICT DO NOTHING work
);

-- Indexes -------------------------------------------------------------------
create index if not exists idx_expenses_user_date on expenses (user_id, occurred_at);
create index if not exists idx_subscriptions_user_active on subscriptions (user_id, is_active);
create index if not exists idx_accounts_user on accounts (user_id);
create index if not exists idx_category_rules_user on category_rules (user_id);
