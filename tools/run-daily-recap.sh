#!/usr/bin/env bash
# ============================================================================
# Builds the stored daily market recap (daily_recaps, 55_daily_recaps.sql)
# from data previous runs already wrote - the day's biggest movers, each
# with a real linked headline, plus breadth and the index proxies' moves.
#
# Makes ZERO outbound calls: no Finnhub, no Tavily, and above all no
# Gemini. That's the point of stage 1 - the recap can never be rate-limited
# out of existence the way market_news_findings was (0 rows ever, because
# its single Gemini call always lost the race for a 20-request DAILY quota
# shared with deal-agent). Stage 2 adds one batched Gemini call for a
# short written synthesis, as an enhancement on top of a card that is
# already complete without it.
#
# Schedule: weekdays after the close (see setup-server-machine.sh's
# install_weekday_agent / DAILY_RECAP_HOUR, default 16:30 America/New_York
# on the server machine's own clock). Safe to run more often - it keys off
# the latest trade_date actually present in daily_prices rather than off
# the calendar, and upserts one row per trading day, so a re-run refines
# that day's row instead of creating a second one. A weekend run simply
# rebuilds Friday's recap.
# Run on the SERVER MACHINE only.
#
# Usage:
#   ./tools/run-daily-recap.sh
#   DRY_RUN=1 ./tools/run-daily-recap.sh   # no writes
#
# Requires: node 18+ and tools/.env.deal-agent. Only SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY are actually used, but requireEnv() still
# insists on the Tavily/Gemini/Finnhub keys - the same accepted quirk
# run-price-agent-fast.sh already documents, not worth special-casing
# since the shared env file has them all anyway.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# launchd gives a scheduled job a minimal default PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew's node -
# see run-price-agent.sh's own copy of this comment for the full story.
# This is not optional boilerplate: com.embed-expenses.hourly failed
# silently with exit 127 every hour for days over exactly this.
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

export RECAP_ONLY=1
node price-agent.js
