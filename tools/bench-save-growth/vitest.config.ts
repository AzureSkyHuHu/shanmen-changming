import { defineConfig } from 'vitest/config';

// Deliberately outside tests/**: integration owner runs this benchmark explicitly.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/bench-save-growth/save-growth.bench.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
  },
});
