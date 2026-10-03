/** Opt-in Node tooling only. Nothing here is imported by production code. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { Session as InspectorSession } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isManagementV10Identity } from '../src/content/sect-v10/world-content';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../src/core/kernel/save-v10';
import { canonicalStringify } from '../src/core/kernel/serialization';
import { inspectUnregisteredWorldV10Records } from '../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../src/core/save-budget';
import type { WorldStateV10 } from '../src/core/sect-expansion/upgrade-types';
import { assessManagementCapacityV10 } from '../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 } from '../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10, type RuntimeInstanceMetricsV10 } from '../src/core/world/runtime-instance-v10';
import { admitSaveWorldV10 } from '../src/core/world/save-admission-v10';
import { benchmarkOwner, benchmarkSession, prepareScenarios, SCENARIO_NAMES, sourceEvidence,
  type Scenario, type ScenarioName } from './benchmark-v10-workloads.ts';

export const WORKLOAD_BASELINE = Object.freeze({
  reportSha256: 'c7558026ef8a08339c60659b54ac26eecd43636d7b22d509435fa53b60ff76f9',
  commit: '641c2b56bdf3eb5e12d48457e982f114d254a507', tree: '93957f4cddfb55c0468e0c76cf730d86c1746676',
  reducerTicks: 8281, acceptedCommands: 82,
  finalEarnedCareWorldSha256: '76413cf3a0a2eba04077288ab5670429028ed83cf3a9d573c6b347f9c9ff0930',
});
/** Copied from the completed 0030 report, never generated from a loaded manifest. */
export const WORKLOAD_SOURCE_HASHES: Readonly<Record<ScenarioName, string>> = Object.freeze({
  'upgrade-precheckpoint': 'ac492afea5567be7d747ef90baafbb8e88486c0e995b49edd7785b61b112417d',
  'upgrade-half-checkpoint': 'e8802a8be13c6d3002f88173ceee6a642d88e9f663fac3d8e4ee2b6f444b70ac',
  'upgrade-final-checkpoint': '6a93fa90412c621b007ea6bba6e247847495bc5f2655d0cea99186291aba5ba7',
  'l2-production-working': 'b2c7812fda926ef4c2c852776319848217134107722ff90aa79e87030799f4dd',
  'l2-production-work-complete': '62c74a446751e3e26840c29c4fcf70142ed94fb29018ac4f0bb05a6fb00a8334',
  'l2-production-delivery': '6426b292c187ce460ebedeec7a7a6f8da441d9de8f462cbc891e219cbc342eea',
  'l2-maintenance-renewal': '688f587ae164eaac8e3bcddec5bdd2e0095be063043632b3f5ebd1ef65f63e2e',
  'alternative-care-working': 'a5bc3da0d6b1fa2a87a99e9289ea0dfe918c28dbc9f88c3580fa1d5349fa32a8',
  'alternative-care-complete': 'bb4e29540bc6b0009b9e978a9e97810444ff080a4f1ea3718a8be27e56cd3eda',
});
export const DEFAULT_PROFILE_SCENARIOS: readonly ScenarioName[] = Object.freeze([
  'upgrade-precheckpoint', 'alternative-care-working', 'upgrade-half-checkpoint',
]);
const SAMPLES = 20; const WARMUPS = 3; const SAMPLING_INTERVAL_MICROSECONDS = 1000;
type Progress = (message: string) => void;
type SourceRevision = { commit: string; tree: string };
type FixtureEntry = { name: ScenarioName; file: string; fileSha256: string; canonicalWorldSha256: string; bytes: number };
export type FixtureManifest = {
  schemaVersion: 1; scope: 'genuine-v10-workload-fixtures'; baselineReportSha256: string;
  baselineSource: SourceRevision; producer: SourceRevision; createdAt: string;
  node: string; platform: string; arch: string;
  setup: { milliseconds: number; reducerTicks: number; acceptedCommands: number; finalEarnedCareWorldSha256: string };
  scenarios: FixtureEntry[];
};
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const worldHash = (world: WorldStateV10): string => digest(canonicalStringify(world));
const same = (a: unknown, b: unknown, message: string): void => check(canonicalStringify(a) === canonicalStringify(b), message);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const revision = (value: unknown): value is SourceRevision => exact(value, ['commit', 'tree'])
  && typeof value.commit === 'string' && /^[0-9a-f]{40}$/.test(value.commit)
  && typeof value.tree === 'string' && /^[0-9a-f]{40}$/.test(value.tree);

