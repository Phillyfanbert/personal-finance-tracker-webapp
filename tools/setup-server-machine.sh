#!/usr/bin/env bash
# ============================================================================
# One-shot SERVER MACHINE bootstrap - run this on your own home/server
# machine (whichever one is colocated with Ollama), from the tools/ directory.
# Idempotent: safe to re-run after a partial failure or to pick up a change.
#
# Sets up the shared prerequisites that used to block both live deal
# discovery and live asset pricing:
#   1. tools/.env.deal-agent (prompts for the Supabase service_role key -
#      never put it in this script or in chat, it bypasses RLS entirely)
#   2. SearXNG's one-time settings.yml edits (JSON format + a real secret_key)
#   3. tools/gemma-auth-proxy.js running persistently as a LaunchAgent, and
#      the existing Cloudflare Tunnel LaunchAgent repointed at it instead of
#      Ollama directly (see the "Gemma tunnel lockdown" session note for why)
#   4. Weekly launchd schedules for run-deal-agent.sh and run-price-agent.sh,
#      now on genuinely DIFFERENT calendar days (Sunday / Wednesday,
#      PRICE_AGENT_WEEKDAY), not just different hours of the same day - an
#      earlier version of this comment described staggered hours on the
#      same Sunday as sufficient spacing (leftover from when both scripts
#      shared a SearXNG container, since removed in the 2026-08-14
#      Tavily+Gemini migration), but that never addressed the real shared
#      constraint: Gemini's 20-requests/day free quota resets per calendar
#      day, not per hours-apart, so both scripts wanting Gemini calls on
#      the same Sunday could (and, confirmed live 2026-08-16, did) collide
#      regardless of the hour. See PRICE_AGENT_WEEKDAY's own comment
#      further down for the full story.
#   5. An hourly launchd schedule for embed-expenses.js (RAG retrieval for
#      the Reports page's "Ask about your spending" Q&A - see
#      supabase/45_expense_embeddings.sql) - much tighter than the weekly
#      deal/price cadence on purpose: its content-hash delta detection
#      makes an unchanged expense cost one comparison, not a search+fetch+
#      Gemma round trip, so a frequent run is cheap, and new expenses
#      should become searchable soon after they're added rather than up to
#      a week later.
#   6. A tight (default 15-minute) launchd schedule for price-agent.js's
#      FAST_ONLY mode (com.price-agent.fast, run-price-agent-fast.sh) -
#      real stock-ticker prices only, straight to Finnhub with no
#      Tavily/Gemini step at all, so it can run far more often than the
#      full weekly pipeline without touching either service's constrained
#      free-tier budget. This is what makes the Investments tab's real
#      prices/net worth track the market closely instead of up to a week
#      stale - see price-agent.js's own header comment for the full
#      before/after call-volume accounting.
#
# Usage:
#   cd tools
#   ./setup-server-machine.sh
#
# Optional env overrides:
#   GEMMA_PROXY_SECRET   - must match app/config.js's GEMMA_AUTH_KEY and the
#                           Cloudflare dashboard's GEMMA_AUTH_KEY, so it
#                           defaults to the one already generated for this
#                           project rather than a fresh random value that
#                           would silently stop matching them.
#   DEAL_AGENT_HOUR/MIN, PRICE_AGENT_HOUR/MIN, PRICE_AGENT_WEEKDAY -
#                           launchd schedule for the two weekly Gemini-
#                           using runs (defaults Sunday 03:00 and
#                           Wednesday 05:00, local time - deliberately
#                           different days, see PRICE_AGENT_WEEKDAY's own
#                           comment further down for why)
#   EMBED_EXPENSES_INTERVAL_SECONDS - how often embed-expenses.js runs
#                           (default 3600 = hourly)
#   PRICE_AGENT_FAST_INTERVAL_SECONDS - how often price-agent.js's
#                           FAST_ONLY (Finnhub-only) mode runs (default
#                           900 = 15 minutes)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
TOOLS_DIR="$(pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_GUI="gui/$(id -u)"

