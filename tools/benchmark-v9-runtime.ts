import { performance } from 'node:perf_hooks';
import { CALENDAR_TICKS_PER_MONTH } from '../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../src/core/kernel/commands-v9';
import { canonicalStringify, cloneJson } from '../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9, prepareNormalTickCandidateV9 } from '../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../src/core/save-budget/admission';
import { createUnregisteredWorldV9 } from '../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9 } from '../src/core/world/runtime-capacity-v9';
import { advanceIdleCapacityLimitedTicksV9 } from '../src/core/world/runtime-idle-v9';
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
    { name: 'valid-heavy-history', world: recordChecked(heavy), fixture: '256 real successful cultivation commands and matching World/domain receipts', expectedEquivalent: true },
    { name: 'month-boundary', world: recordChecked(month), fixture: 'Explicit idle tick-1199 boundary; timed tick performs real month transition', expectedEquivalent: true },
    { name: 'death-boundary', world: death, fixture: 'Explicit zero-history lifespan boundary; timed tick performs actual pending-death lifecycle', expectedEquivalent: true },
    { name: 'capacity-recovery', world: recovery, fixture: 'Valid diagnostic byte-pressure fixture plus real reserved work/death cancellation', expectedEquivalent: true },
  ];
}
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
export async function runBenchmarkV9(samples = 20): Promise<unknown> {
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 100) throw new Error('samples must be 3..100');
  const fixtureStart = performance.now(); const inputs = scenarios(); const fixtureMs = performance.now() - fixtureStart;
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
  // The normal preparation remains the unchanged strict differential oracle.
  if (typeof prepareNormalTickCandidateV9 !== 'function') throw new Error('Missing normal preparation');
  return { protocol: 'fresh-management-v9-unregistered.3', runtime: 'explicitly limited: no active/new teaching',
    fixtureSetupMillisecondsExcluded: fixtureMs, warmupsPerRow: 2, samplesPerRow: samples, timer: 'node:perf_hooks.performance.now',
    interpretation: 'Serial local measurements; setup/equality/query checks excluded. No 20Hz promise. FullQueries counts whole management-capacity assessments; FastQueries counts exact owned scalar ticks. Active work falls back to strict.', rows };
}
