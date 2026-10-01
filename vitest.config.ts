import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    clearMocks: true,
    restoreMocks: true,
    // Bound test-process pressure; simulation integration tests retain their real assertions/timeouts.
    maxWorkers: 2,
    sequence: { concurrent: false },
  },
});
