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

# Minimal runtime tools + GitHub CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates git \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install provider CLIs — required by their respective SDKs
RUN npm install -g @anthropic-ai/claude-code --ignore-scripts 2>/dev/null || \
    npm install -g @anthropic-ai/claude-code

# OpenAI Codex CLI (subscription + API key support)
RUN npm install -g @openai/codex --ignore-scripts 2>/dev/null || \
    npm install -g @openai/codex

# Google Gemini CLI (placeholder for future implementation)
RUN npm install -g @google/gemini-cli --ignore-scripts 2>/dev/null || \
    npm install -g @google/gemini-cli || echo "Note: @google/gemini-cli may not exist on npm yet"

# Copy package files and install production dependencies
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist/ ./dist/

# Create workspace mount points for volumes (vault, sessions, agent)
RUN mkdir -p /workspace/vault /workspace/sessions /workspace/agent

CMD ["node", "dist/index.js"]
