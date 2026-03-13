# nano-agent-team — Core server Dockerfile
#
# Multi-stage build:
#   1. ts-builder     — compile TypeScript
#   2. dashboard-builder — build Vue 3 dashboard
#   3. settings-builder  — build settings feature frontend
#   4. runtime        — lean production image
#
# Usage:
#   docker build -t nano-agent-team .
#   docker run -v /my/data:/data -p 3001:3001 nano-agent-team

# ── Stage 1: TypeScript compiler ──────────────────────────────────────────────
FROM node:22-alpine AS ts-builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


# ── Stage 2: Dashboard builder ────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-builder
WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build


# ── Stage 3: Settings feature frontend builder ────────────────────────────────
FROM node:22-alpine AS settings-builder
WORKDIR /app/settings-frontend

COPY features/settings/frontend/package.json features/settings/frontend/package-lock.json* ./
RUN npm ci

COPY features/settings/frontend/ ./
# Build output goes to ../frontend-dist (relative to frontend/ dir)
RUN npm run build


# ── Stage 4: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Install nats-server for embedded NATS + Docker CLI for agent containers
RUN apk add --no-cache \
    nats-server \
    docker-cli \
    && rm -rf /var/cache/apk/*

# Production Node.js dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Compiled TypeScript
COPY --from=ts-builder /app/dist/ ./dist/

# Static agents (settings agent + blank-agent)
COPY agents/ ./agents/

# Features backend
COPY features/ ./features/

# Teams manifests (if any)
COPY teams/ ./teams/ 2>/dev/null || true

# MCP config
COPY mcp/ ./mcp/

# Built frontends
COPY --from=dashboard-builder /app/dashboard/dist/ ./dashboard/dist/
COPY --from=settings-builder /app/settings-frontend/../frontend-dist/ ./features/settings/frontend-dist/

# Data directory (mounted as volume at runtime)
VOLUME ["/data"]

# API port
EXPOSE 3001

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV DATA_DIR=/data \
    NODE_ENV=production \
    LOG_LEVEL=info

ENTRYPOINT ["/docker-entrypoint.sh"]
