import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ApplicationSessionV10 } from '../src/application/session-v10';
import { isManagementV10Identity } from '../src/content/sect-v10/world-content';
import type { SectRecipeId, SectResearchId } from '../src/content/sect-v9/types';
import { TICK_MILLISECONDS } from '../src/core/kernel/clock';
import type { CommandV10, SectCommandV10 } from '../src/core/kernel/contracts-v10';
import { canonicalStringify } from '../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../src/core/kernel/validation';
import type { WorldStateV10 } from '../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../src/core/world/create-world-v10';
import { assessManagementCapacityV10 } from '../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10, dispatchCapacityLimitedCommandV10 } from '../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10 } from '../src/core/world/runtime-instance-v10';
import { admitSaveWorldV10 } from '../src/core/world/save-admission-v10';

/** Opt-in Node measurements only. There are no test mocks, inventory grants,
 * clock edits, version casts, partial cost fixtures, or cached admission flags.
 * The fresh constructor and every command are production v10 entry points.
 * Fixture preparation executes every real normal reducer tick, then every
 * scenario passes complete record, capacity and headless-save admission. */
const SEED = 'v10-workloads-earned-from-genesis-1';
const SAMPLES = 20;
const WARMUPS = 3;
export const SCENARIO_NAMES = Object.freeze([
  'upgrade-precheckpoint', 'upgrade-half-checkpoint', 'upgrade-final-checkpoint',
  'l2-production-working', 'l2-production-work-complete', 'l2-production-delivery',
  'l2-maintenance-renewal', 'alternative-care-working', 'alternative-care-complete',
] as const);
export type ScenarioName = typeof SCENARIO_NAMES[number];
type CommandBody<T> = T extends unknown ? Omit<T, 'commandId' | 'sequence' | 'issuedTick'> : never;
export type Scenario = { name: ScenarioName; mode: 'continuous' | 'repeated-boundary'; source: WorldStateV10;
  primeTicks: number; description: string; verify: (before: WorldStateV10, after: WorldStateV10) => void };
type Progress = (message: string) => void;
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const hash = (value: unknown): string => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const same = (a: unknown, b: unknown, label: string): void => check(canonicalStringify(a) === canonicalStringify(b), label);
function statistics(rawMs: readonly number[]) {
  check(rawMs.length === SAMPLES, 'A reported row must have exactly 20 measured samples');
  const sorted = [...rawMs].sort((a, b) => a - b);
  return { samples: rawMs.length, p50: sorted[Math.ceil(.5 * sorted.length) - 1]!,
    p95: sorted[Math.ceil(.95 * sorted.length) - 1]!, max: sorted.at(-1)!, rawMs };
}
function snapshot(owner: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = owner.snapshot(); check(result.ok && result.world, `Snapshot failed: ${result.error}`); return result.world;
}
function createOwner(source: WorldStateV10): PrivateRuntimeInstanceV10 {
  const result = createPrivateRuntimeV10(source);
  check(result.ok, `Owner admission failed: ${!result.ok ? result.error : ''}`);
  check(!result.recoveryOnly, 'Benchmark source must not be recovery-only'); return result.instance;
}
function strictTick(source: WorldStateV10): WorldStateV10 {
  const result = advanceCapacityLimitedTicksV10(source, 1);
  check(!result.stopped && result.world.clock.simulationTick === source.clock.simulationTick + 1,
    `Strict oracle stopped: ${canonicalStringify(result.stopped)}`);
  return result.world;
}

