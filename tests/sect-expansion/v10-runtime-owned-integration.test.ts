import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 as normal, prepareNoOptionalGrowthTickCandidateV10 as noOptional } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 as strict, verifyCapacityLimitedCandidateV10 as verify } from '../../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10, type RuntimeOperationV10 } from '../../src/core/world/runtime-instance-v10';
import type { RuntimeReadV10, RuntimeReadonlyV10 } from '../../src/core/world/runtime-view-types-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Only records which fixed private/strict port ran. No production API accepts
 * these hooks, arbitrary candidates, assessment values or callbacks. Plain
 * forwarders avoid spy wrappers reading intentionally hostile thrown objects. */
const hooks = vi.hoisted(() => ({
  trace: null as null | Array<{ kind: string; world: unknown }>,
  refuseCapture: false, refuseNormal: false,
  captureError: null as null | { thrown: unknown }, normalError: null as null | { thrown: unknown },
  onNormal: null as null | (() => void),
}));
vi.mock('../../src/core/world/runtime-owned-ticks-v10', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/world/runtime-owned-ticks-v10')>();
  return { ...actual, createOwnedTickPipelineV10() {
    const factory = actual.createOwnedTickPipelineV10(); let retained: unknown = null;
    return Object.freeze({
      capture(input: unknown) {
        hooks.trace?.push({ kind: 'owned-capture', world: input });
        if (hooks.captureError) throw hooks.captureError.thrown;
        if (hooks.refuseCapture) { factory.clear(); retained = null; return null; }
        const result = factory.capture(input); retained = result?.world ?? null; return result;
      },
      advanceNormal() {
        hooks.trace?.push({ kind: 'owned-normal', world: retained }); hooks.onNormal?.();
        if (hooks.normalError) throw hooks.normalError.thrown;
        if (hooks.refuseNormal) return null;
        const result = factory.advanceNormal(); if (result) retained = result.world; return result;
      },
      advanceNoOptional() {
        hooks.trace?.push({ kind: 'owned-no-optional', world: retained });
        const result = factory.advanceNoOptional(); if (result) retained = result.world; return result;
      },
      clear() { factory.clear(); retained = null; },
    });
  } };
});
vi.mock('../../src/core/kernel/simulation-v10', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/kernel/simulation-v10')>();
  return { ...actual,
    prepareNormalTickCandidateV10(world: WorldStateV10) {
      hooks.trace?.push({ kind: 'strict-normal', world }); return actual.prepareNormalTickCandidateV10(world);
    },
    prepareNoOptionalGrowthTickCandidateV10(world: WorldStateV10) {
      hooks.trace?.push({ kind: 'strict-no-optional', world }); return actual.prepareNoOptionalGrowthTickCandidateV10(world);
    },
  };
});
afterEach(() => {
  hooks.trace = null; hooks.refuseCapture = false; hooks.refuseNormal = false;
  hooks.captureError = null; hooks.normalError = null; hooks.onNormal = null;
});

