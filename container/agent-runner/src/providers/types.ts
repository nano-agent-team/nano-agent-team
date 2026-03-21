/**
 * Provider abstraction types
 *
 * Defines the interface that all LLM providers must implement.
 * Providers can be Claude (native SDK), OpenAI Codex, Google Gemini, etc.
 */

export type McpServerConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export type ProviderEvent =
  | { type: 'session_id'; sessionId: string }
  | { type: 'tool_call'; toolName: string }
  | { type: 'text'; text: string }
  | { type: 'result'; result: string; success: boolean; errorSubtype?: string };

export interface ProviderRunOptions {
  model: string;
  /** True if model was explicitly set in manifest (not auto-selected from capabilities) */
  modelExplicit?: boolean;
  cwd: string;
  prompt: string;
  sessionId?: string;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
  /** System prompt passed directly to the provider, overrides the default Claude Code identity. */
  systemPrompt?: string;
  /** Extra environment variables injected into the provider subprocess (e.g. GH_TOKEN). */
  extraEnv?: Record<string, string>;
  /** Extra tools to allow beyond the provider defaults (e.g. ["Skill"] for superpowers skills). */
  allowedTools?: string[];
}

export interface Provider {
  readonly name: string;

  /** Write system prompt to provider-specific location in cwd */
  writeSystemPrompt(cwd: string, content: string): void;

  /** Run LLM query and yield events */
  run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent>;
}