export function prepareScenarios(progress: Progress) {
  let commandSequence = 0; let reducerTicks = 0;
  const milestones: { label: string; simulationTick: number; elapsedMs: number }[] = [];
  const setupStart = performance.now();
  const mark = (label: string, world: WorldStateV10) => {
    const row = { label, simulationTick: world.clock.simulationTick, elapsedMs: performance.now() - setupStart };
    milestones.push(row); progress(`${label}: tick ${row.simulationTick}, setup ${(row.elapsedMs / 1000).toFixed(1)}s`);
  };
  function apply(world: WorldStateV10, body: CommandBody<CommandV10>, id?: string): WorldStateV10 {
    const sequence = commandSequence++;
    const commandId = id ?? `workload.${sequence}`;
    const command = { ...body, commandId, sequence, issuedTick: world.clock.simulationTick };
    const result = dispatchCapacityLimitedCommandV10(world, command);
    check(result.result.status === 'accepted', `Fixture command ${commandId}: ${canonicalStringify(result.result)}`);
    return result.world;
  }
  function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
    return apply(world, { kind: 'sect.command', payload }, payload.command.commandId);
  }
  const id = () => `workload.sect.${commandSequence}`;
  function tick(world: WorldStateV10): WorldStateV10 {
    const next = prepareNormalTickCandidateV10(world); reducerTicks++;
    check(next.clock.simulationTick === world.clock.simulationTick + 1,
      `Fixture paused/stalled at ${world.clock.simulationTick}`);
    return next;
  }
  function until(world: WorldStateV10, predicate: (world: WorldStateV10) => boolean, label: string, limit = 2400): WorldStateV10 {
    let current = world;
    for (let count = 0; count < limit && !predicate(current); count++) current = tick(current);
    check(predicate(current), `Fixture ${label} did not finish within ${limit} actual ticks`); return current;
  }
  const startLegacy = (world: WorldStateV10, recipeId: string, workerId: string) =>
    apply(world, { kind: 'production.start', payload: { recipeId, workerId } });
  function startSectProduction(world: WorldStateV10, recipeId: SectRecipeId, workerId = 'entity:2'): WorldStateV10 {
    return sect(world, { domain: 'production', command: { kind: 'production.start', commandId: id(),
      expectedRevision: world.sectExpansion.production.revision, recipeId, workerId } });
  }
  function finishSectProduction(world: WorldStateV10): WorldStateV10 {
    const active = world.sectExpansion.production.jobs.filter(job => !job.terminal).map(job => job.transactionId);
    const done = until(world, value => active.every(jobId => value.sectExpansion.production.jobs
      .some(job => job.transactionId === jobId && job.terminal?.kind === 'completed')), 'production delivery');
    return done;
  }
  function construct(world: WorldStateV10, definitionId: 'library.v9' | 'alchemy.v9', x: number): WorldStateV10 {
    let next = sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: id(),
      expectedRevision: world.sectExpansion.construction.revision, placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } } });
    next = sect(next, { domain: 'construction', command: { kind: 'construction.start', commandId: id(),
      expectedRevision: next.sectExpansion.construction.revision,
      blueprintId: next.sectExpansion.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' } });
    return until(next, value => value.sectExpansion.construction.jobs.at(-1)?.terminal?.kind === 'completed', definitionId);
  }
  function research(world: WorldStateV10, researchId: SectResearchId): WorldStateV10 {
    const started = sect(world, { domain: 'research', command: { kind: 'research.start', commandId: id(),
      expectedRevision: world.sectExpansion.research.revision, researchId, workerId: 'entity:2' } });
    return until(started, value => value.sectExpansion.research.jobs.at(-1)?.terminal?.kind === 'completed', researchId);
  }
  function researchStock(world: WorldStateV10, count: number): WorldStateV10 {
    let next = world;
    for (let index = 0; index < count; index++) {
      next = startSectProduction(next, 'extract.spirit-stone.v9', 'entity:2');
      next = startSectProduction(next, 'study.basic-insight.v9', 'entity:3');
      next = finishSectProduction(next);
    }
    return next;
  }
  // Two adults gather while the third crafts. The fourth roster member is the
  // genuine 14-year-old starter; we never fabricate a fourth eligible worker.
  let world = createUnregisteredWorldV10(SEED);
  check(world.disciples.length === 4, 'Expected the genuine four-person starter roster');
  mark('Starting genuine v10 command/reducer setup', world);
  const enoughBase = (value: WorldStateV10) => value.inventory.wood.owned >= 70
    && value.inventory.herbs.owned >= 30 && value.inventory.plank.owned >= 20;
  for (let count = 0; count < 6000 && (!enoughBase(world) || world.activeProductionTransactionIds.length > 0); count++) {
    const idle = (workerId: string) => !world.activeProductionTransactionIds.some(transactionId => world.transactions[transactionId]?.workerId === workerId);
    if (idle('entity:2') && world.inventory.plank.owned < 20 && world.inventory.wood.owned - world.inventory.wood.reserved >= 3)
      world = startLegacy(world, 'craft.plank', 'entity:2');
    if (idle('entity:3') && world.inventory.wood.owned < 70) world = startLegacy(world, 'gather.wood', 'entity:3');
    if (idle('entity:4') && world.inventory.herbs.owned < 30) world = startLegacy(world, 'gather.herbs', 'entity:4');
    world = tick(world);
  }
  check(enoughBase(world) && world.activeProductionTransactionIds.length === 0, 'Genuine base-resource setup stalled');
  while (world.inventory.stone.owned < 27) world = finishSectProduction(startSectProduction(world, 'gather.stone.v9'));
  mark('Earned wood, stone, herbs and planks', world);
  world = construct(world, 'library.v9', 1);
  world = researchStock(world, 2); world = research(world, 'basic-medicine.v9');
  world = construct(world, 'alchemy.v9', 10);
  world = researchStock(world, 4); world = research(world, 'herbal-compatibility.v9');
  mark('Earned both research completions and L1 alchemy', world);
  const building = world.sectExpansion.construction.buildings.find(value => value.definitionId === 'alchemy.v9');
  check(building, 'Missing genuinely constructed alchemy building');
  world = sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: id(),
    expectedRevision: world.sectExpansion.upgrade.revision, buildingId: building.buildingId, workerId: 'entity:2' } });
  const scenarios: Scenario[] = [];
  function mixed(source: WorldStateV10, includeHerbs = true): WorldStateV10 {
    let next = startLegacy(source, 'gather.wood', 'entity:3');
    if (includeHerbs) next = startLegacy(next, 'gather.herbs', 'entity:4'); return next;
  }
  const upgrade = (value: WorldStateV10) => value.sectExpansion.upgrade.jobs.at(-1)!;
  world = until(world, value => upgrade(value).activeTicks === 150, 'upgrade active 150');
  scenarios.push({ name: 'upgrade-precheckpoint', mode: 'continuous', source: mixed(world), primeTicks: WARMUPS,
    description: 'Four-person roster; paid upgrade plus real wood/herb jobs, all 20 measured ticks below checkpoint 200',
    verify: (before, after) => {
      check(upgrade(after).activeTicks === upgrade(before).activeTicks + 1 && upgrade(after).activeTicks < 200
        && upgrade(after).checkpoints.length === 0, 'Precheckpoint sample escaped its declared phase');
    } });
  world = until(world, value => upgrade(value).activeTicks === 198, 'upgrade before half');
  scenarios.push({ name: 'upgrade-half-checkpoint', mode: 'repeated-boundary', source: mixed(world), primeTicks: 1,
    description: 'Independent exact 199→200 paid half-checkpoint samples with two real gather jobs',
    verify: (before, after) => check(upgrade(before).activeTicks === 199 && upgrade(after).activeTicks === 200
      && upgrade(after).checkpoints.length === 1, 'Missing actual half checkpoint') });
  world = until(world, value => upgrade(value).activeTicks === 398, 'upgrade before final');
  scenarios.push({ name: 'upgrade-final-checkpoint', mode: 'repeated-boundary', source: mixed(world), primeTicks: 1,
    description: 'Independent exact 399→400 final payment/completion samples with two real gather jobs',
    verify: (before, after) => check(upgrade(before).activeTicks === 399 && upgrade(after).terminal?.kind === 'completed'
      && upgrade(after).checkpoints.length === 2, 'Missing actual upgrade completion') });
  const completed = until(world, value => upgrade(value).terminal?.kind === 'completed', 'upgrade completion');
  mark('Earned L2 alchemy with both real payment checkpoints', completed);
  const latestPayment = completed.sectExpansion.maintenance.payments.findLast(payment => payment.buildingId === building.buildingId);
  const due = latestPayment?.dueCalendarTick ?? building.firstMaintenanceCalendarTick;
  check(due > completed.clock.calendarTick + 1, 'Expected a still-funded maintenance period after upgrade');
  let renewal = until(completed, value => value.clock.calendarTick === due - 2, 'L2 maintenance due');
  renewal = startSectProduction(renewal, 'craft.wound-powder-alt.v9');
  scenarios.push({ name: 'l2-maintenance-renewal', mode: 'repeated-boundary', source: mixed(renewal), primeTicks: 1,
    description: 'Real due-calendar renewal at L2 while alternative production and two gather jobs are active',
    verify: (before, after) => check(after.sectExpansion.maintenance.payments.some(payment => payment.buildingId === building.buildingId
      && payment.rate?.level === 2 && payment.paidCalendarTick === after.clock.calendarTick)
      && after.sectExpansion.maintenance.payments.length > before.sectExpansion.maintenance.payments.length,
    'Missing actual L2 maintenance payment') });
  world = startSectProduction(completed, 'craft.wound-powder-alt.v9');
  const production = (value: WorldStateV10) => value.sectExpansion.production.jobs.at(-1)!;
  world = until(world, value => production(value).activeTicks === 50, 'alternative medicine working');
  scenarios.push({ name: 'l2-production-working', mode: 'continuous', source: mixed(world), primeTicks: WARMUPS,
    description: 'Actual L2 alternative recipe plus two gather jobs; 20 consecutive productive ticks',
    verify: (before, after) => check(production(after).productiveSite.level === 2 && production(after).phase === 'Working'
      && production(after).activeTicks === production(before).activeTicks + 1, 'Expected actual L2 production work') });
  world = until(world, value => production(value).activeTicks === 198, 'alternative medicine before work completion');
  scenarios.push({ name: 'l2-production-work-complete', mode: 'repeated-boundary', source: mixed(world), primeTicks: 1,
    description: 'Alternative recipe 199→200 work boundary, distinct from delivery/payment settlement',
    verify: (before, after) => check(production(before).activeTicks === 199 && production(after).activeTicks === 200
      && production(after).phase === 'TravellingToStorage' && production(after).terminal === null,
    'Missing actual alternative production work boundary') });
  let previous = world;
  world = until(world, value => production(value).phase === 'TravellingToStorage', 'alternative medicine return');
  for (let count = 0; count < 600 && production(world).phase !== 'AwaitingDelivery'; count++) { previous = world; world = tick(world); }
  check(production(world).phase === 'AwaitingDelivery', 'No actual delivery arrival');
  scenarios.push({ name: 'l2-production-delivery', mode: 'repeated-boundary', source: mixed(previous), primeTicks: 1,
    description: 'Actual storage arrival prime, then paid alternative medicine delivery/credit boundary',
    verify: (before, after) => check(production(before).phase === 'AwaitingDelivery' && production(after).terminal?.kind === 'completed'
      && after.sectExpansion.stock['wound-powder'].owned === before.sectExpansion.stock['wound-powder'].owned + 1,
    'Missing actual alternative powder delivery') });
  world = finishSectProduction(world);
  const doseJobId = production(world).transactionId;
  world = sect(world, { domain: 'care', command: { kind: 'care.start', commandId: id(),
    expectedRevision: world.sectExpansion.care.revision, patientId: 'entity:4' } });
  const care = (value: WorldStateV10) => value.sectExpansion.care.jobs.at(-1)!;
  check(care(world).doseProductionJobId === doseJobId, 'Care did not claim the actually delivered alternative medicine');
  world = until(world, value => care(value).activeTicks === 5, 'care working');
  const careMixed = (source: WorldStateV10) => mixed(startSectProduction(source, 'craft.wound-powder-alt.v9'), false);
  scenarios.push({ name: 'alternative-care-working', mode: 'continuous', source: careMixed(world), primeTicks: WARMUPS,
    description: 'Patient consumes authenticated alternative-medicine dose while two adults produce medicine/gather wood',
    verify: (before, after) => check(care(after).doseProductionJobId === doseJobId && care(after).terminal === null
      && care(after).activeTicks === care(before).activeTicks + 1, 'Expected active care of the authentic alternative dose') });
  world = until(world, value => care(value).activeTicks === 38, 'care before completion');
  scenarios.push({ name: 'alternative-care-complete', mode: 'repeated-boundary', source: careMixed(world), primeTicks: 1,
    description: 'Independent actual care 39→40 medicine debit and injury-effect boundary with concurrent production/gather',
    verify: (before, after) => check(care(before).activeTicks === 39 && care(after).terminal?.kind === 'completed'
      && care(after).terminal?.effect !== null && care(after).doseProductionJobId === doseJobId
      && after.cultivation.disciples.find(value => value.discipleId === 'entity:4')!.injury
        < before.cultivation.disciples.find(value => value.discipleId === 'entity:4')!.injury, 'Missing actual care effect') });
  const healed = until(world, value => care(value).terminal?.kind === 'completed', 'actual care completion');
  mark('Delivered alternative medicine and completed authentic care', healed);
  for (const scenario of scenarios) {
    check(isManagementV10Identity(scenario.source.contentIdentity), `${scenario.name}: wrong frozen v10 identity`);
    check(inspectUnregisteredWorldV10Records(scenario.source).length === 0, `${scenario.name}: invalid complete records`);
    const admission = admitSaveWorldV10(scenario.source);
    check(admission.ok, `${scenario.name}: full save admission failed ${!admission.ok ? admission.error.code : ''}`);
    same(admission.world, scenario.source, `${scenario.name}: admission changed source`);
  }
  return { scenarios, setup: { milliseconds: performance.now() - setupStart, reducerTicks, acceptedCommands: commandSequence,
    milestones, finalEarnedCareWorldSha256: hash(healed), origin: 'createUnregisteredWorldV10(seed); genuine commands and every actual reducer tick' } };
}

