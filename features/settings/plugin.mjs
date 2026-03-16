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
import { execSync, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple logger compatible with main app's pino output format
const log = {
  info:  (msg, ...args) => console.log(JSON.stringify({ level: 30, time: Date.now(), name: 'settings', msg, ...args[0] })),
  warn:  (msg, ...args) => console.warn(JSON.stringify({ level: 40, time: Date.now(), name: 'settings', msg, ...args[0] })),
  error: (msg, ...args) => console.error(JSON.stringify({ level: 50, time: Date.now(), name: 'settings', msg, ...args[0] })),
};

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

    async function saveOauthTokenToConfig() {
      try {
        // Try reading token from ~/.claude/.credentials.json (older Claude Code versions)
        let token = null;
        const credPaths = [
          path.join(process.env.HOME ?? '/root', '.claude', '.credentials.json'),
          '/root/.claude/.credentials.json',
        ];
        for (const p of credPaths) {
          try {
            const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (creds?.claudeAiOauth?.accessToken) {
              token = creds.claudeAiOauth.accessToken;
              break;
            }
          } catch { /* not present */ }
        }

        // Fallback: use CLAUDE_CODE_OAUTH_TOKEN env var if Claude Code set it
        if (!token && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
          token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }

        if (!token) {
          log.info('OAuth login completed but token not accessible — will use mounted .claude dir');
          return;
        }

        const config = loadConfig() ?? {};
        config.provider = { ...(config.provider ?? {}), type: 'claude-code-oauth', apiKey: token };
        saveConfig(config);
        log.info('OAuth token saved to config.json');
      } catch (err) {
        log.warn('Could not save OAuth token to config.json', { err: err?.message });
      }
    }

    function maskSecrets(config) {
      if (!config) return config;
      const masked = JSON.parse(JSON.stringify(config));
      if (masked?.provider?.apiKey) masked.provider.apiKey = '***';
      return masked;
    }

    function getMissing(config) {
      const missing = [];
      // Multi-provider: primaryProvider set means wizard completed (OAuth/subscription
      // providers store credentials in credential files, not in config)
      if (config?.primaryProvider) return missing;
      // Legacy: single provider config
      if (!config?.provider?.type) missing.push('provider.type');
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

    // ── POST /api/config/set-path ────────────────────────────────────────────
    // Set config value at dot-path (e.g. providers.codex.apiKey)
    app.post('/api/config/set-path', (req, res) => {
      try {
        const { path: keyPath, value } = req.body ?? {};
        if (!keyPath || typeof keyPath !== 'string') {
          res.status(400).json({ error: 'Missing path' });
          return;
        }

        const config = loadConfig() ?? { version: '1', installed: { features: [], teams: [] }, meta: { createdAt: new Date().toISOString(), setupCompletedAt: null } };
        const keys = keyPath.split('.');
        let cur = config;
        for (let i = 0; i < keys.length - 1; i++) {
          if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
            cur[keys[i]] = {};
          }
          cur = cur[keys[i]];
        }
        cur[keys[keys.length - 1]] = value;
        saveConfig(config);

        res.json({ ok: true, path: keyPath });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── POST /api/auth/codex-login ───────────────────────────────────────────
    // Spustí `codex auth login` uvnitř kontejneru, vrátí OAuth URL
    app.post('/api/auth/codex-login', async (req, res) => {
      // Nejdřív zkontroluj jestli už token existuje
      const codexAuthPath = path.join(process.env.HOME ?? '/root', '.codex', 'auth.json');
      try {
        const creds = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
        const token = creds?.tokens?.access_token;
        if (token) {
          return res.json({ alreadyLoggedIn: true });
        }
      } catch { /* not present, proceed with login */ }

      // Najdi codex binary
      let codexBin = null;
      const candidates = ['/usr/local/bin/codex', '/usr/bin/codex', process.env.CODEX_BIN].filter(Boolean);
      for (const p of candidates) {
        try { if (fs.existsSync(p)) { codexBin = p; break; } } catch { /* skip */ }
      }
      if (!codexBin) {
        try { codexBin = execSync('which codex', { encoding: 'utf8' }).trim(); } catch { /* skip */ }
      }
      if (!codexBin) {
        return res.status(404).json({ error: 'codex CLI not found in container. Rebuild the image.' });
      }

      let responded = false;
      let proc;
      try {
        proc = spawn(codexBin, ['auth', 'login'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm' },
        });
      } catch (spawnErr) {
        return res.status(500).json({ error: `Failed to start codex: ${spawnErr.message}` });
      }

      const urlTimeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          proc.kill();
          res.status(504).json({ error: 'Timeout — codex auth login did not emit URL within 15s' });
        }
      }, 15_000);

      function handleOutput(data) {
        if (responded) return;
        const text = data.toString();
        const urlMatch = text.match(/https:\/\/[^\s]+/);
        if (urlMatch) {
          responded = true;
          clearTimeout(urlTimeout);
          res.json({ url: urlMatch[0] });
        }
      }

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('exit', (exitCode) => {
        if (!responded) {
          responded = true;
          clearTimeout(urlTimeout);
          if (exitCode === 0) {
            res.json({ alreadyLoggedIn: true });
          } else {
            res.status(500).json({ error: `codex auth login exited with code ${exitCode}` });
          }
        } else {
          // Login dokončen — emitni SSE event
          emitSseEvent('auth-completed', { type: 'codex-oauth' });
        }
      });
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

        // Start observability stack if builtin provider is configured
        if (config.observability?.provider === 'builtin' && config.observability?.level !== 'none') {
          try {
            const obsRes = await fetch('http://localhost:3001/api/observability/start', { method: 'POST' });
            if (obsRes.ok) {
              log.info('Observability stack started via builtin provider');
            } else {
              log.warn('Failed to start observability stack', { status: obsRes.status });
            }
          } catch (err) {
            log.warn('Could not start observability stack', { err: err?.message });
          }
        }

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
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm' },
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

              // 2. Mapujeme inode → port z /proc/net/tcp + tcp6
              for (const tcpFile of ['tcp', 'tcp6']) {
                try {
                  const netTcp = fs.readFileSync(`/proc/${pid}/net/${tcpFile}`, 'utf8');
                  for (const line of netTcp.split('\n').slice(1)) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 10) continue;
                    if (parts[3] !== '0A') continue; // jen LISTEN
                    if (!inodes.has(parts[9])) continue; // jen sockety tohoto procesu
                    const portHex = parts[1].split(':')[1];
                    port = parseInt(portHex, 16);
                    break;
                  }
                } catch { /* tcp6 nemusí existovat */ }
                if (port) break;
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

      proc.on('exit', (exitCode) => {
        authLoginProc = null;
        if (!responded) {
          responded = true;
          clearTimeout(urlTimeout);
          if (exitCode === 0) {
            // Already logged in — save token to config.json
            void saveOauthTokenToConfig();
            res.json({ url: null, alreadyLoggedIn: true });
          } else {
            res.status(500).json({ error: `claude auth login exited with code ${exitCode}` });
          }
        } else if (exitCode === 0) {
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
        const query = `code=${encodeURIComponent(code.trim())}&state=${encodeURIComponent(state)}`;
        // Try IPv4 first, fall back to IPv6 (Claude may listen on ::1)
        let resp;
        let successHost;
        for (const host of [`127.0.0.1`, `[::1]`]) {
          try {
            resp = await fetch(`http://${host}:${port}/callback?${query}`);
            successHost = host;
            break;
          } catch { /* try next */ }
        }
        if (!resp) throw new Error(`Could not reach claude callback on port ${port} (tried IPv4 and IPv6)`);
        console.log(`[auth] claude callback forwarded via http://${successHost}:${port}`);
        if (resp.ok || resp.status === 302) {
          // Claude zpracoval kód — počkáme na exit procesu (max 10s)
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 10_000);
            authLoginSession?.proc?.on('exit', () => { clearTimeout(t); resolve(); });
          });

          // Přečteme token z Claude Code a uložíme do config.json
          await saveOauthTokenToConfig();
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

    // ── GET /api/hub/catalog ─────────────────────────────────────────────────
    // Returns available teams/agents from hub GitHub repo (or local fallback)
    app.get('/api/hub/catalog', async (req, res) => {
      const config = loadConfig() ?? {};
      const hubRepo = config?.hub?.url ?? 'nano-agent-team/hub';
      const hubBranch = config?.hub?.branch ?? 'main';

      function fetchHubCatalogViaGit() {
        // Use git clone into a cache dir — no rate limits, no token needed for public repos
        const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? config?.hub?.ghToken ?? '';
        const hubGitUrl = ghToken
          ? `https://x-access-token:${ghToken}@github.com/${hubRepo}.git`
          : `https://github.com/${hubRepo}.git`;
        const cacheDir = path.join(dataDir, 'hub-cache');

        // Clone or pull
        if (fs.existsSync(path.join(cacheDir, '.git'))) {
          const pull = spawnSync('git', ['-C', cacheDir, 'fetch', '--depth=1', 'origin', hubBranch], { encoding: 'utf8', timeout: 30_000 });
          spawnSync('git', ['-C', cacheDir, 'reset', '--hard', `origin/${hubBranch}`], { encoding: 'utf8' });
        } else {
          fs.mkdirSync(cacheDir, { recursive: true });
          const clone = spawnSync('git', ['clone', '--depth=1', '--branch', hubBranch, hubGitUrl, cacheDir], { encoding: 'utf8', timeout: 30_000 });
          if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
        }

        function readDirItems(dir, manifestFile) {
          const items = [];
          if (!fs.existsSync(dir)) return items;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const mPath = path.join(dir, entry.name, manifestFile);
            if (!fs.existsSync(mPath)) continue;
            try {
              const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
              const setupPath = path.join(dir, entry.name, 'setup.json');
              let requires = [];
              let setup_url = null;
              if (fs.existsSync(setupPath)) {
                try { const s = JSON.parse(fs.readFileSync(setupPath, 'utf8')); requires = s.requires ?? []; setup_url = s.setup_url ?? null; } catch { /* skip */ }
              }
              items.push({ id: m.id ?? entry.name, name: m.name ?? entry.name, type: manifestFile === 'team.json' ? 'team' : 'agent', description: m.description ?? '', status: m.status ?? 'stable', requires, setup_url });
            } catch { /* skip */ }
          }
          return items;
        }

        return {
          source: 'hub',
          teams: readDirItems(path.join(cacheDir, 'teams'), 'team.json'),
          agents: readDirItems(path.join(cacheDir, 'agents'), 'manifest.json'),
        };
      }

      try {
        const catalog = fetchHubCatalogViaGit();
        return res.json(catalog);
      } catch (hubErr) {
        log.warn('Hub git fetch failed, falling back to local scan', { err: hubErr?.message });
      }

      // Fallback: local scan
      const result = { source: 'local', teams: [], agents: [] };
      const teamsDir = path.join(__dirname, '..', '..', 'teams');
      if (fs.existsSync(teamsDir)) {
        for (const entry of fs.readdirSync(teamsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const tjPath = path.join(teamsDir, entry.name, 'team.json');
          if (!fs.existsSync(tjPath)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(tjPath, 'utf8'));
            const setupPath = path.join(teamsDir, entry.name, 'setup.json');
            let requires = [];
            if (fs.existsSync(setupPath)) {
              try { requires = JSON.parse(fs.readFileSync(setupPath, 'utf8')).requires ?? []; } catch { /* skip */ }
            }
            result.teams.push({ id: m.id ?? entry.name, name: m.name, description: m.description ?? '', status: m.status ?? 'stable', requires });
          } catch { /* skip */ }
        }
      }
      res.json(result);
    });

    // ── POST /api/hub/generate-ssh ────────────────────────────────────────────
    app.post('/api/hub/generate-ssh', (req, res) => {
      const { teamId } = req.body ?? {};
      if (!teamId || !/^[a-zA-Z0-9_-]+$/.test(teamId)) {
        return res.status(400).json({ error: 'Invalid teamId' });
      }

      const keysDir = path.join(dataDir, 'keys');
      if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

      const keyPath = path.join(keysDir, `${teamId}_ed25519`);
      // Remove existing key files if present
      try { fs.unlinkSync(keyPath); } catch { /* ignore */ }
      try { fs.unlinkSync(`${keyPath}.pub`); } catch { /* ignore */ }

      const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `nanoclaw-${teamId}`], {
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        return res.status(500).json({ error: result.stderr || 'ssh-keygen failed' });
      }

      try {
        const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
        res.json({ publicKey });
      } catch (err) {
        res.status(500).json({ error: `Could not read public key: ${String(err)}` });
      }
    });

    // ── POST /api/hub/install ─────────────────────────────────────────────────
    app.post('/api/hub/install', async (req, res) => {
      const { items = [], config: installConfig = {}, force = false } = req.body ?? {};
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '"items" array required' });
      }

      const cfg = loadConfig() ?? {};
      const hubRepo = cfg?.hub?.url ?? 'nano-agent-team/hub';
      const hubBranch = cfg?.hub?.branch ?? 'main';
      const hubGitUrl = `https://github.com/${hubRepo}.git`;
      const installed = [];
      const errors = [];

      function progress(step, detail = '') {
        emitSseEvent('hub-install-progress', { step, detail, ts: Date.now() });
      }

      /** Sparse-clone a single path from hub into destDir */
      function hubSparseClone(sparsePath, destDir) {
        if (fs.existsSync(destDir)) {
          if (!force) return; // already installed, skip
          fs.rmSync(destDir, { recursive: true, force: true });
        }
        const tmpDir = `/tmp/hub-${sparsePath.replace(/\//g, '-')}-${Date.now()}`;
        try {
          const clone = spawnSync('git', [
            'clone', '--depth=1', '--filter=blob:none', '--sparse',
            '--branch', hubBranch, hubGitUrl, tmpDir,
          ], { encoding: 'utf8', timeout: 60_000 });
          if (clone.status !== 0) throw new Error(clone.stderr || 'git clone failed');

          const sparse = spawnSync('git', ['-C', tmpDir, 'sparse-checkout', 'set', sparsePath], { encoding: 'utf8' });
          if (sparse.status !== 0) throw new Error(sparse.stderr || 'sparse-checkout failed');

          const srcPath = path.join(tmpDir, sparsePath);
          if (!fs.existsSync(srcPath)) throw new Error(`${sparsePath} not found in hub`);

          fs.mkdirSync(destDir, { recursive: true });
          spawnSync('cp', ['-r', `${srcPath}/.`, destDir], { encoding: 'utf8' });
        } finally {
          try { spawnSync('rm', ['-rf', tmpDir]); } catch { /* ignore */ }
        }
      }

      /** Build a feature component */
      function buildComponent(featureDir, component) {
        const compDir = path.join(featureDir, component.path);
        if (!fs.existsSync(compDir)) return;
        const buildCmd = component.build ?? 'npm ci && npm run build';
        log.info('Building component', { type: component.type, dir: compDir, cmd: buildCmd });
        const result = spawnSync('sh', ['-c', buildCmd], { cwd: compDir, encoding: 'utf8', timeout: 120_000 });
        if (result.status !== 0) {
          throw new Error(`Build failed in ${compDir}: ${result.stderr || result.stdout}`);
        }
      }

      for (const teamId of items) {
        if (!/^[a-zA-Z0-9_-]+$/.test(teamId)) {
          errors.push({ id: teamId, error: 'Invalid team id' });
          continue;
        }

        try {
          // 1. Clone team manifest (preserve config files across force reinstall)
          progress('clone-team', teamId);
          const teamDir = path.join(dataDir, 'teams', teamId);
          const configDir = path.join(teamDir, 'config');
          const configBackup = {};
          if (force && fs.existsSync(configDir)) {
            for (const f of fs.readdirSync(configDir)) {
              try { configBackup[f] = fs.readFileSync(path.join(configDir, f)); } catch { /* skip */ }
            }
          }
          hubSparseClone(`teams/${teamId}`, teamDir);
          if (force && Object.keys(configBackup).length > 0) {
            fs.mkdirSync(configDir, { recursive: true });
            for (const [f, buf] of Object.entries(configBackup)) {
              fs.writeFileSync(path.join(configDir, f), buf);
            }
          }

          // 1b. Symlink node_modules into plugin-dist so ESM can resolve packages
          const pluginDistDir = path.join(teamDir, 'plugin-dist');
          const nmLink = path.join(pluginDistDir, 'node_modules');
          if (fs.existsSync(pluginDistDir) && !fs.existsSync(nmLink)) {
            try {
              // /app/node_modules contains better-sqlite3 etc. needed by team plugins
              fs.symlinkSync('/app/node_modules', nmLink);
            } catch { /* may already exist */ }
          }

          // 2. Read team.json → get agents + features
          const teamJson = JSON.parse(fs.readFileSync(path.join(teamDir, 'team.json'), 'utf8'));
          const agentIds = teamJson.agents ?? [];
          const featureIds = teamJson.features ?? [];
          const configEnvMap = teamJson.config_env_map ?? {};

          // 3. Clone agents — team-specific path first, fall back to top-level agents/
          for (const agentId of agentIds) {
            progress('clone-agent', agentId);
            const agentDir = path.join(dataDir, 'agents', agentId);
            try {
              hubSparseClone(`teams/${teamId}/agents/${agentId}`, agentDir);
            } catch {
              hubSparseClone(`agents/${agentId}`, agentDir);
            }
          }

          // 4. Clone + build features
          for (const featureId of featureIds) {
            progress('clone-feature', featureId);
            const featureDir = path.join(dataDir, 'features', featureId);
            hubSparseClone(`features/${featureId}`, featureDir);

            const featureJsonPath = path.join(featureDir, 'feature.json');
            if (fs.existsSync(featureJsonPath)) {
              const featureJson = JSON.parse(fs.readFileSync(featureJsonPath, 'utf8'));
              for (const component of featureJson.components ?? []) {
                progress('build', `${featureId}/${component.type}`);
                buildComponent(featureDir, component);
              }
            }
          }

          // 5. Apply config_env_map
          for (const [configKey, envKey] of Object.entries(configEnvMap)) {
            if (installConfig[configKey] !== undefined) {
              process.env[envKey] = String(installConfig[configKey]);
            }
          }

          // 6. Save config
          const current = loadConfig() ?? cfg;
          const updatedCfg = deepMerge(current, {
            teams: { [teamId]: { config: installConfig, env_map: configEnvMap } },
            installed: {
              teams: [...new Set([...(current.installed?.teams ?? []), teamId])],
            },
          });
          saveConfig(updatedCfg);

          installed.push(teamId);
        } catch (err) {
          errors.push({ id: teamId, error: String(err) });
        }
      }

      // 7. Reload features + start new agents
      progress('reload', 'Spouštím agenty...');
      try {
        if (reloadFeatures) await reloadFeatures();
      } catch (err) {
        log.warn('reloadFeatures error', { err: err?.message });
      }
      progress('done', installed.join(', '));

      if (errors.length > 0 && installed.length === 0) {
        return res.status(500).json({ ok: false, errors });
      }

      res.json({ ok: true, installed, errors: errors.length ? errors : undefined });
    });

    // ── Serve settings frontend static assets ───────────────────────────────
    const frontendDist = path.join(__dirname, 'frontend-dist');
    if (fs.existsSync(frontendDist)) {
      const { default: express } = await import('express');
      app.use('/features/settings', express.static(frontendDist));
      log.info('Serving frontend', { from: frontendDist });
    } else {
      log.warn('Frontend not built — run: cd features/settings/frontend && npm run build');
    }

    log.info('Config API registered (/api/config)');
  },
};
