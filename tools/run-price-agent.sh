#!/usr/bin/env bash
# ============================================================================
# Brings SearXNG up, runs the live asset-price agent, tears SearXNG back
# down - same wrapper shape as run-deal-agent.sh, so SearXNG never sits
# resident between runs. Run on the SERVER MACHINE only.
#
# Usage:
#   ./tools/run-price-agent.sh
#   DRY_RUN=1 ./tools/run-price-agent.sh   # no writes to asset_price_findings
#
# Requires: docker compose, node 18+, and tools/.env.deal-agent filled in -
# shared with deal-agent.js/monthly-report.js, not a separate env file.
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

cleanup() {
  echo "Stopping SearXNG..."
  docker compose -f searxng/docker-compose.yml down
}
trap cleanup EXIT

echo "Starting SearXNG..."
docker compose -f searxng/docker-compose.yml up -d

echo "Waiting for SearXNG..."
ready=false
for _ in $(seq 1 30); do
  if curl -sf "${SEARXNG_URL}/search?q=ping&format=json" > /dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo "SearXNG didn't become ready in time." >&2
  exit 1
fi
echo "SearXNG is up."

node price-agent.js
