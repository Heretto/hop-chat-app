#!/usr/bin/env bash
# Install (on first run) and start HOP Chat locally: the FastAPI backend and the
# Angular admin UI, on free ports, with the browser opened on the admin UI.
#
#   ./dev.sh              install what's missing, then run
#   ./dev.sh --install    install/refresh dependencies only
#   ./dev.sh --no-open    run without opening a browser
#   ./dev.sh --reload     restart the backend when its code changes
#
# Modelled on hop-core's demo/run.sh. Ctrl+C stops both servers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
VENV="$BACKEND_DIR/.venv"

INSTALL_ONLY=false
OPEN_BROWSER=true
RELOAD=false
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL_ONLY=true ;;
    --no-open) OPEN_BROWSER=false ;;
    --reload)  RELOAD=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

die() { echo "Error: $*" >&2; exit 1; }

# Nothing may fail silently: with set -e, a failing command otherwise just ends
# the script mid-output. Name the line and command instead.
trap 'status=$?; echo "" >&2; echo "Error: dev.sh stopped at line $LINENO (exit $status): $BASH_COMMAND" >&2; exit $status' ERR

free_port() {
  # Portable: lsof is not installed everywhere.
  python3 - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
while True:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            break
        except OSError:
            port += 1
print(port)
PY
}

wait_for_http() {
  local url=$1 label=$2 tries=${3:-30} pid=${4:-}
  printf "  Waiting for %s" "$label"
  for _ in $(seq 1 "$tries"); do
    if curl -sf "$url" &>/dev/null; then printf " ✓\n"; return 0; fi
    # Stop waiting as soon as the server has died.
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then printf " exited\n"; return 1; fi
    printf "."
    sleep 1
  done
  printf " timed out\n"
  return 1
}

# A stamp of the dependency files, so a changed pin reinstalls automatically.
stamp_of() { cat "$@" | python3 -c "import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"; }

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v python3 &>/dev/null || die "python3 not found — install Python 3.11+"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' \
  || die "Python 3.11+ is required (found $(python3 -V 2>&1))"
command -v git  &>/dev/null || die "git not found — hop-core is installed from its GitHub release tag"
command -v node &>/dev/null || die "node not found — install Node.js 24.15+ (or 22.22.3+)"
command -v npm  &>/dev/null || die "npm not found"
command -v curl &>/dev/null || die "curl not found"

# Angular 22 refuses older Node (hop-core AGENTS.md §7).
node -e '
  const [a, b, c] = process.versions.node.split(".").map(Number);
  const ok = a > 24 || (a === 24 && b >= 15) || (a === 22 && (b > 22 || (b === 22 && c >= 3)));
  process.exit(ok ? 0 : 1);
' || die "Node $(node -v) is too old for Angular 22 — install Node 24.15+ (or 22.22.3+)"

echo "  Using Python $(python3 -c 'import platform; print(platform.python_version())') at $(command -v python3)"

# ── Install ───────────────────────────────────────────────────────────────────

# Backend: a venv with hop-core at the tag pinned in requirements.txt.
# A venv whose interpreter has gone (e.g. Homebrew upgraded Python) is rebuilt.
if [ -d "$VENV" ] && ! "$VENV/bin/python" -c "pass" &>/dev/null; then
  echo "  The backend virtualenv is broken (its Python has moved) — recreating it..."
  rm -rf "$VENV"
fi
if [ ! -x "$VENV/bin/python" ]; then
  echo "  Creating backend virtualenv in backend/.venv..."
  python3 -m venv "$VENV" || die "could not create a virtualenv with $(command -v python3)"
fi
BACKEND_STAMP="$(stamp_of "$BACKEND_DIR/requirements.txt" "$BACKEND_DIR/requirements-dev.txt")"
if [ "$(cat "$VENV/.deps-stamp" 2>/dev/null || true)" != "$BACKEND_STAMP" ] \
   || ! "$VENV/bin/python" -c "import hop_core, uvicorn" &>/dev/null; then
  echo "  Installing backend dependencies into backend/.venv (hop-core from its release tag)."
  echo "  The first install downloads about 60 packages and can take a few minutes..."
  # A venv made by uv (or some distro Pythons) has no pip until asked.
  if ! "$VENV/bin/python" -m pip --version &>/dev/null; then
    "$VENV/bin/python" -m ensurepip --upgrade \
      || die "the virtualenv has no pip and ensurepip failed — try a python.org or Homebrew Python"
  fi
  "$VENV/bin/python" -m pip install --disable-pip-version-check -q --upgrade pip \
    || die "could not upgrade pip in backend/.venv"
  # Not -q: a first install is long, and a package building from source should be visible.
  "$VENV/bin/python" -m pip install --disable-pip-version-check --progress-bar on \
      -r "$BACKEND_DIR/requirements-dev.txt" \
    || die "backend install failed — see the pip output above"
  echo "  Backend dependencies installed ✓"
  echo "$BACKEND_STAMP" > "$VENV/.deps-stamp"
fi

# Frontend: reinstall when the lock file, the platform or the Node version
# changes — node_modules holds native binaries (esbuild, lmdb) for one OS/CPU,
# so a checkout shared between machines must not reuse another's install.
FRONTEND_STAMP="$( { cat "$FRONTEND_DIR/package-lock.json"; uname -sm; node -v; } | stamp_of /dev/stdin)"
if [ ! -d "$FRONTEND_DIR/node_modules" ] \
   || [ "$(cat "$FRONTEND_DIR/node_modules/.deps-stamp" 2>/dev/null || true)" != "$FRONTEND_STAMP" ]; then
  echo "  Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm ci --no-audit --no-fund --loglevel=error) \
    || die "frontend install failed — see the npm output above"
  echo "$FRONTEND_STAMP" > "$FRONTEND_DIR/node_modules/.deps-stamp"