/** Metadata parser only. Passing this function NEVER admits a World. */
export function validateFixtureManifest(value: unknown): FixtureManifest {
  check(exact(value, ['schemaVersion', 'scope', 'baselineReportSha256', 'baselineSource', 'producer', 'createdAt',
    'node', 'platform', 'arch', 'setup', 'scenarios']), 'Invalid fixture manifest fields');
  check(value.schemaVersion === 1 && value.scope === 'genuine-v10-workload-fixtures'
    && value.baselineReportSha256 === WORKLOAD_BASELINE.reportSha256, 'Wrong fixture manifest identity/baseline');
  check(revision(value.baselineSource) && value.baselineSource.commit === WORKLOAD_BASELINE.commit
    && value.baselineSource.tree === WORKLOAD_BASELINE.tree && revision(value.producer), 'Invalid fixture source revision');
  for (const key of ['createdAt', 'node', 'platform', 'arch'] as const)
    check(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 128, `Invalid fixture ${key}`);
  check(exact(value.setup, ['milliseconds', 'reducerTicks', 'acceptedCommands', 'finalEarnedCareWorldSha256'])
    && typeof value.setup.milliseconds === 'number' && Number.isFinite(value.setup.milliseconds) && value.setup.milliseconds >= 0
    && value.setup.reducerTicks === WORKLOAD_BASELINE.reducerTicks && value.setup.acceptedCommands === WORKLOAD_BASELINE.acceptedCommands
    && value.setup.finalEarnedCareWorldSha256 === WORKLOAD_BASELINE.finalEarnedCareWorldSha256, 'Invalid genuine setup provenance');
  check(Array.isArray(value.scenarios) && value.scenarios.length === SCENARIO_NAMES.length, 'Fixture manifest must contain all nine sources');
  const seen = new Set<string>();
  for (const entry of value.scenarios) {
    check(exact(entry, ['name', 'file', 'fileSha256', 'canonicalWorldSha256', 'bytes'])
      && typeof entry.name === 'string' && SCENARIO_NAMES.includes(entry.name as ScenarioName), 'Unknown fixture scenario');
    const name = entry.name as ScenarioName;
    check(!seen.has(name), 'Duplicate fixture scenario'); seen.add(name);
    check(entry.file === `${name}.save-v10.json`, 'Fixture filenames must be fixed basenames');
    check(sha(entry.fileSha256) && entry.canonicalWorldSha256 === WORKLOAD_SOURCE_HASHES[name], 'Fixture source differs from recorded baseline');
    check(typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes > 0
      && entry.bytes <= SAVE_FILE_LIMIT_BYTES, 'Invalid fixture file bound');
  }
  return value as FixtureManifest;
}

function readBounded(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    check(info.isFile() && info.size > 0 && info.size <= maximum, `Invalid bounded regular file: ${path}`);
    // Read at most the verified size plus one, even if the file grows concurrently.
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break; length += count;
    }
    check(length === info.size, `File changed while reading: ${path}`);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
