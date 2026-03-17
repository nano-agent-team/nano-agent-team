/**
 * oauth-flow — standalone CLI for PKCE OAuth setup
 *
 * Usage: node dist/oauth-flow.js
 * Writes credentials.json to DATA_DIR (default: ./data)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';

// ─── Constants ────────────────────────────────────────────────────────────────

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const SCOPE = 'org:create_api_key user:profile user:inference';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpsPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  const authParams = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  console.log('\n=== nano-agent-team OAuth Setup ===\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(`   ${AUTH_URL}?${authParams.toString()}\n`);
  console.log('2. Authorize the application');
  console.log('3. You will be redirected — copy the "code#state" value from the URL\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const input: string = await new Promise((resolve) => {
    rl.question('Paste code#state from the browser: ', resolve);
  });
  rl.close();

  const [code, receivedState] = input.trim().split('#');

  if (!code) {
    console.error('Error: no code provided');
    process.exit(1);
  }

  if (receivedState && receivedState !== state) {
    console.error('Error: state mismatch — possible CSRF attack');
    process.exit(1);
  }

  console.log('\nExchanging code for tokens...');

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state,
  }).toString();

  const responseText = await httpsPost(TOKEN_URL, tokenBody);

  let json: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  try {
    json = JSON.parse(responseText) as typeof json;
  } catch {
    console.error('Error: failed to parse token response:', responseText);
    process.exit(1);
  }

  if (json.error || !json.access_token) {
    console.error(`Error: ${json.error ?? 'no access_token'}: ${json.error_description ?? responseText}`);
    process.exit(1);
  }

  const credentials = {
    version: 1 as const,
    method: 'oauth' as const,
    oauth_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    api_key: null,
    created_at: new Date().toISOString(),
    expires_at: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const credPath = path.join(DATA_DIR, 'credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log(`\n✓ Credentials saved to ${credPath}`);
  console.log('  Run /nat-rebuild to restart the stack with credential proxy enabled.\n');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