export function sourceEvidence(world: WorldStateV10) {
  const capacity = assessManagementCapacityV10(world);
  check(capacity.supported && capacity.fits && capacity.actualFits, 'Scenario lacks complete capacity');
  return { seed: world.seed, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
    roster: world.disciples.map(row => ({ id: row.id, ageMonths: row.ageMonths, canWork: row.canWork })),
    contentIdentity: world.contentIdentity, canonicalWorldSha256: hash(world), capacityCosts: capacity.costs,
    inventory: world.inventory, sectStock: world.sectExpansion.stock,
    activeLegacyJobs: world.activeProductionTransactionIds.map(id => ({ id, recipeId: world.transactions[id]!.recipeId })),
    activeSectJobs: world.sectExpansion.production.jobs.filter(job => !job.terminal).map(job => ({ id: job.transactionId, recipeId: job.recipeId })),
    earnedResearch: world.sectExpansion.research.jobs.filter(job => job.terminal?.kind === 'completed').map(job => ({ id: job.jobId, researchId: job.researchId })),
    upgradeJobs: world.sectExpansion.upgrade.jobs.map(job => ({ id: job.jobId, activeTicks: job.activeTicks, checkpoints: job.checkpoints, terminal: job.terminal })),
    careJobs: world.sectExpansion.care.jobs.map(job => ({ id: job.jobId, activeTicks: job.activeTicks, doseProductionJobId: job.doseProductionJobId })) };
}