// The admitted constructor intentionally returns a frozen snapshot. Mutating
// explicit caller fixtures requires a detached ordinary JSON copy.
const fresh = (): WorldStateV10 => cloneJson(createUnregisteredWorldV10('v10-owned-integration'));
function runtime(world = fresh()): PrivateRuntimeInstanceV10 {
  const result = createPrivateRuntimeV10(world); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error); return result.instance;
}
function snapshot(owner: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = owner.snapshot(); expect(result.ok).toBe(true); if (!result.world) throw new Error('Missing snapshot'); return result.world;
}
function value<T>(result: RuntimeReadV10<T>): RuntimeReadonlyV10<T> {
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error); return result.value;
}
function input(world: WorldStateV10, body: Omit<CommandV10, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): CommandV10 {
  return { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 } as CommandV10;
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
  return apply(world, input(world, { kind: 'sect.command', payload }, payload.command.commandId));
}
function gathering(): WorldStateV10 {
  const source = fresh(); return apply(source, input(source,
    { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'owned-integration.gather'));
}
function atWireCost(source: WorldStateV10, target: number): WorldStateV10 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const baseline = assess(world); expect(baseline.supported).toBe(true);
  world.diagnostics.at(-1)!.message = 'x'.repeat(target - baseline.costs.wireBytes!);
  expect(assess(world).costs.wireBytes).toBe(target); return world;
}
function automatic(): WorldStateV10 {
  let source = fresh(); source = apply(source, input(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set',
    plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'owned-integration.plan'));
  return apply(source, input(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'owned-integration.enable'));
}
function compare(owner: PrivateRuntimeInstanceV10, source: WorldStateV10, count = 1) {
  const expected = strict(source, count); const result = owner.advance(count); const world = snapshot(owner);
  expect(world).toEqual(expected.world); expect(result.stopped?.kind ?? null).toBe(expected.stopped?.kind ?? null);
  expect(result.advancedTicks).toBe(world.clock.simulationTick - source.clock.simulationTick);
  expect(result.recoveryOnly).toBe(!assess(world).fits); return { result, world };
}

