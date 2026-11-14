#!/usr/bin/env bash
# Installs TIMON as a systemd --user daemon on a VPS (step 4.5).
#
#   bash scripts/install-linux.sh
#   bash scripts/install-linux.sh --dry-run
#
# Checks Node ≥ 20 and git, clones/pulls into ~/timon, `npm ci && npm run
# build` (orchestrator + app), generates the unit from the template
# (WorkingDirectory = installDir), `loginctl enable-linger $USER`,
# `systemctl --user enable --now timon-orchestrator`, prints `timon doctor`.
#
# Idempotent: a second run pulls, rewrites the same unit, enable --now is a
# start (not a restart) if the service is already running, linger is a no-op.
#
# Do NOT run this from a TIMON mission: rewriting the prod machine's live
# unit would target ~/timon and `enable --now` would touch the running
# daemon. --dry-run writes nothing and calls neither systemctl nor loginctl.
set -euo pipefail

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      echo
      echo "usage: $0 [--dry-run] [--force]"
      echo "  TIMON_INSTALL_DIR  clone target (default: \$HOME/timon)"
      echo "  TIMON_REPO_URL     git repo (default: script's origin, else Timon)"
      echo "  TIMON_HOME         config/secrets (default: \$HOME/.timon)"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 64
      ;;
  esac
done

# $0 is not a file when piped (curl | bash): we'll read the template from
# the clone afterward.
_src=${BASH_SOURCE[0]-}
if [ -n "$_src" ] && [ -f "$_src" ]; then
  SCRIPT_DIR=$(cd "$(dirname "$_src")" && pwd)
else
  SCRIPT_DIR=""
fi

USER_NAME="${USER:-$(id -un)}"
INSTALL_DIR="${TIMON_INSTALL_DIR:-$HOME/timon}"
TIMON_HOME="${TIMON_HOME:-$HOME/.timon}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/timon-orchestrator.service"
DEFAULT_REPO_URL="https://github.com/ai-timon/timon.git"

# ── paths ────────────────────────────────────────────────────────────────────

