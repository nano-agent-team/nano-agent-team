/**
 * Claude Provider — native Claude Agent SDK implementation
 *
 * Implements the Provider interface using @anthropic-ai/claude-agent-sdk
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class ClaudeProvider implements Provider {
  readonly name = 'claude';

  writeSystemPrompt(cwd: string, content: string): void {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, content, 'utf8');
  }

  async *run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    // Build per-namespace MCP tool patterns (mcp__* glob doesn't match across __ delimiters)
    const mcpToolPatterns = Object.keys(options.mcpServers ?? {}).map((name) => `mcp__${name}__*`);
    const defaultTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', ...mcpToolPatterns];
    const extraTools = options.allowedTools ?? [];
    // Merge defaults + extras (deduplicated)
    const allTools = [...new Set([...defaultTools, ...extraTools])];
    const sdkOptions: Record<string, unknown> = {
      model: options.model,
      cwd: options.cwd,
      permissionMode: 'acceptEdits',
      allowedTools: allTools,
      maxTurns: options.maxTurns ?? 50,
      includePartialMessages: true,
      // Load skills from ~/.claude/skills/ (user) and .claude/skills/ (project)
      // Without this, the SDK never discovers skills even if Skill is in allowedTools
      settingSources: ['user', 'project'],
    };

    // Add MCP servers if provided
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      sdkOptions.mcpServers = options.mcpServers;
    }

    // Resume session if provided
    if (options.sessionId) {
      sdkOptions.resume = options.sessionId;
    }

    // Pass system prompt directly to override the default "You are Claude Code" identity
    if (options.systemPrompt) {
      sdkOptions.systemPrompt = options.systemPrompt;
    }

    // Inject extra env vars (e.g. GH_TOKEN) without mutating process.env
    if (options.extraEnv && Object.keys(options.extraEnv).length > 0) {
      sdkOptions.env = { ...process.env, ...options.extraEnv };
    }

    const q = query({ prompt: options.prompt, options: sdkOptions });

    let sessionId: string | undefined;
    let result = '';
    let errorSubtype: string | undefined;

    try {
      for await (const sdkMsg of q) {
        if (!sdkMsg || typeof sdkMsg !== 'object') continue;
        const msg = sdkMsg as Record<string, unknown>;

        // Capture session id
        if (!sessionId && typeof msg['session_id'] === 'string') {
          sessionId = msg['session_id'];
          yield { type: 'session_id', sessionId };
        }

        // Stream text deltas from partial assistant messages
        if (msg['type'] === 'stream_event') {
          const event = msg['event'] as Record<string, unknown> | undefined;
          if (event?.['type'] === 'content_block_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
              yield { type: 'text', text: delta['text'] };
            }
          }
        }

        // Record tool calls
        if (msg['type'] === 'tool_use_summary') {
          const toolName = typeof msg['tool_name'] === 'string' ? msg['tool_name'] : 'unknown';
          yield { type: 'tool_call', toolName };
        }

        // Check for result
        if (msg['type'] === 'result') {
          if (msg['subtype'] === 'success') {
            result = typeof msg['result'] === 'string' ? msg['result'] : '';
          } else {
            errorSubtype = typeof msg['subtype'] === 'string' ? msg['subtype'] : 'unknown';
            result = `[Error: ${errorSubtype}]`;
          }
          break;
        }
      }
    } catch (err) {
      errorSubtype = 'exception';
      result = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
    }

    yield {
      type: 'result',
      result,
      success: !errorSubtype,
      errorSubtype,
    };
  }
}