GEMMA_PROXY_SECRET="${GEMMA_PROXY_SECRET:-$(openssl rand -hex 32)}"
DEAL_AGENT_HOUR="${DEAL_AGENT_HOUR:-3}"
DEAL_AGENT_MIN="${DEAL_AGENT_MIN:-0}"
PRICE_AGENT_HOUR="${PRICE_AGENT_HOUR:-5}"
PRICE_AGENT_MIN="${PRICE_AGENT_MIN:-0}"
# Deliberately NOT Sunday (deal-agent.js's own day, weekday 0 below) - found
# live 2026-08-16 that scheduling both weekly Gemini-using scripts on the
# SAME calendar day meant they competed for one shared 20-requests/day
# free-tier quota, which is what caused deal-agent.js to fail 8-9 of 10
# real queries. Gemini's quota resets per calendar day, not per hours-
# apart, so same-day scheduling can't avoid this regardless of the hour.
# 3 = Wednesday (launchd Weekday: 0=Sunday...6=Saturday) - conflict-free
# with everything else scheduled (the interval/day-of-month jobs below
# don't touch Gemini, or don't care about weekday at all).
PRICE_AGENT_WEEKDAY="${PRICE_AGENT_WEEKDAY:-3}"
EMBED_EXPENSES_INTERVAL_SECONDS="${EMBED_EXPENSES_INTERVAL_SECONDS:-3600}"
PRICE_AGENT_FAST_INTERVAL_SECONDS="${PRICE_AGENT_FAST_INTERVAL_SECONDS:-900}"
MONTHLY_REPORT_DAY="${MONTHLY_REPORT_DAY:-1}"
MONTHLY_REPORT_HOUR="${MONTHLY_REPORT_HOUR:-6}"
MONTHLY_REPORT_MIN="${MONTHLY_REPORT_MIN:-0}"
# Weekdays only, after the US close. Unlike every other job here the
# recap has a real reason to care what time it is: it summarizes a
# finished trading session, so running it mid-session would recap a
# half-finished day. 16:30 assumes the server machine's own clock is
# US Eastern - override if it isn't. It still keys off the latest
# trade_date actually in daily_prices rather than the calendar, so an
# early or repeated run is harmless, just less complete.
DAILY_RECAP_HOUR="${DAILY_RECAP_HOUR:-16}"
DAILY_RECAP_MIN="${DAILY_RECAP_MIN:-30}"

log() { echo "== $* =="; }

# launchctl bootout is asynchronous - an immediate bootstrap of the same
# label right after can fail with "Bootstrap failed: 5: Input/output error"
# even though the exact same bootstrap call succeeds a moment later
# (confirmed live: every one of this script's 4 bootout+bootstrap sites hit
# this on a real run, and a manual retry a couple seconds afterward worked
# every time with no other change). One retry after a short pause is enough
# in practice - this isn't launchd behaving randomly, just not being fully
# unloaded yet at the instant bootout's own command returns.
bootout_and_bootstrap() {
  local label="$1" plist="$2"
  launchctl bootout "$UID_GUI/${label}" 2>/dev/null || true
  sleep 1
  if ! launchctl bootstrap "$UID_GUI" "$plist" 2>/dev/null; then
    sleep 2
    launchctl bootstrap "$UID_GUI" "$plist"
  fi
}

log "Checking prerequisites"
command -v docker >/dev/null || { echo "docker not found - install Docker Desktop or OrbStack first."; exit 1; }
command -v node >/dev/null || { echo "node not found - install Node 18+ first (e.g. brew install node)."; exit 1; }
command -v ollama >/dev/null || echo "WARNING: ollama CLI not found on PATH - assuming it's still running as a service."
echo "docker: $(docker --version)"
echo "node:   $(node --version)"

# ---- 1. tools/.env.deal-agent -----------------------------------------------
ENV_FILE="$TOOLS_DIR/.env.deal-agent"
if [ -f "$ENV_FILE" ]; then
  log ".env.deal-agent already exists, leaving it as-is (delete it first to regenerate)"
else
  log "Creating .env.deal-agent"
  read -r -p "Supabase project URL (e.g. https://YOUR_PROJECT_REF.supabase.co): " SB_URL
  [ -n "$SB_URL" ] || { echo "A Supabase project URL is required."; exit 1; }
  read -r -s -p "Supabase SERVICE_ROLE key (input hidden, from Dashboard > Project Settings > API Keys): " SB_KEY
  echo
  if [ -z "$SB_KEY" ]; then
    echo "No service_role key entered - aborting so a broken .env.deal-agent doesn't get created." >&2
    exit 1
  fi
  cat > "$ENV_FILE" <<EOF
