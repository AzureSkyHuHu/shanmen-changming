import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const legacyRoot = resolve(process.env.SAVE_GROWTH_V5_ROOT ?? '../validation-combat-v5');
const currentRoot = resolve(process.env.SAVE_GROWTH_CURRENT_ROOT ?? '../validation-history-v6');
process.env.SAVE_GROWTH_V5_ROOT = legacyRoot;
process.env.SAVE_GROWTH_CURRENT_ROOT = currentRoot;
export default defineConfig({
  resolve: { alias: {
    '@save-growth-v5': resolve(legacyRoot, 'src'),
    '@save-growth-current': resolve(currentRoot, 'src'),
  } },
  test: { environment: 'node', include: ['tools/bench-save-growth/v6-comparison.bench.test.mjs'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 240_000 },
});
