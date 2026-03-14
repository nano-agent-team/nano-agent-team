/**
 * Observability Feature Plugin
 *
 * Manages observability stack (Tempo, Loki, Grafana, Alloy) via Docker Compose.
 * Two modes:
 *   - builtin: feature manages Docker Compose lifecycle
 *   - custom: user provides own endpoints, no Docker services
 *
 * Key insight: Docker daemon runs on HOST but this plugin runs INSIDE a container.
 * Volume mounts in compose must use HOST paths. We copy config files to /data/observability/
 * (which is bind-mounted from the host) so Docker daemon can access them.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_CONFIGS_SRC = path.join(__dirname, 'compose');

function defaultEndpoints() {
  return {
    otlp: 'http://tempo:4318',
    loki: 'http://loki:3100',
    grafana: 'http://localhost:3000',
  };
}

/**
 * Ensure config files are copied to /data/observability/ (host-accessible volume)
 * and generate a docker-compose file with correct host paths.
 */
function ensureComposeDir(dataDir) {
  const obsDir = path.join(dataDir, 'observability');
  if (!fs.existsSync(obsDir)) fs.mkdirSync(obsDir, { recursive: true });

  // Copy config files from bundled compose/ to data dir
  const configs = ['tempo.yaml', 'loki.yaml', 'alloy.config', 'grafana-datasources.yaml', 'grafana-dashboards.yaml'];
  for (const f of configs) {
    const src = path.join(COMPOSE_CONFIGS_SRC, f);
    const dst = path.join(obsDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Copy dashboard JSON files
  const dashboardsSrc = path.join(COMPOSE_CONFIGS_SRC, 'dashboards');
  const dashboardsDst = path.join(obsDir, 'dashboards');
  if (fs.existsSync(dashboardsSrc)) {
    if (!fs.existsSync(dashboardsDst)) fs.mkdirSync(dashboardsDst, { recursive: true });
    for (const f of fs.readdirSync(dashboardsSrc)) {
      fs.copyFileSync(path.join(dashboardsSrc, f), path.join(dashboardsDst, f));
    }
  }

  // HOST_DATA_DIR is the host path to /data (set in docker-compose.dev.yml)
  const hostDataDir = process.env.HOST_DATA_DIR ?? dataDir;
  const hostObsDir = path.join(hostDataDir, 'observability');

  // Generate compose file with host-resolvable paths
  const composeContent = `
services:
  tempo:
    image: grafana/tempo:2.6.1
    container_name: nano-tempo
    command: ["-config.file=/etc/tempo/tempo.yaml"]
    volumes:
      - ${hostObsDir}/tempo.yaml:/etc/tempo/tempo.yaml:ro
      - nano-tempo-data:/var/tempo
    ports:
      - "3200:3200"
      - "4317:4317"
      - "4318:4318"
    restart: unless-stopped

  loki:
    image: grafana/loki:3.3.2
    container_name: nano-loki
    command: ["-config.file=/etc/loki/loki.yaml"]
    volumes:
      - ${hostObsDir}/loki.yaml:/etc/loki/loki.yaml:ro
      - nano-loki-data:/loki
    ports:
      - "3100:3100"
    restart: unless-stopped

  alloy:
    image: grafana/alloy:v1.5.1
    container_name: nano-alloy
    command:
      - run
      - /etc/alloy/config.alloy
      - --server.http.listen-addr=0.0.0.0:12345
      - --stability.level=generally-available
    volumes:
      - ${hostObsDir}/alloy.config:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - "12345:12345"
    depends_on:
      - loki
    restart: unless-stopped

  grafana:
    image: grafana/grafana:11.4.0
    container_name: nano-grafana
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
      - GF_AUTH_DISABLE_LOGIN_FORM=true
      - GF_FEATURE_TOGGLES_ENABLE=traceqlEditor tempoSearch tempoServiceGraph
    volumes:
      - ${hostObsDir}/grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro
      - ${hostObsDir}/grafana-dashboards.yaml:/etc/grafana/provisioning/dashboards/dashboards.yaml:ro
      - ${hostObsDir}/dashboards:/var/lib/grafana/dashboards:ro
      - nano-grafana-data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - tempo
      - loki
    restart: unless-stopped

volumes:
  nano-tempo-data:
  nano-loki-data:
  nano-grafana-data:
`;

  const composePath = path.join(obsDir, 'docker-compose.yml');
  fs.writeFileSync(composePath, composeContent);
  return composePath;
}

/** Run docker compose command */
function composeExec(composeFile, args, timeout = 120_000) {
  const cmd = `docker compose -f ${composeFile} ${args}`;
  try {
    const result = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      timeout,
    });
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err) };
  }
}

