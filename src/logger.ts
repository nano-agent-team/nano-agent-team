import pino from 'pino';

import { LOG_LEVEL } from './config.js';

const isProduction = process.env.NODE_ENV === 'production';

function buildTransport(): ReturnType<typeof pino.transport> {
  if (!isProduction) {
    return pino.transport({ target: 'pino-pretty', options: { colorize: true } });
  }
  return pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        level: LOG_LEVEL,
        options: { colorize: false, destination: 2 }, // stderr
      },
    ],
  });
}

/**
 * OTel trace correlation mixin — adds traceId/spanId to every log line.
 * When OTel is not active, returns empty object (zero overhead).
 */
function otelMixin(): Record<string, unknown> {
  try {
    // @opentelemetry/api is only loaded when tracing is enabled (by init.ts)
    // Use dynamic require-style check via the module cache
    const api = (globalThis as Record<string, unknown>).__otelApi as typeof import('@opentelemetry/api') | undefined;
    if (!api) return {};

    const span = api.trace.getActiveSpan();
    if (!span) return {};

    const ctx = span.spanContext();
    if (!ctx || !api.isSpanContextValid(ctx)) return {};

    return { traceId: ctx.traceId, spanId: ctx.spanId };
  } catch {
    return {};
  }
}

export const logger = pino(
  {
    level: LOG_LEVEL,
    mixin: otelMixin,
  },
  buildTransport(),
);

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
