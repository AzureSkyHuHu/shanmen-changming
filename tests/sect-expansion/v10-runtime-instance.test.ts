import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import * as simulation from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10, CAPACITY_LIMITED_V10_MAX_STEPS, dispatchCapacityLimitedCommandV10 } from '../../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10, type RuntimeOperationV10 } from '../../src/core/world/runtime-instance-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Explicit record-only lift of earned old fixtures. No migration/codec/UI path
 * is exercised. Base-stock funding in the shared fixture remains test setup. */
function records(source: WorldStateV9 = createUnregisteredWorldV9('private-v10-runtime')): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable old L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No old L2 fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function runtime(world = records()): PrivateRuntimeInstanceV10 {
  const result = createPrivateRuntimeV10(world); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected valid private v10 source');
  expect(result.metrics.sourceChecks).toBe(1); return result.instance;
}
function snapshot(instance: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = instance.snapshot(); expect(result.ok).toBe(true); expect(result.world).not.toBeNull();
  expect(result.metrics.exports).toBe(1); expect(result.metrics.sourceChecks).toBe(1); return result.world!;
}
function command(world: WorldStateV10, body: Omit<CommandV10, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): CommandV10 {
  return { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 } as CommandV10;
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 { return command(world, { kind: 'sect.command', payload }, payload.command.commandId); }
function discard(world: WorldStateV10, id = 'owner.discard', quantity = 1): CommandV10 {
  return command(world, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity } }, id);
}
function prepared(world: WorldStateV10, input: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, input);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = world;
  for (let n = 0; n < limit && !done(next); n++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Genuine v10 fixture did not finish'); return next;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}
/** Plain module-factory forwarders deliberately avoid vi.spyOn/vi.fn around
 * thrown objects: the spy wrapper inspects `error instanceof TypeError` first.
 * Hooks are test-only and absent from the actual runtime's public input surface. */
const injectedFailures = vi.hoisted(() => ({
  capture: null as null | ((input: unknown) => unknown),
  normal: null as null | ((world: WorldStateV10) => WorldStateV10),
  fallback: null as null | ((world: WorldStateV10) => WorldStateV10),
}));
vi.mock('../../src/core/world/v10-sect-records', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/world/v10-sect-records')>();
  return { ...actual, captureV10RecordData(input: unknown): unknown {
    return injectedFailures.capture ? injectedFailures.capture(input) : actual.captureV10RecordData(input);
  } };
});
vi.mock('../../src/core/kernel/simulation-v10', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/kernel/simulation-v10')>();
  return { ...actual,
    prepareNormalTickCandidateV10(world: WorldStateV10): WorldStateV10 {
      return injectedFailures.normal ? injectedFailures.normal(world) : actual.prepareNormalTickCandidateV10(world);
    },
    prepareNoOptionalGrowthTickCandidateV10(world: WorldStateV10): WorldStateV10 {
      return injectedFailures.fallback ? injectedFailures.fallback(world) : actual.prepareNoOptionalGrowthTickCandidateV10(world);
    },
    prepareOwnedNormalTickStagesV10(world: WorldStateV10): WorldStateV10 {
      return injectedFailures.normal ? injectedFailures.normal(world) : actual.prepareOwnedNormalTickStagesV10(world);
    },
    prepareOwnedNoOptionalGrowthTickStagesV10(world: WorldStateV10): WorldStateV10 {
      return injectedFailures.fallback ? injectedFailures.fallback(world) : actual.prepareOwnedNoOptionalGrowthTickStagesV10(world);
    },
  };
});
function atWireCost(source: WorldStateV10, target: number): WorldStateV10 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const baseline = assess(world); expect(baseline.supported).toBe(true);
  world.diagnostics.at(-1)!.message = 'x'.repeat(target - baseline.costs.wireBytes!);
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); expect(assess(world).costs.wireBytes).toBe(target);
  return world;
}
function planned(): WorldStateV10 {
  const world = records(); return prepared(world, sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'owner.place',
    expectedRevision: 0, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
}
function recoverySource(): WorldStateV10 {
  const source = planned(); const world: WorldStateV10 = { ...source, sectExpansion: { ...source.sectExpansion,
    construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]);
  expect(assess(world)).toMatchObject({ supported: true, actualFits: true, fits: false }); return world;
}
function cancelPlan(world: WorldStateV10): CommandV10 {
  return sect(world, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'owner.cancel',
    expectedRevision: world.sectExpansion.construction.revision, blueprintId: world.sectExpansion.construction.blueprints[0]!.blueprintId } });
}

