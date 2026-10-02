import { performance } from 'node:perf_hooks';
import { CALENDAR_TICKS_PER_MONTH } from '../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../src/core/kernel/commands-v9';
import { canonicalStringify, cloneJson } from '../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9, prepareNormalTickCandidateV9 } from '../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../src/core/save-budget/admission';
import { createUnregisteredWorldV9 } from '../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9 } from '../src/core/world/runtime-capacity-v9';
import { advanceIdleCapacityLimitedTicksV9 } from '../src/core/world/runtime-idle-v9';
import { createPrivateRuntimeV9, type PrivateRuntimeInstanceV9, type RuntimeInstanceMetricsV9 } from '../src/core/world/runtime-instance-v9';
import type { WorldStateV9 } from '../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixtureSectCommand, fixtureUntil, fundedRuntimeFixture,
  medicineRuntimeFixture, recordChecked } from '../tests/sect-expansion/fixtures/v9-runtime';

type Scenario = { name: string; world: WorldStateV9; fixture: string; expectedEquivalent: boolean };
function nearDeath(source: WorldStateV9): WorldStateV9 {
  const world = cloneJson(source); const actor = world.disciples.find(value => value.id === 'entity:2')!;
  const profile = world.cultivation.disciples.find(value => value.discipleId === actor.id)!;
  actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  return recordChecked(world);
}
function pressure(source: WorldStateV9): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const assessment = assessManagementCapacityV9(world);
  world.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 700_000 - assessment.costs.wireBytes!); return recordChecked(world);
}
function scenarios(): Scenario[] {
  const medicine = medicineRuntimeFixture();
  const caring = fixtureUntil(fixtureCareStart(medicine), world => world.sectExpansion.care.jobs[0]!.activeTicks === 5);
  let mixed = fixtureApply(caring, fixtureSectCommand(caring, { domain: 'production', command: { kind: 'production.start', commandId: 'bench.mixed.sect',
    expectedRevision: caring.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
  mixed = fixtureApply(mixed, fixtureCommand(mixed, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:3' } }, 'bench.mixed.manual'));
  let heavy = fundedRuntimeFixture();
  for (let index = 0; index < 256; index++) {
    const id = `bench.history.${index}`;
    const applied = dispatchUnregisteredCommandV9(heavy, fixtureCommand(heavy, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
      expectedRevision: heavy.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, id));
    if (applied.result.status !== 'accepted') throw new Error('Cannot prepare genuine heavy history'); heavy = applied.world;
  }
  // Combined load, not heavy idle standing in for active work. These 256
  // commands are actually accepted on the paid-medicine World before assigning
  // the same three independent workers as the original mixed fixture.
  let heavyMedicine = medicine; const earlierReceipts = medicine.cultivation.receipts.length;
  for (let index = 0; index < 256; index++) {
    const id = `bench.heavy-mixed.history.${index}`;
    const applied = dispatchUnregisteredCommandV9(heavyMedicine, fixtureCommand(heavyMedicine, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
      expectedRevision: heavyMedicine.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, id));
    if (applied.result.status !== 'accepted') throw new Error('Cannot prepare genuine heavy mixed-work history'); heavyMedicine = applied.world;
  }
  if (heavyMedicine.cultivation.receipts.length !== earlierReceipts + 256) throw new Error('Heavy mixed-work fixture lost real receipts');
  const heavyCaring = fixtureUntil(fixtureCareStart(heavyMedicine), world => world.sectExpansion.care.jobs[0]!.activeTicks === 5);
  let heavyMixed = fixtureApply(heavyCaring, fixtureSectCommand(heavyCaring, { domain: 'production', command: { kind: 'production.start', commandId: 'bench.heavy-mixed.sect',
    expectedRevision: heavyCaring.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
  heavyMixed = fixtureApply(heavyMixed, fixtureCommand(heavyMixed, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:3' } }, 'bench.heavy-mixed.manual'));
  const month = createUnregisteredWorldV9('bench-month');
  // Explicit zero-work within-month boundary; the timed operation executes the
  // actual .3 month record, actor projection and all normal work stages.
  month.clock = { ...month.clock, simulationTick: CALENDAR_TICKS_PER_MONTH - 1, calendarTick: CALENDAR_TICKS_PER_MONTH - 1 };
  const death = nearDeath(createUnregisteredWorldV9('bench-death'));
  let recovery = nearDeath(createUnregisteredWorldV9('bench-capacity-recovery'));
  recovery = fixtureApply(recovery, fixtureSectCommand(recovery, { domain: 'production', command: { kind: 'production.start', commandId: 'bench.recovery.work',
    expectedRevision: recovery.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
  recovery = pressure(recovery);
  return [
    { name: 'idle', world: createUnregisteredWorldV9('bench-idle'), fixture: 'Fresh .3 World', expectedEquivalent: true },
    { name: 'actual-medicine', world: caring, fixture: 'Real library, research, alchemy, powder and active care; extra base stock only', expectedEquivalent: true },
    { name: 'mixed-work', world: mixed, fixture: 'Actual care + sect mining + legacy plank work with three exclusive owners', expectedEquivalent: true },
    { name: 'heavy-mixed-work', world: recordChecked(heavyMixed), fixture: '256 additional real successful cultivation commands plus actual care, sect mining and legacy plank work with three exclusive owners', expectedEquivalent: true },
    { name: 'valid-heavy-history', world: recordChecked(heavy), fixture: '256 real successful cultivation commands and matching World/domain receipts', expectedEquivalent: true },
    { name: 'month-boundary', world: recordChecked(month), fixture: 'Explicit idle tick-1199 boundary; timed tick performs real month transition', expectedEquivalent: true },
    { name: 'death-boundary', world: death, fixture: 'Explicit zero-history lifespan boundary; timed tick performs actual pending-death lifecycle', expectedEquivalent: true },
    { name: 'capacity-recovery', world: recovery, fixture: 'Valid diagnostic byte-pressure fixture plus real reserved work/death cancellation', expectedEquivalent: true },
  ];
}
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
export async function runBenchmarkV9(samples = 20, scenarioFilter?: string): Promise<unknown> {
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 100) throw new Error('samples must be 3..100');
  const fixtureStart = performance.now(); const available = scenarios();
  const inputs = scenarioFilter === undefined ? available : available.filter(scenario => scenario.name === scenarioFilter);
  if (!inputs.length) throw new Error(`Unknown scenario ${scenarioFilter}; available: ${available.map(scenario => scenario.name).join(', ')}`);
  const fixtureMs = performance.now() - fixtureStart;
  const rows: object[] = [];
  for (const scenario of inputs) {
    const assessment = assessManagementCapacityV9(scenario.world);
    if (!assessment.supported || !assessment.actualFits) throw new Error(`Invalid benchmark source ${scenario.name}`);
    const unchanged = canonicalStringify(scenario.world);
    for (const steps of [1, 20]) {
      const baseline = advanceUnregisteredTicksV9(scenario.world, steps); const gated = advanceCapacityLimitedTicksV9(scenario.world, steps);
      if (scenario.expectedEquivalent && canonicalStringify(baseline.world) !== canonicalStringify(gated.world)) throw new Error(`Boundary equivalence failed: ${scenario.name}/${steps}`);
      const expected = canonicalStringify({ world: gated.world, stopped: gated.stopped, commandResults: gated.commandResults });
      for (const mode of ['record-only-baseline', 'capacity-gated-strict', 'capacity-gated-owned-idle'] as const) {
        const timings: number[] = []; let fullQueries = 0; let fastQueries = 0; let actualTicks = 0; let stop: string | null = null;
        const invoke = () => mode === 'record-only-baseline' ? advanceUnregisteredTicksV9(scenario.world, steps)
          : mode === 'capacity-gated-strict' ? advanceCapacityLimitedTicksV9(scenario.world, steps) : advanceIdleCapacityLimitedTicksV9(scenario.world, steps);
        for (let warmup = 0; warmup < 2; warmup++) invoke();
        for (let index = 0; index < samples; index++) {
          const start = performance.now(); const result = invoke(); timings.push(performance.now() - start);
          fullQueries = 'metrics' in result ? result.metrics.fullQueries : 0;
          fastQueries = 'metrics' in result && 'fastQueries' in result.metrics && typeof result.metrics.fastQueries === 'number' ? result.metrics.fastQueries : 0;
          actualTicks = result.world.clock.simulationTick - scenario.world.clock.simulationTick; stop = result.stopped?.kind ?? null;
          if (mode === 'capacity-gated-owned-idle' && canonicalStringify({ world: result.world, stopped: result.stopped, commandResults: result.commandResults }) !== expected) {
            throw new Error(`Owned idle/strict equivalence failed: ${scenario.name}/${steps}/${index}`);
          }
        }
        rows.push({ scenario: scenario.name, fixture: scenario.fixture, mode, requestedTicks: steps, actualTicks, samples,
          milliseconds: { p50: percentile(timings, .5), p95: percentile(timings, .95), max: Math.max(...timings) }, fullQueriesPerCall: fullQueries, fastQueriesPerCall: fastQueries, stop });
      }
    }
    if (canonicalStringify(scenario.world) !== unchanged || Object.isFrozen(scenario.world)) throw new Error(`Caller input changed: ${scenario.name}`);
  }
  const instanceRows = benchmarkInstances(inputs, samples);
  // The normal preparation remains the unchanged strict differential oracle.
  if (typeof prepareNormalTickCandidateV9 !== 'function') throw new Error('Missing normal preparation');
  return { protocol: 'fresh-management-v9-unregistered.3', runtime: 'explicitly limited: no active/new teaching',
    fixtureSetupMillisecondsExcluded: fixtureMs, scenarioFilter: scenarioFilter ?? null, warmupsPerRow: 2, samplesPerRow: samples, timer: 'node:perf_hooks.performance.now',
    interpretation: 'Serial local measurements; setup/equality/query checks excluded. No 20Hz promise. FullQueries counts whole management-capacity assessments; FastQueries counts exact owned scalar ticks. Active work falls back to strict. Instance initialization and export times are reported separately, not hidden in fixture preparation; instance operations return no World.', rows, instanceRows };
}

function timing(values: readonly number[]) { return { p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) }; }
function mustCreate(source: WorldStateV9): PrivateRuntimeInstanceV9 {
  const result = createPrivateRuntimeV9(source); if (!result.ok) throw new Error(`Instance construction failed: ${result.error}`); return result.instance;
}
function measuredSnapshot(instance: PrivateRuntimeInstanceV9, expected: string): number {
  const start = performance.now(); const result = instance.snapshot(); const elapsed = performance.now() - start;
  if (!result.ok || !result.world || canonicalStringify(result.world) !== expected) throw new Error('Instance snapshot differs from strict oracle'); return elapsed;
}
function benchmarkInstances(inputs: readonly Scenario[], samples: number): object[] {
  const rows: object[] = [];
  for (const scenario of inputs) {
    const sourceText = canonicalStringify(scenario.world);
    // Cold costs are explicitly timed, including descriptor detachment, full
    // assessment and owned freezing. Nothing is treated as a free import.
    for (const operation of ['cold-create', 'validated-replace'] as const) {
      const timings: number[] = []; const exports: number[] = [];
      const setupStart = performance.now(); const reusable = operation === 'validated-replace' ? mustCreate(scenario.world) : null;
      const setupMs = operation === 'validated-replace' ? performance.now() - setupStart : 0;
      for (let trial = -2; trial < samples; trial++) {
        const start = performance.now();
        const created = operation === 'cold-create' ? createPrivateRuntimeV9(scenario.world) : null;
        const replaced = reusable?.replace(scenario.world); const elapsed = performance.now() - start;
        if (created && !created.ok || replaced && !replaced.ok) throw new Error('Cold instance entrance failed');
        const instance = created?.ok ? created.instance : reusable!;
        const snapshotMs = measuredSnapshot(instance, sourceText);
        if (trial >= 0) { timings.push(elapsed); exports.push(snapshotMs); }
        if (created?.ok) instance.close();
      }
      reusable?.close();
      rows.push({ scenario: scenario.name, fixture: scenario.fixture, mode: `private-instance-${operation}`, samples,
        milliseconds: timing(timings), subsequentSnapshotMilliseconds: timing(exports), separatelyMeasuredReusableInitializationMilliseconds: setupMs,
        fullQueriesPerCall: 1, requestedTicks: 0, actualTicks: 0 });
    }
    for (const [ticksPerCall, calls] of [[1, 20], [20, 3]] as const) {
      // Run the real strict sequence once outside timings. Keep actual tick counts
      // (including death pauses/capacity stops), never label requests as work done.
      let oracle = scenario.world;
      const expectedCalls: { ticks: number; stopped: unknown }[] = [];
      for (let call = 0; call < calls; call++) {
        const result = advanceCapacityLimitedTicksV9(oracle, ticksPerCall);
        expectedCalls.push({ ticks: result.world.clock.simulationTick - oracle.clock.simulationTick, stopped: result.stopped }); oracle = result.world;
      }
      const expected = canonicalStringify(oracle); const initialization: number[] = []; const exports: number[] = [];
      const totalTimes: number[] = []; const callTimes: number[] = [];
      let lastMetrics: Record<keyof RuntimeInstanceMetricsV9, number> | null = null;
      for (let trial = -2; trial < samples; trial++) {
        const initialStart = performance.now(); const instance = mustCreate(scenario.world); const initialMs = performance.now() - initialStart;
        let elapsed = 0; const metrics = { fullQueries: 0, fastQueries: 0, normalCandidates: 0, noOptionalCandidates: 0, exports: 0 };
        for (let call = 0; call < calls; call++) {
          const start = performance.now(); const result = instance.advance(ticksPerCall); const callMs = performance.now() - start; elapsed += callMs;
          if (trial >= 0) callTimes.push(callMs);
          if (result.advancedTicks !== expectedCalls[call]!.ticks || canonicalStringify(result.stopped) !== canonicalStringify(expectedCalls[call]!.stopped)) {
            throw new Error(`Instance sequence outcome differs: ${scenario.name}/${ticksPerCall}/${call}`);
          }
          for (const key of Object.keys(metrics) as (keyof RuntimeInstanceMetricsV9)[]) metrics[key] += result.metrics[key];
        }
        const exportMs = measuredSnapshot(instance, expected); instance.close();
        if (trial >= 0) { initialization.push(initialMs); totalTimes.push(elapsed); exports.push(exportMs); lastMetrics = metrics; }
      }
      rows.push({ scenario: scenario.name, fixture: scenario.fixture, mode: `private-instance-repeated-${ticksPerCall}-tick`, samples, callsPerTrial: calls,
        requestedTicksPerCall: ticksPerCall, requestedTicksPerTrial: ticksPerCall * calls,
        actualTicksPerCall: expectedCalls.map(value => value.ticks), actualTicksPerTrial: oracle.clock.simulationTick - scenario.world.clock.simulationTick,
        operationMillisecondsPerCall: timing(callTimes), operationMillisecondsPerTrial: timing(totalTimes), initializationMillisecondsPerTrial: timing(initialization),
        finalSnapshotMillisecondsPerTrial: timing(exports), operationMetricsPerTrial: lastMetrics,
        initializationFullQueriesPerTrial: 1, stop: expectedCalls.at(-1)!.stopped });
    }
    // Commands include a new operation, its exact retry and a payload conflict.
    // The history/work source is real; no caller-supplied budget or empty stand-in.
    const id = `bench.instance.${scenario.name}`;
    const input = fixtureCommand(scenario.world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
      expectedRevision: scenario.world.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, id);
    const conflict = fixtureCommand(scenario.world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
      expectedRevision: scenario.world.cultivation.revision, discipleId: 'entity:2', mode: 'rest' } } }, id);
    const commands = [input, input, conflict]; let commandOracle = scenario.world;
    const commandResults = commands.map(command => { const result = dispatchCapacityLimitedCommandV9(commandOracle, command); commandOracle = result.world; return canonicalStringify(result.result); });
    const commandTimes: number[][] = [[], [], []]; const commandInitial: number[] = []; const commandExports: number[] = [];
    for (let trial = -2; trial < samples; trial++) {
      const initialStart = performance.now(); const instance = mustCreate(scenario.world); const initialMs = performance.now() - initialStart;
      for (const [index, command] of commands.entries()) {
        const start = performance.now(); const result = instance.command(command); const elapsed = performance.now() - start;
        if (canonicalStringify(result.result) !== commandResults[index]) throw new Error(`Instance command differs: ${scenario.name}/${index}`);
        if (trial >= 0) commandTimes[index]!.push(elapsed);
      }
      const exportMs = measuredSnapshot(instance, canonicalStringify(commandOracle)); instance.close();
      if (trial >= 0) { commandInitial.push(initialMs); commandExports.push(exportMs); }
    }
    rows.push({ scenario: scenario.name, fixture: scenario.fixture, mode: 'private-instance-command-new-retry-conflict', samples,
      expectedCommandResults: commandResults.map(value => JSON.parse(value)),
      newCommandMilliseconds: timing(commandTimes[0]!), retryMilliseconds: timing(commandTimes[1]!), conflictMilliseconds: timing(commandTimes[2]!),
      initializationMillisecondsPerTrial: timing(commandInitial), finalSnapshotMillisecondsPerTrial: timing(commandExports) });
    const freshExports: number[] = []; const cachedExports: number[] = []; const snapshotInitial: number[] = [];
    const invalidation: number[] = []; const afterInvalidation: number[] = [];
    const after = advanceCapacityLimitedTicksV9(scenario.world, 1);
    for (let trial = -2; trial < samples; trial++) {
      const initialStart = performance.now(); const instance = mustCreate(scenario.world); const initialMs = performance.now() - initialStart;
      const fresh = measuredSnapshot(instance, sourceText); const cached = measuredSnapshot(instance, sourceText);
      const invalidateStart = performance.now(); const invalidated = instance.invalidate(); const invalidateMs = performance.now() - invalidateStart;
      if (!invalidated.ok) throw new Error('Instance invalidation failed');
      const nextStart = performance.now(); const advanced = instance.advance(1); const nextMs = performance.now() - nextStart;
      if (canonicalStringify(advanced.stopped) !== canonicalStringify(after.stopped)) throw new Error('Invalidated operation differs');
      measuredSnapshot(instance, canonicalStringify(after.world)); instance.close();
      if (trial >= 0) { freshExports.push(fresh); cachedExports.push(cached); snapshotInitial.push(initialMs); invalidation.push(invalidateMs); afterInvalidation.push(nextMs); }
    }
    rows.push({ scenario: scenario.name, fixture: scenario.fixture, mode: 'private-instance-export-and-invalidate', samples,
      initializationMillisecondsPerTrial: timing(snapshotInitial), freshSnapshotMilliseconds: timing(freshExports), cachedSnapshotMilliseconds: timing(cachedExports),
      invalidationMilliseconds: timing(invalidation), firstAdvanceAfterInvalidationMilliseconds: timing(afterInvalidation),
      requestedTicks: 1, actualTicks: after.world.clock.simulationTick - scenario.world.clock.simulationTick });
    if (canonicalStringify(scenario.world) !== sourceText || Object.isFrozen(scenario.world)) throw new Error('Instance benchmark modified or froze caller input');
  }
  return rows;
}