export function benchmarkOwner(scenario: Scenario) {
  const rawMs: number[] = []; const creationMs: number[] = []; const primeMs: number[] = []; const snapshotMs: number[] = [];
  const metrics: object[] = []; const ticks: number[] = []; let finalHash = '';
  const sourceHash = hash(scenario.source);
  if (scenario.mode === 'continuous') {
    const start = performance.now(); const owner = createOwner(scenario.source); const coldCreateMs = performance.now() - start;
    let expected = scenario.source;
    try {
      for (let index = -WARMUPS; index < SAMPLES; index++) {
        const before = expected; expected = strictTick(before); // Entire oracle is outside measured advance.
        const timer = performance.now(); const result = owner.advance(1); const elapsed = performance.now() - timer;
        const exportStart = performance.now(); const actual = snapshot(owner); const exportMs = performance.now() - exportStart;
        check(result.ok && result.advancedTicks === 1 && result.stopped === null && result.recoveryOnly === false, `${scenario.name}: owner stopped`);
        same(actual, expected, `${scenario.name}: strict whole-World mismatch`); scenario.verify(before, actual);
        if (index >= 0) { rawMs.push(elapsed); snapshotMs.push(exportMs); metrics.push(result.metrics); ticks.push(actual.clock.simulationTick); }
      }
      finalHash = hash(expected);
      check(hash(scenario.source) === sourceHash, 'Owner mutated the fixture source');
      return { operation: 'private-owner.advance(1)', sampling: scenario.mode, milliseconds: statistics(rawMs),
        coldCreateMs, separatelyMeasuredSnapshotMilliseconds: statistics(snapshotMs), metrics, measuredResultTicks: ticks, finalWorldSha256: finalHash, allExact: true };
    } finally { owner.close(); }
  }
  // Checkpoint and delivery boundaries only happen once on a timeline. A new
  // owner per trial uses the exact same earned source; one untimed real tick
  // primes its retained cursor. Never pad a 1-tick boundary with idle samples.
  let before = scenario.source;
  for (let index = 0; index < scenario.primeTicks; index++) before = strictTick(before);
  const expected = strictTick(before); scenario.verify(before, expected);
  for (let index = -WARMUPS; index < SAMPLES; index++) {
    const start = performance.now(); const owner = createOwner(scenario.source); const coldMs = performance.now() - start;
    try {
      const primeStart = performance.now(); const primed = owner.advance(scenario.primeTicks); const primeElapsed = performance.now() - primeStart;
      check(primed.ok && primed.advancedTicks === scenario.primeTicks && !primed.stopped, `${scenario.name}: prime failed`);
      same(snapshot(owner), before, `${scenario.name}: prime strict mismatch`);
      const timer = performance.now(); const result = owner.advance(1); const elapsed = performance.now() - timer;
      const exportStart = performance.now(); const actual = snapshot(owner); const exportMs = performance.now() - exportStart;
      check(result.ok && result.advancedTicks === 1 && !result.stopped && result.recoveryOnly === false, `${scenario.name}: boundary stopped`);
      same(actual, expected, `${scenario.name}: boundary strict mismatch`); scenario.verify(before, actual);
      if (index >= 0) { rawMs.push(elapsed); creationMs.push(coldMs); primeMs.push(primeElapsed); snapshotMs.push(exportMs); metrics.push(result.metrics); ticks.push(actual.clock.simulationTick); }
    } finally { owner.close(); }
  }
  check(hash(scenario.source) === sourceHash, 'Owner mutated the fixture source');
  return { operation: 'private-owner.advance(1)', sampling: scenario.mode, milliseconds: statistics(rawMs),
    separatelyMeasuredCreationMilliseconds: statistics(creationMs), separatelyMeasuredPrimeMilliseconds: statistics(primeMs),
    separatelyMeasuredSnapshotMilliseconds: statistics(snapshotMs), primeTicksPerTrial: scenario.primeTicks,
    metrics, measuredResultTicks: ticks, finalWorldSha256: hash(expected), allExact: true };
}

