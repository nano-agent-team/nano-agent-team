/**
 * Provider registry — manages provider factory functions
 *
 * Built-in providers are registered automatically.
 * Custom providers can be registered via registerProvider().
 */

import type { Provider } from './types.js';
import { ClaudeProvider } from './claude.js';

const providers = new Map<string, () => Provider>();

/**
 * Register a provider factory function
 */
export function registerProvider(name: string, factory: () => Provider): void {
  providers.set(name, factory);
}

/**
 * Create a provider instance by name
 * @throws Error if provider not found
 */
export function createProvider(name: string): Provider {
  const factory = providers.get(name);
  if (!factory) {
    throw new Error(
      `Unknown provider: ${name}. Available: ${[...providers.keys()].join(', ')}`
    );
  }
  return factory();
}

/**
 * Get list of available provider names
 */
export function getAvailableProviders(): string[] {
  return [...providers.keys()];
}

// Register built-in providers
import { CodexProvider } from './codex.js';
import { GeminiProvider } from './gemini.js';

registerProvider('claude', () => new ClaudeProvider());
registerProvider('codex', () => new CodexProvider());
registerProvider('gemini', () => new GeminiProvider());
