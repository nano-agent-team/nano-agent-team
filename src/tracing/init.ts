/**
 * OTel tracing status helper.
 *
 * Actual SDK initialization happens in register.mjs (loaded via node --import).
 * This module only exposes the status check.
 */

/** Check if OTel tracing is active (set by register.mjs via globalThis) */
export function isTracingEnabled(): boolean {
  return (globalThis as Record<string, unknown>).__otelTracingEnabled === true;
}
