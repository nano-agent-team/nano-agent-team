/**
 * OpenAI Codex Provider — runs `codex exec` CLI subprocess
 *
 * Auth priority:
 *   1. CODEX_OAUTH_TOKEN (subscription token from ~/.codex/auth.json)
 *   2. OPENAI_API_KEY (direct API key)
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Provider, ProviderRunOptions, ProviderEvent } from './types.js';

export class CodexProvider implements Provider {
  readonly name = 'codex';

  writeSystemPrompt(cwd: string, content: string, _agentId: string): void {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), content, 'utf8');
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  }

  async *run(options: ProviderRunOptions): AsyncGenerator<ProviderEvent> {
    const oauthToken = process.env.CODEX_OAUTH_TOKEN;
    const apiKey = process.env.OPENAI_API_KEY;

    if (!oauthToken && !apiKey) {
      yield { type: 'result', result: '[Error: Codex requires CODEX_OAUTH_TOKEN or OPENAI_API_KEY]', success: false, errorSubtype: 'no_auth' };
      return;
    }

    const codexBin = '/usr/local/bin/codex';
    if (!fs.existsSync(codexBin)) {
      yield { type: 'result', result: '[Error: codex CLI not found]', success: false, errorSubtype: 'no_cli' };
      return;
    }

    // Write .codex/config.toml for MCP servers
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      const lines: string[] = [];
      for (const [name, srv] of Object.entries(options.mcpServers)) {
        lines.push(`[mcp_servers.${name}]`);
        lines.push(`command = "${srv.command}"`);
        if (srv.args?.length) lines.push(`args = [${srv.args.map(a => `"${a}"`).join(', ')}]`);
        if (srv.env) {
          lines.push(`[mcp_servers.${name}.env]`);
          for (const [k, v] of Object.entries(srv.env)) lines.push(`${k} = "${v}"`);
        }
        lines.push('');
      }
      fs.writeFileSync(path.join(options.cwd, '.codex', 'config.toml'), lines.join('\n'), 'utf8');
    }

    yield { type: 'session_id', sessionId: `codex-${Date.now()}` };

    const args = ['exec', '--skip-git-repo-check'];
    if (options.model) args.push('--model', options.model);
    args.push(options.prompt);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (oauthToken) env.CODEX_OAUTH_TOKEN = oauthToken;
    if (apiKey) env.OPENAI_API_KEY = apiKey;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn(codexBin, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('exit', (code) => {
          if (code === 0) resolve(stdout.trim() || stderr.trim());
          else reject(new Error(stderr.trim() || stdout.trim() || `codex exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      yield { type: 'result', result: output, success: true };
    } catch (err) {
      yield { type: 'result', result: `[Codex error: ${String(err)}]`, success: false, errorSubtype: 'execution_error' };
    }
  }
}
