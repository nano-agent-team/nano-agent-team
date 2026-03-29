/**
 * SecretManager — wraps SecretStore with file mount support and deterministic-only guard.
 *
 * LLM agents never receive secrets directly. Only deterministic agents
 * (kind === 'deterministic') get secrets injected as env vars and/or file mounts.
 *
 * File mounts: secrets written to host temp files and bind-mounted into containers
 * with restrictive permissions (default 0400).
 */

import fs from 'fs';
import path from 'path';

import { SecretStore } from './secret-store.js';
import { logger } from './logger.js';

export interface FileMount {
  secret: string;   // key in secret store
  path: string;     // container path to mount to
  mode?: string;    // file permission mode, default '0400'
}

export interface ResolvedSecrets {
  envVars: string[];
  fileMounts: Array<{ hostPath: string; containerPath: string; mode: string }>;
}

export class SecretManager {
  private readonly store: SecretStore;
  private readonly mountDir: string;

  constructor(private readonly dataDir: string) {
    this.store = new SecretStore();
    this.mountDir = path.join(dataDir, 'secret-mounts');
    fs.mkdirSync(this.mountDir, { recursive: true });
  }

  /** Resolve secrets for an agent. Returns empty for LLM agents. */
  resolve(manifest: {
    id: string;
    required_env?: string[];
    required_files?: FileMount[];
  }, isDeterministic: boolean): ResolvedSecrets {
    if (!isDeterministic) {
      return { envVars: [], fileMounts: [] };
    }

    const envVars = this.store.getEnvVars(manifest.required_env ?? []);

    const missingEnv = this.store.getMissing(manifest.required_env ?? []);
    if (missingEnv.length > 0) {
      logger.warn({ agentId: manifest.id, missing: missingEnv }, 'Agent missing required secrets');
    }

    const fileMounts: ResolvedSecrets['fileMounts'] = [];
    for (const fm of manifest.required_files ?? []) {
      const value = this.store.get(fm.secret);
      if (!value) {
        logger.warn({ agentId: manifest.id, secret: fm.secret }, 'File mount secret not found — skipping');
        continue;
      }
      const hostPath = path.join(this.mountDir, `${manifest.id}-${fm.secret}`);
      fs.writeFileSync(hostPath, value, { mode: parseInt(fm.mode ?? '0400', 8) });
      fileMounts.push({
        hostPath,
        containerPath: fm.path,
        mode: fm.mode ?? '0400',
      });
    }

    logger.debug(
      { agentId: manifest.id, envCount: envVars.length, fileCount: fileMounts.length },
      'Secrets resolved for deterministic agent',
    );

    return { envVars, fileMounts };
  }

  // Delegate store methods for API use
  get(key: string): string | undefined { return this.store.get(key); }
  set(key: string, value: string): void { this.store.set(key, value); }
  delete(key: string): void { this.store.delete(key); }
  listKeys(): string[] { return this.store.listKeys(); }
  getMissing(keys: string[]): string[] { return this.store.getMissing(keys); }
  getEnvVars(keys: string[]): string[] { return this.store.getEnvVars(keys); }
}
