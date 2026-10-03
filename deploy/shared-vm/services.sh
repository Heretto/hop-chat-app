#!/usr/bin/env bash
# Start and stop everything on the shared VM: the edge proxy (Caddy), the
# Release Notes Agent and HOP Chat.
#
# It belongs to the VM, not to any one app: copy it next to the Caddyfile,
#   cp ~/hop-chat-app/deploy/shared-vm/services.sh ~/edge/ && chmod +x ~/edge/services.sh
# and set the paths below once.
#
#   ./services.sh start   [stack…]   start (edge first), --build to rebuild the apps' images
#   ./services.sh stop    [stack…]   stop (edge last)
#   ./services.sh restart [stack…]
#   ./services.sh status  [stack…]
#
# Stacks: edge, release-notes, hop-chat (default: all three).
#
# "stop" uses `docker compose down`: containers are removed, so nothing comes
# back on its own after a reboot (Release Notes' are `restart: always`), but
# data volumes and certificates are kept. Nothing here ever deletes data.
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
EDGE_DIR="$HOME/edge"
RELEASE_NOTES_DIR="$HOME/release-notes-agent"
# The env file Release Notes' production stack was started with (it holds
# POSTGRES_PASSWORD and the other secrets). Required; while it is running,
#   docker inspect release-notes-nginx --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}'
# prints it.
RELEASE_NOTES_ENV_FILE=""
HOP_CHAT_DIR="$HOME/hop-chat-app"
# ─────────────────────────────────────────────────────────────────────────────

ALL_STACKS=(edge release-notes hop-chat)

die() { echo "Error: $*" >&2; exit 1; }
usage() { sed -n '2,19p' "$0"; exit "${1:-0}"; }

# Each stack's `docker compose` invocation, as an array in COMPOSE.
compose_for() {
  case "$1" in
    edge)
      COMPOSE=(docker compose --project-directory "$EDGE_DIR" -f "$EDGE_DIR/docker-compose.proxy.yml") ;;
    release-notes)
      [ -n "$RELEASE_NOTES_ENV_FILE" ] || die "set RELEASE_NOTES_ENV_FILE at the top of $0"
      [ -f "$RELEASE_NOTES_ENV_FILE" ] || die "RELEASE_NOTES_ENV_FILE not found: $RELEASE_NOTES_ENV_FILE"
      COMPOSE=(docker compose --project-directory "$RELEASE_NOTES_DIR" --env-file "$RELEASE_NOTES_ENV_FILE"
               -f "$RELEASE_NOTES_DIR/docker-compose.production.yml") ;;
    hop-chat)
      COMPOSE=(docker compose --project-directory "$HOP_CHAT_DIR" -f "$HOP_CHAT_DIR/docker-compose.yml"
               -f "$HOP_CHAT_DIR/deploy/shared-vm/docker-compose.override.yml") ;;
    *) die "unknown stack \"$1\" (expected: ${ALL_STACKS[*]})" ;;
  esac
}

ensure_edge_network() {
  docker network inspect edge &>/dev/null || { echo "Creating the edge network"; docker network create edge >/dev/null; }
}

start_stack() {
  local build=()
  if $BUILD && [ "$1" != edge ]; then build=(--build); fi
  compose_for "$1"
  echo "── Starting $1"
  "${COMPOSE[@]}" up -d ${build[@]+"${build[@]}"}
}

stop_stack() {
  compose_for "$1"
  echo "── Stopping $1"
  "${COMPOSE[@]}" down
}

status_stack() {
  compose_for "$1"
  echo "── $1"
  "${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
}

# ── Arguments ────────────────────────────────────────────────────────────────
[ $# -ge 1 ] || usage 2
ACTION="$1"; shift
BUILD=false
STACKS=()
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    -h|--help) usage ;;
    *) STACKS+=("$arg") ;;
  esac
done
[ ${#STACKS[@]} -gt 0 ] || STACKS=("${ALL_STACKS[@]}")

# Always act in dependency order, whatever order the stacks were named in.
ordered() {
  local s want
  for s in "${ALL_STACKS[@]}"; do
    for want in "${STACKS[@]}"; do
      if [ "$s" = "$want" ]; then echo "$s"; fi
    done
  done
}
for want in "${STACKS[@]}"; do compose_for "$want"; done   # validate names and settings up front
ORDER=($(ordered))
REVERSE=(); for ((i=${#ORDER[@]}-1; i>=0; i--)); do REVERSE+=("${ORDER[$i]}"); done

command -v docker &>/dev/null || die "docker not found"

case "$ACTION" in
  start)
    ensure_edge_network
    for s in "${ORDER[@]}"; do start_stack "$s"; done ;;
  stop)
    for s in "${REVERSE[@]}"; do stop_stack "$s"; done ;;
  restart)
    for s in "${REVERSE[@]}"; do stop_stack "$s"; done
    ensure_edge_network
    for s in "${ORDER[@]}"; do start_stack "$s"; done ;;
  status)
    for s in "${ORDER[@]}"; do status_stack "$s"; done ;;
  -h|--help) usage ;;
  *) echo "Unknown action \"$ACTION\"." >&2; usage 2 ;;
esac
