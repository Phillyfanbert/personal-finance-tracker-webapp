#!/usr/bin/env bash
# ============================================================================
# Runs price-agent.js in FAST_ONLY mode - real Finnhub ticker prices only
# (a user's own watchlist + MARKET_MOVERS_WATCHLIST), skipping every
# Tavily/Gemini-backed step (market indexes, "why did it move"
# explanations, the news digest) entirely. This is what lets the
# Investments tab's real prices refresh far more often than the weekly
# full run - Finnhub's free tier is 60 calls/min with no daily cap, and a
# FAST_ONLY run uses only ~21 calls, so a tight interval (installed as
# com.price-agent.fast, see setup-server-machine.sh) costs nothing extra.
# Run on the SERVER MACHINE only.
#
# Usage:
#   ./tools/run-price-agent-fast.sh
#   DRY_RUN=1 ./tools/run-price-agent-fast.sh   # no writes
#
# Requires: node 18+ and tools/.env.deal-agent filled in - same shared env
# file as run-price-agent.sh (TAVILY_API_KEY/GEMINI_API_KEY are required by
# requireEnv() even though FAST_ONLY never calls either, not worth
# special-casing since the shared env file already has them).
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

export FAST_ONLY=1
node price-agent.js
