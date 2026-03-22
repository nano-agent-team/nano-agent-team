#!/bin/bash
set -e

usage() {
  echo "Usage: $0 [--name INSTANCE] [--port PORT]"
  echo ""
  echo "  --name, -n  Instance name (default: nate)"
  echo "              Also used as Docker container/project name."
  echo "              Multiple instances must have unique names."
  echo "  --port, -p  Host port to expose NATE on (default: 3001)"
  echo ""
  echo "Examples:"
  echo "  $0                          # nate on :3001, data in ./data"
  echo "  $0 --name nate2 --port 3002 # second instance on :3002, data in ./data-nate2"
}

INSTANCE=""
PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|-n) INSTANCE="$2"; shift 2 ;;
    --port|-p) PORT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

INSTANCE="${INSTANCE:-nate}"
PORT="${PORT:-3001}"

# Default instance uses ./data for backward compatibility; named instances get ./data-{name}
if [ "$INSTANCE" = "nate" ]; then
  DATA_DIR="${DATA_DIR:-./data}"
else
  DATA_DIR="${DATA_DIR:-./data-$INSTANCE}"
fi

export COMPOSE_PROJECT_NAME="$INSTANCE"
export PORT
export DATA_DIR

echo "==> Instance : $INSTANCE"
echo "==> Port     : $PORT"
echo "==> Data dir : $DATA_DIR"
echo ""

echo "==> Building NATE..."
docker build -t nano-agent-team . 2>&1 | tail -5

echo "==> Building deterministic runner..."
(cd container/deterministic-runner && npm ci && npm run build) 2>&1 | tail -3
docker build -t nano-deterministic:latest container/deterministic-runner/ 2>&1 | tail -5

echo "==> Starting container..."
docker rm -f "$INSTANCE" 2>/dev/null || true
# Kill any other container blocking the port
BLOCKING=$(docker ps -q --filter "publish=$PORT" 2>/dev/null)
[ -n "$BLOCKING" ] && docker rm -f $BLOCKING 2>/dev/null || true
docker compose -p "$INSTANCE" up -d

echo -n "==> Waiting for NATE to start"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "==> Ready! http://localhost:$PORT"
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
echo "  docker logs $INSTANCE"
exit 1