/** The report's exact bytes are pinned as well as each canonical source hash. */
export function readWorkloadBaseline(path: string): void {
  const bytes = readBounded(path, 4 * 1024 * 1024);
  check(digest(bytes) === WORKLOAD_BASELINE.reportSha256, 'Baseline report SHA-256 differs from the completed 0030 report');
  const report: unknown = JSON.parse(bytes.toString('utf8'));
  check(record(report) && Array.isArray(report.rows) && report.rows.length === SCENARIO_NAMES.length, 'Invalid baseline rows');
  for (const name of SCENARIO_NAMES) {
    const rows = report.rows.filter((row: unknown) => record(row) && row.scenario === name);
    check(rows.length === 1 && record(rows[0]) && record(rows[0].source)
      && rows[0].source.canonicalWorldSha256 === WORKLOAD_SOURCE_HASHES[name], `Baseline source hash differs: ${name}`);
  }
}
function sourceRevision(): SourceRevision {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Refuse untracked source too: the recorded tree must describe all tooling/code.
  check(git('status', '--porcelain', '--untracked-files=normal') === '', 'Freeze a clean source commit before capture/profiling');
  const result = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  check(revision(result), 'Invalid source revision'); return result;
}
function newOutputDirectory(path: string): string {
  check(isAbsolute(path), 'Output directory must be an explicit absolute local path');
  const root = realpathSync(process.cwd());
  const output = join(realpathSync(dirname(path)), basename(path));
  const rel = relative(root, output);
  check(rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel),
    'Generated fixtures/profiles must be outside the repository');
  mkdirSync(output); // No recursive mkdir and no overwrite/reuse of an existing output directory.
  return output;
}
function validateWorld(world: WorldStateV10, name: ScenarioName): void {
  check(isManagementV10Identity(world.contentIdentity), `${name}: wrong v10 identity`);
  check(inspectUnregisteredWorldV10Records(world).length === 0, `${name}: invalid complete records`);
  const capacity = assessManagementCapacityV10(world);
  check(capacity.supported && capacity.actualFits && capacity.fits, `${name}: incomplete capacity admission`);
  const admitted = admitSaveWorldV10(world);
  check(admitted.ok, `${name}: full save admission failed`);
  same(admitted.world, world, `${name}: full save admission changed World`);
  check(worldHash(world) === WORKLOAD_SOURCE_HASHES[name], `${name}: World differs from the earned baseline source`);
}

/** Expensive on purpose: this is the one actual genesis/command/tick generation. */
export function captureWorkloadFixtures(options: { directory: string; baselineReport: string; progress?: Progress }) {
  readWorkloadBaseline(options.baselineReport); const producer = sourceRevision();
  // Reserve the destination before costly setup; never replace an existing capture.
  const directory = newOutputDirectory(options.directory); const createdAt = new Date().toISOString();
  const prepared = prepareScenarios(options.progress ?? (() => {}));
  check(prepared.setup.reducerTicks === WORKLOAD_BASELINE.reducerTicks && prepared.setup.acceptedCommands === WORKLOAD_BASELINE.acceptedCommands
    && prepared.setup.finalEarnedCareWorldSha256 === WORKLOAD_BASELINE.finalEarnedCareWorldSha256, 'Genuine setup differs from recorded baseline');
  const scenarios: FixtureEntry[] = [];
  for (const scenario of prepared.scenarios) {
    validateWorld(scenario.source, scenario.name);
    const envelope = createSaveEnvelopeV10(scenario.source, { buildId: producer.commit, savedAt: createdAt });
    const text = serializeSaveV10(envelope); const parsed = parseSaveV10(text);
    check(parsed.ok, `${scenario.name}: saved fixture did not parse`);
    validateWorld(parsed.world, scenario.name); same(parsed.world, scenario.source, `${scenario.name}: save round-trip changed World`);
    const file = `${scenario.name}.save-v10.json`;
    writeFileSync(join(directory, file), text, { flag: 'wx' });
    scenarios.push({ name: scenario.name, file, fileSha256: digest(text), canonicalWorldSha256: worldHash(scenario.source), bytes: Buffer.byteLength(text) });
  }
  same(sourceRevision(), producer, 'Source changed during genuine fixture preparation');
  const manifest: FixtureManifest = { schemaVersion: 1, scope: 'genuine-v10-workload-fixtures', baselineReportSha256: WORKLOAD_BASELINE.reportSha256,
    baselineSource: { commit: WORKLOAD_BASELINE.commit, tree: WORKLOAD_BASELINE.tree }, producer, createdAt,
    node: process.version, platform: process.platform, arch: process.arch,
    setup: { milliseconds: prepared.setup.milliseconds, reducerTicks: prepared.setup.reducerTicks,
      acceptedCommands: prepared.setup.acceptedCommands, finalEarnedCareWorldSha256: prepared.setup.finalEarnedCareWorldSha256 }, scenarios };
  validateFixtureManifest(manifest);
  // Written last: an interrupted directory is explicitly incomplete and cannot load.
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { scope: 'Genuine fixture capture only; no latency measurements', directory, manifest };
}