SUPABASE_URL=${SB_URL}
SUPABASE_SERVICE_ROLE_KEY=${SB_KEY}

SEARXNG_URL=http://localhost:8080

GEMMA_ENDPOINT=http://localhost:11434/api/generate
GEMMA_MODEL=gemma4:e4b
GEMMA_EMBED_MODEL=nomic-embed-text
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (mode 600)."
fi

# ---- 2. SearXNG one-time settings ------------------------------------------
SEARXNG_DIR="$TOOLS_DIR/searxng"
SETTINGS="$SEARXNG_DIR/searxng-config/settings.yml"
if [ ! -f "$SETTINGS" ]; then
  log "Bootstrapping SearXNG config (first docker compose up/down)"
  (cd "$SEARXNG_DIR" && docker compose up -d && sleep 3 && docker compose down)
fi
if [ -f "$SETTINGS" ]; then
  if grep -q "^\s*formats:" "$SETTINGS"; then
    echo "settings.yml already has a formats: line - leaving it."
  else
    log "Enabling JSON output format in settings.yml"
    # The bundled settings.yml a fresh docker-compose bootstrap produces has
    # gotten much slimmer across SearXNG image versions than this script
    # originally assumed - confirmed live it can be as little as
    # use_default_settings: true plus a server: block, with no top-level
    # search: key at all to insert under. use_default_settings: true means
    # any top-level key added here (search:, same as server: already is)
    # gets merged with the image's real defaults rather than replacing them
    # wholesale - verified live (a real docker compose up + a real
    # ?format=json query against a freshly-appended search: block returned
    # real JSON results), so appending a brand new section when none exists
    # is the correct fix, not just a fallback guess.
    python3 - "$SETTINGS" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()
out = []
inserted = False
for line in lines:
    out.append(line)
    if not inserted and line.rstrip() == "search:":
        out.append("  formats:\n")
        out.append("    - html\n")
        out.append("    - json\n")
        inserted = True
if not inserted:
    if out and out[-1].strip() != "":
        out.append("\n")
    out.append("search:\n")
    out.append("  formats:\n")
    out.append("    - html\n")
    out.append("    - json\n")
    inserted = True
with open(path, "w") as f:
    f.writelines(out)
print("inserted formats: [html, json]")
PYEOF
  fi

  if grep -qE '^\s*secret_key:\s*"?ultrasecretkey"?' "$SETTINGS"; then
    log "Setting a real SearXNG secret_key"
    NEW_SECRET="$(openssl rand -hex 32)"
    python3 - "$SETTINGS" "$NEW_SECRET" <<'PYEOF'
import re, sys
path, secret = sys.argv[1], sys.argv[2]
with open(path) as f:
    content = f.read()
content = re.sub(r'secret_key:\s*"?ultrasecretkey"?', f'secret_key: "{secret}"', content)
with open(path, "w") as f:
    f.write(content)
print("secret_key set")
PYEOF
  else
    echo "settings.yml secret_key doesn't look like the default placeholder - leaving it (verify by hand if SearXNG ever fails to start)."
  fi
else
  echo "WARNING: $SETTINGS still doesn't exist after bootstrap attempt - check docker compose output above and finish this step by hand (see tools/searxng/docker-compose.yml's header)."
fi

# ---- 3. gemma-auth-proxy LaunchAgent + repoint the tunnel ------------------
PROXY_PLIST="$LAUNCH_AGENTS_DIR/com.gemma-auth-proxy.plist"
log "Installing com.gemma-auth-proxy LaunchAgent"
mkdir -p "$LAUNCH_AGENTS_DIR"
cat > "$PROXY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gemma-auth-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${TOOLS_DIR}/gemma-auth-proxy.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GEMMA_PROXY_SECRET</key>
    <string>${GEMMA_PROXY_SECRET}</string>
    <key>GEMMA_PROXY_PORT</key>
    <string>11435</string>
    <key>OLLAMA_URL</key>
    <string>http://localhost:11434</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/gemma-auth-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/gemma-auth-proxy.log</string>
