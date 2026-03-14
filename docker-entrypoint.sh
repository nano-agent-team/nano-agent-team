#!/bin/sh
# docker-entrypoint.sh — nano-agent-team startup

DATA_DIR="${DATA_DIR:-/data}"

# Ensure data directories exist
mkdir -p \
  "$DATA_DIR/sessions" \
  "$DATA_DIR/workspaces" \
  "$DATA_DIR/vault/public" \
  "$DATA_DIR/vault/agents" \
  "$DATA_DIR/vault/teams"

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

exec node dist/index.js
