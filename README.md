# Personal Expense Tracker - Project Spec & Design Proposal

> A private, multi-user expense tracker with natural-language entry, automatic
> categorization, subscription monitoring, and monthly reports - built and
> deployed for **$0 with no credit card required anywhere**.

---

## Part 1 - Project Specifications

### 1.1 Goals (what the product does)

| # | Feature | Description |
|---|---------|-------------|
| F1 | Log & track expenses | Record new expenses and view existing ones. |
| F2 | Natural-language entry | Type free text like `$14 lunch chipotle debit` and have it parsed into a structured expense. |
| F3 | Auto-categorization | Assign a category (Food, Transport, Subscriptions, etc.) as the expense is entered. |
| F4 | Payment tracking | Record whether each expense is credit / debit / cash, and **which** account it came from (e.g. "Chase checking"). |
| F5 | Subscription monitoring | Track active subscriptions as a first-class category with renewal dates and amounts. |
| F6 | Discount discovery | Proactively surface cheaper subscription options - student plans, annual pricing, family plans - matched to the user's profile. |
| F7 | Monthly reports | Generate visualizations and a summary of the past month's spending. |

### 1.2 Users & privacy

- **Scale:** a small number of users (≈2). No need to design for scale.
- **Isolation:** each user sees **only their own** financial data. This is a hard requirement, enforced at the database layer (not just in app code).
- **Profiles:** each user has a profile capturing status (`working` / `student` / `other`) and any details that help match discounts (e.g. school, graduation year). Profile data feeds F6.

### 1.3 Platform & experience

- **Primary device:** iPhone. Entry must be fast and seamless on mobile.
- **Also usable** from a desktop/laptop browser.
- **Installability:** launches from the home screen like an app.

### 1.4 Hard constraints

- **$0 total cost** during building *and* deployment.
- **No credit card** connected to any service at any point.
- Local **Gemma** model (planned) will run on a separate machine and be integrated later - the product must be fully functional before that integration lands.

### 1.5 Explicit non-goals (for v1)

- No App Store distribution.
- No bank-account syncing / transaction imports (manual + natural-language entry only).
- No real-time web scraping of live deals (see F6 scoping in §3.6).

---

## Part 2 - Design Proposal

### 2.1 Architecture at a glance

The system has **three zones**, which are also the three privacy boundaries:

```
┌─────────────────────┐        store & read          ┌──────────────────────────┐
│   iPhone (PWA)       │ <──────────────────────────> │   Supabase (cloud)       │
│  · NL entry          │                              │  · Postgres + Auth       │
│  · charts & reports  │                              │  · Row-Level Security    │
│  add to home screen  │ ──────┐                      │  per-user data isolation │
└─────────────────────┘        │ parse text→category  └──────────────────────────┘
                               ▼
                        ┌──────────────────────────┐
                        │   Home machine           │
                        │  · Gemma via Ollama      │
                        │  · Cloudflare Tunnel     │
                        │  reachable from anywhere │
                        └──────────────────────────┘
```

- The **phone** holds no secrets beyond the user's session token; it reads/writes through Supabase.
- **Supabase** is the source of truth and the privacy enforcement point.
- The **home machine** is an optional enrichment service that never blocks the app.

### 2.2 Technology stack

| Layer | Choice | Why | Cost / card |
|-------|--------|-----|-------------|
| Frontend | **PWA** (React/Next.js, SvelteKit, or plain HTML/JS) | Installs to iPhone home screen; no App Store, no $99/yr Apple Developer account. | $0 / no card |
| Static hosting | **Cloudflare Pages** (or Netlify / Vercel) | Real free tier for static/PWA hosting. | $0 / no card |
| Database + Auth + API | **Supabase** | Bundles Postgres, authentication, auto-generated REST/Realtime APIs, and **Row-Level Security**. | $0 / no card |
| Privacy enforcement | **Postgres RLS** (via Supabase) | Filters rows at the database level so a user can only ever see their own data. | included |
| NL parsing / categorization | **Gemma via Ollama** on home machine, exposed by **Cloudflare Tunnel** | Keeps expense text private; reachable from the phone. | $0 / no card |
| Fallback categorization | Deterministic keyword rules (in-app or Supabase Edge Function) | Always available even when the home machine is off. | included |
| Charts / reports | Client-side (Recharts / Chart.js) or a scheduled Supabase Edge Function | No extra infrastructure. | included |

