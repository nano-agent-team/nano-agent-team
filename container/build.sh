#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENTS_DIR="${AGENTS_DIR:-${REPO_ROOT}/agents}"

echo "==> Building agent-runner TypeScript..."
cd "${SCRIPT_DIR}/agent-runner"
npm install
npm run build
cd "${SCRIPT_DIR}"

echo "==> Building default image nano-agent:latest..."
docker build -t nano-agent:latest .

echo "Built nano-agent:latest"

# Build per-agent images: any agents/{id}/Dockerfile (including plugin groups)
echo "==> Scanning for per-agent Dockerfiles in ${AGENTS_DIR}..."

find "${AGENTS_DIR}" -name "Dockerfile" | while read -r dockerfile; do
  agent_dir="$(dirname "$dockerfile")"
  agent_id="$(basename "$agent_dir")"
  image_name="nano-agent-${agent_id}:latest"

  echo "==> Building ${image_name} from ${dockerfile}..."
  # Build context is container/ dir so agent-runner/ is available via COPY
  docker build \
    -t "${image_name}" \
    -f "${dockerfile}" \
    "${SCRIPT_DIR}"

  echo "Built ${image_name}"
done

# Also scan hub agents for per-agent Dockerfiles
HUB_AGENTS_DIR="${SCRIPT_DIR}/../../hub/agents"
if [ -d "$HUB_AGENTS_DIR" ]; then
  echo "==> Scanning for hub agent Dockerfiles in ${HUB_AGENTS_DIR}..."
  find "${HUB_AGENTS_DIR}" -name "Dockerfile" | while read -r dockerfile; do
    agent_dir="$(dirname "$dockerfile")"
    agent_id="$(basename "$agent_dir")"
    image_name="nano-agent-${agent_id}:latest"
    echo "==> Building ${image_name} from ${dockerfile}..."
    docker build \
      -t "${image_name}" \
      -f "${dockerfile}" \
      "${SCRIPT_DIR}"
    echo "Built ${image_name}"
  done
fi

echo ""
echo "==> All images built:"
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep "nano-agent"