expand_install_dir() {
  case "$INSTALL_DIR" in
    ~) INSTALL_DIR="$HOME" ;;
    ~/*) INSTALL_DIR="$HOME/${INSTALL_DIR#~/}" ;;
  esac
  case "$INSTALL_DIR" in
    /*) ;;
    *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;
  esac
}

default_repo_url() {
  local url=""
  if [ -n "$SCRIPT_DIR" ] && command -v git >/dev/null 2>&1; then
    url=$(git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null || true)
  fi
  if [ -n "$url" ]; then
    printf '%s\n' "$url"
  else
    printf '%s\n' "$DEFAULT_REPO_URL"
  fi
}

REPO_URL="${TIMON_REPO_URL:-$(default_repo_url)}"
expand_install_dir
INSTALL_ORCH="$INSTALL_DIR/orchestrator"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "REFUSED: $1 not found" >&2
    exit 1
  fi
}

require_node() {
  need_cmd node
  local raw major
  raw=$(node -v 2>/dev/null || true)
  raw=${raw#v}
  major=${raw%%.*}
  case "$major" in
    ''|*[!0-9]*)
      echo "REFUSED: unreadable Node version (${raw:-empty})" >&2
      exit 1
      ;;
  esac
  if [ "$major" -lt 20 ]; then
    echo "REFUSED: Node ≥ 20 required (found v$raw)" >&2
    exit 1
  fi
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ %s\n' "$*"
    return 0
  fi
  "$@"
}

run_in() {
  local dir=$1
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ (cd %s && %s)\n' "$dir" "$*"
    return 0
  fi
  (cd "$dir" && "$@")
}

resolve_template() {
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../orchestrator/scripts/timon-orchestrator.service.template" ]; then
    printf '%s\n' "$SCRIPT_DIR/../orchestrator/scripts/timon-orchestrator.service.template"
    return
  fi
  printf '%s\n' "$INSTALL_DIR/orchestrator/scripts/timon-orchestrator.service.template"
}

render_unit() {
  local template=$1
  if [ ! -f "$template" ]; then
    echo "REFUSED: systemd template not found — $template" >&2
    exit 1
  fi
  # `@PORT@`/`@HEAP@` (step 5.7.6): a repo install keeps the historical values,
  # while `timon service install` substitutes what the config asks for.
  sed -e "s|@REPO@|${INSTALL_DIR}|g" -e "s|@USER@|${USER_NAME}|g" \
      -e "s|@PORT@|${PORT:-3000}|g" -e "s|@HEAP@|${HEAP_MB:-4096}|g" "$template"
}

install_dir_for_config() {
  case "$INSTALL_ORCH" in
    "$HOME"/*) printf '~/%s' "${INSTALL_ORCH#"$HOME"/}" ;;
    *) printf '%s' "$INSTALL_ORCH" ;;
  esac
}

json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# ── guards ───────────────────────────────────────────────────────────────────

# enable --now on the prod machine would kill live missions. --dry-run is
# allowed: it doesn't call systemctl.
if [ -n "${TIMON_MISSION_ID:-}" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "REFUSED: this script is running inside a TIMON mission (TIMON_MISSION_ID=${TIMON_MISSION_ID})." >&2
  echo "         Rewriting the live unit and enable --now would touch the prod daemon." >&2
  echo "         Run it from a real terminal, on the target VPS." >&2
  exit 1
fi

require_node
need_cmd git
need_cmd npm
need_cmd loginctl
need_cmd systemctl

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "REFUSED: $INSTALL_DIR exists and is not a git repo" >&2
  exit 1
fi

if [ -f "$UNIT_FILE" ] && [ "$FORCE" -eq 0 ]; then
  live_wd=$(grep -E '^WorkingDirectory=' "$UNIT_FILE" | head -n1 | cut -d= -f2- || true)
  if [ -n "$live_wd" ] && [ "$live_wd" != "$INSTALL_ORCH" ]; then
    echo "REFUSED: the live unit points elsewhere ($live_wd), not $INSTALL_ORCH." >&2
    echo "         This script is for a fresh VPS (target ~/timon). --force to overwrite." >&2
    exit 1
  fi
fi

echo "install  : $INSTALL_DIR"
echo "origin   : $REPO_URL"
echo "TIMON_HOME: $TIMON_HOME"
echo "unit     : $UNIT_FILE"
[ "$DRY_RUN" -eq 1 ] && echo "(dry-run: no write command, no systemctl)"
echo

# ── clone / pull ─────────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  run git -C "$INSTALL_DIR" pull --ff-only
else
  run git clone "$REPO_URL" "$INSTALL_DIR"
fi

run_in "$INSTALL_DIR/orchestrator" npm ci
run_in "$INSTALL_DIR/orchestrator" npm run build
run_in "$INSTALL_DIR/app" npm ci
run_in "$INSTALL_DIR/app" npm run build
# The mission launcher (Landlock + seccomp), found by the daemon in
# native/timon-fence/build/. Optional: without a C compiler the build is
# skipped, missions run unfenced and `timon doctor` says so.
run_in "$INSTALL_DIR" node native/timon-fence/build.mjs --optional

# ── config: installDir, only if the file doesn't already exist ──────────────
# Without this the daemon falls back on the folder its code was built in,
# which may not be where it runs on a VPS. We never overwrite an existing config.

CFG="$TIMON_HOME/timon.config.json"
if [ -f "$CFG" ]; then
  echo "config already present: $CFG (unchanged)"
else
  cfg_body=$(printf '%s\n' \
    '{' \
    '  "profile": "linux-server",' \
    "  \"daemon\": { \"installDir\": $(json_string "$(install_dir_for_config)") }," \
    '  "host": { "traefik": false }' \
    '}')
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ mkdir -p %s\n' "$TIMON_HOME"
    printf '+ write %s\n%s\n' "$CFG" "$cfg_body"
  else
    mkdir -p "$TIMON_HOME"
    printf '%s\n' "$cfg_body" > "$CFG"
    echo "config written: $CFG"
  fi
fi

# ── systemd unit ─────────────────────────────────────────────────────────────

TEMPLATE=$(resolve_template)
UNIT_BODY=$(render_unit "$TEMPLATE")
echo "----- timon-orchestrator.service -----"
printf '%s\n' "$UNIT_BODY"
echo "-----"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ mkdir -p %s\n' "$UNIT_DIR"
  printf '+ write %s\n' "$UNIT_FILE"
else
  mkdir -p "$UNIT_DIR"
  printf '%s\n' "$UNIT_BODY" > "$UNIT_FILE"
fi

run loginctl enable-linger "$USER_NAME"
run systemctl --user daemon-reload
run systemctl --user enable --now timon-orchestrator

TIMON_BIN="$INSTALL_DIR/orchestrator/bin/timon"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ %s doctor\n' "$TIMON_BIN"
  echo "dry-run OK"
  exit 0
fi

"$TIMON_BIN" doctor
