/**
 * OpenAI Codex Provider — OpenAI API with Codex CLI integration
 *
 * Supports both subscription tokens (from `codex auth login`) and direct API keys.
 * Requires CODEX_OAUTH_TOKEN or OPENAI_API_KEY environment variable.
 *
 * This is a minimal implementation using OpenAI SDK directly.
 * Full Codex CLI integration would use @openai/codex SDK when available.
 */

import fs from 'fs';
import path from 'path';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class CodexProvider implements Provider {
  readonly name = 'codex';

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    // Codex convention: AGENTS.md
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, content, 'utf8');

    // Prepare .codex/config.toml for MCP servers if needed
    // This will be populated by the run() method
    const codexConfigDir = path.join(cwd, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
  }

  async *run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // For now, Codex provider is stubbed with an informative message
    // Full implementation would require @openai/codex-sdk or direct OpenAI API calls
    // with proper streaming and tool handling.

    // Check if API key is configured
    const hasApiKey = process.env.OPENAI_API_KEY || process.env.CODEX_OAUTH_TOKEN;
    if (!hasApiKey) {
      yield {
        type: 'result',
        result: '[Error: Codex provider requires OPENAI_API_KEY or CODEX_OAUTH_TOKEN env var]',
        success: false,
        errorSubtype: 'no_auth',
      };
      return;
    }

    // TODO: Implement full Codex SDK integration
    // Steps:
    // 1. Load @openai/codex-sdk (or use openai SDK)
    // 2. Create Codex instance with auth
    // 3. Start thread (or resume with sessionId)
    // 4. Write .codex/config.toml with MCP server config
    // 5. Stream prompts and yield ProviderEvents
    // 6. Handle tool calls (bash, read, write, etc.)

    yield {
      type: 'result',
      result: '[Notice: Codex provider implementation in progress. Use Claude provider for now.]',
      success: false,
      errorSubtype: 'not_implemented',
    };
  }
}
