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

# Install NATS CLI — agents use `nats pub` to signal pipeline stages
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  NATS_ARCH="amd64" ;; \
      aarch64) NATS_ARCH="arm64" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fL "https://github.com/nats-io/natscli/releases/download/v0.1.6/nats-0.1.6-linux-${NATS_ARCH}.zip" \
      -o /tmp/nats.zip && \
    apt-get update && apt-get install -y --no-install-recommends unzip && \
    unzip /tmp/nats.zip -d /tmp/nats-cli && \
    mv /tmp/nats-cli/nats-*/nats /usr/local/bin/nats && \
    chmod +x /usr/local/bin/nats && \
    rm -rf /tmp/nats.zip /tmp/nats-cli && \
    apt-get purge -y --auto-remove unzip && \
    rm -rf /var/lib/apt/lists/*

# Install provider CLIs — pinned to known-good versions
RUN npm install -g @anthropic-ai/claude-code@2.1.76 --ignore-scripts 2>/dev/null || \
    npm install -g @anthropic-ai/claude-code@2.1.76

# OpenAI Codex CLI (subscription + API key support)
RUN npm install -g @openai/codex@0.114.0 --ignore-scripts 2>/dev/null || \
    npm install -g @openai/codex@0.114.0

# Copy package files and install production dependencies
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist/ ./dist/

# Create workspace mount points for volumes (vault, sessions, agent)
RUN mkdir -p /workspace/vault /workspace/sessions /workspace/agent

# Create non-root agent user (no fixed UID — base image may already have UID 1000)
RUN groupadd -r agent && useradd -r -g agent -m -s /bin/bash agent

# Ensure workspace dirs are owned by agent
RUN chown -R agent:agent /workspace /app

# Set npm global prefix for non-root user
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH="/home/agent/.npm-global/bin:$PATH"
ENV HOME=/home/agent

USER agent

CMD ["node", "dist/index.js"]