export function benchmarkSession(scenario: Scenario) {
  const rawMs: number[] = []; const creationMs: number[] = []; const cachedProjectionMs: number[] = [];
  const verify = (session: ApplicationSessionV10, before: WorldStateV10, expected: WorldStateV10) => {
    const exported = session.exportWorld(); check(exported.ok, `${scenario.name}: Session export failed`);
    same(exported.value, expected, `${scenario.name}: Session strict whole-World mismatch`); scenario.verify(before, exported.value);
    const projected = session.getSnapshot();
    check(!projected.runtimeFailure && !projected.stopped && projected.frame.clock.simulationTick === expected.clock.simulationTick,
      `${scenario.name}: Session projection stale or failed`);
    // Compare all four fixed DTOs against independently created strict-oracle
    // runtime views. These cold reads and this comparison are never timed.
    const oracleOwner = createOwner(expected);
    try {
      const frame = oracleOwner.frame(); const expansion = oracleOwner.expansion();
      const selected = projected.selection?.kind === 'disciple' ? projected.selection.id : null;
      const cultivation = oracleOwner.cultivation(selected); const build = oracleOwner.build(selected);
      check(frame.ok && expansion.ok && cultivation.ok && build.ok, 'Strict projection oracle failed');
      same({ frame: projected.frame, expansion: projected.expansion, cultivation: projected.cultivation, build: projected.build },
        { frame: frame.value, expansion: expansion.value, cultivation: cultivation.value, build: build.value }, 'Session DTO mismatch');
    } finally { oracleOwner.close(); }
  };
  function measured(session: ApplicationSessionV10, timestamp: number, before: WorldStateV10, expected: WorldStateV10, record: boolean) {
    const start = performance.now(); const result = session.frame(timestamp); const elapsed = performance.now() - start;
    check(result.ok && result.value === 1, `${scenario.name}: Session did not advance one actual tick`);
    const readStart = performance.now(); const projection = session.getSnapshot(); const readMs = performance.now() - readStart;
    check(projection.frame.clock.simulationTick === expected.clock.simulationTick, 'Wrong Session result tick');
    verify(session, before, expected);
    if (record) { rawMs.push(elapsed); cachedProjectionMs.push(readMs); }
  }
  if (scenario.mode === 'continuous') {
    const start = performance.now(); const session = new ApplicationSessionV10(scenario.source); const coldCreateMs = performance.now() - start;
    let expected = scenario.source; let timestamp = 0;
    try {
      const baseline = session.frame(timestamp); check(baseline.ok && baseline.value === 0, 'Session baseline failed');
      for (let index = -WARMUPS; index < SAMPLES; index++) {
        const before = expected; expected = strictTick(before); timestamp += TICK_MILLISECONDS;
        measured(session, timestamp, before, expected, index >= 0);
      }
      return { operation: 'ApplicationSessionV10.frame(50ms delta), including owner advance and fresh DTO publication',
        sampling: scenario.mode, milliseconds: statistics(rawMs), coldCreateMs,
        cachedGetSnapshotMilliseconds: statistics(cachedProjectionMs), allWorldsAndFourDTOsExact: true };
    } finally { session.close(); }
  }
  let before = scenario.source;
  for (let count = 0; count < scenario.primeTicks; count++) before = strictTick(before);
  const expected = strictTick(before);
  for (let index = -WARMUPS; index < SAMPLES; index++) {
    const start = performance.now(); const session = new ApplicationSessionV10(scenario.source); const coldMs = performance.now() - start;
    try {
      const baseline = session.frame(0); check(baseline.ok && baseline.value === 0, 'Session baseline failed');
      const prime = session.frame(scenario.primeTicks * TICK_MILLISECONDS);
      check(prime.ok && prime.value === scenario.primeTicks, 'Session boundary prime failed');
      const exported = session.exportWorld(); check(exported.ok, 'Session prime export failed');
      same(exported.value, before, 'Session prime differs from strict oracle');
      measured(session, (scenario.primeTicks + 1) * TICK_MILLISECONDS, before, expected, index >= 0);
      if (index >= 0) creationMs.push(coldMs);
    } finally { session.close(); }
  }
  return { operation: 'ApplicationSessionV10.frame(50ms delta), including owner advance and fresh DTO publication',
    sampling: scenario.mode, milliseconds: statistics(rawMs), separatelyMeasuredCreationMilliseconds: statistics(creationMs),
    primeTicksPerTrial: scenario.primeTicks, cachedGetSnapshotMilliseconds: statistics(cachedProjectionMs), allWorldsAndFourDTOsExact: true };
}

