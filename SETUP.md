# Phase 0 - Foundation Setup

This gets the privacy-and-data core running: a Supabase project with the schema
and Row-Level Security, plus the installable PWA with a working manual-entry
form. Everything here is **$0 and no credit card**. Budget ~30–45 minutes.

```
personal-finance-agent/
├── SETUP.md              ← you are here
├── SECURITY.md           ← credential handling rules - read before step 4
├── LICENSE.md
├── supabase/
│   ├── 01_schema.sql     ← tables + indexes            (run 1st)
│   ├── 01b_grants.sql    ← Data API grants             (run 2nd) - needed because auto-expose is off
│   ├── 02_rls.sql        ← RLS + auth trigger          (run 3rd)  ← THE privacy core
│   └── 03_seed.sql       ← catalog reference data      (run 4th, optional)
└── app/
    ├── index.html        ← the PWA UI
    ├── app.js             ← Supabase queries + UI logic
    ├── categorize.js     ← keyword auto-categorization (README §3.5)
    ├── config.example.js ← committed template - copy this to config.js (step 4)
    ├── config.js         ← ⚠️ gitignored; put your real Supabase URL + key here (step 4)
    ├── manifest.json     ← PWA install metadata
    ├── sw.js             ← service worker (installability)
    └── icons/            ← app icons
```

## 1. Create a free Supabase project (no card)

1. Go to https://supabase.com and sign up (GitHub or email).
2. **New project** → name it `expense-tracker`, pick a region near you, set a
   strong database password (save it), leave it on the **Free** plan.
3. Wait ~2 min for it to provision.

## 2. Run the schema

Dashboard → **SQL Editor** → **New query**. Paste the entire contents of
`supabase/01_schema.sql`, then **Run**. You should see "Success. No rows returned."

## 2b. Grant Data API access (do not skip if you disabled auto-expose)

This project was created with **"Automatically expose new tables" OFF** (Settings
→ API → Data API). That's an extra safety wall: tables aren't reachable through
the public API until explicitly granted. But it means the app would hit
"permission denied" until you run the grants.

New query → paste `supabase/01b_grants.sql` → **Run**.

> If you instead left auto-expose **ON**, skip this step - the tables are already
> reachable, and RLS (next) still enforces per-user isolation either way.

## 3. Run RLS (do not skip - this is what keeps users' data private)

New query → paste `supabase/02_rls.sql` → **Run**.

Then paste `supabase/03_seed.sql` → **Run** (optional, adds subscription catalog).
Re-running it is safe: `01_schema.sql` now has a `unique (service, plan_type)`
constraint, so the seed's `ON CONFLICT DO NOTHING` skips duplicates instead of
appending them.

## 4. Wire your keys into the app

Dashboard → **Connect** (top bar) or **Settings → API Keys**. Copy:

- **Project URL** → e.g. `https://abcxyz.supabase.co`
- **Publishable key** → starts with `sb_publishable_...`

> Supabase moved to new key names (publishable/secret) and new projects no
> longer ship the legacy `anon`/`service_role` keys by default. The
> **publishable** key is the drop-in replacement for the old anon key: same low
> privileges, RLS still applies. Older docs saying "copy the `eyJ...` anon key"
> refer to the legacy scheme.

`app/config.js` is **gitignored** - it holds your real Supabase URL and key.
Never commit a real copy of live credentials to git history, whether the
repo is public or private - treat this as a hard rule either way, not a
public-repo-only precaution. Instead, create your local copy from the
committed template:

```bash
cd app
cp config.example.js config.js
```

Open the new `app/config.js` and paste your real values in (the config field
is still named `SUPABASE_ANON_KEY` for compatibility - put the publishable
key there):

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://abcxyz.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_...your-publishable-key...",
};
```

`app/config.js` stays local to your machine from here on - see `SECURITY.md`
for the full reasoning and for how the Cloudflare Pages deploy generates a
production copy of this file from environment variables instead of reading
it from git.

⚠️ Use the **publishable** key only. Never put a **secret** key
(`sb_secret_...`, or the legacy `service_role`) in the app - it bypasses RLS
entirely (README §3.3).

## 5. Configure auth (magic links, free)

Dashboard → **Authentication → Providers → Email**: make sure **Email** is
enabled. Magic links work out of the box on the free tier.

- **Do NOT** enable Phone/SMS auth - sending texts costs money (README §3.4).
- Dashboard → **Authentication → URL Configuration**: add your app's URL(s) to
  **Redirect URLs** so the magic link returns to the app. For local testing add
  `http://localhost:8000`; after deploy (step 7) add your Cloudflare Pages URL.

