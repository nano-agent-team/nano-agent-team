#!/bin/sh
# docker-entrypoint.sh — nano-agent-team startup

DATA_DIR="${DATA_DIR:-/data}"

# ── Start internal Docker daemon (DinD mode) ──────────────────────────────────
# Skip if DOCKER_HOST is set (dev mode using host socket) or SKIP_DOCKERD=true
if [ -z "$DOCKER_HOST" ] && [ -z "$SKIP_DOCKERD" ]; then
  echo "[entrypoint] Starting internal Docker daemon..."
  # Clean up stale PID file from previous run (survives container restart)
  rm -f /var/run/docker.pid
  dockerd --log-level=warn \
          --storage-driver=overlay2 \
          --data-root "$DATA_DIR/docker" \
          2>/var/log/dockerd.log & \
  DOCKERD_PID=$!

  # Wait briefly, then check if overlay2 failed and retry with vfs
  sleep 2
  if ! kill -0 $DOCKERD_PID 2>/dev/null; then
    # dockerd exited — check if it's an overlay2 issue
    if grep -q "overlay2" /var/log/dockerd.log 2>/dev/null; then
      echo "[entrypoint] overlay2 not supported, retrying with vfs..."
      dockerd --log-level=warn \
              --storage-driver=vfs \
              --data-root "$DATA_DIR/docker" \
              2>/var/log/dockerd.log &
    else
      echo "[entrypoint] ERROR: dockerd failed to start"
      cat /var/log/dockerd.log
      exit 1
    fi
  fi

  # Wait for socket to be ready (max 30s)
  timeout 30 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done' \
    || { echo "[entrypoint] ERROR: dockerd failed to start"; cat /var/log/dockerd.log; exit 1; }
  echo "[entrypoint] Docker daemon ready"

  # Build nano-agent image if not already present (persists in DATA_DIR/docker volume)
  if ! docker image inspect nano-agent:latest >/dev/null 2>&1; then
    echo "[entrypoint] Building nano-agent:latest..."
    docker build -t nano-agent:latest /app/container/ \
      && echo "[entrypoint] nano-agent:latest ready" \
      || { echo "[entrypoint] ERROR: nano-agent build failed"; exit 1; }
  fi
fi
# ─────────────────────────────────────────────────────────────────────────────

# Ensure data directories exist
mkdir -p \
  "$DATA_DIR/sessions" \
  "$DATA_DIR/workspaces" \
  "$DATA_DIR/vault/public" \
  "$DATA_DIR/vault/agents" \
  "$DATA_DIR/vault/teams" \
  "$DATA_DIR/.claude" \
  "$DATA_DIR/.codex"

# Store Claude/Codex credentials inside the data volume (host-independent)
ln -sfn "$DATA_DIR/.claude" /root/.claude
ln -sfn "$DATA_DIR/.codex" /root/.codex
# Claude Code 2.x stores OAuth token in ~/.claude.json (not ~/.claude/.credentials.json)
ln -sf "$DATA_DIR/.claude.json" /root/.claude.json

# Log startup mode
if [ -f "$DATA_DIR/config.json" ]; then
  echo "[entrypoint] Config found — starting in run mode"
else
  echo "[entrypoint] No config found — starting in setup mode"
  echo "[entrypoint] Open http://localhost:3001 to complete setup"
fi

# Ensure team plugin-dist dirs have node_modules symlink (ESM resolution)
for pd in "$DATA_DIR"/teams/*/agents/plugin-dist; do
  [ -d "$pd" ] && [ ! -e "$pd/node_modules" ] && ln -s /app/node_modules "$pd/node_modules" 2>/dev/null || true
done

# --import loads OTel instrumentation BEFORE any app modules (required for http/express patching)
exec node --import ./dist/tracing/register.mjs dist/index.js