/** Fixed tooling assertions mirror the original nine benchmark contracts. No
 * description, function, sampling mode or prime count is accepted from a file. */
export function fixtureScenario(name: ScenarioName, source: WorldStateV10): Scenario {
  check(SCENARIO_NAMES.includes(name), 'Unknown fixed workload scenario');
  const upgrade = (world: WorldStateV10) => world.sectExpansion.upgrade.jobs.at(-1)!;
  const production = (world: WorldStateV10) => world.sectExpansion.production.jobs.at(-1)!;
  const care = (world: WorldStateV10) => world.sectExpansion.care.jobs.at(-1)!;
  const continuous = name === 'upgrade-precheckpoint' || name === 'l2-production-working' || name === 'alternative-care-working';
  const buildingId = source.sectExpansion.construction.buildings.find(site => site.definitionId === 'alchemy.v9')?.buildingId;
  const doseJobId = care(source)?.doseProductionJobId;
  const verify: Scenario['verify'] = (before, after) => {
    switch (name) {
      case 'upgrade-precheckpoint': check(upgrade(after).activeTicks === upgrade(before).activeTicks + 1
        && upgrade(after).activeTicks < 200 && upgrade(after).checkpoints.length === 0, 'Precheckpoint phase differs'); break;
      case 'upgrade-half-checkpoint': check(upgrade(before).activeTicks === 199 && upgrade(after).activeTicks === 200
        && upgrade(after).checkpoints.length === 1, 'Half payment missing'); break;
      case 'upgrade-final-checkpoint': check(upgrade(before).activeTicks === 399 && upgrade(after).terminal?.kind === 'completed'
        && upgrade(after).checkpoints.length === 2, 'Final payment/completion missing'); break;
      case 'l2-maintenance-renewal': check(buildingId && after.sectExpansion.maintenance.payments.some(payment => payment.buildingId === buildingId
        && payment.rate?.level === 2 && payment.paidCalendarTick === after.clock.calendarTick)
        && after.sectExpansion.maintenance.payments.length > before.sectExpansion.maintenance.payments.length, 'L2 payment missing'); break;
      case 'l2-production-working': check(production(after).productiveSite.level === 2 && production(after).phase === 'Working'
        && production(after).activeTicks === production(before).activeTicks + 1, 'L2 work missing'); break;
      case 'l2-production-work-complete': check(production(before).activeTicks === 199 && production(after).activeTicks === 200
        && production(after).phase === 'TravellingToStorage' && production(after).terminal === null, 'L2 work boundary missing'); break;
      case 'l2-production-delivery': check(production(before).phase === 'AwaitingDelivery' && production(after).terminal?.kind === 'completed'
        && after.sectExpansion.stock['wound-powder'].owned === before.sectExpansion.stock['wound-powder'].owned + 1, 'Alternative dose delivery missing'); break;
      case 'alternative-care-working': check(doseJobId && care(after).doseProductionJobId === doseJobId && care(after).terminal === null
        && care(after).activeTicks === care(before).activeTicks + 1, 'Authentic alternative care work missing'); break;
      case 'alternative-care-complete': check(doseJobId && care(before).activeTicks === 39 && care(after).terminal?.kind === 'completed'
        && care(after).terminal?.effect !== null && care(after).doseProductionJobId === doseJobId
        && after.cultivation.disciples.find(member => member.discipleId === 'entity:4')!.injury
          < before.cultivation.disciples.find(member => member.discipleId === 'entity:4')!.injury, 'Authentic care effect missing'); break;
    }
  };
  return { name, source, mode: continuous ? 'continuous' : 'repeated-boundary', primeTicks: continuous ? WARMUPS : 1,
    description: `Pinned earned source, fixed ${name} boundary assertions`, verify };
}