describe('actual owned ticks through the retained private owner', () => {
  it('keeps the scalar idle path first and its counters separate', () => {
    const source = fresh(); const owner = runtime(source); const { result } = compare(owner, source, 5);
    expect(result.metrics).toEqual({ sourceChecks: 0, candidateChecks: 0, normalCandidates: 0, noOptionalCandidates: 0,
      exports: 0, fastTicks: 5, ownedCaptures: 0, ownedNormalAttempts: 0, ownedNoOptionalAttempts: 0, ownedTicks: 0 });
  });
  it('retains one actual-work capture across calls and publishes exact whole-world ticks', () => {
    let source = gathering(); const before = canonicalStringify(source); const original = source; const owner = runtime(source);
    let publication = 0;
    for (const count of [1, 1, 3]) {
      const { result, world } = compare(owner, source, count);
      expect(result).toMatchObject({ ok: true, advancedTicks: count, stopped: null,
        stamp: { generation: 1, publication: publication + count }, metrics: { fastTicks: 0, ownedTicks: count,
          ownedCaptures: publication === 0 ? 1 : 0, ownedNormalAttempts: count, ownedNoOptionalAttempts: 0,
          sourceChecks: 0, candidateChecks: 0, normalCandidates: 0, noOptionalCandidates: 0 } });
      source = world; publication += count;
    }
    expect(canonicalStringify(original)).toBe(before); expect(original.clock.simulationTick).toBe(0);
  });
  it('preserves the owned cursor through snapshots and successful, invalid and reentrant reads', () => {
    const owner = runtime(gathering()); expect(owner.advance(1).metrics.ownedCaptures).toBe(1);
    const saved = snapshot(owner); const frame = value(owner.frame()); const build = value(owner.build('entity:2'));
    expect(value(owner.frame())).toBe(frame); expect(owner.expansion().ok).toBe(true); expect(owner.cultivation('entity:2').ok).toBe(true);
    expect(owner.previewUpgrade({})).toMatchObject({ error: 'invalid-query' });
    let nestedReads = 0; const dangerous = new Proxy({}, { ownKeys() { nestedReads++; throw null; } });
    const nested: RuntimeOperationV10[] = [];
    const query = new Proxy({ buildingId: 'sect-building:1', workerId: 'entity:2' }, { ownKeys(target) {
      nested.push(owner.advance(1), owner.previewUpgrade(dangerous), owner.command(dangerous), owner.invalidate());
      return Reflect.ownKeys(target);
    } });
    expect(owner.previewUpgrade(query).ok).toBe(true); nested.forEach(result => expect(result.error).toBe('reentrant'));
    expect(nestedReads).toBe(0); expect(owner.advance(-1).error).toBe('invalid-steps');
    const result = compare(owner, saved).result;
    expect(result.metrics).toMatchObject({ ownedCaptures: 0, ownedNormalAttempts: 1, ownedTicks: 1, sourceChecks: 0 });
    expect(value(owner.frame())).not.toBe(frame); expect(value(owner.build('entity:2'))).not.toBe(build);
    expect(frame.clock.simulationTick).toBe(saved.clock.simulationTick);
  });
  it.each(['invalid-command', 'command', 'invalid-control', 'no-op-control', 'speed', 'invalid-replace', 'replace', 'invalidate'] as const)(
    'clears the exact owned cursor on %s without changing unrelated retained data', kind => {
      const owner = runtime(gathering()); expect(owner.advance(1).metrics.ownedTicks).toBe(1);
      const before = snapshot(owner); const previous = owner.frame().stamp;
      const operation = kind === 'invalid-command' ? owner.command({})
        : kind === 'command' ? owner.command(input(before, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'owned-integration.discard'))
          : kind === 'invalid-control' ? owner.controlClock({ kind: 'speed', speed: 4 })
            : kind === 'no-op-control' ? owner.controlClock({ kind: 'speed', speed: 1 })
              : kind === 'speed' ? owner.controlClock({ kind: 'speed', speed: 3 })
                : kind === 'invalid-replace' ? owner.replace({})
                  : kind === 'replace' ? owner.replace(before) : owner.invalidate();
      if (kind.startsWith('invalid-') || kind === 'no-op-control') expect(operation.stamp).toEqual(previous);
      const current = snapshot(owner);
      if (kind.startsWith('invalid-') || kind === 'no-op-control' || kind === 'replace' || kind === 'invalidate') expect(current).toEqual(before);
      const { result } = compare(owner, current);
      expect(result.metrics).toMatchObject({ ownedCaptures: 1, ownedNormalAttempts: 1, ownedTicks: 1 });
      expect(result.stamp.generation).toBe(operation.stamp.generation);
      expect(result.stamp.publication).toBe(operation.stamp.publication + 1);
    });
  it('does not share a cursor or authority between owners, replacements or borrowed methods', () => {
    const source = gathering(); const a = runtime(source); a.advance(1); const foreign = snapshot(a); const b = runtime(foreign);
    expect(b.advance.call({}, 1)).toMatchObject({ metrics: { ownedCaptures: 1, ownedTicks: 1 } }); expect(snapshot(a)).toEqual(foreign);
    expect(a.advance(1).metrics.ownedCaptures).toBe(0); const old = value(a.frame());
    expect(a.replace(snapshot(b))).toMatchObject({ ok: true, stamp: { generation: 2, publication: 3 } });
    expect(value(a.frame())).not.toBe(old); expect(a.advance(1).metrics.ownedCaptures).toBe(1);
    const saved = snapshot(a); const closed = a.close(); hooks.trace = [];
    expect(a.advance(1)).toMatchObject({ error: 'closed', stamp: closed.stamp, metrics: { ownedCaptures: 0, ownedTicks: 0 } });
    expect(a.snapshot().world).toBeNull(); expect(hooks.trace).toEqual([]); expect(saved.clock.simulationTick).toBe(3);
  });
  it.each(['capture-null', 'normal-null', 'capture-throw', 'normal-throw'] as const)(
    'falls back to strict normal after %s and never reads hostile exceptions', mode => {
      const source = gathering(); const expected = strict(source, 1).world; const owner = runtime(source); let reads = 0;
      const thrown = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
      hooks.refuseCapture = mode === 'capture-null'; hooks.refuseNormal = mode === 'normal-null';
      hooks.captureError = mode === 'capture-throw' ? { thrown } : null;
      hooks.normalError = mode === 'normal-throw' ? { thrown } : null; hooks.trace = [];
      const result = owner.advance(1);
      expect(result).toMatchObject({ ok: true, advancedTicks: 1, stopped: null,
        metrics: { ownedTicks: 0, normalCandidates: 1, noOptionalCandidates: 0, candidateChecks: 1 } });
      expect(hooks.trace.some(row => row.kind === 'strict-normal')).toBe(true);
      expect(hooks.trace.some(row => row.kind === 'owned-no-optional' || row.kind === 'strict-no-optional')).toBe(false);
      expect(reads).toBe(0); expect(snapshot(owner)).toEqual(expected);
      hooks.refuseCapture = false; hooks.refuseNormal = false; hooks.captureError = null; hooks.normalError = null;
      expect(owner.advance(1).metrics).toMatchObject({ ownedCaptures: 1, ownedTicks: 1 });
    });
  it('checks strict normal before same-source no-optional work after genuine optional-growth refusal', () => {
    const source = atWireCost(automatic(), SAVE_FILE_LIMIT_BYTES - 100); const before = canonicalStringify(source);
    const expected = strict(source, 1); expect(expected.stopped).toBeNull();
    expect(assess(normal(source)).fits).toBe(false); expect(assess(noOptional(source)).fits).toBe(true);
    const owner = runtime(source); hooks.trace = []; const result = owner.advance(1);
    expect(result).toMatchObject({ ok: true, advancedTicks: 1, metrics: { ownedCaptures: 1, ownedNormalAttempts: 1,
      ownedNoOptionalAttempts: 1, ownedTicks: 1, normalCandidates: 1, noOptionalCandidates: 0, candidateChecks: 1 } });
    const trace = hooks.trace; const normalIndex = trace.findIndex(row => row.kind === 'owned-normal');
    const strictIndex = trace.findIndex(row => row.kind === 'strict-normal'); const fallbackIndex = trace.findIndex(row => row.kind === 'owned-no-optional');
    expect(normalIndex).toBeGreaterThanOrEqual(0); expect(strictIndex).toBeGreaterThan(normalIndex); expect(fallbackIndex).toBeGreaterThan(strictIndex);
    expect(trace[strictIndex]!.world).toBe(trace[normalIndex]!.world); expect(trace[fallbackIndex]!.world).toBe(trace[normalIndex]!.world);
    expect(snapshot(owner)).toEqual(expected.world); expect(snapshot(owner).sectEconomy.enabled).toBe(true);
    expect(canonicalStringify(source)).toBe(before);
  }, 60000);
  it('retains the preceding published tick when both actual and strict next candidates fail numerically', () => {
    const base = fresh(); const source: WorldStateV10 = { ...base, sectExpansion: { ...base.sectExpansion,
      construction: { ...base.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    const expected = strict(source, 2); const owner = runtime(source); const result = owner.advance(2);
    expect(result).toMatchObject({ ok: false, error: 'internal-failure', advancedTicks: 1, stamp: { generation: 1, publication: 1 },
      stopped: { kind: 'invalid-records' }, metrics: { ownedTicks: 1, normalCandidates: 1, noOptionalCandidates: 1 } });
    expect(snapshot(owner)).toEqual(expected.world); hooks.trace = [];
    const stopped = owner.advance(1); expect(stopped).toMatchObject({ advancedTicks: 0, stopped: result.stopped, stamp: result.stamp });
    expect(hooks.trace).toEqual([]); expect(owner.controlClock({ kind: 'speed', speed: 3 }).stopped).toEqual(result.stopped);
    expect(owner.advance(1).advancedTicks).toBe(0); expect(hooks.trace).toEqual([]);
  });
  it('checks the outer reentrant guard while the private factory is executing', () => {
    const owner = runtime(gathering()); let reflected = 0; const results: RuntimeOperationV10[] = [];
    const hostile = new Proxy({}, { ownKeys() { reflected++; throw null; } });
    hooks.onNormal = () => { results.push(owner.command(hostile), owner.replace(hostile), owner.controlClock(hostile),
      owner.advance(1), owner.invalidate(), owner.close(), owner.previewUpgrade(hostile), owner.snapshot()); };
    expect(owner.advance(1)).toMatchObject({ ok: true, advancedTicks: 1, metrics: { ownedTicks: 1 } });
    expect(results).toHaveLength(8); results.forEach(result => expect(result.error).toBe('reentrant')); expect(reflected).toBe(0);
    hooks.onNormal = null; expect(owner.advance(1).metrics.ownedCaptures).toBe(0);
  });
  it('leaves actual paid teaching on the unchanged strict path', () => {
    const old = fundedRuntimeFixture(); const knowledgeId = 'knowledge.owned-integration';
    old.cultivation = createCultivationStateV3(old.cultivation.disciples.map((profile, index) => ({ ...profile,
      knowledge: index === 0 ? [{ knowledgeId, teacherId: null, teachingId: null }] : [] })));
    old.clock = { ...old.clock, simulationTick: MONTH - 2, calendarTick: MONTH - 2 };
    const initial = records(old); const commandId = 'owned-integration.lesson';
    const source = apply(initial, input(initial, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin',
      commandId, expectedRevision: initial.cultivation.revision, discipleId: 'entity:1', studentId: 'entity:2', knowledgeId } } }, commandId));
    const { result, world } = compare(runtime(source), source, 2);
    expect(result.metrics).toMatchObject({ fastTicks: 0, ownedCaptures: 0, ownedTicks: 0, normalCandidates: 2, candidateChecks: 2 });
    expect(world.cultivation.disciples[0]!.teaching?.completedMonths).toBe(1);
  }, 30000);
});

