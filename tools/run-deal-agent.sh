#!/usr/bin/env bash
# ============================================================================
# F6 stretch - runs the deal-search agent (Gemini + Google Search grounding,
# no local search engine to bring up/down). Run on the SERVER MACHINE only.
# This is the script to point a weekly cron/systemd timer at (Phase D) - not
# the raw node command - so env vars are always loaded consistently.
#
# Usage:
#   ./tools/run-deal-agent.sh
#   DRY_RUN=1 ./tools/run-deal-agent.sh   # no writes to deal_findings
#
# Requires: node 18+ and tools/.env.deal-agent filled in (GEMINI_API_KEY,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) from tools/.env.deal-agent.example.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# launchd gives a scheduled job a minimal default PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew's node -
# confirmed live (2026-08-16) that this silently broke every unattended
# run of the sibling embed-expenses.hourly job with "node: command not
# found" (exit 127) since it was installed, with no failure visible
# anywhere since the crash happens before writeRunStatus() can even run.
# Both directories cover Apple Silicon and Intel Homebrew installs.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ENV_FILE=".env.deal-agent"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "Missing $ENV_FILE - copy .env.deal-agent.example and fill in real values." >&2
  exit 1
fi

node deal-agent.js
