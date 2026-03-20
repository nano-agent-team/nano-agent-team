/**
 * credential-proxy — HTTP proxy that injects Anthropic auth headers
 *
 * Worker containers set ANTHROPIC_BASE_URL=http://<parent-ip>:8082
 * and never see the real token. Token refresh happens transparently.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { logger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredCredentials {
  version: 1;
  method: 'oauth' | 'apikey';
  oauth_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  created_at: string;
  expires_at: string | null;
}

// ─── Credential I/O ───────────────────────────────────────────────────────────

function readCredentials(dataDir: string): StoredCredentials | null {
  const credPath = path.join(dataDir, 'credentials.json');
  try {
    const raw = fs.readFileSync(credPath, 'utf8');
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

function writeCredentials(dataDir: string, creds: StoredCredentials): void {
  const credPath = path.join(dataDir, 'credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// ─── Token refresh ────────────────────────────────────────────────────────────

function shouldRefresh(creds: StoredCredentials): boolean {
  if (creds.method !== 'oauth' || !creds.expires_at) return false;
  const expiresAt = new Date(creds.expires_at).getTime();
  return expiresAt - Date.now() < 5 * 60 * 1000; // within 5 minutes
}

async function refreshOauthToken(
  creds: StoredCredentials,
  dataDir: string,
): Promise<StoredCredentials> {
  const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token ?? '',
    client_id: CLIENT_ID,
  }).toString();

  return new Promise((resolve) => {
    const url = new URL(TOKEN_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false, // Alpine container may lack CA certs
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number;
            };
            if (!json.access_token) {
              logger.warn({ status: res.statusCode }, 'OAuth refresh: no access_token in response');
              resolve(creds);
              return;
            }
            const updated: StoredCredentials = {
              ...creds,
              oauth_token: json.access_token,
              refresh_token: json.refresh_token ?? creds.refresh_token,
              expires_at: json.expires_in
                ? new Date(Date.now() + json.expires_in * 1000).toISOString()
                : null,
            };
            writeCredentials(dataDir, updated);
            logger.info('OAuth token refreshed successfully');
            resolve(updated);
          } catch (err) {
            logger.warn({ err }, 'OAuth refresh: failed to parse response');
            resolve(creds);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.warn({ err }, 'OAuth refresh: request failed');
      resolve(creds);
    });

    req.write(body);
    req.end();
  });
}

// ─── Background refresh guard ─────────────────────────────────────────────────

let refreshInFlight = false;

function maybeRefreshBackground(creds: StoredCredentials, dataDir: string): void {
  if (refreshInFlight || !shouldRefresh(creds)) return;
  refreshInFlight = true;
  refreshOauthToken(creds, dataDir).finally(() => {
    refreshInFlight = false;
  });
}

// ─── Hop-by-hop headers to strip ─────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
]);

// ─── Proxy server ─────────────────────────────────────────────────────────────

export function createProxyServer(dataDir: string): http.Server {
  return http.createServer((req, res) => {
    const creds = readCredentials(dataDir);

    if (!creds) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('credential-proxy: no credentials.json found');
      return;
    }

    // Fire-and-forget background refresh
    maybeRefreshBackground(creds, dataDir);

    // Copy incoming headers, strip hop-by-hop
    const outHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
        outHeaders[key] = value as string | string[];
      }
    }

    // Inject auth
    if (creds.method === 'oauth' && creds.oauth_token) {
      outHeaders['authorization'] = `Bearer ${creds.oauth_token}`;
    } else if (creds.method === 'apikey' && creds.api_key) {
      outHeaders['x-api-key'] = creds.api_key;
    }

    // Ensure anthropic-version header
    if (!outHeaders['anthropic-version']) {
      outHeaders['anthropic-version'] = '2023-06-01';
    }

    const proxyReq = https.request(
      {
        hostname: 'api.anthropic.com',
        path: req.url,
        method: req.method,
        headers: outHeaders,
        rejectUnauthorized: false, // Alpine container may lack CA certs
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      logger.warn({ err, url: req.url }, 'credential-proxy: upstream error');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`credential-proxy upstream error: ${err.message}`);
    });

    req.pipe(proxyReq);
  });
}

export function startCredentialProxy(dataDir: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createProxyServer(dataDir);

    server.on('error', reject);

    server.listen(8082, '0.0.0.0', () => {
      logger.info('credential-proxy listening on :8082');
      resolve(server);
    });
  });
}
