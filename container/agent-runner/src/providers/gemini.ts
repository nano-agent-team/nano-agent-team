/**
 * Google Gemini Provider — Google Generative AI integration
 *
 * Supports Gemini API with future MCP support.
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable.
 *
 * Uses @google/generative-ai SDK when available.
 */

import fs from 'fs';
import path from 'path';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class GeminiProvider implements Provider {
  readonly name = 'gemini';

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    // Gemini convention: AGENTS.md (generic multi-provider format)
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, content, 'utf8');
  }

  async *run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // Check if API key is configured
    const hasApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!hasApiKey) {
      yield {
        type: 'result',
        result: '[Error: Gemini provider requires GEMINI_API_KEY or GOOGLE_API_KEY env var]',
        success: false,
        errorSubtype: 'no_auth',
      };
      return;
    }

    // TODO: Implement full Gemini SDK integration
    // Steps:
    // 1. Load @google/generative-ai SDK
    // 2. Create GenerativeModel with auth
    // 3. Start chat session (or use history for resume)
    // 4. Stream prompts and yield ProviderEvents
    // 5. Handle tool calls when supported
    // 6. MCP: plan integration (may require grpc or different approach)

    yield {
      type: 'result',
      result: '[Notice: Gemini provider implementation in progress. Use Claude provider for now.]',
      success: false,
      errorSubtype: 'not_implemented',
    };
  }
}
