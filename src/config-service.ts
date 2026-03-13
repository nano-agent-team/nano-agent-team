/**
 * ConfigService — read/write /data/config.json
 *
 * Supports dot-path access: setPath("provider.apiKey", "sk-ant-...")
 */

import fs from 'fs';
import path from 'path';

export interface NanoConfig {
  version: string;
  setupCompleted: boolean;
  provider?: {
    type: 'claude-code' | 'claude-code-oauth';
    apiKey?: string;
  };
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
    return masked;
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