/** Explicit record lift of earned old history, not migration evidence. */
function records(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected old L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No old alternative medicine'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean): WorldStateV10 {
  let next = world;
  for (let tick = 0; tick < 1600 && !done(next); tick++) next = normal(next);
  if (!done(next)) throw new Error('Actual integration fixture did not finish');
  expect(inspectUnregisteredWorldV10Records(next)).toEqual([]); return next;
}
describe('owned publication across actual upgrade, medicine and lifecycle boundaries', () => {
  let old: WorldStateV9; let started: WorldStateV10; let beforeHalf: WorldStateV10; let almost: WorldStateV10;
  let completed: WorldStateV10; let careLast: WorldStateV10; let maintenanceDue: WorldStateV10;
  beforeAll(() => { old = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const)
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  beforeAll(() => {
    let world = records(old);
    world = sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'integration.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } });
    world = until(world, next => next.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'integration.upgrade',
      expectedRevision: world.sectExpansion.upgrade.revision, buildingId: world.sectExpansion.construction.buildings
        .find(building => building.definitionId === 'alchemy.v9')!.buildingId, workerId: 'entity:2' } });
    beforeHalf = until(started, next => next.sectExpansion.upgrade.jobs[0]!.activeTicks === 199);
    almost = until(beforeHalf, next => next.sectExpansion.upgrade.jobs[0]!.activeTicks === 399); completed = normal(almost);
  }, 180000);
  beforeAll(() => {
    let world = sect(completed, { domain: 'production', command: { kind: 'production.start', commandId: 'integration.alternative',
      expectedRevision: completed.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' } });
    world = until(world, next => next.sectExpansion.production.jobs.at(-1)!.terminal !== null);
    world = sect(world, { domain: 'care', command: { kind: 'care.start', commandId: 'integration.care',
      expectedRevision: world.sectExpansion.care.revision, patientId: 'entity:4' } });
    careLast = until(world, next => next.sectExpansion.care.jobs.at(-1)!.activeTicks === 39);
    const paid = until(completed, next => next.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2));
    const payment = paid.sectExpansion.maintenance.payments.findLast(value => value.rate?.level === 2)!;
    maintenanceDue = until(paid, next => next.clock.calendarTick === payment.dueCalendarTick - 1);
  }, 180000);
  it.each(['upgrade-start', 'upgrade-half', 'upgrade-final', 'care-final', 'maintenance-due'] as const)(
    'publishes a complete actual %s candidate without a second strict replay', kind => {
      const source = kind === 'upgrade-start' ? started : kind === 'upgrade-half' ? beforeHalf
        : kind === 'upgrade-final' ? almost : kind === 'care-final' ? careLast : maintenanceDue;
      const owner = runtime(source); const before = value(owner.expansion()); const { result, world } = compare(owner, source);
      expect(result).toMatchObject({ ok: true, advancedTicks: 1, metrics: { fastTicks: 0, ownedCaptures: 1,
        ownedNormalAttempts: 1, ownedNoOptionalAttempts: 0, ownedTicks: 1, normalCandidates: 0, noOptionalCandidates: 0, candidateChecks: 0 } });
      expect(value(owner.expansion())).not.toBe(before);
      if (kind === 'upgrade-half') expect(world.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(1);
      if (kind === 'upgrade-final') expect(world).toEqual(completed);
      if (kind === 'care-final') expect(world.sectExpansion.care.jobs.at(-1)!.terminal?.kind).toBe('completed');
      if (kind === 'maintenance-due') expect(world.sectExpansion.maintenance.payments.at(-1)!.rate?.level).toBe(2);
    }, 30000);
  it('returns from completed actual work to scalar idle without using a stale owned cursor', () => {
    const owner = runtime(almost); const { result, world } = compare(owner, almost, 3);
    expect(result.metrics).toMatchObject({ ownedCaptures: 1, ownedTicks: 1, fastTicks: 2 });
    expect(world.sectExpansion.upgrade.jobs).toEqual(completed.sectExpansion.upgrade.jobs);
    expect(world.clock.simulationTick).toBe(completed.clock.simulationTick + 2);
  }, 30000);
  it('keeps normal reserved-recovery completion ahead of all optional fallback attempts', () => {
    const source = atWireCost(almost, SAVE_FILE_LIMIT_BYTES + 200_000);
    expect(assess(source)).toMatchObject({ supported: true, actualFits: true, fits: false });
    const expected = strict(source, 1); expect(expected.stopped).toBeNull();
    expect(verify(source, expected.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    const owner = runtime(source); hooks.trace = []; const result = owner.advance(1);
    expect(result).toMatchObject({ ok: true, advancedTicks: 1, metrics: { ownedCaptures: 0, ownedNormalAttempts: 0,
      ownedNoOptionalAttempts: 0, ownedTicks: 0, normalCandidates: 1, noOptionalCandidates: 0, candidateChecks: 1 } });
    expect(hooks.trace.every(row => row.kind === 'strict-normal')).toBe(true); expect(snapshot(owner)).toEqual(expected.world);
    expect(snapshot(owner).sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
  }, 60000);
  it('preserves month/death-before-completion ordering and domain pause in the actual owner', () => {
    const source = cloneJson(almost); const target = Math.ceil((source.clock.calendarTick + 1) / MONTH) * MONTH;
    // Explicit validated near-lifespan initial point, not a claimed simulated gap.
    source.clock.simulationTick = target - 1; source.clock.calendarTick = target - 1;
    const actor = source.disciples.find(member => member.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * MONTH; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const owner = runtime(source); const { result, world } = compare(owner, source, 2);
    expect(result).toMatchObject({ advancedTicks: 1, metrics: { ownedTicks: 1, fastTicks: 0 } });
    const death = world.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    expect(world.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 399,
      terminal: { kind: 'cancelled', cancellation: { kind: 'death', deathId: death.deathId } } });
    expect(world.sectExpansion.maintenance).toEqual(source.sectExpansion.maintenance);
    expect(world.clock.pauseReasons).toContain('cultivation');
    expect(owner.controlClock({ kind: 'pause', reason: 'player', paused: false }).changed).toBe(false);
    expect(owner.advance(1)).toMatchObject({ advancedTicks: 0, metrics: { ownedCaptures: 0, ownedNormalAttempts: 0, ownedTicks: 0 } });
    expect(snapshot(owner)).toEqual(world);
  }, 30000);
});
