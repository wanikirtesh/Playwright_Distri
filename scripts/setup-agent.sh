#!/usr/bin/env bash
###############################################################################
# Playwright Distributed Agent — One-shot bootstrap & runner (Linux)
#
# Usage (first time and every time after):
#   REPO_URL=https://github.com/<user>/<repo>.git \
#   AGENT_PORT=3001 AGENT_ID=vm-1 \
#   bash setup-agent.sh
#
# Optional env vars:
#   WAIT_MODE     What to do after successful health check:
#                 - exit    (default): finish script
#                 - logs    : follow agent.log
#                 - journal : follow systemd journal (falls back to logs)
#                 - wait    : keep process alive while agent is running
#
# What it does (idempotent):
#   1. Installs Node.js (LTS) if missing.
#   2. Installs git if missing.
#   3. Clones repo if not present, otherwise pulls latest changes.
#   4. Runs `npm install` (fast no-op if up to date).
#   5. Installs Playwright browsers + system deps if missing.
#   6. Installs/updates a systemd service so the agent auto-starts on boot
#      and restarts on failure. If systemd is not available, falls back to
#      nohup + pid file.
#   7. Restarts the agent so the latest code is running.
###############################################################################
set -euo pipefail

# ─── Config (override via env vars) ──────────────────────────────────────────
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/playwright_distri}"
AGENT_PORT="${AGENT_PORT:-3001}"
AGENT_ID="${AGENT_ID:-$(hostname)}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="${SERVICE_NAME:-playwright-agent}"
WAIT_MODE="${WAIT_MODE:-exit}"

if [[ -z "$REPO_URL" && ! -d "$APP_DIR/.git" ]]; then
  echo "ERROR: REPO_URL env var is required on first run." >&2
  echo "Example: REPO_URL=https://github.com/you/playwright_distri.git bash $0" >&2
  exit 1
fi

log() { echo -e "\033[1;36m[setup]\033[0m $*"; }

SUDO=""
if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

# ─── 1. Detect package manager ───────────────────────────────────────────────
PKG=""
if   command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf     >/dev/null 2>&1; then PKG="dnf"
elif command -v yum     >/dev/null 2>&1; then PKG="yum"
else
  log "WARNING: unsupported package manager; assuming deps are present."
fi

pkg_install() {
  case "$PKG" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    yum) $SUDO yum install -y "$@" ;;
  esac
}

# ─── 2. Install git ──────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  log "Installing git..."
  pkg_install git
fi

# ─── 3. Install Node.js if missing or too old ────────────────────────────────
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  current_major=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [[ "$current_major" -lt "$NODE_MAJOR" ]]; then need_node=1; fi
fi

if [[ "$need_node" -eq 1 ]]; then
  log "Installing Node.js $NODE_MAJOR..."
  case "$PKG" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
      $SUDO $PKG install -y nodejs
      ;;
    *)
      echo "Please install Node.js $NODE_MAJOR+ manually." >&2; exit 1 ;;
  esac
fi
log "Node $(node -v), npm $(npm -v)"

# ─── 4. Clone or update repo ─────────────────────────────────────────────────
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -d "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    if [[ -z "$REPO_URL" ]]; then
      echo "ERROR: APP_DIR exists and is not a git repo; REPO_URL is required to recover." >&2
      exit 1
    fi
    BACKUP_DIR="${APP_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
    log "APP_DIR exists but is not a git repo. Backing it up to $BACKUP_DIR"
    mv "$APP_DIR" "$BACKUP_DIR"
  fi
  log "Cloning $REPO_URL into $APP_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  log "Pulling latest changes in $APP_DIR..."
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"

# ─── 5. npm install ──────────────────────────────────────────────────────────
log "Installing npm dependencies..."
npm install --no-audit --no-fund

# ─── 6. Playwright browsers + system deps ────────────────────────────────────
# `playwright install --with-deps` is idempotent; safe to run every time.
log "Installing Playwright browsers and OS dependencies (chromium)..."
if [[ -n "$SUDO" ]]; then
  npx --yes playwright install chromium
  $SUDO env "PATH=$PATH" npx --yes playwright install-deps chromium || true