## 6. Run locally & test isolation with two accounts

From the `app/` folder:

```bash
cd app
python3 -m http.server 8000
```

Open http://localhost:8000. Sign in with your email → click the magic link →
add an account and an expense.

**The isolation test (do this once, it's the whole point):**

1. Sign in as user A, add an expense.
2. Sign out, sign in as user B (a second email), add a different expense.
3. Confirm B sees only B's expense, and A sees only A's. If either user can see
   the other's rows, RLS is misconfigured - recheck step 3.

## 7. Deploy free to Cloudflare Pages (no card)

1. Push this folder to a GitHub repo (or use Cloudflare's direct upload).
2. https://dash.cloudflare.com → **Workers & Pages → Create → Pages**.
3. Connect the repo (or upload the `app/` folder). **Build command:** none.
   **Build output directory:** `app` (or the repo root if you only pushed `app/`).
4. Deploy → you get a `https://your-app.pages.dev` URL.
5. Add that URL to Supabase **Redirect URLs** (step 5) so magic links work in prod.

## 8. Install on iPhone

Open the `pages.dev` URL in **Safari** → **Share** → **Add to Home Screen**.
It launches full-screen like a native app. (iOS has no auto-install prompt, so
this manual step is expected - README §2.4.)

## 9. Keep it from pausing (Cloudflare Worker cron)

Supabase free projects **pause after 7 days of inactivity** (README §3.9) - where
"activity" means any API request hitting the project, not whether you logged an
expense. A paused project stops responding until you manually **Restore** it from
the dashboard (no data is lost - pausing ≠ deletion). To avoid that, run a tiny
scheduled ping that keeps the 7-day timer from ever elapsing.

**Why a Cloudflare Worker (not GitHub Actions):** GitHub disables scheduled
workflows after ~60 days with no commits - fatal for a commit-and-forget repo.
A Cloudflare Worker Cron Trigger has no such behavior, runs on infrastructure you
already use for Pages, and is $0 / no card.

### 9a. Create the Worker (dashboard, no CLI needed)

1. https://dash.cloudflare.com → **Workers & Pages → Create → Create Worker**.
2. Name it e.g. `supabase-keepalive`, **Deploy**, then **Edit code**.
3. Replace the default code with this and **Deploy**:

```js
// Pings the Supabase REST API on a schedule so the project never idles out.
// A request that returns [] (blocked by RLS) still counts as activity - the
// point is to touch the database, not to read data.
export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscription_catalog?select=id&limit=1`,
      { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } }
    );
    console.log("keep-alive ping:", res.status);
  },
};
```

### 9b. Add the environment variables

Worker → **Settings → Variables and Secrets** → add two:

- `SUPABASE_URL` = `https://<your-ref>.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_...`

(The publishable key is safe to store here - it's public by design and RLS-bound.)

### 9c. Add the cron trigger

Worker → **Settings → Triggers → Cron Triggers → Add** → set a schedule well
inside the 7-day window, e.g. every 3 days at 06:00 UTC:

```
0 6 */3 * *
```

Save. You can confirm it fired under the Worker's **Logs / Observability** tab
(look for the `keep-alive ping: 200` line), or just watch that your Supabase
project never shows "Paused."

> **Honest caveat:** no keep-alive is 100% guaranteed - if you ever need
> ironclad uptime, Supabase Pro never pauses (but costs money + a card, so it's
> off the table here). For a personal 2-user app, the Worker cron is plenty.

---

## Definition of done for Phase 0

- [ ] Schema + RLS applied; every user table shows RLS enabled with a policy.
- [ ] Two-account isolation test passes (users can't see each other's data).
- [ ] You can add and delete an expense from your phone's home screen.

## Phase 1 is included (README §3.1)

The app now also has: **tap-to-edit** expenses, a **category-correction
learning loop** (correcting a category upserts a `keyword → category` rule so
similar future entries auto-categorize), **account deletion** (expenses stay,
just become unassigned), and a **Reports** tab with Chart.js charts - spend by
category, by account, and a 6-month trend, with a month picker.

> **Schema note (important if you already ran 01_schema.sql):** the `user_id`
> columns now carry `default auth.uid()` so inserts populate the owner
> automatically and pass RLS. If you created the tables from an earlier copy,
> re-run `01_schema.sql` on a fresh project, **or** apply this once:
>
> ```sql
> alter table accounts       alter column user_id set default auth.uid();
> alter table expenses       alter column user_id set default auth.uid();
> alter table category_rules alter column user_id set default auth.uid();
> alter table subscriptions  alter column user_id set default auth.uid();
> ```

## Phase 2 is included (README §3.7 / F5)

There's now a **Subscriptions** tab: add/edit/delete subscriptions (name,
amount, billing cycle, next renewal, account, active flag, notes), a monthly-
and yearly-normalized spend total, an **upcoming-renewals (30 days)** list, and
a tappable **dashboard tile** on the Log screen showing monthly subscription
spend and the next renewal. Annual plans are normalized to a monthly equivalent
for totals. Logic lives in `app/subscriptions.js` (unit-tested).

