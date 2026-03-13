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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      if (!config?.provider?.apiKey) missing.push('provider.apiKey');
      if (!config?.provider?.type) missing.push('provider.type');
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
