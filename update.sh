#!/bin/bash
# update.sh — host-side update script (alternative to the Settings UI button)
# Pulls latest code, rebuilds Docker image, restarts container.
# Data in ./data is PRESERVED (Docker volume mount).
set -e

PORT="${PORT:-3001}"
CONTAINER="${COMPOSE_PROJECT_NAME:-nate}"

echo "==> [1/3] Pulling latest code..."
git pull --ff-only

echo ""
echo "==> [2/3] Building Docker image..."
docker build -t nano-agent-team . 2>&1 | tail -10

echo ""
echo "==> [3/3] Restarting container (data preserved)..."
docker compose up -d --force-recreate

echo ""
echo -n "==> Waiting for NATE to start"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "==> Ready! http://localhost:$PORT"
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo ""
echo "ERROR: NATE didn't start in time. Check logs:"
echo "  docker logs $CONTAINER"
exit 1