## Profiles UI is included (README §1.2)

The **👤 Profile** button (Log header) opens an editor for your display name,
status (working / student / other), and - when you're a student - school and
graduation year, plus free-text notes. This data is private (RLS-scoped to you)
and feeds the Phase 4 discount matcher. The `profiles` row is auto-created on
sign-up by the DB trigger; the editor upserts changes to it.

## Phase 4 is included (README §3.7 / F6, v1 scope)

The Subscriptions tab now shows a **💰 Savings found** card. For each active
subscription it matches the seeded `subscription_catalog` for the same service,
keeps only plans you're **eligible** for (student plans require student status;
individual/annual/family are open to anyone), and surfaces the cheapest plan
that beats what you pay today - with monthly + yearly savings and a link. If
you're not marked as a student, a gentle **"Are you a student?"** upsell lists
the student-only deals you'd unlock, and tapping it opens your profile. Saving
the profile re-runs the match live. Logic lives in `app/discounts.js`
(unit-tested, incl. accurate annual↔monthly normalization).

> Keep `subscription_catalog` prices current (see the note atop `03_seed.sql`);
> the quality of these suggestions is only as good as that reference data.

## Phase 3 is included (README §3.6) - Gemma natural-language parsing

The quick-add box now does **two-layer parsing**: an instant keyword pass fills
the fields immediately, and - if a Gemma endpoint is configured - a debounced
background call enriches them (amount, merchant, category, payment, date) with
a "✨ parsed by Gemma" badge. It's fully **best-effort**: a timeout, an error,
or an unconfigured endpoint just leaves the keyword guess in place, so the app
never blocks or breaks when the home machine is asleep. Expenses saved after a
successful parse are marked `source = 'parsed'`. Client logic is in
`app/gemma.js` (unit- and integration-tested).

### Test it now with the mock endpoint (no home machine needed)

```bash
node tools/mock-gemma-server.js          # listens on http://localhost:11434
```

Then set in `app/config.js`:

```js
GEMMA_ENDPOINT: "http://localhost:11434/api/generate",
```

Reload the app, type `$14 lunch chipotle debit`, and watch the fields fill with
the "✨ parsed by Gemma" badge. (Note: browsers block plain-HTTP calls from an
HTTPS page - use the mock only against a locally-served `http://localhost` app,
or a real HTTPS tunnel in production.)

### Real setup on your home machine (README §3.6)

1. Install Ollama and pull the model: `ollama pull gemma`.
2. Allow browser calls (CORS): run Ollama with `OLLAMA_ORIGINS=*` (or your app's
   origin), e.g. `OLLAMA_ORIGINS=* ollama serve`.
3. Expose it with a free **Cloudflare Tunnel** (no card): `cloudflared tunnel
   --url http://localhost:11434`, which prints a stable `https://…trycloudflare.com`
   URL (or set up a named tunnel for a permanent hostname).
4. Put that HTTPS URL + `/api/generate` in `GEMMA_ENDPOINT`, and set
   `GEMMA_MODEL` to your pulled model name.

The client posts `{ model, prompt, stream:false, format:"json" }` and reads
Ollama's `{ response: "<json>" }`, so it works against a stock Ollama server.

## What's next (README §3.1)

- **F6 stretch (later)** - a live web-search agent for real-time deals, once the
  curated-catalog version has proven useful. The only remaining roadmap item.
- **Phase 4** - discount discovery against `subscription_catalog` + profile.