/** Get services to start based on level */
function getServices(level) {
  if (level === 'full') return ''; // all services
  if (level === 'logging') return 'loki alloy grafana'; // no tempo
  return '';
}

/** Check if a service is healthy via HTTP */
async function checkServiceHealth(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    return { ok: false, error: String(err.cause?.code ?? err.message ?? err) };
  }
}

export default {
  async register(app, _nc, _manager, opts) {
    const { configService, emitSseEvent, dataDir } = opts;
    const configPath = path.join(dataDir, 'config.json');

    function loadConfig() {
      try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
      catch { return {}; }
    }

    function saveConfig(config) {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

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

    function getComposeFile() {
      return ensureComposeDir(dataDir);
    }

    // ── GET /api/observability/status ──────────────────────────────────────
    app.get('/api/observability/status', async (_req, res) => {
      try {
        const config = loadConfig();
        const obs = config.observability ?? { level: 'none', provider: 'builtin', endpoints: {} };

        let composeRunning = false;
        if (obs.provider === 'builtin' && obs.level !== 'none') {
          const composeFile = getComposeFile();
          const ps = composeExec(composeFile, 'ps --format json', 10_000);
          composeRunning = ps.ok && ps.stdout.includes('"State"');
        }

        res.json({
          level: obs.level,
          provider: obs.provider,
          endpoints: obs.endpoints ?? defaultEndpoints(),
          composeRunning,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── POST /api/observability/configure ──────────────────────────────────
    app.post('/api/observability/configure', async (req, res) => {
      try {
        const { level, provider, endpoints } = req.body;
        const config = loadConfig();

        const obsUpdate = {};
        if (level !== undefined) obsUpdate.level = level;
        if (provider !== undefined) obsUpdate.provider = provider;
        if (endpoints !== undefined) obsUpdate.endpoints = endpoints;

        if (obsUpdate.provider === 'builtin' && !obsUpdate.endpoints) {
          obsUpdate.endpoints = defaultEndpoints();
        }

        config.observability = deepMerge(config.observability ?? {}, obsUpdate);
        if (!config.observability.endpoints) config.observability.endpoints = defaultEndpoints();

        saveConfig(config);

        // Auto-start/stop compose
        if (config.observability.provider === 'builtin') {
          const composeFile = getComposeFile();
          if (config.observability.level === 'none') {
            composeExec(composeFile, 'down', 30_000);
          } else {
            const services = getServices(config.observability.level);
            composeExec(composeFile, `up -d ${services}`, 120_000);
          }
        }

        emitSseEvent('observability-configured', {
          level: config.observability.level,
          provider: config.observability.provider,
        });

        res.json({ ok: true, observability: config.observability });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── GET /api/observability/health ──────────────────────────────────────
    app.get('/api/observability/health', async (_req, res) => {
      try {
        const config = loadConfig();
        const obs = config.observability ?? { level: 'none', provider: 'builtin', endpoints: {} };

        if (obs.level === 'none') {
          return res.json({ healthy: false, services: {}, message: 'Observability is disabled' });
        }

        // For builtin, check compose is running first
        if (obs.provider === 'builtin') {
          const composeFile = getComposeFile();
          const ps = composeExec(composeFile, 'ps --format json', 10_000);
          if (!ps.ok || !ps.stdout.includes('"State"')) {
            return res.json({ healthy: false, services: {}, message: 'Stack is not running. Click Start to launch it.' });
          }
        }

        // Health checks use localhost (host network mode)
        const health = {};

        if (obs.level === 'full') {
          health.tempo = await checkServiceHealth('http://localhost:3200/ready');
        }
        if (obs.level === 'logging' || obs.level === 'full') {
          health.loki = await checkServiceHealth('http://localhost:3100/ready');
          health.grafana = await checkServiceHealth('http://localhost:3000/api/health');
        }

        const allHealthy = Object.values(health).every(h => h.ok);
        res.json({ healthy: allHealthy, services: health });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── POST /api/observability/start ──────────────────────────────────────
    app.post('/api/observability/start', async (_req, res) => {
      try {
        const config = loadConfig();
        const obs = config.observability ?? { level: 'full', provider: 'builtin' };

        if (obs.provider !== 'builtin') {
          return res.status(400).json({ error: 'Cannot start services for custom provider' });
        }

        const level = obs.level || 'full';
        const composeFile = getComposeFile();
        const services = getServices(level);
        const result = composeExec(composeFile, `up -d ${services}`, 120_000);

        if (result.ok) {
          emitSseEvent('observability-started', { level });
          res.json({ ok: true, level });
        } else {
          res.status(500).json({ error: result.stderr || 'docker compose up failed' });
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── POST /api/observability/stop ──────────────────────────────────────
    app.post('/api/observability/stop', async (_req, res) => {
      try {
        const composeFile = getComposeFile();
        const result = composeExec(composeFile, 'down', 30_000);
        if (result.ok) {
          emitSseEvent('observability-stopped', {});
          res.json({ ok: true });
        } else {
          res.status(500).json({ error: result.stderr || 'docker compose down failed' });
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── GET /api/observability/traces — proxy to Tempo search ──────────────
    app.get('/api/observability/traces', async (req, res) => {
      try {
        const limit = req.query.limit ?? 30;
        const q = req.query.q ?? '{}';
        const start = req.query.start ?? '';
        const end = req.query.end ?? '';
        let url = `http://localhost:3200/api/search?q=${encodeURIComponent(q)}&limit=${limit}`;
        if (start) url += `&start=${start}`;
        if (end) url += `&end=${end}`;
        const r = await fetch(url);
        if (!r.ok) return res.status(r.status).json({ error: await r.text() });
        res.json(await r.json());
      } catch (err) {
        res.status(502).json({ error: String(err.cause?.code ?? err.message) });
      }
    });

    // ── GET /api/observability/trace/:traceId — get single trace detail ──
    app.get('/api/observability/trace/:traceId', async (req, res) => {
      try {
        const r = await fetch(`http://localhost:3200/api/traces/${req.params.traceId}`);
        if (!r.ok) return res.status(r.status).json({ error: await r.text() });
        res.json(await r.json());
      } catch (err) {
        res.status(502).json({ error: String(err.cause?.code ?? err.message) });
      }
    });

    // ── GET /api/observability/logs — proxy to Loki ─────────────────────
    app.get('/api/observability/logs', async (req, res) => {
      try {
        const query = req.query.query ?? '{job="nano-agent-team"}';
        const limit = req.query.limit ?? 100;
        const url = `http://localhost:3100/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=${limit}&direction=backward`;
        const r = await fetch(url);
        if (!r.ok) return res.status(r.status).json({ error: await r.text() });
        res.json(await r.json());
      } catch (err) {
        res.status(502).json({ error: String(err.cause?.code ?? err.message) });
      }
    });

    // ── Serve frontend static assets ──────────────────────────────────────
    const frontendDist = path.join(__dirname, 'frontend-dist');
    if (fs.existsSync(frontendDist)) {
      const { default: express } = await import('express');
      app.use('/features/observability', express.static(frontendDist));
    }

    console.log('[observability feature] Plugin registered');
  },
};
