#!/usr/bin/env bash
# Reset HOP Chat to a fresh install: delete every account, organization,
# credential, agent, chat app and conversation.
#
#   ./reset-system.sh            show what will be deleted, ask, then wipe
#   ./reset-system.sh --start    ... and start HOP Chat again, empty
#   ./reset-system.sh --yes      don't ask (for scripts) — careful
#
# Removes, for this repo's Docker Compose project only:
#   - its containers (HOP Chat stops; it is not restarted unless --start)
#   - its data volume <project>_chat-data (the SQLite database)
#   - a local-development database in backend/, if there is one
# Keeps: the built images, .env and its secrets, and everything belonging to
# other projects on the machine (other apps, the edge proxy, its certificates).
#
# The project is found from Docker's labels, so this needs neither .env nor
# the compose files to be valid. Set COMPOSE_PROJECT_NAME if you started HOP
# Chat under a different project name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --start) START=true ;;
    --yes) ASSUME_YES=true ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "Error: $*" >&2; exit 1; }
command -v docker &>/dev/null || die "docker not found"

# Compose's default project name: the directory name, lower-cased, limited to [a-z0-9_-].
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$SCRIPT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
VOLUME="${PROJECT}_chat-data"

CONTAINERS="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}')"
HAS_VOLUME=false
docker volume inspect "$VOLUME" &>/dev/null && HAS_VOLUME=true
LOCAL_DBS="$(ls "$SCRIPT_DIR"/backend/*.db "$SCRIPT_DIR"/backend/data/*.db 2>/dev/null || true)"

# Remember how HOP Chat was started (plain, or with the shared-VM override), for --start.
CONFIG_FILES=""
if [ -n "$CONTAINERS" ]; then
  CONFIG_FILES="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
    $(echo "$CONTAINERS" | head -1) 2>/dev/null || true)"
fi

echo "HOP Chat reset — Docker Compose project \"${PROJECT}\""
echo ""
if [ -z "$CONTAINERS" ] && ! $HAS_VOLUME && [ -z "$LOCAL_DBS" ]; then
  echo "Nothing to delete: no containers, no ${VOLUME} volume, no local database."
  echo "It is already a fresh install."
  exit 0
fi
echo "This permanently deletes:"
[ -n "$CONTAINERS" ] && echo "$CONTAINERS" | sed 's/^/  container  /'
$HAS_VOLUME && echo "  volume     ${VOLUME}   (the database: accounts, credentials, agents, chat apps, conversations)"
[ -n "$LOCAL_DBS" ] && echo "$LOCAL_DBS" | sed 's/^/  file       /'
echo ""
echo "Kept: images, .env (secrets), and all other projects' containers and volumes."
echo ""

if ! $ASSUME_YES; then
  [ -t 0 ] || die "not a terminal; re-run interactively, or with --yes"
  printf 'Type "wipe" to continue: '
  read -r answer
  [ "$answer" = "wipe" ] || { echo "Cancelled. Nothing was changed."; exit 1; }
fi

if [ -n "$CONTAINERS" ]; then
  echo "Removing containers..."
  docker rm -f $CONTAINERS >/dev/null
fi
if $HAS_VOLUME; then
  echo "Removing volume ${VOLUME}..."
  docker volume rm "$VOLUME" >/dev/null
fi
if [ -n "$LOCAL_DBS" ]; then
  echo "Removing local database files..."
  echo "$LOCAL_DBS" | while read -r f; do rm -f "$f" "$f-journal" "$f-wal" "$f-shm"; done
fi
# The project's own network (not shared ones like "edge", which other stacks use).
docker network rm "${PROJECT}_default" &>/dev/null || true

echo ""
echo "HOP Chat is reset to a fresh install and stopped."

if $START; then
  cd "$SCRIPT_DIR"
  FILES=()
  if [ -n "$CONFIG_FILES" ]; then
    IFS=',' read -r -a PATHS <<< "$CONFIG_FILES"
    for f in "${PATHS[@]}"; do FILES+=(-f "$f"); done
  else
    FILES=(-f docker-compose.yml)
  fi
  echo "Starting it again (${CONFIG_FILES:-docker-compose.yml})..."
  docker compose -p "$PROJECT" "${FILES[@]}" up -d
  echo ""
  echo "Started with an empty database. Register the first account straight away."
else
  echo "Start it again later with:  hc up -d   (or docker compose ... up -d)"
fi
