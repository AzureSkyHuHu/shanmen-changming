// Explicit opt-in: npm test/build/check do not invoke this launcher; --run is required.
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.log('Opt-in genuine v10 workloads: node tools/benchmark-v10-workloads.mjs --run [--without-session] [--scenario=NAME]');
  console.log('Setup earns resources/research/L2/medicine/care through real commands and ticks and may take several minutes. See docs/v10-workload-benchmark.md.');
} else {
  const allowed = args.every(value => value === '--run' || value === '--without-session' || value.startsWith('--scenario='));
  if (!allowed || args.filter(value => value.startsWith('--scenario=')).length > 1) throw new Error('Unknown or repeated benchmark option');
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const module = await server.ssrLoadModule('/tools/benchmark-v10-workloads.ts');
    const scenario = args.find(value => value.startsWith('--scenario='))?.slice('--scenario='.length);
    if (scenario !== undefined && !module.SCENARIO_NAMES.includes(scenario)) throw new Error(`Unknown scenario. Choose: ${module.SCENARIO_NAMES.join(', ')}`);
    const result = module.runWorkloadBenchmark({ ...(scenario === undefined ? {} : { scenario }),
      session: !args.includes('--without-session'), progress: message => process.stderr.write(`[v10-workloads] ${message}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await server.close(); }
}
