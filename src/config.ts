import fs from 'fs';
import os from 'os';
import path from 'path';

export const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
export const AGENTS_DIR = process.env.AGENTS_DIR ?? './agents';
export const DATA_DIR =
  process.env.DATA_DIR ?? path.join(os.homedir(), 'nano-agent-team', 'data');
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// Agent container configuration
export const AGENT_IMAGE = process.env.AGENT_IMAGE ?? 'nano-agent:latest';
export const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'host';
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? '';

/**
 * Read Anthropic/Claude auth token.
 * Priority:
 *   1. ANTHROPIC_API_KEY env var (explicit key)
 *   2. CLAUDE_CODE_OAUTH_TOKEN env var (Claude Code subscription)
 *   3. ~/.claude/.credentials.json → claudeAiOauth.accessToken (auto-synced by Claude Code)
 *   4. DATA_DIR/config.json → provider.apiKey (saved by setup wizard)
 */
function resolveAnthropicApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth.accessToken;
  } catch { /* not present */ }
  try {
    const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), 'nano-agent-team', 'data');
    const configPath = path.join(dataDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config?.provider?.apiKey) return config.provider.apiKey;
  } catch { /* not present */ }
  return '';
}

export const ANTHROPIC_API_KEY = resolveAnthropicApiKey();
export const API_PORT = parseInt(process.env.API_PORT ?? '3001', 10);
export const DB_PATH =
  process.env.DB_PATH ?? path.join(DATA_DIR, 'nano-agent-team.db');
export const AGENT_RESTART_MAX = parseInt(process.env.AGENT_RESTART_MAX ?? '3', 10);
export const AGENT_RESTART_DELAY_MS = parseInt(process.env.AGENT_RESTART_DELAY_MS ?? '5000', 10);
export const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.HEALTH_CHECK_INTERVAL_MS ?? '30000',
  10,
);
