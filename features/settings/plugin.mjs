/**
 * Settings Feature Plugin
 *
 * Express routes for config management + setup wizard.
 * Always loaded by core (even in setup mode).
 *
 * Routes:
 *   GET  /api/config           → current config (secrets masked)
 *   PATCH /api/config          → partial update (deepMerge)
 *   GET  /api/config/status    → { complete: bool, missing: string[] }
 *   POST /api/setup/complete   → mark setup done + trigger live reload
 *   GET  /api/available        → available teams + features to install
 *   GET  /features/settings/*  → static frontend assets
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find claude CLI — try common locations
function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    process.env.CLAUDE_BIN,
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  // Try which
  try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { /* skip */ }
  return null;
}

// Active auth login subprocess + session info (one at a time)
let authLoginProc = null;
let authLoginSession = null; // { port, state, proc }

function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export default {
  async register(app, _nc, _manager, opts) {
    const { dataDir, configService, emitSseEvent, reloadFeatures } = opts;
    const configPath = path.join(dataDir, 'config.json');

    function loadConfig() {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        return null;
      }
    }

    function saveConfig(config) {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    function maskSecrets(config) {
      if (!config) return config;
      const masked = JSON.parse(JSON.stringify(config));
      if (masked?.provider?.apiKey) masked.provider.apiKey = '***';
      return masked;
    }

    function getMissing(config) {
      const missing = [];
      if (!config?.provider?.type) missing.push('provider.type');
      // claude-code-oauth uses mounted credentials — no apiKey needed
      if (config?.provider?.type !== 'claude-code-oauth' && !config?.provider?.apiKey) {
        missing.push('provider.apiKey');
      }
      return missing;
    }

    // ── GET /api/config ─────────────────────────────────────────────────────
    app.get('/api/config', (req, res) => {
      const config = loadConfig();
      res.json(maskSecrets(config));
    });

    // ── PATCH /api/config ───────────────────────────────────────────────────
    app.patch('/api/config', (req, res) => {
      try {
        const current = loadConfig() ?? {
          version: '1',
          setupCompleted: false,
          installed: { features: [], teams: [] },
          meta: { createdAt: new Date().toISOString(), setupCompletedAt: null },
        };
        const updated = deepMerge(current, req.body);
        saveConfig(updated);
        emitSseEvent('config-updated', maskSecrets(updated));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── GET /api/config/status ──────────────────────────────────────────────
    app.get('/api/config/status', (req, res) => {
      const config = loadConfig();
      const missing = getMissing(config);
      const complete = config?.setupCompleted === true && missing.length === 0;
      res.json({ complete, missing, setupCompleted: config?.setupCompleted ?? false });
    });

    // ── POST /api/setup/complete ────────────────────────────────────────────
    app.post('/api/setup/complete', async (req, res) => {
      try {
        const { install = [] } = req.body ?? {};
        const config = loadConfig() ?? {
          version: '1',
          installed: { features: [], teams: [] },
          meta: { createdAt: new Date().toISOString(), setupCompletedAt: null },
        };

        // Categorize install items (teams vs features)
        const teamsDir = path.join(__dirname, '..', '..', 'teams');
        const teams = [];
        const features = [];
        for (const id of install) {
          const teamManifest = path.join(teamsDir, id, 'team.json');
          if (fs.existsSync(teamManifest)) {
            teams.push(id);
          } else {
            features.push(id);
          }
        }

        config.setupCompleted = true;
        config.installed = {
          features: [...new Set([...(config.installed?.features ?? []), ...features])],
          teams: [...new Set([...(config.installed?.teams ?? []), ...teams])],
        };
        if (!config.meta) config.meta = { createdAt: new Date().toISOString(), setupCompletedAt: null };
        config.meta.setupCompletedAt = new Date().toISOString();
        saveConfig(config);

        // Trigger live reload
        if (reloadFeatures) await reloadFeatures();

        emitSseEvent('setup-completed', { installed: config.installed });
        res.json({ ok: true, installed: config.installed });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── GET /api/available ──────────────────────────────────────────────────
    app.get('/api/available', (req, res) => {
      const available = { features: [], teams: [] };

      // Scan features/
      const featuresDir = path.join(__dirname, '..', '..', 'features');
      if (fs.existsSync(featuresDir)) {
        for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const fjPath = path.join(featuresDir, entry.name, 'feature.json');
          if (fs.existsSync(fjPath)) {
            try {
              const m = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
              if (m.id !== 'settings') available.features.push({ id: m.id, name: m.name });
            } catch { /* skip */ }
          }
        }
      }

      // Scan teams/
      const teamsDir = path.join(__dirname, '..', '..', 'teams');
      if (fs.existsSync(teamsDir)) {
        for (const entry of fs.readdirSync(teamsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const tjPath = path.join(teamsDir, entry.name, 'team.json');
          if (fs.existsSync(tjPath)) {
            try {
              const m = JSON.parse(fs.readFileSync(tjPath, 'utf8'));
              available.teams.push({ id: m.id, name: m.name });
            } catch { /* skip */ }
          }
        }
      }

      res.json(available);
    });

    // ── POST /api/auth/claude-login — spustí `claude auth login`, vrátí OAuth URL + port/state ──
    app.post('/api/auth/claude-login', async (req, res) => {
      const claudeBin = findClaudeBin();
      if (!claudeBin) {
        return res.status(404).json({ error: 'claude CLI not found. Add it to the container image.' });
      }

      // Zabij předchozí proces pokud ještě běží
      if (authLoginProc) {
        try { authLoginProc.kill(); } catch { /* ignore */ }
        authLoginProc = null;
        authLoginSession = null;
      }

      let responded = false;
      let proc;
      try {
        proc = spawn(claudeBin, ['auth', 'login'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'xterm' },
        });
      } catch (spawnErr) {
        return res.status(500).json({ error: `Failed to start claude: ${spawnErr.message}` });
      }
      authLoginProc = proc;

      proc.on('error', (err) => {
        authLoginProc = null;
        authLoginSession = null;
        if (!responded) {
          responded = true;
          clearTimeout(urlTimeout);
          res.status(500).json({ error: `claude spawn error: ${err.message}` });
        }
      });

      const urlTimeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          proc.kill();
          res.status(504).json({ error: 'Timeout — claude auth login did not emit URL within 15s' });
        }
      }, 15_000);

      function handleOutput(data) {
        if (responded) return;
        const text = data.toString();
        const urlMatch = text.match(/https:\/\/[^\s]+/);
        if (urlMatch) {
          const url = urlMatch[0];
          const state = new URL(url).searchParams.get('state') ?? '';

          // Najdeme port který claude otevřel přes inode mapping (spolehlivé)
          setTimeout(() => {
            let port = null;
            try {
              const pid = proc.pid;

              // 1. Získáme inode čísla socketů daného procesu z /proc/PID/fd
              const fds = fs.readdirSync(`/proc/${pid}/fd`);
              const inodes = new Set();
              for (const fd of fds) {
                try {
                  const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                  const m = link.match(/socket:\[(\d+)\]/);
                  if (m) inodes.add(m[1]);
                } catch { /* fd může zmizet */ }
              }

              // 2. Mapujeme inode → port z /proc/net/tcp
              const netTcp = fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8');
              for (const line of netTcp.split('\n').slice(1)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 10) continue;
                if (parts[3] !== '0A') continue; // jen LISTEN
                if (!inodes.has(parts[9])) continue; // jen sockety tohoto procesu
                const portHex = parts[1].split(':')[1];
                port = parseInt(portHex, 16);
                break;
              }
            } catch { /* ignore */ }

            authLoginSession = { port, state, proc };
            responded = true;
            clearTimeout(urlTimeout);
            res.json({ url, port, state });
          }, 1500); // počkáme 1.5s než claude otevře server
        }
      }

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('exit', (code) => {
        authLoginProc = null;
        if (!responded) {
          responded = true;
          clearTimeout(urlTimeout);
          if (code === 0) {
            res.json({ url: null, alreadyLoggedIn: true });
          } else {
            res.status(500).json({ error: `claude auth login exited with code ${code}` });
          }
        } else if (code === 0) {
          authLoginSession = null;
          emitSseEvent('auth-completed', { type: 'claude-code-oauth' });
        }
      });
    });

    // ── POST /api/auth/claude-callback — uživatel vloží kód ze stránky Anthropic ──
    app.post('/api/auth/claude-callback', async (req, res) => {
      const { code } = req.body ?? {};
      if (!code) return res.status(400).json({ error: '"code" required' });

      if (!authLoginSession) {
        return res.status(409).json({ error: 'No active auth login session. Start with POST /api/auth/claude-login first.' });
      }

      const { port, state } = authLoginSession;
      if (!port) {
        return res.status(500).json({ error: 'Could not detect claude callback port. Try again.' });
      }

      try {
        const callbackUrl = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code.trim())}&state=${encodeURIComponent(state)}`;
        const resp = await fetch(callbackUrl);
        if (resp.ok || resp.status === 302) {
          // Claude zpracoval kód — počkáme na exit procesu (max 10s)
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 10_000);
            authLoginSession?.proc?.on('exit', () => { clearTimeout(t); resolve(); });
          });
          res.json({ ok: true });
        } else {
          const body = await resp.text().catch(() => '');
          res.status(400).json({ error: `claude rejected code: HTTP ${resp.status} ${body}` });
        }
      } catch (err) {
        res.status(500).json({ error: `Callback failed: ${String(err)}` });
      }
    });

    // ── GET /api/auth/claude-login/status — zkontroluje zda jsou credentials platné ──
    app.get('/api/auth/claude-login/status', (req, res) => {
      const credPaths = [
        '/root/.claude/.credentials.json',
        path.join(process.env.HOME ?? '/root', '.claude', '.credentials.json'),
      ];
      for (const p of credPaths) {
        try {
          const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (creds?.claudeAiOauth?.accessToken) {
            return res.json({ ok: true, path: p });
          }
        } catch { /* skip */ }
      }
      res.json({ ok: false });
    });

    // ── Serve settings frontend static assets ───────────────────────────────
    const frontendDist = path.join(__dirname, 'frontend-dist');
    if (fs.existsSync(frontendDist)) {
      const { default: express } = await import('express');
      app.use('/features/settings', express.static(frontendDist));
      console.log('[settings feature] Serving frontend from', frontendDist);
    } else {
      console.log('[settings feature] Frontend not built — run: cd features/settings/frontend && npm run build');
    }

    console.log('[settings feature] Config API registered (/api/config)');
  },
};
