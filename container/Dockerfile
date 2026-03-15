## Stage 1: Build agent-runner TypeScript
FROM node:22-slim AS builder
WORKDIR /app
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

## Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# Minimal runtime tools + GitHub CLI + SSH for git push
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates git openssh-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI — required by @anthropic-ai/claude-agent-sdk query()
RUN npm install -g @anthropic-ai/claude-code --ignore-scripts 2>/dev/null || \
    npm install -g @anthropic-ai/claude-code

# Copy package files and install production dependencies
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist/ ./dist/

# Create workspace mount points for volumes (vault, sessions, agent)
RUN mkdir -p /workspace/vault /workspace/sessions /workspace/agent

CMD ["node", "dist/index.js"]