export function runWorkloadBenchmark(options: { scenario?: ScenarioName; session?: boolean; progress?: Progress } = {}) {
  const progress = options.progress ?? (() => {});
  check(options.scenario === undefined || SCENARIO_NAMES.includes(options.scenario), 'Unknown benchmark scenario');
  const started = performance.now(); const prepared = prepareScenarios(progress);
  const selected = prepared.scenarios.filter(row => !options.scenario || row.name === options.scenario);
  const rows = selected.map(scenario => {
    progress(`Measuring ${scenario.name}`);
    const sourceHash = hash(scenario.source); const source = sourceEvidence(scenario.source);
    const owner = benchmarkOwner(scenario);
    const session = options.session === false ? null : benchmarkSession(scenario);
    check(hash(scenario.source) === sourceHash, `${scenario.name}: source changed during measurement`);
    return { scenario: scenario.name, description: scenario.description, source, owner, session };
  });
  return { scope: 'Opt-in serial Node headless v10 workload benchmark; genuine four-person starter roster with three eligible adults',
    limitations: 'Not browser, phone, 36-person, long-history, 3x speed, render, public-route, migration or full-game acceptance. No latency budget is automatically passed.',
    protocol: 'management-v10-alchemy-upgrade.1', samplesPerRow: SAMPLES, warmupsPerRow: WARMUPS,
    percentile: 'Nearest rank: sorted[ceil(p * 20) - 1]', timer: 'node:perf_hooks.performance.now',
    node: process.version, platform: process.platform, arch: process.arch, setup: prepared.setup,
    totalMilliseconds: performance.now() - started,
    interpretation: 'Only owner.advance(1) or Session.frame is in the primary timed interval. Setup, complete admission, strict oracle, snapshots, DTO comparison, creation and priming are excluded or separately labeled. Session.frame includes projection and runtime; cached getSnapshot is not fresh projection cost. Do not subtract independently measured distributions.',
    rows };
}
