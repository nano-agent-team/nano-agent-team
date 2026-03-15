/**
 * ConfigService — read/write /data/config.json
 *
 * Supports dot-path access: setPath("provider.apiKey", "sk-ant-...")
 */

import fs from 'fs';
import path from 'path';

export interface ProviderConfig {
  apiKey?: string;
  /** Capability tag → model name mapping. Key 'default' is fallback. */
  modelMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface NanoConfig {
  version: string;
  setupCompleted: boolean;
  provider?: {
    type: 'claude-code' | 'claude-code-oauth';
    apiKey?: string;
  };
  /** Primary LLM provider used for 'auto' agents (default: 'claude') */
  primaryProvider?: string;
  /** Per-provider credentials and model maps */
  providers?: Record<string, ProviderConfig>;
  installed: {
    features: string[];
    teams: string[];
  };
  meta: {
    createdAt: string;
    setupCompletedAt: string | null;
  };
}

function createDefaultConfig(): NanoConfig {
  return {
    version: '1',
    setupCompleted: false,
    installed: { features: [], teams: [] },
    meta: { createdAt: new Date().toISOString(), setupCompletedAt: null },
  };
}

function getNestedValue(obj: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setNestedValue(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

export class ConfigService {
  private configPath: string;

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, 'config.json');
  }

  async load(): Promise<NanoConfig | null> {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(raw) as NanoConfig;
    } catch {
      return null;
    }
  }

  async save(config: NanoConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  async loadOrCreate(): Promise<NanoConfig> {
    return (await this.load()) ?? createDefaultConfig();
  }

  async setPath(keyPath: string, value: unknown): Promise<void> {
    const config = await this.loadOrCreate();
    setNestedValue(config as unknown as Record<string, unknown>, keyPath.split('.'), value);
    await this.save(config);
  }

  async getPath(keyPath: string): Promise<unknown> {
    const config = await this.load();
    if (!config) return undefined;
    if (!keyPath) return config;
    return getNestedValue(config as unknown as Record<string, unknown>, keyPath.split('.'));
  }

  exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  /** Returns a copy of config with secrets masked (safe to send to LLM or API) */
  maskSecrets(config: NanoConfig): NanoConfig {
    const masked = structuredClone(config) as NanoConfig;
    if (masked.provider?.apiKey) {
      masked.provider.apiKey = '***';
    }
    // Mask per-provider API keys
    if (masked.providers) {
      for (const p of Object.values(masked.providers)) {
        if (p.apiKey) p.apiKey = '***';
      }
    }
    return masked;
  }

  /** Resolve provider and model for an agent based on capabilities + config */
  resolveAgentProvider(manifest: { model?: string; provider?: string; capabilities?: string[] }, config: NanoConfig): { provider: string; model: string } {
    const primaryProvider = config.primaryProvider ?? 'claude';

    // Explicit model override → use as-is
    if (manifest.model) {
      const provider = (manifest.provider && manifest.provider !== 'auto')
        ? manifest.provider
        : primaryProvider;
      return { provider, model: manifest.model };
    }

    // Determine provider
    const provider = (manifest.provider && manifest.provider !== 'auto')
      ? manifest.provider
      : primaryProvider;

    // Auto-select model from capabilities + modelMap
    const modelMap = config.providers?.[provider]?.modelMap ?? {};
    const capabilities = manifest.capabilities ?? [];
    const priorityOrder = ['reasoning', 'long-context', 'fast', 'cheap'];
    for (const cap of priorityOrder) {
      if (capabilities.includes(cap) && modelMap[cap]) {
        return { provider, model: modelMap[cap] };
      }
    }
    return { provider, model: modelMap['default'] ?? 'claude-haiku-4-5-20251001' };
  }

  /** What's missing for setup to be considered complete */
  getMissing(config: NanoConfig): string[] {
    const missing: string[] = [];
    if (!config.provider?.type) missing.push('provider.type');
    // claude-code-oauth uses mounted credentials — no apiKey needed
    if (config.provider?.type !== 'claude-code-oauth' && !config.provider?.apiKey) {
      missing.push('provider.apiKey');
    }
    return missing;
  }
}
