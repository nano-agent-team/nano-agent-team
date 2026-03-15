/**
 * OpenAI Codex Provider — stub implementation
 *
 * Full implementation would use @openai/codex-sdk
 * Requires CODEX_OAUTH_TOKEN or OPENAI_API_KEY environment variable
 */

import fs from 'fs';
import path from 'path';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class CodexProvider implements Provider {
  readonly name = 'codex';

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    // Codex uses AGENTS.md or alternative convention
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, content, 'utf8');

    // Also write to .codex/config.toml for MCP server configuration if needed
    const codexConfigDir = path.join(cwd, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
  }

  async *run(_options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // TODO: Implement Codex SDK integration
    // For now, yield an error
    yield {
      type: 'result',
      result: '[Error: Codex provider not yet implemented]',
      success: false,
      errorSubtype: 'not_implemented',
    };
  }
}
