#!/bin/bash
set -e

PORT="${PORT:-3001}"
CONTAINER="${COMPOSE_PROJECT_NAME:-nate}"

echo "==> Building NATE..."
docker build -t nano-agent-team . 2>&1 | tail -5

echo "==> Starting container..."
docker rm -f "$CONTAINER" 2>/dev/null || true
# Kill any other container blocking the port
BLOCKING=$(docker ps -q --filter "publish=$PORT" 2>/dev/null)
[ -n "$BLOCKING" ] && docker rm -f $BLOCKING 2>/dev/null || true
docker compose up -d

echo -n "==> Waiting for NATE to start"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "==> Ready! http://localhost:$PORT"
    # Open browser if available
    if command -v open >/dev/null 2>&1; then
      open "http://localhost:$PORT"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://localhost:$PORT"
    fi
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo ""
echo "ERROR: NATE didn't start in time. Check logs:"
echo "  docker logs $CONTAINER"
exit 1