</dict>
</plist>
EOF
bootout_and_bootstrap "com.gemma-auth-proxy" "$PROXY_PLIST"
sleep 1
if curl -sf -m 3 -o /dev/null -w '' -X POST http://localhost:11435/api/generate -H 'Content-Type: application/json' -H "X-Gemma-Key: ${GEMMA_PROXY_SECRET}" -d '{"model":"gemma4:e4b","prompt":"ping","stream":false}'; then
  echo "Proxy is up and forwarding real requests on :11435."
else
  echo "WARNING: proxy didn't respond as expected on :11435 - check /tmp/gemma-auth-proxy.log"
fi

TUNNEL_PLIST="$LAUNCH_AGENTS_DIR/com.cloudflared.gemma-tunnel.plist"
if [ -f "$TUNNEL_PLIST" ]; then
  if grep -q "localhost:11434" "$TUNNEL_PLIST"; then
    log "Repointing the Cloudflare Tunnel at the proxy (11434 -> 11435)"
    cp "$TUNNEL_PLIST" "$TUNNEL_PLIST.bak"
    sed -i '' 's#localhost:11434#localhost:11435#' "$TUNNEL_PLIST"
    bootout_and_bootstrap "com.cloudflared.gemma-tunnel" "$TUNNEL_PLIST"
    sleep 3
    NEW_URL="$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-gemma.log | tail -1 || true)"
    if [ -n "$NEW_URL" ]; then
      echo "New tunnel URL: ${NEW_URL}"
      echo "Update GEMMA_ENDPOINT to ${NEW_URL}/api/generate in local app/config.js AND the Cloudflare dashboard."
    else
      echo "Could not find a new tunnel URL in /tmp/cloudflared-gemma.log yet - check it manually in a few seconds."
    fi
    echo "Backed up the original tunnel plist to ${TUNNEL_PLIST}.bak"
  elif grep -q "localhost:11435" "$TUNNEL_PLIST"; then
    echo "Tunnel already points at :11435 - nothing to change."
  else
    echo "WARNING: couldn't find localhost:11434 or :11435 in ${TUNNEL_PLIST} - check its --url argument by hand."
  fi
else
  echo "WARNING: ${TUNNEL_PLIST} not found - is the Cloudflare Tunnel LaunchAgent set up under a different name? Repoint it at http://localhost:11435 by hand."
fi

# ---- 4. Weekly scheduling for deal-agent / price-agent, on different days -
# weekday is a real parameter now, not hardcoded - previously both jobs
# were pinned to Sunday inside this function regardless of what HOUR/MIN
# were passed, which is exactly what caused the Gemini-quota collision
# PRICE_AGENT_WEEKDAY's own comment above explains. Changing just the hour
# would never have fixed it.
WEEKDAY_NAMES=(Sun Mon Tue Wed Thu Fri Sat)
install_weekly_agent() {
  local label="$1" script="$2" weekday="$3" hour="$4" minute="$5"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  log "Installing ${label} (${WEEKDAY_NAMES[$weekday]} ${hour}:$(printf '%02d' "$minute"))"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>${weekday}</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.log</string>
</dict>
</plist>
EOF
  bootout_and_bootstrap "${label}" "$plist"
}
install_weekly_agent "com.deal-agent.weekly" "${TOOLS_DIR}/run-deal-agent.sh" "0" "$DEAL_AGENT_HOUR" "$DEAL_AGENT_MIN"
install_weekly_agent "com.price-agent.weekly" "${TOOLS_DIR}/run-price-agent.sh" "$PRICE_AGENT_WEEKDAY" "$PRICE_AGENT_HOUR" "$PRICE_AGENT_MIN"

# A fourth shape, genuinely not a reuse of the three above:
# install_weekly_agent hardcodes ONE Weekday integer, and the recap needs
# to fire Monday through Friday. launchd takes an ARRAY of
# StartCalendarInterval dicts for exactly this, so this emits five - one
# per weekday - rather than installing five separate labels.
install_weekday_agent() {
  local label="$1" script="$2" hour="$3" minute="$4"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  log "Installing ${label} (weekdays ${hour}:$(printf '%02d' "$minute"))"
  local entries=""
  for weekday in 1 2 3 4 5; do
    entries+="    <dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
"
  done
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${entries}  </array>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.log</string>
</dict>
</plist>
EOF
  bootout_and_bootstrap "${label}" "$plist"
}
install_weekday_agent "com.daily-recap.weekday" "${TOOLS_DIR}/run-daily-recap.sh" "$DAILY_RECAP_HOUR" "$DAILY_RECAP_MIN"