export function loadWorkloadFixtures(options: { directory: string; baselineReport: string; scenarios?: readonly ScenarioName[] }) {
  check(isAbsolute(options.directory), 'Fixture directory must be an explicit absolute local path');
  const start = performance.now(); readWorkloadBaseline(options.baselineReport);
  const manifest = validateFixtureManifest(JSON.parse(readBounded(join(options.directory, 'manifest.json'), 64 * 1024).toString('utf8')));
  const selected = options.scenarios ?? SCENARIO_NAMES;
  check(selected.length > 0 && selected.length <= SCENARIO_NAMES.length && new Set(selected).size === selected.length
    && selected.every(name => SCENARIO_NAMES.includes(name)), 'Invalid selected scenarios');
  const scenarios = selected.map(name => {
    const entry = manifest.scenarios.find(row => row.name === name)!;
    const bytes = readBounded(join(options.directory, entry.file), SAVE_FILE_LIMIT_BYTES);
    check(bytes.length === entry.bytes && digest(bytes) === entry.fileSha256, `${name}: fixture file digest differs`);
    const text = bytes.toString('utf8'); const parsed = parseSaveV10(text);
    check(parsed.ok, `${name}: complete v10 save parser rejected fixture`);
    validateWorld(parsed.world, name);
    const roundTrip = serializeSaveV10(parsed.envelope); const restored = parseSaveV10(roundTrip);
    check(restored.ok, `${name}: canonical reparse failed`);
    same(restored.world, parsed.world, `${name}: canonical round-trip World differs`);
    check(roundTrip === text && worldHash(restored.world) === entry.canonicalWorldSha256, `${name}: noncanonical fixture round-trip`);
    return fixtureScenario(name, parsed.world);
  });
  return { scenarios, manifest, loadAndAdmissionMilliseconds: performance.now() - start };
}

export function benchmarkReusedWorkloads(options: { directory: string; baselineReport: string; scenario?: ScenarioName; session?: boolean; progress?: Progress }) {
  const started = performance.now(); const producer = sourceRevision();
  const loaded = loadWorkloadFixtures({ directory: options.directory, baselineReport: options.baselineReport,
    ...(options.scenario ? { scenarios: [options.scenario] } : {}) });
  const rows = loaded.scenarios.map(scenario => {
    options.progress?.(`Measuring reused earned source ${scenario.name}`);
    const sourceHash = worldHash(scenario.source); const source = sourceEvidence(scenario.source);
    const owner = benchmarkOwner(scenario); const session = options.session === false ? null : benchmarkSession(scenario);
    check(worldHash(scenario.source) === sourceHash, 'Fixture source changed');
    return { scenario: scenario.name, description: scenario.description, source, owner, session };
  });
  same(sourceRevision(), producer, 'Source changed during reused benchmark');
  return { scope: 'Unprofiled benchmark from fully readmitted genuine saved sources; setup was NOT rerun', producer,
    protocol: 'management-v10-alchemy-upgrade.1', samplesPerRow: SAMPLES, warmupsPerRow: WARMUPS,
    node: process.version, platform: process.platform, arch: process.arch,
    fixtureProvenance: loaded.manifest, loadAndAdmissionMilliseconds: loaded.loadAndAdmissionMilliseconds,
    totalMilliseconds: performance.now() - started,
    limitations: 'Headless four-person sources only; not browser, phone, 36-person, 3x, long-history or full-game acceptance',
    interpretation: 'Original owner/Session measurement functions, no CPU profiler. Original capture setup metadata is provenance, not work performed by this run.', rows };
}

