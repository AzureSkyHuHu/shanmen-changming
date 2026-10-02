import { createServer } from 'vite';
const value = process.argv.find(value => value.startsWith('--samples='));
const samples = value ? Number(value.slice('--samples='.length)) : 20;
const scenarioOption = process.argv.find(value => value.startsWith('--scenario='));
const scenario = scenarioOption?.slice('--scenario='.length);
// Vite's SSR loader resolves the repository's extensionless TypeScript imports.
// No browser, network endpoint, installation, or production-build mutation.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { runBenchmarkV9 } = await server.ssrLoadModule('/tools/benchmark-v9-runtime.ts');
  process.stdout.write(`${JSON.stringify(await runBenchmarkV9(samples, scenario), null, 2)}\n`);
} finally { await server.close(); }
