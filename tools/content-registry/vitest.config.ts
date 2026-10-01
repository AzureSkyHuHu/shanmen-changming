import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tools/content-registry/capture-v7.test.ts'], maxWorkers: 1 } });
