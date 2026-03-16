import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 70_000,   // C2 heartbeat test čeká až 65s
    hookTimeout: 15_000,
  },
});
