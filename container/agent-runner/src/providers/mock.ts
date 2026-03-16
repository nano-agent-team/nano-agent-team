/**
 * Mock Provider — deterministic responses for automated testing
 *
 * Activated by setting PROVIDER=mock (or primaryProvider:"mock" in config.json).
 * Does NOT call any external LLM API.
 *
 * Response logic:
 *   - Returns MOCK_RESPONSE env var if set
 *   - Otherwise returns a default fixed string
 */

import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

const DEFAULT_RESPONSE = process.env.MOCK_RESPONSE ?? 'Mock provider: task acknowledged.';

export class MockProvider implements Provider {
  readonly name = 'mock';

  writeSystemPrompt(_cwd: string, _content: string): void {
    // No-op — mock provider doesn't need system prompt
  }

  async *run(_options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // Simulate minimal processing delay
    await new Promise(resolve => setTimeout(resolve, 50));

    yield {
      type: 'result',
      result: DEFAULT_RESPONSE,
      success: true,
    };
  }
}
