#!/usr/bin/env bash
# ============================================================================
# One-shot SERVER MACHINE bootstrap - run this on whichever machine is
# colocated with Ollama, from the tools/ directory. Idempotent: safe to
# re-run after a partial failure or to pick up a change.
#
# Sets up the whole home-machine side of this app's optional live-data
# pipeline (F6 deal discovery + live asset pricing + RAG retrieval all
# share this same setup):
#   1. tools/.env.deal-agent (prompts for the Supabase service_role key -
#      never put it in this script or in chat, it bypasses RLS entirely)
#   2. SearXNG's one-time settings.yml edits (JSON format + a real secret_key)
#   3. tools/gemma-auth-proxy.js running persistently as a LaunchAgent, and
#      the existing Cloudflare Tunnel LaunchAgent repointed at it instead of
#      Ollama directly - a bare quick tunnel has no auth in front of it, so
#      anyone who found the URL could hit your home GPU for free; this
#      closes that gap with a shared-secret header the tunnel now requires
#   4. Weekly launchd schedules for run-deal-agent.sh and run-price-agent.sh,
#      deliberately staggered - both scripts bring up/tear down the SAME
#      named SearXNG container, so running them concurrently would have one
#      script's cleanup trap kill SearXNG out from under the other mid-run.
#   5. An hourly launchd schedule for embed-expenses.js (RAG retrieval for
#      the Reports page's "Ask about your spending" Q&A - see
#      supabase/45_expense_embeddings.sql) - much tighter than the weekly
#      deal/price cadence on purpose: its content-hash delta detection
#      makes an unchanged expense cost one comparison, not a search+fetch+
#      Gemma round trip, so a frequent run is cheap, and new expenses
#      should become searchable soon after they're added rather than up to
#      a week later.
#
# Usage:
#   cd tools
#   ./setup-server-machine.sh
#
# Optional env overrides:
#   GEMMA_PROXY_SECRET   - must match app/config.js's GEMMA_AUTH_KEY and the
#                           Cloudflare dashboard's GEMMA_AUTH_KEY exactly, or
#                           the app's real requests will get 401s from the
#                           proxy. Auto-generated with openssl if you don't
#                           pass one - the script prints whatever value it
#                           ends up using, copy that into both config spots.
#                           Pass the SAME value explicitly on any future
#                           re-run (or save what got generated), otherwise a
#                           fresh random secret each run will stop matching
#                           what you already put in config.js/the dashboard.
#   DEAL_AGENT_HOUR/MIN, PRICE_AGENT_HOUR/MIN - launchd schedule (defaults
#                           Sunday 03:00 and Sunday 05:00, local time)
#   EMBED_EXPENSES_INTERVAL_SECONDS - how often embed-expenses.js runs
#                           (default 3600 = hourly)
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
EMBED_EXPENSES_INTERVAL_SECONDS="${EMBED_EXPENSES_INTERVAL_SECONDS:-3600}"

echo "Using GEMMA_PROXY_SECRET: ${GEMMA_PROXY_SECRET}"
echo "(copy this into app/config.js's GEMMA_AUTH_KEY and the Cloudflare dashboard's GEMMA_AUTH_KEY - see the env override notes above)"

log() { echo "== $* =="; }

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
  read -r -p "Supabase project URL (https://YOUR-PROJECT-REF.supabase.co): " SB_URL
  if [ -z "$SB_URL" ]; then
    echo "No project URL entered - aborting." >&2
    exit 1
  fi
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
with open(path, "w") as f:
    f.writelines(out)
print("inserted formats: [html, json]" if inserted else "WARNING: no top-level 'search:' key found - add formats: [html, json] under it by hand")
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
launchctl bootout "$UID_GUI/com.gemma-auth-proxy" 2>/dev/null || true
launchctl bootstrap "$UID_GUI" "$PROXY_PLIST"
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
    launchctl bootout "$UID_GUI/com.cloudflared.gemma-tunnel" 2>/dev/null || true
    launchctl bootstrap "$UID_GUI" "$TUNNEL_PLIST"
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

# ---- 4. Weekly scheduling for deal-agent / price-agent, staggered ---------
install_weekly_agent() {
  local label="$1" script="$2" hour="$3" minute="$4"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  log "Installing ${label} (Sun ${hour}:$(printf '%02d' "$minute"))"
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
    <integer>0</integer>
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
  launchctl bootout "$UID_GUI/${label}" 2>/dev/null || true
  launchctl bootstrap "$UID_GUI" "$plist"
}
install_weekly_agent "com.deal-agent.weekly" "${TOOLS_DIR}/run-deal-agent.sh" "$DEAL_AGENT_HOUR" "$DEAL_AGENT_MIN"
install_weekly_agent "com.price-agent.weekly" "${TOOLS_DIR}/run-price-agent.sh" "$PRICE_AGENT_HOUR" "$PRICE_AGENT_MIN"

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
  launchctl bootout "$UID_GUI/${label}" 2>/dev/null || true
  launchctl bootstrap "$UID_GUI" "$plist"
}
install_interval_agent "com.embed-expenses.hourly" "${TOOLS_DIR}/run-embed-expenses.sh" "$EMBED_EXPENSES_INTERVAL_SECONDS"

log "Done"
echo "Scheduled: deal-agent Sundays ${DEAL_AGENT_HOUR}:$(printf '%02d' "$DEAL_AGENT_MIN"), price-agent Sundays ${PRICE_AGENT_HOUR}:$(printf '%02d' "$PRICE_AGENT_MIN") (staggered on purpose - both scripts share one SearXNG container and tear it down on exit, so overlapping runs would kill each other's SearXNG mid-run). embed-expenses every ${EMBED_EXPENSES_INTERVAL_SECONDS}s (cheap thanks to content-hash delta detection - most runs do nothing)."
echo "Test any agent right now with: DRY_RUN=1 ./run-deal-agent.sh   (or run-price-agent.sh / run-embed-expenses.sh)"
echo "Remember to flip DEAL_FINDINGS_ENABLED / PRICE_FINDINGS_ENABLED to true in app/config.js and the Cloudflare dashboard once you're ready to surface results in the UI. RAG retrieval for the Q&A needs no such flag - it's best-effort and just silently contributes nothing until embed-expenses.js has actually run once."
