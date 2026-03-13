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

export const logger = pino(
  { level: LOG_LEVEL },
  buildTransport(),
);

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