fi

# Settings: generate backend/.env with fresh secrets if missing.
if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo "  No backend/.env found — generating secrets..."
  "$SCRIPT_DIR/scripts/setup.sh"
fi

if $INSTALL_ONLY; then
  echo ""
  echo "Dependencies installed. Run ./dev.sh to start."
  exit 0
fi

# ── Pick free ports ───────────────────────────────────────────────────────────

BACKEND_PORT=$(free_port "${BACKEND_PORT:-8000}")
FRONTEND_PORT=$(free_port "${FRONTEND_PORT:-4200}")
PUBLIC_URL="http://localhost:${FRONTEND_PORT}"

# ── Write a proxy config for the chosen backend port ─────────────────────────
# The admin UI, the API and the visitor chat share one origin, as in production.

# ng picks the proxy-config format from the extension, so it must end in .json;
# a directory keeps that portable (BSD mktemp cannot add a suffix).
# Keys are path prefixes, so the trailing slashes matter: a bare "/c" would also
# send the app's /chunk-*.js bundles and /chat-apps, /credentials to the backend.
PROXY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hop-chat-proxy.XXXXXX")
PROXY_CONF="$PROXY_DIR/proxy.json"
cat > "$PROXY_CONF" <<EOF
{
  "/api/":    { "target": "http://127.0.0.1:${BACKEND_PORT}", "secure": false },
  "/c/":      { "target": "http://127.0.0.1:${BACKEND_PORT}", "secure": false },
  "/embed/":  { "target": "http://127.0.0.1:${BACKEND_PORT}", "secure": false },
  "/widget/": { "target": "http://127.0.0.1:${BACKEND_PORT}", "secure": false }
}
EOF

# ── Cleanup on exit ───────────────────────────────────────────────────────────

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$BACKEND_PID"  ] && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  rm -rf "$PROXY_DIR"
}
trap cleanup EXIT INT TERM

# ── Start backend ─────────────────────────────────────────────────────────────

echo ""
echo "Starting HOP Chat"
echo "  Backend  → http://localhost:${BACKEND_PORT}   (API docs: /docs)"
echo "  Admin UI → ${PUBLIC_URL}"
echo ""

# SQLite does not create a missing parent directory; it fails at startup with
# "unable to open database file". Relative paths resolve from backend/.
DB_URL="${DATABASE_URL:-$(sed -n 's/^DATABASE_URL=//p' "$BACKEND_DIR/.env" 2>/dev/null | tail -n 1)}"
case "$DB_URL" in
  sqlite:///*) (cd "$BACKEND_DIR" && mkdir -p "$(dirname "${DB_URL#sqlite:///}")") ;;
esac

# Off by default, as in hop-core's demo: uvicorn's reloader outlives an app that
# fails to start, so a broken backend would only be noticed at the timeout.
RELOAD_ARGS=()
$RELOAD && RELOAD_ARGS=(--reload --reload-dir app)

(
  cd "$BACKEND_DIR"
  # Embed snippets and chat URLs are built from PUBLIC_BASE_URL, so it must be
  # the port the browser actually uses. Environment beats backend/.env.
  PUBLIC_BASE_URL="$PUBLIC_URL" \
  FRONTEND_BASE_URL="$PUBLIC_URL" \
  CORS_ORIGINS="$PUBLIC_URL" \
    exec "$VENV/bin/uvicorn" app.main:app \
      ${RELOAD_ARGS[@]+"${RELOAD_ARGS[@]}"} \
      --host 127.0.0.1 \
      --port "$BACKEND_PORT" \
      --log-level warning
) &
BACKEND_PID=$!

wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/health" "backend" 45 "$BACKEND_PID" \
  || die "Backend did not start — check for errors above"

# ── Start frontend ────────────────────────────────────────────────────────────

(
  cd "$FRONTEND_DIR"
  # ng serve runs backgrounded with no interactive stdin — suppress CLI
  # first-run prompts, which otherwise crash with "User force closed the prompt".
  export NG_CLI_ANALYTICS=false
  export CI=1
  # The local binary, not npx: exec then makes $FRONTEND_PID ng itself, so
  # cleanup stops it rather than a wrapper that leaves ng running.
  exec ./node_modules/.bin/ng serve \
    --port "$FRONTEND_PORT" \
    --proxy-config "$PROXY_CONF" \
    --configuration development \
    --no-open
) &
FRONTEND_PID=$!

wait_for_http "${PUBLIC_URL}/" "admin UI" 120 "$FRONTEND_PID" \
  || die "Admin UI did not start — check for errors above"

# ── Open browser ──────────────────────────────────────────────────────────────

echo ""
echo "HOP Chat is live → ${PUBLIC_URL}"
echo "  Register, then: Credentials (AI provider + Heretto Deploy) → Agents → Chat Apps."
echo "Press Ctrl+C to stop."
echo ""

if $OPEN_BROWSER; then
  if command -v open &>/dev/null; then
    open "$PUBLIC_URL"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$PUBLIC_URL" &>/dev/null || true
  fi
fi

# Keep running until either process exits or Ctrl+C
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 2
done
