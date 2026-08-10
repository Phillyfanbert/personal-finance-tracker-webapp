# Security & Credential Handling

This is a personal, $0-budget project (README §1.4), so there's no dedicated
security team - this doc is the substitute: one place that states what's safe
to commit, what isn't, and what tooling enforces the difference.

## What's safe to commit

- **`app/config.example.js`** - a placeholder template with dummy values.
  Committed intentionally so anyone setting this up (including future-you on
  a new machine) knows the shape `config.js` needs to take.
- The Supabase **publishable key** (`sb_publishable_...`), *if* it ever ends
  up in a committed file. It's designed to be public-facing - the same role
  the old `anon` key played - and is powerless without a signed-in user's
  JWT. Row-Level Security (`supabase/02_rls.sql`) is the real privacy
  boundary, not secrecy of this key.

## What must never be committed

- **`app/config.js`** (the real one) - gitignored on purpose. Contains your
  live Supabase URL + publishable key. Not dangerous if leaked (see above),
  but keeping it out of git avoids inviting random signups that eat into the
  free-tier quota (500 MB Postgres, 5 GB egress, magic-link email sends).
- The Supabase **secret / `service_role`** key - this one *does* bypass RLS
  entirely. It must never appear in any file in this repo, committed or not,
  since anything in `app/` is served straight to the browser with no build
  step to strip it out.
- The **Gmail SMTP app password** used for magic-link email (README §3.4).
  Lives only in the Supabase dashboard (Authentication → SMTP settings) -
  never in a file here.
- Any **Cloudflare API token**, if one is ever created for scripted deploys.
- Real personal expense/subscription data, exports, or database dumps.

## Tooling that enforces this

- **`.gitignore`** - keeps `app/config.js` and OS junk (`.DS_Store`,
  `.Rhistory`) out of every commit automatically.
- **gitleaks pre-commit hook** (`.git/hooks/pre-commit`, not itself tracked
  by git - see note below) - scans every commit for anything shaped like a
  secret before it's created.
- **`.gitleaksignore`** - allowlists the one known-safe publishable-key
  fingerprint so the hook doesn't nag about it.
- **GitHub secret scanning + push protection** - free once a repo is public
  (Settings → Code security). A second, independent layer in case something
  slips past gitleaks locally.

## Setting up the pre-commit hook on a new clone

Git hooks live in `.git/hooks/` and are **not** synced by `git clone` - if
you ever set this repo up on another machine, re-run:

```bash
brew install gitleaks
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/sh
gitleaks protect --staged --verbose
EOF
chmod +x .git/hooks/pre-commit
```

## If a real secret ever does get committed

1. **Rotate it immediately** (Supabase Dashboard → Settings → API Keys, or
   the equivalent for whatever leaked). Rotation neutralizes the exposure
   regardless of what happens to git history.
2. Optionally scrub it from history with `git filter-repo` and a
   force-push - worthwhile for a clean portfolio repo, but rotation is the
   step that actually matters; history-scrubbing is cleanup on top of that.
3. Note that GitHub retains unreachable commits for some time after a
   force-push before garbage-collecting them, and that forks or already-open
   pull requests can keep old data reachable - another reason rotation,
   not history-rewriting, is the real fix.

## Reporting

This is a personal single-maintainer project with no public issue-tracker
SLA, but if you notice something here that looks like a real leaked
credential, please open an issue or contact the repo owner directly rather
than exploiting it.
