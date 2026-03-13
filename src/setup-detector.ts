/**
 * Setup mode detection
 *
 * Determines whether the system needs to run through the setup wizard.
 * Called at startup before anything else.
 */

import { ConfigService } from './config-service.js';

export type SetupMode =
  | 'first-run'          // /data/config.json doesn't exist
  | 'setup-incomplete'   // config exists but setupCompleted = false
  | 'ready';             // config valid, setupCompleted = true, provider present

export async function detectSetupMode(dataDir: string): Promise<SetupMode> {
  const svc = new ConfigService(dataDir);

  if (!svc.exists()) return 'first-run';

  const config = await svc.load();
  if (!config) return 'first-run';

  if (!config.setupCompleted) return 'setup-incomplete';

  const missing = svc.getMissing(config);
  if (missing.length > 0) return 'setup-incomplete';

  return 'ready';
}

export function isSetupRequired(mode: SetupMode): boolean {
  return mode !== 'ready';
}
