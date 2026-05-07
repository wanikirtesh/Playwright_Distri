#!/usr/bin/env bash
###############################################################################
# Playwright Distributed Coordinator — One-shot bootstrap & runner (Linux)
#
# Usage:
#   First time on a fresh VM/host:
#     REPO_URL=https://github.com/<user>/<repo>.git bash setup-coordinator.sh
#
#   Subsequent runs (pull latest + dispatch a test run):
#     bash ~/playwright_distri/scripts/setup-coordinator.sh
#
# Optional env vars:
#   REPO_URL      Git URL (required on first run only)
#   BRANCH        Branch to track (default: main)
#   APP_DIR       Clone target (default: ~/playwright_distri)
#   CONFIG        Config file passed to coordinator (default: config.json)
#   NODE_MAJOR    Required Node.js major version (default: 20)
#   SKIP_RUN      If "1", only setup; do not invoke the coordinator.
#   EXTRA_ARGS    Extra CLI args passed verbatim to coordinator.js
#
# This script is idempotent: safe to run on first install and every time after.
# Unlike the agent, the coordinator is run on demand (not as a service), so
# this script ends by invoking the coordinator once.
###############################################################################
set -euo pipefail

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/playwright_distri}"
CONFIG="${CONFIG:-config.json}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SKIP_RUN="${SKIP_RUN:-0}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

if [[ -z "$REPO_URL" && ! -d "$APP_DIR/.git" ]]; then
  echo "ERROR: REPO_URL env var is required on first run." >&2
  echo "Example: REPO_URL=https://github.com/you/playwright_distri.git bash $0" >&2
  exit 1
fi

log() { echo -e "\033[1;35m[coordinator-setup]\033[0m $*"; }

SUDO=""
if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ─── 1. Detect package manager ───────────────────────────────────────────────
PKG=""
if   command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf     >/dev/null 2>&1; then PKG="dnf"
elif command -v yum     >/dev/null 2>&1; then PKG="yum"
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

# ─── 6. Pre-flight: verify config exists ─────────────────────────────────────
if [[ ! -f "$APP_DIR/$CONFIG" ]]; then
  echo "ERROR: config file '$CONFIG' not found in $APP_DIR." >&2
  echo "Provide one via the repo or set CONFIG=<path>." >&2
  exit 1
fi

mkdir -p "$APP_DIR/reports"

# ─── 7. Run the coordinator (unless SKIP_RUN=1) ──────────────────────────────
if [[ "$SKIP_RUN" == "1" ]]; then
  log "Setup complete. SKIP_RUN=1 — not invoking coordinator."
  log "To run manually:  node $APP_DIR/coordinator/coordinator.js --config=$CONFIG"
  exit 0
fi

log "Dispatching coordinator with --config=$CONFIG $EXTRA_ARGS"
exec node "$APP_DIR/coordinator/coordinator.js" --config="$CONFIG" $EXTRA_ARGS