else
  npx --yes playwright install --with-deps chromium
fi

# ─── 7. Install / update systemd service (or fall back to nohup) ─────────────
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if command -v systemctl >/dev/null 2>&1 && [[ -d /etc/systemd/system ]]; then
  log "Configuring systemd service: $SERVICE_NAME"
  TMP_UNIT="$(mktemp)"
  cat > "$TMP_UNIT" <<EOF
[Unit]
Description=Playwright Distributed Agent ($AGENT_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) $APP_DIR/agent/agent.js --port=$AGENT_PORT --id=$AGENT_ID
Restart=always
RestartSec=5
StandardOutput=append:$APP_DIR/agent.log
StandardError=append:$APP_DIR/agent.log

[Install]
WantedBy=multi-user.target
EOF
  $SUDO mv "$TMP_UNIT" "$SERVICE_FILE"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  $SUDO systemctl restart "$SERVICE_NAME"
  log "Service status:"
  $SUDO systemctl --no-pager status "$SERVICE_NAME" | head -n 12 || true
  log "Logs: tail -f $APP_DIR/agent.log   |   journalctl -u $SERVICE_NAME -f"
else
  log "systemd not available; using nohup fallback."
  PIDFILE="$APP_DIR/agent.pid"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "Stopping previous agent (pid $(cat "$PIDFILE"))..."
    kill "$(cat "$PIDFILE")" || true
    sleep 2
  fi
  nohup node "$APP_DIR/agent/agent.js" --port="$AGENT_PORT" --id="$AGENT_ID" \
    >> "$APP_DIR/agent.log" 2>&1 &
  echo $! > "$PIDFILE"
  log "Agent started (pid $(cat "$PIDFILE")). Logs: tail -f $APP_DIR/agent.log"
fi

# ─── 8. Quick health check ───────────────────────────────────────────────────
log "Waiting for agent to become healthy on port $AGENT_PORT..."
for i in {1..15}; do
  if curl -fsS "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null 2>&1; then
    log "Agent is healthy:"
    curl -s "http://127.0.0.1:${AGENT_PORT}/health"; echo

    case "$WAIT_MODE" in
      exit)
        exit 0
        ;;
      logs)
        log "WAIT_MODE=logs: following $APP_DIR/agent.log (Ctrl+C to stop viewing; service keeps running)."
        exec tail -f "$APP_DIR/agent.log"
        ;;
      journal)
        if command -v systemctl >/dev/null 2>&1 && [[ -d /etc/systemd/system ]]; then
          log "WAIT_MODE=journal: following journalctl -u $SERVICE_NAME (Ctrl+C to stop viewing; service keeps running)."
          exec $SUDO journalctl -u "$SERVICE_NAME" -f
        fi
        log "WAIT_MODE=journal requested but systemd is unavailable; following $APP_DIR/agent.log instead."
        exec tail -f "$APP_DIR/agent.log"
        ;;
      wait)
        log "WAIT_MODE=wait: keeping setup script attached while agent is running (Ctrl+C to exit wait loop)."
        if command -v systemctl >/dev/null 2>&1 && [[ -d /etc/systemd/system ]]; then
          while true; do
            if ! $SUDO systemctl is-active --quiet "$SERVICE_NAME"; then
              echo "ERROR: service '$SERVICE_NAME' is no longer active." >&2
              exit 1
            fi
            sleep 2
          done
        fi
        if [[ -f "$APP_DIR/agent.pid" ]]; then
          while kill -0 "$(cat "$APP_DIR/agent.pid")" 2>/dev/null; do
            sleep 2
          done
          echo "ERROR: agent process is no longer running." >&2
          exit 1
        fi
        echo "ERROR: WAIT_MODE=wait requires systemd service or nohup pid file to monitor." >&2
        exit 1
        ;;
      *)
        echo "ERROR: invalid WAIT_MODE '$WAIT_MODE'. Use one of: exit, logs, journal, wait." >&2
        exit 1
        ;;
    esac
  fi
  sleep 1
done

echo "WARNING: agent did not respond on /health within 15s. Check $APP_DIR/agent.log" >&2
exit 1
