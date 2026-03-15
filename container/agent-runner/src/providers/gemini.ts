/**
 * Google Gemini Provider — stub implementation
 *
 * Full implementation would use @google/generative-ai
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable
 */

import fs from 'fs';
import path from 'path';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class GeminiProvider implements Provider {
  readonly name = 'gemini';

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    // Gemini may use AGENTS.md or CLAUDE.md convention
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, content, 'utf8');
  }

  async *run(_options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // TODO: Implement Gemini SDK integration
    // For now, yield an error
    yield {
      type: 'result',
      result: '[Error: Gemini provider not yet implemented]',
      success: false,
      errorSubtype: 'not_implemented',
    };
  }
}
