#!/usr/bin/env bash
# ============================================================================
# Wrapper for tools/embed-expenses.js - loads env vars and runs it. Run on
# the SERVER MACHINE only. Deliberately much smaller than run-deal-agent.sh/
# run-price-agent.sh: this script never touches SearXNG (embedding an
# expense needs Ollama and Supabase only, no web search), so there's no
# docker compose up/down dance here.
#
# Usage:
#   ./tools/run-embed-expenses.sh
#   DRY_RUN=1 ./tools/run-embed-expenses.sh   # no writes to expense_embeddings
#
# Requires: node 18+ and tools/.env.deal-agent filled in (shared with
# deal-agent.js/price-agent.js/monthly-report.js, not a separate env file).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

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

node embed-expenses.js