### 2.3 Supabase free-tier facts (verified) & implications

- Free tier includes **500 MB Postgres**, **50,000 monthly active users**, **~5 GB egress**, **up to 2 projects**, **no credit card**, and commercial use is allowed.
- **Projects pause after 7 days of inactivity** → add a lightweight keep-alive ping (§3.9).
- **Explicit Postgres grants** are required for the auto-generated Data API when "auto-expose new tables" is off (this project disables it as an extra safety wall) → the grants live in `supabase/01b_grants.sql`, run right after the schema.
- **API keys** use the new publishable/secret scheme (`sb_publishable_...` / `sb_secret_...`); new projects no longer ship the legacy `anon`/`service_role` keys. The PWA uses the **publishable** key (drop-in for the old anon key).

### 2.4 iPhone / PWA facts (verified) & implications

- iOS 16.4+ supports **web push** for PWAs added to the home screen (useful for "your monthly report is ready").
- **No background sync**, and iOS may evict cached data for a long-unused PWA → treat the server as the source of truth; the PWA is a fast front door, not an offline database.
- **Manual "Add to Home Screen"** in Safari (no auto-install prompt) → include a short first-run instruction screen.

### 2.5 Data model (overview)

```
auth.users (managed by Supabase)
   │ 1:1
   ▼
profiles ──────────── accounts ──────────── expenses
   (status, school)     (name, type)          (amount, category, payment_type, account_id, occurred_at, raw_input)
                                                     │
                                                     └── category_rules  (learned keyword → category)
subscriptions (name, amount, cycle, next_renewal, account_id, is_active)
subscription_catalog  (reference: known plans, student/annual pricing) - powers F6
```

Every user-owned table carries a `user_id uuid` column and an RLS policy tying rows to `auth.uid()`.

---

## Part 3 - Implementation Guide

### 3.1 Recommended build order (phased)

Build in this order so you have something usable within a weekend, not a half-finished everything:

- [ ] **Phase 0 - Foundation.** Supabase project, auth (email magic link / Google OAuth), schema + RLS, a dead-simple manual entry form. *This is the whole privacy-and-data core.*
- [ ] **Phase 1 - Usable app.** Accounts management, keyword auto-categorization, expense list/edit, monthly charts. Ship it, use it daily.
- [ ] **Phase 2 - Subscriptions.** Subscriptions table, renewal tracking, subscriptions category, dashboard tile.
- [ ] **Phase 3 - Natural language.** Wire in Gemma (Ollama + tunnel) for free-text parsing, with the keyword rules as fallback.
- [ ] **Phase 4 - Discount discovery.** Match subscriptions + profile against the catalog table; surface savings. (Live web-search agent is a later stretch goal.)

### 3.2 Database schema (SQL)