type Hotspot = { functionName: string; url: string; lineNumber: number; columnNumber: number; selfMicroseconds: number; inclusiveMicroseconds: number; samples: number };
/** Diagnostic sample attribution only. Inclusive rows overlap and are not additive. */
export function summarizeCpuProfiles(profiles: readonly Profiler.Profile[]) {
  const totals = new Map<string, Hotspot>(); let attributedMicroseconds = 0; let sampleCount = 0;
  for (const profile of profiles) {
    const nodes = new Map(profile.nodes.map(node => [node.id, node])); const parent = new Map<number, number>();
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
    const samples = profile.samples ?? []; const deltas = profile.timeDeltas ?? [];
    check(samples.length === deltas.length, 'CPU profile sample/delta lengths differ');
    for (let index = 0; index < samples.length; index++) {
      const delta = deltas[index]!; check(Number.isFinite(delta) && delta >= 0, 'Invalid CPU profile delta');
      attributedMicroseconds += delta; sampleCount++;
      let id: number | undefined = samples[index]; const visited = new Set<number>(); const attributed = new Set<string>(); let self = true;
      while (id !== undefined) {
        check(!visited.has(id), 'Cyclic CPU profile call tree'); visited.add(id);
        const node = nodes.get(id); check(node, 'CPU profile has an unknown node');
        const frame = node.callFrame; const key = JSON.stringify([frame.functionName, frame.url, frame.lineNumber, frame.columnNumber]);
        const row = totals.get(key) ?? { functionName: frame.functionName, url: frame.url, lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber, selfMicroseconds: 0, inclusiveMicroseconds: 0, samples: 0 };
        if (self) { row.selfMicroseconds += delta; row.samples++; }
        if (!attributed.has(key)) { row.inclusiveMicroseconds += delta; attributed.add(key); }
        totals.set(key, row); self = false; id = parent.get(id);
      }
    }
  }
  const rows = [...totals.values()];
  return { sampleCount, attributedMicroseconds, lineNumbers: 'V8 zero-based; raw profile URLs may use Vite SSR source names',
    topSelf: [...rows].sort((a, b) => b.selfMicroseconds - a.selfMicroseconds).slice(0, 60),
    topInclusive: [...rows].sort((a, b) => b.inclusiveMicroseconds - a.inclusiveMicroseconds).slice(0, 60) };
}
function snapshot(owner: PrivateRuntimeInstanceV10): WorldStateV10 {
  const value = owner.snapshot(); check(value.ok && value.world, 'Owner snapshot failed'); return value.world;
}
function createOwner(source: WorldStateV10): PrivateRuntimeInstanceV10 {
  const result = createPrivateRuntimeV10(source); check(result.ok && !result.recoveryOnly, 'Owner admission failed'); return result.instance;
}
function strictTick(world: WorldStateV10): WorldStateV10 {
  const next = advanceCapacityLimitedTicksV10(world, 1);
  check(!next.stopped && next.world.clock.simulationTick === world.clock.simulationTick + 1, 'Strict oracle failed'); return next.world;
}

