// Explicit opt-in only. Production entries and default tests never invoke this.
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.log('Owner CPU diagnostics: node tools/profile-v10-workloads.mjs --run --fixtures=/absolute/capture-directory --baseline-report=/absolute/0030-report.json --output=/absolute/new-profile-directory [--scenarios=NAME,NAME]');
  console.log('Defaults: upgrade-precheckpoint, alternative-care-working, upgrade-half-checkpoint. See docs/v10-profiling.md.');
} else {
  const prefixes = ['--fixtures=', '--baseline-report=', '--output=', '--scenarios='];
  if (new Set(args).size !== args.length || args.some(value => value !== '--run' && !prefixes.some(prefix => value.startsWith(prefix)))
    || prefixes.some(prefix => args.filter(value => value.startsWith(prefix)).length > 1)) throw new Error('Unknown or repeated profile option');
  const option = prefix => args.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const directory = option('--fixtures='); const baselineReport = option('--baseline-report='); const outputDirectory = option('--output=');
  const names = option('--scenarios=');
  if (!directory || !baselineReport || !outputDirectory || names === '') throw new Error('Explicit nonempty fixture, baseline and output paths are required');
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const module = await server.ssrLoadModule('/tools/profile-v10-workloads.ts');
    const result = await module.profileWorkloads({ directory, baselineReport, outputDirectory,
      ...(names === undefined ? {} : { scenarios: names.split(',') }),
      progress: message => process.stderr.write(`[v10-profile] ${message}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await server.close(); }
}
