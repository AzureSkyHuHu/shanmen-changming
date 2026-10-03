// Explicit opt-in: npm test/build/check do not invoke this launcher; --run is required.
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.log('Opt-in genuine v10 workloads: node tools/benchmark-v10-workloads.mjs --run [--without-session] [--scenario=NAME]');
  console.log('Capture once: --run --capture-fixtures=/absolute/new-directory --baseline-report=/absolute/0030-report.json');
  console.log('Reuse: --run --fixtures=/absolute/capture-directory --baseline-report=/absolute/0030-report.json [--without-session] [--scenario=NAME]');
  console.log('Setup earns resources/research/L2/medicine/care through real commands and ticks and may take several minutes. See docs/v10-workload-benchmark.md.');
} else {
  const prefixes = ['--scenario=', '--capture-fixtures=', '--fixtures=', '--baseline-report='];
  const allowed = args.every(value => value === '--run' || value === '--without-session' || prefixes.some(prefix => value.startsWith(prefix)));
  if (!allowed || new Set(args).size !== args.length || prefixes.some(prefix => args.filter(value => value.startsWith(prefix)).length > 1))
    throw new Error('Unknown or repeated benchmark option');
  const option = prefix => args.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const capture = option('--capture-fixtures='); const fixtures = option('--fixtures='); const baselineReport = option('--baseline-report=');
  if (prefixes.some(prefix => option(prefix) === '')) throw new Error('Empty benchmark option');
  if (capture && (fixtures || option('--scenario=') || args.includes('--without-session')))
    throw new Error('Capture generates all nine sources only; do not combine with measurement flags');
  if (!!(capture || fixtures) !== !!baselineReport) throw new Error('Capture/reuse requires an explicit baseline report, and baseline alone is unsupported');
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const module = await server.ssrLoadModule('/tools/benchmark-v10-workloads.ts');
    const scenario = args.find(value => value.startsWith('--scenario='))?.slice('--scenario='.length);
    if (scenario !== undefined && !module.SCENARIO_NAMES.includes(scenario)) throw new Error(`Unknown scenario. Choose: ${module.SCENARIO_NAMES.join(', ')}`);
    const progress = message => process.stderr.write(`[v10-workloads] ${message}\n`);
    let result;
    if (capture || fixtures) {
      const tooling = await server.ssrLoadModule('/tools/profile-v10-workloads.ts');
      result = capture ? tooling.captureWorkloadFixtures({ directory: capture, baselineReport, progress })
        : tooling.benchmarkReusedWorkloads({ directory: fixtures, baselineReport, ...(scenario === undefined ? {} : { scenario }),
          session: !args.includes('--without-session'), progress });
    } else {
      result = module.runWorkloadBenchmark({ ...(scenario === undefined ? {} : { scenario }),
        session: !args.includes('--without-session'), progress });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await server.close(); }
}
