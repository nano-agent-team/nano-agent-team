FROM node:22-alpine
WORKDIR /app

# Minimal runtime tools — curl for API calls only
RUN apk add --no-cache curl bash

# Copy package files and install production dependencies
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled JavaScript
COPY agent-runner/dist/ ./dist/

# Create workspace mount points for volumes (vault, sessions, agent)
RUN mkdir -p /workspace/vault /workspace/sessions /workspace/agent

CMD ["node", "dist/index.js"]