export async function profileWorkloads(options: { directory: string; baselineReport: string; outputDirectory: string;
  scenarios?: readonly ScenarioName[]; progress?: Progress }) {
  const started = performance.now(); const producer = sourceRevision();
  const outputDirectory = newOutputDirectory(options.outputDirectory);
  const loaded = loadWorkloadFixtures({ directory: options.directory, baselineReport: options.baselineReport,
    scenarios: options.scenarios ?? DEFAULT_PROFILE_SCENARIOS });
  const inspector = new InspectorSession(); inspector.connect();
  const rows = [];
  try {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_MICROSECONDS });
    for (const scenario of loaded.scenarios) {
      options.progress?.(`Profiling only owner.advance(1): ${scenario.name}`);
      const profiles: Profiler.Profile[] = []; const diagnosticAdvanceMilliseconds: number[] = []; const profileFiles: string[] = [];
      const metrics: RuntimeInstanceMetricsV10[] = []; const ticks: number[] = []; const sourceHash = worldHash(scenario.source);
      const advance = async (owner: PrivateRuntimeInstanceV10, before: WorldStateV10, expected: WorldStateV10, index: number) => {
        let profile: Profiler.Profile | null = null; let result; let elapsed: number;
        if (index >= 0) await inspector.post('Profiler.start');
        try {
          const timer = performance.now(); result = owner.advance(1); elapsed = performance.now() - timer;
        } finally {
          if (index >= 0) profile = (await inspector.post('Profiler.stop')).profile;
        }
        check(result.ok && result.advancedTicks === 1 && !result.stopped && result.recoveryOnly === false
          && result.metrics.ownedTicks === 1 && result.metrics.normalCandidates === 0, 'Expected one successful retained owned tick');
        // Export, canonical comparisons, named domain checks and disk writes are AFTER stop.
        const actual = snapshot(owner); same(actual, expected, `${scenario.name}: full strict World mismatch`); scenario.verify(before, actual);
        if (index >= 0) {
          check(profile, 'CPU profile missing'); profiles.push(profile); diagnosticAdvanceMilliseconds.push(elapsed);
          metrics.push(result.metrics); ticks.push(actual.clock.simulationTick);
          const file = `${scenario.name}.${String(index + 1).padStart(2, '0')}.cpuprofile`;
          writeFileSync(join(outputDirectory, file), JSON.stringify(profile), { flag: 'wx' }); profileFiles.push(file);
        }
      };
      if (scenario.mode === 'continuous') {
        const owner = createOwner(scenario.source); let expected = scenario.source;
        try {
          for (let index = -WARMUPS; index < SAMPLES; index++) {
            const before = expected; expected = strictTick(before);
            await advance(owner, before, expected, index);
          }
        } finally { owner.close(); }
      } else {
        let before = scenario.source;
        for (let index = 0; index < scenario.primeTicks; index++) before = strictTick(before);
        const expected = strictTick(before); scenario.verify(before, expected);
        for (let index = -WARMUPS; index < SAMPLES; index++) {
          const owner = createOwner(scenario.source);
          try {
            const prime = owner.advance(scenario.primeTicks);
            check(prime.ok && prime.advancedTicks === scenario.primeTicks && !prime.stopped, 'Owner prime failed');
            same(snapshot(owner), before, 'Prime differs from strict oracle');
            await advance(owner, before, expected, index);
          } finally { owner.close(); }
        }
      }
      check(worldHash(scenario.source) === sourceHash, 'Profiler mutated the source');
      rows.push({ scenario: scenario.name, sampling: scenario.mode, samples: SAMPLES, discardedWarmups: WARMUPS,
        sourceSha256: sourceHash, diagnosticAdvanceMilliseconds, metrics, measuredResultTicks: ticks, profileFiles,
        cpu: summarizeCpuProfiles(profiles), allWorldsExact: true });
    }
  } finally { inspector.disconnect(); }
  same(sourceRevision(), producer, 'Source changed during profiling');
  const report = { scope: 'Diagnostic owner CPU sampling, not a latency-budget benchmark', producer,
    node: process.version, platform: process.platform, arch: process.arch, outputDirectory,
    samplingIntervalMicroseconds: SAMPLING_INTERVAL_MICROSECONDS, fixtureProvenance: loaded.manifest,
    loadAndAdmissionMilliseconds: loaded.loadAndAdmissionMilliseconds, totalMilliseconds: performance.now() - started,
    interpretation: 'Each CPU profile surrounds one owner.advance(1) only. Inspector start/stop protocol, timer and sampling overhead can appear. Creation, priming, strict oracle, export, comparisons and file writes are outside profiles. Diagnostic elapsed times must not be used for the 50ms budget. Inclusive call-site totals overlap.',
    limitations: 'Headless four-person earned sources only. No Session, renderer, browser, phone, 36-person, 3x or long-history claim.', rows };
  writeFileSync(join(outputDirectory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}