```sql
-- PROFILES: one row per user, keyed to the auth user id
create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  display_name  text,
  status        text check (status in ('working','student','other')) default 'other',
  school        text,
  graduation_year int,
  notes         text,
  created_at    timestamptz default now()
);

-- ACCOUNTS: payment sources (Chase checking, Amex, cash, ...)
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  type        text check (type in ('checking','credit','debit','cash','other')) not null,
  last_four   text,
  created_at  timestamptz default now()
);

-- EXPENSES
create table expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  amount        numeric(12,2) not null,
  currency      text default 'USD',
  description   text,
  merchant      text,
  category      text,
  payment_type  text check (payment_type in ('credit','debit','cash')),
  account_id    uuid references accounts on delete set null,
  occurred_at   date not null default current_date,
  raw_input     text,                 -- original natural-language text
  source        text default 'manual',-- 'manual' | 'parsed'
  created_at    timestamptz default now()
);

-- CATEGORY RULES: learned from user corrections (keyword -> category)
create table category_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  keyword    text not null,
  category   text not null,
  created_at timestamptz default now(),
  unique (user_id, keyword)
);

-- SUBSCRIPTIONS
create table subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null,
  amount        numeric(12,2) not null,
  billing_cycle text check (billing_cycle in ('monthly','annual','other')) default 'monthly',
  account_id    uuid references accounts on delete set null,
  next_renewal  date,
  is_active     boolean default true,
  notes         text,
  created_at    timestamptz default now()
);

-- SUBSCRIPTION CATALOG: shared reference data powering discount discovery
create table subscription_catalog (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,          -- 'Spotify'
  plan_type   text not null,          -- 'student' | 'annual' | 'family' | 'individual'
  price       numeric(12,2),
  eligibility text,                   -- 'verified student', 'up to 6 members', ...
  url         text,
  notes       text,
  unique (service, plan_type)         -- makes 03_seed's ON CONFLICT DO NOTHING idempotent
);

create index on expenses (user_id, occurred_at);
create index on subscriptions (user_id, is_active);
```

> **Grants note:** if "auto-expose new tables" is disabled in Supabase (this
> project does, for defense-in-depth), the tables above aren't reachable via the
> Data API until granted. Run `01b_grants.sql` after the schema:
> `grant usage on schema public to authenticated;` plus
> `grant select, insert, update, delete` on the user tables and `grant select`
> on `subscription_catalog`, all to the `authenticated` role. RLS still enforces
> per-user isolation on top of these grants.

### 3.3 Row-Level Security (the privacy core)

**Enable RLS on every user-owned table, then default to deny and allow only own rows.** Leaving RLS *off* exposes all rows to anyone with your project URL and the public anon key.

```sql
-- Turn RLS on
alter table profiles       enable row level security;
alter table accounts       enable row level security;
alter table expenses       enable row level security;
alter table category_rules enable row level security;
alter table subscriptions  enable row level security;

-- Profiles: the row's id IS the user id
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- All other user tables: match on user_id
create policy "own accounts" on accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own expenses" on expenses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rules" on category_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own subscriptions" on subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Catalog is shared reference data: readable by all signed-in users, writable by nobody via the API
alter table subscription_catalog enable row level security;
create policy "read catalog" on subscription_catalog
  for select using (auth.role() = 'authenticated');
```

**RLS rules to live by**
- The `service_role` / **secret** key bypasses RLS entirely - keep it server-side only, never in the PWA.
- The PWA uses only the **publishable** key (`sb_publishable_...`, the drop-in replacement for the legacy anon key); the user's JWT scopes every query automatically.
- `using` filters which existing rows are visible; `with check` validates inserts/updates - set both.

### 3.4 Authentication (avoid the cost trap)

- Use **email magic links** or **Google OAuth** - both free in Supabase.
- **Do NOT** use SMS / phone OTP: sending the text message costs money and would break the $0 rule.
- On first sign-in, create the matching `profiles` row (via a Postgres trigger on `auth.users`, or on first app load).

### 3.5 Categorization strategy

Two layers, so the app is always responsive:

1. **Deterministic keyword pass (always on).** On entry, lowercase the text and match against `category_rules` (user-specific) plus a small built-in default map (`chipotle→Food`, `uber→Transport`, `netflix→Subscriptions`, ...). Covers the majority of real expenses instantly, free, offline-tolerant.
2. **Gemma enrichment (when reachable).** For messy free text or unmatched merchants, send the string to Gemma for structured extraction + category. Runs asynchronously; never blocks the UI.

**Learning loop:** when a user corrects a category, upsert a row into `category_rules` (`keyword → chosen category`). Categorization improves over time with zero ML infrastructure.

### 3.6 Natural-language parsing with Gemma

- Run Gemma locally with **Ollama** (`ollama run gemma`) or llama.cpp on your separate machine.
- Expose it to the phone with a **Cloudflare Tunnel** (free, no card) so the PWA can reach a stable HTTPS URL without opening ports.
- Prompt Gemma to return **strict JSON** so the app can parse it deterministically, e.g.:

```json
{ "amount": 14.00, "merchant": "Chipotle", "category": "Food",
  "payment_type": "debit", "occurred_at": "2026-07-02" }
```

- Because the home machine may be asleep, treat parsing as best-effort: if Gemma is unreachable, fall back to the keyword pass and let the user confirm fields manually.

### 3.7 Subscriptions & discount discovery (F5 / F6)

- **F5 (monitoring):** store each subscription with amount, cycle, and `next_renewal`; show a dashboard tile of monthly subscription spend and upcoming renewals. Optionally auto-detect subscriptions from recurring expenses.
- **F6 (discounts) - scoped for v1:** maintain a curated `subscription_catalog` (Spotify, Adobe, YouTube, etc. with their student/annual/family pricing). Match a user's active subscriptions **and** their profile status against the catalog, then surface the gap ("You pay $11.99/mo for Spotify Individual; as a student you're eligible for $5.99/mo"). This delivers ~90% of the value with ~10% of the effort.
- **F6 stretch goal (later):** a Gemma + web-search agent that hunts live deals. Do this only after the core app is solid - live discount data is scattered and unreliable, and doing it robustly at scale can require paid APIs.

### 3.8 Reports (F7)

- Compute monthly aggregates (by category, by account, subscriptions total) and render with **Recharts** or **Chart.js** client-side.
- Optionally schedule a **Supabase Edge Function** monthly to precompute the summary and (with web push) notify each user their report is ready.

### 3.9 Operational notes for staying at $0

- **Keep-alive:** add a free scheduled ping so the Supabase project doesn't pause after 7 days idle. Use a **Cloudflare Worker Cron Trigger** (not GitHub Actions - GitHub disables scheduled workflows after ~60 days of no commits, which breaks a commit-and-forget repo). The Worker hits a tiny Supabase REST query every few days; setup is in SETUP.md §9.
- **Bandwidth discipline:** paginate expense lists and cache on the client to stay well under the 5 GB egress limit.
- **Two-project limit:** one Supabase project is enough; keep a second slot free for a staging copy if desired.

### 3.10 Cost & no-card checklist

| Component | Free tier | Credit card? |
|-----------|-----------|--------------|
| Supabase (DB/Auth/RLS) | Yes | No |
| Cloudflare Pages (hosting) | Yes | No |
| Cloudflare Tunnel (Gemma access) | Yes | No |
| Ollama + Gemma (local) | Yes (your hardware) | No |
| PWA (vs native app) | Yes | No - avoids Apple's $99/yr |
| Auth via email/OAuth (not SMS) | Yes | No - SMS would cost money |
| Cloudflare Worker cron (keep-alive) | Yes | No |

---

## Part 4 - Risks & Watch-Items

| Risk | Impact | Mitigation |
|------|--------|-----------|
| RLS misconfigured (off, or missing policy) | Data leak across users | Enable RLS on every table; default deny; test with two accounts; keep `service_role` off the client. |
| Home machine asleep when entering on the go | NL parsing unavailable | Keyword fallback + manual confirm; Gemma is enrichment only. |
| F6 over-scoped | Feature stalls the project | Ship the curated-catalog version first; live scraping is a later stretch goal. |
| Supabase project auto-pauses | App cold-starts / appears down | Scheduled keep-alive ping. |
| Hidden costs (Apple account, SMS auth, card-gated hosts) | Breaks $0 constraint | PWA, email/OAuth auth, and confirmed no-card hosts only. |
| Entry friction | Users stop logging | One-box quick-add as the home screen; one-tap category correction. |

---

## Appendix - Open Decisions

- **Frontend framework:** Next.js (rich ecosystem) vs SvelteKit (lighter) vs plain HTML/JS (simplest). Any works with Supabase.
- **Where the keyword pass runs:** in the PWA (simplest) vs a Supabase Edge Function (shareable across devices).
- **Subscription auto-detection:** derive from recurring expenses, or enter manually for v1.
- **Push notifications:** enable for monthly reports, or keep the app pull-only to start.
