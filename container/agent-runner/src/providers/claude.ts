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

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, content, 'utf8');
  }

  async *run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    const sdkOptions: Record<string, unknown> = {
      model: options.model,
      cwd: options.cwd,
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'mcp__tickets__*'],
      maxTurns: options.maxTurns ?? 50,
    };

    // Add MCP servers if provided
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      sdkOptions.mcpServers = options.mcpServers;
    }

    // Resume session if provided
    if (options.sessionId) {
      sdkOptions.resume = options.sessionId;
    }

    const q = query({ prompt: options.prompt, options: sdkOptions });

    let sessionId: string | undefined;
    let result = '';
    let errorSubtype: string | undefined;

    try {
      for await (const sdkMsg of q) {
        // Capture session id
        if (!sessionId && sdkMsg && typeof sdkMsg === 'object' && 'session_id' in sdkMsg) {
          sessionId = (sdkMsg as { session_id: string }).session_id;
          yield { type: 'session_id', sessionId };
        }

        // Record tool calls
        if ((sdkMsg as { type: string }).type === 'tool_use_summary') {
          const toolName = (sdkMsg as { tool_name?: string }).tool_name ?? 'unknown';
          yield { type: 'tool_call', toolName };
        }

        // Check for result
        if (sdkMsg.type === 'result') {
          if (sdkMsg.subtype === 'success') {
            result = sdkMsg.result ?? '';
          } else {
            errorSubtype = sdkMsg.subtype;
            result = `[Error: ${sdkMsg.subtype}]`;
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
