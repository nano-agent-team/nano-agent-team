import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 70_000,
    // 60s: beforeAll polls for agent container readiness via docker exec (OrbStack volume sync lag)
    hookTimeout: 60_000,
    env: {
      BASE_URL: process.env.BASE_URL ?? 'http://localhost:3001',
      NATS_URL: process.env.NATS_URL ?? 'nats://localhost:4222',
      MOCK_RESPONSE: process.env.MOCK_RESPONSE ?? 'Mock provider: task acknowledged.',
    },
  },
});
