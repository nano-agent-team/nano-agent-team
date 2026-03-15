/**
 * Google Gemini Provider — placeholder, not yet implemented.
 *
 * Gemini is not available in the UI until this provider is complete.
 * Auth: GEMINI_API_KEY or GOOGLE_API_KEY environment variable.
 */

import fs from 'fs';
import path from 'path';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class GeminiProvider implements Provider {
  readonly name = 'gemini';

  writeSystemPrompt(cwd: string, content: string): void {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), content, 'utf8');
  }

  async *run(_options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    yield {
      type: 'result',
      result: '[Error: Gemini provider is not yet implemented]',
      success: false,
      errorSubtype: 'not_implemented',
    };
  }
}
