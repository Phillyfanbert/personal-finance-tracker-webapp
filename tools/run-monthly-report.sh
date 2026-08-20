#!/usr/bin/env bash
# ============================================================================
# Wrapper for tools/monthly-report.js - loads env vars and runs it. Run on
# the SERVER MACHINE only. Deliberately small, same shape as
# run-embed-expenses.sh: this script never touches SearXNG (it talks to the
# local Gemma over localhost and Supabase only), so there's no docker
# compose dance here.
#
# Usage:
#   ./tools/run-monthly-report.sh
#   DRY_RUN=1 ./tools/run-monthly-report.sh   # prints report text, no writes
#
# Requires: node 18+ and tools/.env.deal-agent filled in (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, GEMMA_ENDPOINT, GEMMA_MODEL) - shared with
# deal-agent.js/price-agent.js/embed-expenses.js, not a separate env file.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# launchd gives a scheduled job a minimal default PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew's node -
# see run-price-agent.sh's own copy of this comment for the full story.
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

node monthly-report.js
