#!/bin/bash
set -e

PORT="${PORT:-3001}"
CONTAINER="${COMPOSE_PROJECT_NAME:-nate}"

usage() {
  echo "Usage: $0 <team-id|feature-id> [--type team|feature|agent]"
  echo ""
  echo "Examples:"
  echo "  $0 github-team"
  echo "  $0 simple-chat --type feature"
  echo "  $0 reviewer --type agent"
  exit 1
}

[ -z "$1" ] && usage
ID="$1"
TYPE="${3:-team}"  # default: team

# Auto-detect type from --type flag
if [ "$2" = "--type" ]; then
  TYPE="$3"
fi

# Determine data path
case "$TYPE" in
  team)    DATA_PATH="/data/teams/$ID" ;;
  feature) DATA_PATH="/data/features/$ID" ;;
  agent)   DATA_PATH="/data/agents/$ID" ;;
  *)       echo "Unknown type: $TYPE (use team|feature|agent)"; exit 1 ;;
esac

echo "==> Removing $TYPE '$ID' from container..."
docker exec "$CONTAINER" rm -rf "$DATA_PATH"

echo "==> Reinstalling via hub..."
RESPONSE=$(curl -sf -X POST "http://localhost:$PORT/api/hub/install" \
  -H "Content-Type: application/json" \
  -d "{\"items\":[\"$ID\"]}" 2>&1) || {
  echo "ERROR: Hub install API failed: $RESPONSE"
  exit 1
}

echo "==> Triggering reload..."
curl -sf -X POST "http://localhost:$PORT/internal/reload" >/dev/null 2>&1 || true

echo "==> Done! $TYPE '$ID' reinstalled."
echo "    Response: $RESPONSE"
