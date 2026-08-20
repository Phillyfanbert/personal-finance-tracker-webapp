#!/usr/bin/env bash
# ============================================================================
# Runs the live asset-price agent (Gemini + Google Search grounding, no
# local search engine to bring up/down) - same wrapper shape as
# run-deal-agent.sh. Run on the SERVER MACHINE only.
#
# Usage:
#   ./tools/run-price-agent.sh
#   DRY_RUN=1 ./tools/run-price-agent.sh   # no writes to asset_price_findings
#
# Requires: node 18+ and tools/.env.deal-agent filled in (GEMINI_API_KEY,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) - shared with deal-agent.js/
# monthly-report.js, not a separate env file.
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

node price-agent.js