describe('strict private v10 lifecycle and complete publications', () => {
  it('matches the fixed gate across retained idle advances, a command, retry and conflict', () => {
    let world = records(); const instance = runtime(world); let publication = 0;
    for (const ticks of [1, 3, 0, 2]) {
      const oracle = advanceCapacityLimitedTicksV10(world, ticks); const result = instance.advance(ticks);
      expect(result).toMatchObject({ ok: true, advancedTicks: ticks, stopped: null, recoveryOnly: false });
      publication += ticks; expect(result.stamp).toEqual({ generation: 1, publication });
      expect(result.metrics).toEqual({ sourceChecks: 0, candidateChecks: 0, normalCandidates: 0, noOptionalCandidates: 0, exports: 0,
        fastTicks: ticks, ownedCaptures: 0, ownedNormalAttempts: 0, ownedNoOptionalAttempts: 0, ownedTicks: 0 });
      expect('world' in result).toBe(false); world = oracle.world; expect(snapshot(instance)).toEqual(world);
    }
    const input = discard(world); const oracle = dispatchCapacityLimitedCommandV10(world, input); const applied = instance.command(input);
    expect(applied).toMatchObject({ ok: true, published: true, result: oracle.result }); expect(applied.stamp.publication).toBe(++publication);
    world = oracle.world; expect(snapshot(instance)).toEqual(world);
    expect(instance.command(input)).toMatchObject({ published: false, result: oracle.result, stamp: applied.stamp });
    expect(instance.command({ ...input, payload: { resourceId: 'grain', quantity: 2 } })).toMatchObject({ published: false,
      result: { rejection: { code: 'COMMAND_CONFLICT' } }, stamp: applied.stamp });
    expect(snapshot(instance)).toEqual(world);
    expect(Object.keys(instance).sort()).toEqual(['advance', 'close', 'command', 'controlClock', 'invalidate', 'replace', 'snapshot',
      'frame', 'cultivation', 'build', 'expansion', 'previewBreakthrough', 'previewPlacement', 'previewUpgrade', 'nextApplicationCommand'].sort());
    expect(Object.isFrozen(instance)).toBe(true);
  });
  it('detaches every snapshot, command result, replacement and external source without freezing the caller', () => {
    const source = records(); const original = cloneJson(source); const a = runtime(source); const b = runtime(source);
    const stale = snapshot(a); const second = snapshot(a);
    expect(stale).not.toBe(source); expect(second).not.toBe(stale); expect(stale.history).not.toBe(source.history);
    source.inventory.wood.owned++; source.cultivation.revision++;
    expect(snapshot(a)).toEqual(original); expect(snapshot(b)).toEqual(original); expect(Object.isFrozen(source)).toBe(false);
    expect(Reflect.set(stale.inventory.wood, 'owned', 999)).toBe(false); expect(Reflect.set(stale.clock, 'calendarTick', 999)).toBe(false);
    const input = discard(stale); const result = a.command(input); expect(result.published).toBe(true);
    expect(Reflect.set(result.result!.eventIds, '0', 'event:999')).toBe(false);
    expect(Object.isFrozen(result.result)).toBe(true); expect(Object.isFrozen(input)).toBe(false);
    if (input.kind !== 'inventory.discard') throw new Error('Expected discard'); input.payload.quantity = 999;
    expect(snapshot(a).inventory.grain.owned).toBe(stale.inventory.grain.owned - 1); expect(snapshot(b)).toEqual(stale);
    expect(snapshot(a).commandReceipts['owner.discard']!.result).not.toBe(result.result);
    const replacement = records(createUnregisteredWorldV9('private-v10-new')); const saved = cloneJson(replacement);
    expect(a.replace(replacement)).toMatchObject({ ok: true, stamp: { generation: 2, publication: 2 } });
    replacement.inventory.stone.owned++; expect(snapshot(a)).toEqual(saved); expect(stale.clock.simulationTick).toBe(0);
  });
  it('keeps root, stop and counters on failed replacement, and keeps publication stable on invalidation', () => {
    const instance = runtime(); instance.advance(2); const before = instance.snapshot();
    const forged = cloneJson(before.world!); forged.cultivation.revision++;
    const failed = instance.replace(forged); expect(failed).toMatchObject({ ok: false, error: 'invalid-source', stamp: before.stamp,
      recoveryOnly: before.recoveryOnly, stopped: before.stopped });
    expect(snapshot(instance)).toEqual(before.world);
    expect(instance.invalidate()).toMatchObject({ ok: true, stamp: { generation: 2, publication: 2 } });
    expect(snapshot(instance)).toEqual(before.world);
    expect(instance.advance(1)).toMatchObject({ advancedTicks: 1, stamp: { generation: 2, publication: 3 } });
  });
  it('reports recovery-only exports, latches refused ticks and permits a genuine cancellation to clear the stop', () => {
    const world = recoverySource(); const created = createPrivateRuntimeV10(world); expect(created).toMatchObject({ ok: true, recoveryOnly: true });
    if (!created.ok) throw new Error('Expected recovery source'); const instance = created.instance; const before = instance.snapshot();
    // This numeric boundary fails actual candidate record preparation before the
    // capacity gate. Preserve the fixed gate's safe invalid-records classification.
    expect(() => prepareNormalTickCandidateV10(world)).toThrow();
    expect(() => simulation.prepareNoOptionalGrowthTickCandidateV10(world)).toThrow();
    expect(advanceCapacityLimitedTicksV10(world, 1).stopped?.kind).toBe('invalid-records');
    expect(before.recoveryOnly).toBe(true); const failed = instance.advance(1);
    expect(failed).toMatchObject({ ok: false, error: 'internal-failure', advancedTicks: 0, stopped: { kind: 'invalid-records' }, stamp: before.stamp });
    expect(snapshot(instance)).toEqual(before.world);
    expect(instance.advance(1)).toMatchObject({ advancedTicks: 0, stopped: failed.stopped, metrics: { normalCandidates: 0, noOptionalCandidates: 0 } });
    expect(instance.command({})).toMatchObject({ published: false, stopped: failed.stopped });
    expect(instance.invalidate().stopped).toEqual(failed.stopped);
    expect(instance.replace({ trusted: true, frozen: true, world })).toMatchObject({ ok: false, stopped: failed.stopped });
    expect(instance.controlClock({ kind: 'speed', speed: 3 })).toMatchObject({ ok: true, changed: true, stopped: failed.stopped });
    expect(instance.advance(1)).toMatchObject({ advancedTicks: 0, stopped: failed.stopped });
    const current = snapshot(instance); const cancel = cancelPlan(current); const result = instance.command(cancel);
    expect(result).toMatchObject({ ok: true, published: true, stopped: null, result: { status: 'accepted' } });
    expect(snapshot(instance).sectExpansion.construction.blueprints[0]!.status).toBe('cancelled');
    expect(instance.command(cancel)).toMatchObject({ published: false, stopped: null, result: { status: 'accepted' } });
  });
  it('keeps receipt retries and conflicts ahead of new capacity admission without clearing a stopped runtime', () => {
    let world = records(); const input = discard(world); world = prepared(world, input);
    world = prepared(world, sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'retry.place',
      expectedRevision: 0, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
    world = { ...world, sectExpansion: { ...world.sectExpansion,
      construction: { ...world.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    const instance = runtime(world); const stopped = instance.advance(1);
    expect(stopped.stopped?.kind).toBe(advanceCapacityLimitedTicksV10(world, 1).stopped?.kind);
    expect(stopped.stopped?.kind).toBe('invalid-records');
    const before = snapshot(instance);
    expect(instance.command(input)).toMatchObject({ published: false, result: { status: 'accepted' }, stopped: stopped.stopped, stamp: stopped.stamp });
    expect(instance.command({ ...input, payload: { resourceId: 'grain', quantity: 2 } })).toMatchObject({ published: false,
      result: { rejection: { code: 'COMMAND_CONFLICT' } }, stopped: stopped.stopped, stamp: stopped.stamp });
    expect(snapshot(instance)).toEqual(before);
  });
  it('latches an actual future-capacity refusal from record-valid candidates and rejects a deficit-worsening pause', () => {
    const world = planned(); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const baseline = assess(world); expect(baseline.supported).toBe(true);
    world.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 100_000 - baseline.costs.wireBytes!);
    expect(assess(world)).toMatchObject({ supported: true, actualFits: true, fits: false });
    // These candidates really exist and satisfy records; the separate future
    // reserve gate is what rejects publication, unlike MAX-revision prethrows.
    expect(inspectUnregisteredWorldV10Records(prepareNormalTickCandidateV10(world))).toEqual([]);
    expect(inspectUnregisteredWorldV10Records(simulation.prepareNoOptionalGrowthTickCandidateV10(world))).toEqual([]);
    const instance = runtime(world); const before = instance.snapshot(); const stopped = instance.advance(1);
    expect(stopped).toMatchObject({ error: 'capacity', advancedTicks: 0, stopped: { kind: 'capacity' }, stamp: before.stamp });
    expect(advanceCapacityLimitedTicksV10(world, 1).stopped?.kind).toBe('capacity');
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: true })).toMatchObject({ error: 'capacity', changed: false,
      stopped: stopped.stopped, stamp: before.stamp });
    expect(instance.replace({})).toMatchObject({ error: 'invalid-source', stopped: stopped.stopped, stamp: before.stamp });
    expect(snapshot(instance)).toEqual(before.world);
    expect(instance.command(cancelPlan(world))).toMatchObject({ published: true, stopped: null, result: { status: 'accepted' } });
    expect(snapshot(instance).sectExpansion.construction.blueprints[0]!.status).toBe('cancelled');
  }, 30000);
  it('publishes exactly the genuine same-source fallback after normal optional growth is refused', () => {
    let world = records();
    world = prepared(world, command(world, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'owner.optional.plan'));
    world = prepared(world, command(world, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'owner.optional.enable'));
    world = atWireCost(world, SAVE_FILE_LIMIT_BYTES - 100); const original = cloneJson(world);
    const fallback = simulation.prepareNoOptionalGrowthTickCandidateV10(world);
    expect(assess(fallback).fits).toBe(true); expect(assess(prepareNormalTickCandidateV10(world)).fits).toBe(false);
    const instance = runtime(world); expect(instance.advance(1)).toMatchObject({ ok: true, advancedTicks: 1, stopped: null,
      stamp: { generation: 1, publication: 1 }, metrics: { normalCandidates: 1, noOptionalCandidates: 0, candidateChecks: 1,
        ownedCaptures: 1, ownedNormalAttempts: 1, ownedNoOptionalAttempts: 1, ownedTicks: 1 } });
    expect(snapshot(instance)).toEqual(fallback); expect(world).toEqual(original);
    expect(snapshot(instance).automaticProduction.nextCycle).toBe(1); expect(snapshot(instance).sectEconomy.enabled).toBe(true);
  }, 30000);
  it('retains an earlier accepted tick when the next real candidate reaches numeric exhaustion', () => {
    // Explicit valid counter-pressure source with no outstanding construction
    // owner/cancellation reserve. Both boundary checks are real assessments;
    // neither costs nor a fixed gate are mocked or supplied by the caller.
    const source = records(); const world: WorldStateV10 = { ...source, sectExpansion: { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(assess(world)).toMatchObject({ supported: true, fits: true });
    const expected = prepareNormalTickCandidateV10(world);
    expect(assess(expected)).toMatchObject({ supported: true, fits: true });
    expect(expected.sectExpansion.construction.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => prepareNormalTickCandidateV10(expected)).toThrow();
    expect(() => simulation.prepareNoOptionalGrowthTickCandidateV10(expected)).toThrow();
    const oracle = advanceCapacityLimitedTicksV10(world, 2); expect(oracle.world).toEqual(expected);
    expect(oracle.stopped?.kind).toBe('invalid-records');
    const instance = runtime(world); const result = instance.advance(2);
    expect(result).toMatchObject({ error: 'internal-failure', advancedTicks: 1, stamp: { generation: 1, publication: 1 },
      stopped: { kind: 'invalid-records' } });
    expect(snapshot(instance)).toEqual(expected); expect(snapshot(instance).clock.simulationTick).toBe(1);
    expect(world.clock.simulationTick).toBe(0); expect(world.sectExpansion.construction.revision).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
  it('close releases access without cancelling work or changing previously detached snapshots', () => {
    let world = records(); world = prepared(world, command(world, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'close.work'));
    const instance = runtime(world); const before = snapshot(instance); const closed = instance.close();
    expect(closed).toMatchObject({ ok: true, stamp: { generation: 2, publication: 0 }, recoveryOnly: null });
    let reflections = 0; const input = new Proxy({}, { ownKeys() { reflections++; throw new Error('Closed input must not be read'); } });
    for (const result of [instance.close(), instance.advance(1), instance.command(input), instance.replace(input), instance.controlClock(input), instance.invalidate(), instance.snapshot()]) {
      expect(result).toMatchObject({ ok: false, error: 'closed', stamp: closed.stamp, recoveryOnly: null });
    }
    expect(reflections).toBe(0); expect(before.activeProductionTransactionIds).toHaveLength(1);
  });
  for (const steps of [-1, 0.5, Infinity, NaN, CAPACITY_LIMITED_V10_MAX_STEPS + 1, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid/excessive step count ${steps} without publication`, () => {
      const instance = runtime(); const before = instance.snapshot();
      expect(instance.advance(steps)).toMatchObject({ error: 'invalid-steps', advancedTicks: 0, stamp: before.stamp });
      expect(snapshot(instance)).toEqual(before.world);
    });
  }
});

describe('clock controls and hostile/private boundary isolation', () => {
  it('changes only speed or player/hidden pause, preserves all other pause order and canonical fields', () => {
    const source = records(); source.clock = { ...source.clock, pauseReasons: ['choice', 'player', 'danger'] };
    const instance = runtime(source); const before = snapshot(instance);
    expect(instance.controlClock({ kind: 'speed', speed: 3 })).toMatchObject({ ok: true, changed: true, stamp: { generation: 1, publication: 1 } });
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: false })).toMatchObject({ ok: true, changed: true });
    const current = snapshot(instance); expect(current.clock).toEqual({ ...before.clock, speed: 3, pauseReasons: ['choice', 'danger'] });
    expect({ ...current, clock: before.clock }).toEqual(before);
    expect(instance.controlClock({ kind: 'pause', reason: 'hidden', paused: true })).toMatchObject({ ok: true, changed: true });
    const paused = instance.snapshot(); expect(paused.world!.clock.pauseReasons).toEqual(['choice', 'danger', 'hidden']);
    expect(instance.advance(3)).toMatchObject({ advancedTicks: 0, stamp: paused.stamp });
    expect(instance.controlClock({ kind: 'pause', reason: 'hidden', paused: true })).toMatchObject({ changed: false, stamp: paused.stamp });
    for (const control of [{ kind: 'pause', reason: 'cultivation', paused: false }, { kind: 'speed', speed: 2 },
      { kind: 'speed', speed: 1, trusted: true }, { kind: 'pause', reason: 'player', paused: 1 }]) {
      expect(instance.controlClock(control)).toMatchObject({ error: 'invalid-control', changed: false, stamp: paused.stamp });
    }
    expect(snapshot(instance)).toEqual(paused.world);
  });
  it('fully validates frozen/foreign source data and never invokes accessors or reads thrown values', () => {
    const valid = records(); expect(createPrivateRuntimeV10(frozen(cloneJson(valid))).ok).toBe(true);
    let getters = 0; const accessor = Object.defineProperty(cloneJson(valid), 'seed', { enumerable: true, get() { getters++; return valid.seed; } });
    expect(createPrivateRuntimeV10(accessor)).toMatchObject({ ok: false, error: 'invalid-source' }); expect(getters).toBe(0);
    const shared = cloneJson(valid); shared.randomStreams.events = shared.randomStreams.economy;
    expect(createPrivateRuntimeV10(shared)).toMatchObject({ ok: false, error: 'invalid-source' });
    expect(createPrivateRuntimeV10({ ...valid, simulationVersion: '0.9.0' }).ok).toBe(false);
    const thrownReads: string[] = []; const thrown = new Proxy({}, { get(_target, key) { thrownReads.push(String(key)); throw null; },
      getPrototypeOf() { thrownReads.push('prototype'); throw null; } });
    const hostile = new Proxy(valid, { ownKeys() { throw thrown; } });
    expect(createPrivateRuntimeV10(hostile)).toMatchObject({ ok: false, error: 'invalid-source' });
    const instance = runtime(valid); const before = instance.snapshot();
    expect(instance.replace(hostile)).toMatchObject({ error: 'invalid-source', stamp: before.stamp });
    expect(instance.command(hostile)).toMatchObject({ error: 'invalid-command', stamp: before.stamp });
    expect(instance.controlClock(hostile)).toMatchObject({ error: 'invalid-control', stamp: before.stamp });
    expect(thrownReads).toEqual([]); expect(snapshot(instance)).toEqual(before.world);
  });
  it('rejects ordinary non-JSON, hidden descriptors, sparse arrays and revoked proxies at every source entrance', () => {
    const source = records(); const sparse = cloneJson(source); sparse.diagnostics = new Array(1);
    const hidden = Object.defineProperty(cloneJson(source), 'secret', { enumerable: false, value: 1 });
    const revocable = Proxy.revocable(source, {}); revocable.revoke();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const instance = runtime(source); const before = instance.snapshot();
    for (const malformed of [sparse, hidden, revocable.proxy, cyclic, new Date(), Infinity, { ...source, pendingCommands: [{}] }]) {
      expect(createPrivateRuntimeV10(malformed).ok).toBe(false); expect(instance.replace(malformed).ok).toBe(false);
      expect(snapshot(instance)).toEqual(before.world);
    }
  });
  it('guards every method before reentrant input reflection and ignores caller-controlled this', () => {
    const instance = runtime(); const before = instance.snapshot(); const nested: RuntimeOperationV10[] = []; let probes = 0;
    const dangerous = new Proxy({}, { ownKeys() { probes++; throw new Error('Nested argument inspected'); } });
    const input = new Proxy(discard(before.world!), { ownKeys(target) {
      nested.push(instance.advance(1), instance.command(dangerous), instance.replace(dangerous), instance.snapshot(),
        instance.close(), instance.invalidate(), instance.controlClock(dangerous)); return Reflect.ownKeys(target);
    } });
    const detachedCommand = instance.command;
    expect(detachedCommand.call(dangerous, input)).toMatchObject({ ok: true, published: true, stamp: { generation: 1, publication: 1 } });
    expect(nested).toHaveLength(7); for (const result of nested) expect(result).toMatchObject({ error: 'reentrant', stamp: before.stamp });
    expect(probes).toBe(0); expect(snapshot(instance).inventory.grain.owned).toBe(before.world!.inventory.grain.owned - 1);
  });
  it('captures root descriptor values before hostile sibling traps can introduce a getter, then validates the copy', () => {
    const source = records(); let getters = 0;
    const map = source.map; source.map = new Proxy(map, { ownKeys(target) {
      Object.defineProperty(source, 'seed', { enumerable: true, configurable: true, get() { getters++; throw null; } });
      return Reflect.ownKeys(target);
    } });
    const created = createPrivateRuntimeV10(source); expect(created.ok).toBe(true); expect(getters).toBe(0);
    if (!created.ok) throw new Error('Expected captured data'); expect(snapshot(created.instance).seed).toBe('private-v10-runtime');
  });
  it('keeps the last complete boundary when snapshot capture fails and never reads arbitrary exceptions', () => {
    const instance = runtime(); const before = instance.snapshot(); let reads = 0;
    const thrown = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
    injectedFailures.capture = () => { throw thrown; };
    try { expect(instance.snapshot()).toMatchObject({ error: 'snapshot-failed', world: null, stamp: before.stamp }); }
    finally { injectedFailures.capture = null; }
    expect(reads).toBe(0); expect(snapshot(instance)).toEqual(before.world); expect(instance.advance(1).advancedTicks).toBe(1);
  });
  it('contains hostile candidate errors and latches without publishing either attempted tick', () => {
    // A real planned owner excludes the scalar-idle path, so this specifically
    // exercises both strict preparation fault boundaries without a bypass flag.
    const instance = runtime(planned()); const before = instance.snapshot(); let reads = 0;
    const thrown = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
    injectedFailures.normal = () => { throw thrown; }; injectedFailures.fallback = () => { throw thrown; };
    try { expect(instance.advance(1)).toMatchObject({ error: 'internal-failure', advancedTicks: 0, stamp: before.stamp,
      stopped: { kind: 'invalid-records' }, metrics: { normalCandidates: 1, noOptionalCandidates: 1 } }); }
    finally { injectedFailures.normal = null; injectedFailures.fallback = null; }
    expect(reads).toBe(0); expect(snapshot(instance)).toEqual(before.world);
    expect(instance.advance(1).advancedTicks).toBe(0); expect(instance.replace(before.world)).toMatchObject({ ok: true, stopped: null });
    expect(instance.advance(1).advancedTicks).toBe(1);
  });
  it('rejects actual over-capacity data rather than labelling it recovery-only', () => {
    const world = records(); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const size = assess(world).current.wireBytes!;
    world.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 1 - size);
    expect(createPrivateRuntimeV10(world).ok).toBe(false);
    const instance = runtime(); const before = instance.snapshot(); expect(instance.replace(world).ok).toBe(false);
    expect(snapshot(instance)).toEqual(before.world);
  });
});

let oldMedicine: WorldStateV9; let halfUpgrade: WorldStateV10; let almostUpgrade: WorldStateV10;
describe('genuine sixth-owner upgrade snapshot continuation', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let n = 0; n < 4; n++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  }
  beforeAll(() => {
    let world = records(oldMedicine);
    world = prepared(world, sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'owner.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    world = until(world, value => !!value.sectExpansion.research.jobs.at(-1)!.terminal);
    world = prepared(world, sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'owner.upgrade',
      expectedRevision: world.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: world.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
    halfUpgrade = until(world, value => value.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
    almostUpgrade = until(halfUpgrade, value => value.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
  }, 120000);
  it('reconstructs a half-paid snapshot and cancels with exact refunds, retained work and idempotent receipts', () => {
    const original = runtime(halfUpgrade); const saved = snapshot(original); expect(original.close().ok).toBe(true);
    const instance = runtime(saved); const job = saved.sectExpansion.upgrade.jobs[0]!;
    const input = sect(saved, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'owner.upgrade.cancel',
      expectedRevision: saved.sectExpansion.upgrade.revision, jobId: job.jobId } });
    const oracle = dispatchCapacityLimitedCommandV10(saved, input); const result = instance.command(input);
    expect(result).toMatchObject({ ok: true, published: true, result: oracle.result }); const after = snapshot(instance); expect(after).toEqual(oracle.world);
    expect(after.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 200, terminal: { kind: 'cancelled', resultLevel: 1 } });
    expect(after.inventory.stone.owned).toBe(saved.inventory.stone.owned); expect(after.inventory.stone.reserved).toBe(saved.inventory.stone.reserved - 3);
    expect(after.inventory.plank.owned).toBe(saved.inventory.plank.owned); expect(after.inventory.plank.reserved).toBe(saved.inventory.plank.reserved - 3);
    expect(instance.command(input)).toMatchObject({ published: false, result: { status: 'accepted' }, stamp: result.stamp });
    const conflict = sect(after, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: input.commandId,
      expectedRevision: after.sectExpansion.upgrade.revision, jobId: 'sect-upgrade:999' } });
    expect(instance.command(conflict)).toMatchObject({ published: false, result: { rejection: { code: 'COMMAND_CONFLICT' } } });
    expect(snapshot(instance)).toEqual(after); expect(saved.sectExpansion.upgrade.jobs[0]!.terminal).toBeNull();
  });
  it('reconstructs work tick 399, publishes genuine completion once and preserves the immutable L1 construction history', () => {
    const first = runtime(almostUpgrade); const saved = snapshot(first); first.close(); const instance = runtime(saved);
    const oracle = advanceCapacityLimitedTicksV10(saved, 1); expect(instance.advance(1)).toMatchObject({ ok: true, advancedTicks: 1, stamp: { generation: 1, publication: 1 } });
    const completed = snapshot(instance); expect(completed).toEqual(oracle.world);
    expect(completed.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 400, terminal: { kind: 'completed', resultLevel: 2 } });
    expect(completed.sectExpansion.construction.buildings).toEqual(saved.sectExpansion.construction.buildings);
    const restored = runtime(completed); expect(restored.advance(1)).toMatchObject({ ok: true, advancedTicks: 1 });
    expect(snapshot(restored).sectExpansion.upgrade.jobs).toEqual(completed.sectExpansion.upgrade.jobs);
    expect(saved.sectExpansion.upgrade.jobs[0]!.terminal).toBeNull();
  });
});

const KNOWLEDGE = 'knowledge.private-v10-lesson';
let lessonCheckpoint: WorldStateV10; let lessonOrigin: WorldStateV10;
describe('genuine lesson snapshot continuation at both month boundaries', () => {
  it('starts from an explicit legal within-month initial condition and snapshots genuine first-month settlement', () => {
    const old = createUnregisteredWorldV9('owner-teaching');
    old.cultivation = createCultivationStateV3(old.cultivation.disciples.map((profile, index) => ({ ...profile,
      knowledge: index === 0 ? [{ knowledgeId: KNOWLEDGE, teacherId: null, teachingId: null }] : [] })));
    for (const stock of Object.values(old.inventory)) stock.owned = Math.min(80, stock.capacity);
    // Explicit phase-only fixture initial condition, with no prior work/history.
    // This is not claimed to be a two-month runtime trajectory from tick zero.
    old.clock = { ...old.clock, simulationTick: MONTH - 2, calendarTick: MONTH - 2 };
    const world = records(old); const instance = runtime(world); const id = 'owner.lesson.begin';
    const input = command(world, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: id,
      expectedRevision: world.cultivation.revision, discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: KNOWLEDGE } } }, id);
    expect(instance.command(input)).toMatchObject({ ok: true, published: true, result: { status: 'accepted' } });
    lessonOrigin = snapshot(instance); const oracle = advanceCapacityLimitedTicksV10(lessonOrigin, 2);
    expect(instance.advance(2)).toMatchObject({ ok: true, advancedTicks: 2, recoveryOnly: false, stopped: null });
    lessonCheckpoint = snapshot(instance); expect(lessonCheckpoint).toEqual(oracle.world);
    expect(lessonCheckpoint.cultivation.disciples[0]!.teaching).toMatchObject({ completedMonths: 1 });
    instance.close(); const restored = runtime(lessonCheckpoint); const expected = advanceCapacityLimitedTicksV10(lessonCheckpoint, 3);
    expect(restored.advance(3)).toMatchObject({ ok: true, advancedTicks: 3 });
    lessonCheckpoint = snapshot(restored); expect(lessonCheckpoint).toEqual(expected.world); restored.close();
    expect(lessonOrigin.cultivation.disciples[0]!.teaching!.completedMonths).toBe(0);
  }, 30000);
  it('prepares the genuine intervening ticks as fixture setup, then snapshots the final month and completes only once', () => {
    // Execute every intervening actual candidate as setup. The owner is tested on
    // short crossing/reconstruction segments; it is not a full-runtime timing run.
    const almost = until(lessonCheckpoint, world => world.clock.calendarTick === 2 * MONTH - 2);
    const first = runtime(almost); const saved = snapshot(first); first.close(); const restored = runtime(saved);
    const expected = advanceCapacityLimitedTicksV10(saved, 2);
    expect(restored.advance(2)).toMatchObject({ ok: true, advancedTicks: 2, recoveryOnly: false, stopped: null });
    const completed = snapshot(restored); expect(completed).toEqual(expected.world); expect(completed.clock.calendarTick).toBe(2 * MONTH);
    expect(completed.cultivation.disciples[0]!.teaching).toBeNull();
    const knowledge = completed.cultivation.disciples[1]!.knowledge.filter(row => row.knowledgeId === KNOWLEDGE);
    expect(knowledge).toHaveLength(1); expect(knowledge[0]!.teacherId).toBe('entity:1');
    expect(knowledge[0]!.teachingId).toBe(lessonOrigin.cultivation.disciples[0]!.teaching!.teachingId);
    restored.close(); const finished = runtime(completed);
    expect(finished.advance(1)).toMatchObject({ ok: true, advancedTicks: 1 });
    expect(snapshot(finished).cultivation.disciples[1]!.knowledge.filter(row => row.knowledgeId === KNOWLEDGE)).toHaveLength(1);
    expect(saved.cultivation.disciples[0]!.teaching).toMatchObject({ completedMonths: 1 }); finished.close();
  }, 120000);
});
