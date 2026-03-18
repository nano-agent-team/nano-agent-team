/**
 * SecretStore — file-based secret management
 *
 * PoC implementation: secrets are stored in data/secrets.json (mode 0600).
 * Future: replace with encrypted store, system keychain, or Vault.
 *
 * Secrets are consumed by MCP server containers as env vars — agents
 * never receive secrets directly.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');

export class SecretStore {
  private load(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private save(secrets: Record<string, string>): void {
    const dir = path.dirname(SECRETS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    // mode 0600: owner read/write only
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }

  get(key: string): string | undefined {
    return this.load()[key];
  }

  set(key: string, value: string): void {
    const secrets = this.load();
    secrets[key] = value;
    this.save(secrets);
    logger.debug({ key }, 'Secret stored');
  }

  delete(key: string): void {
    const secrets = this.load();
    delete secrets[key];
    this.save(secrets);
    logger.debug({ key }, 'Secret deleted');
  }

  /** Returns all secret keys — values are never logged or exposed. */
  listKeys(): string[] {
    return Object.keys(this.load());
  }

  /** Returns subset of secrets as env-var pairs. Used by McpManager to inject into containers. */
  getEnvVars(keys: string[]): string[] {
    const secrets = this.load();
    return keys.flatMap((key) => {
      const value = secrets[key];
      return value ? [`${key}=${value}`] : [];
    });
  }

  /** Returns which keys from the given list are not yet set. */
  getMissing(keys: string[]): string[] {
    const secrets = this.load();
    return keys.filter((k) => !secrets[k]);
  }
}