# ---- 5. Frequent scheduling for embed-expenses.js (RAG retrieval) ---------
# StartInterval (seconds, repeating) rather than StartCalendarInterval
# (a single fixed time) - the whole point of the content-hash delta design
# is that a frequent no-op run is cheap, unlike deal/price-agent which
# genuinely do real search+fetch+Gemma work worth staggering to once a week.
install_interval_agent() {
  local label="$1" script="$2" interval_seconds="$3"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  log "Installing ${label} (every ${interval_seconds}s)"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script}</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval_seconds}</integer>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.log</string>
</dict>
</plist>
EOF
  bootout_and_bootstrap "${label}" "$plist"
}
install_interval_agent "com.embed-expenses.hourly" "${TOOLS_DIR}/run-embed-expenses.sh" "$EMBED_EXPENSES_INTERVAL_SECONDS"

# ---- 6. Frequent scheduling for price-agent.js's FAST_ONLY mode ----------
# Same install_interval_agent shape as embed-expenses.hourly above - real
# ticker prices only, straight to Finnhub, cheap enough to run often (see
# price-agent.js's own header comment for the call-volume accounting).
install_interval_agent "com.price-agent.fast" "${TOOLS_DIR}/run-price-agent-fast.sh" "$PRICE_AGENT_FAST_INTERVAL_SECONDS"

# ---- 7. Monthly scheduling for monthly-report.js --------------------------
# A genuine third shape, not a reuse of install_weekly_agent (hardcodes a
# Weekday key, no day-of-month concept) or install_interval_agent (a plain
# StartInterval in seconds would drift off real calendar-month boundaries
# over time, and doesn't map to "the month that just ended" the way a
# fixed Day-of-month does). Previously had no launchd job at all - its own
# header comment even said scheduling was "a one-line addition once you're
# ready," which was never actually added; the Reports page's Monthly
# report card could never show anything but "No monthly reports yet"
# without someone running this by hand.
install_monthly_agent() {
  local label="$1" script="$2" day="$3" hour="$4" minute="$5"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  log "Installing ${label} (day ${day} of each month, ${hour}:$(printf '%02d' "$minute"))"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key>
    <integer>${day}</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.log</string>
</dict>
</plist>
EOF
  bootout_and_bootstrap "${label}" "$plist"
}
install_monthly_agent "com.monthly-report.monthly" "${TOOLS_DIR}/run-monthly-report.sh" "$MONTHLY_REPORT_DAY" "$MONTHLY_REPORT_HOUR" "$MONTHLY_REPORT_MIN"

log "Done"
echo "Scheduled: deal-agent ${WEEKDAY_NAMES[0]}s ${DEAL_AGENT_HOUR}:$(printf '%02d' "$DEAL_AGENT_MIN"), price-agent (full) ${WEEKDAY_NAMES[$PRICE_AGENT_WEEKDAY]}s ${PRICE_AGENT_HOUR}:$(printf '%02d' "$PRICE_AGENT_MIN") - deliberately different days, see PRICE_AGENT_WEEKDAY's own comment above for why. embed-expenses every ${EMBED_EXPENSES_INTERVAL_SECONDS}s (cheap thanks to content-hash delta detection - most runs do nothing). price-agent (FAST_ONLY, Finnhub-only real ticker prices) every ${PRICE_AGENT_FAST_INTERVAL_SECONDS}s. monthly-report day ${MONTHLY_REPORT_DAY} of each month at ${MONTHLY_REPORT_HOUR}:$(printf '%02d' "$MONTHLY_REPORT_MIN")."
echo "Test any agent right now with: DRY_RUN=1 ./run-deal-agent.sh   (or run-price-agent.sh / run-price-agent-fast.sh / run-embed-expenses.sh / run-monthly-report.sh)"
echo "Remember to flip DEAL_FINDINGS_ENABLED / PRICE_FINDINGS_ENABLED to true in app/config.js and the Cloudflare dashboard once you're ready to surface results in the UI. RAG retrieval for the Q&A needs no such flag - it's best-effort and just silently contributes nothing until embed-expenses.js has actually run once."
