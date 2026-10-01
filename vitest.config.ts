import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    clearMocks: true,
    restoreMocks: true,
    // Match the verified serial integration lane on shared CI CPUs.
    // Keep every real assertion and per-test timeout unchanged; avoid competing replay-heavy workers.
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
