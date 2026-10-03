import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { recordAutomaticNotice } from '../../src/core/economy/automatic-production';
import { iterateArchivedCommandReceipts, lookupArchivedProduction, restoreHistoryArchive } from '../../src/core/history';
import { CALENDAR_TICKS_PER_MONTH as MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import * as tickPreparation from '../../src/core/kernel/simulation-v10';
import { prepareNormalTickCandidateV10 as normal, prepareNoOptionalGrowthTickCandidateV10 as noOptional } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import * as recordValidation from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import * as capacity from '../../src/core/world/management-capacity-v10';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 as strict, verifyCapacityLimitedCandidateV10 as verify } from '../../src/core/world/runtime-capacity-v10';
import * as dischargeRecords from '../../src/core/world/reserved-discharges-v10';
import { inspectReservedDischargeRecordsV10 } from '../../src/core/world/reserved-discharges-v10';
import { createOwnedTickPipelineV10, type OwnedTickBoundaryV10 } from '../../src/core/world/runtime-owned-ticks-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

// The constructor intentionally returns an admitted frozen snapshot. Tests that
// mutate explicit caller fixtures must detach, never weaken constructor ownership.
const fresh = (): WorldStateV10 => cloneJson(createUnregisteredWorldV10('actual-owned-v10'));
/** Record-only lift of genuine paid historical fixtures, never migration/codec
 * authority. Base funding is explicit in fundedRuntimeFixture; sect stock is earned. */
function records(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No L2 in old fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const next = prepareUnregisteredCommandCandidateV10(world, command);
  expect(next.result.status, JSON.stringify(next.result)).toBe('accepted'); return next.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
  return apply(world, { kind: 'sect.command', commandId: payload.command.commandId, sequence: 0,
    issuedTick: world.clock.simulationTick, payload });
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, maximum = 1600): WorldStateV10 {
  let next = world;
  for (let count = 0; count < maximum && !done(next); count++) next = normal(next);
  if (!done(next)) throw new Error('Actual fixed v10 fixture did not reach boundary'); return next;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function allFrozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(allFrozen);
}
function atWireCost(source: WorldStateV10, target: number): WorldStateV10 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const measured = assess(world); expect(measured.supported).toBe(true);
  const length = target - measured.costs.wireBytes!; expect(length).toBeGreaterThanOrEqual(0);
  world.diagnostics.at(-1)!.message = 'x'.repeat(length);
  expect(assess(world).costs.wireBytes).toBe(target); return world;
}
function automatic(source = fresh()): WorldStateV10 {
  let world = apply(source, { kind: 'sect-economy.command', commandId: 'owned.auto.plan', sequence: 0,
    issuedTick: source.clock.simulationTick, payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } });
  world = apply(world, { kind: 'sect-economy.command', commandId: 'owned.auto.enable', sequence: 0,
    issuedTick: world.clock.simulationTick, payload: { command: { kind: 'enabled.set', enabled: true } } });
  return world;
}
function exactNext(source: WorldStateV10, mode: 'normal' | 'no-optional-growth' = 'normal') {
  const before = canonicalStringify(source); const pipeline = createOwnedTickPipelineV10();
  const captured = pipeline.capture(source); expect(captured).not.toBeNull();
  expect(captured!.assessment).toEqual(assess(source));
  const next = mode === 'normal' ? pipeline.advanceNormal() : pipeline.advanceNoOptional(); expect(next).not.toBeNull();
  const expected = mode === 'normal' ? normal(source) : noOptional(source);
  expect(verify(source, expected)).toMatchObject({ ok: true, reason: 'ordinary' });
  expect(next!.world).toEqual(expected); expect(next!.assessment).toEqual(assess(expected));
  if (mode === 'normal') { const result = strict(source, 1); expect(result.stopped).toBeNull(); expect(next!.world).toEqual(result.world); }
  expect(next!.diagnostic).toEqual({ kind: 'owned-v10-actual-tick', preparation: mode,
    sourceSimulationTick: source.clock.simulationTick, simulationTick: source.clock.simulationTick + 1 });
  expect(allFrozen(next)).toBe(true); expect(canonicalStringify(source)).toBe(before);
  return { pipeline, captured: captured!, next: next! };
}

describe('per-owner actual fixed-v10 tick pipeline', () => {
  it('fully captures once and executes one actual reducer plus one complete query per step', () => {
    const source = fresh(); const pipeline = createOwnedTickPipelineV10();
    const query = vi.spyOn(capacity, 'assessManagementCapacityV10');
    const prepare = vi.spyOn(tickPreparation, 'prepareOwnedNormalTickStagesV10');
    const fallback = vi.spyOn(tickPreparation, 'prepareOwnedNoOptionalGrowthTickStagesV10');
    const publicNormal = vi.spyOn(tickPreparation, 'prepareNormalTickCandidateV10');
    const publicFallback = vi.spyOn(tickPreparation, 'prepareNoOptionalGrowthTickCandidateV10');
    const records = vi.spyOn(dischargeRecords, 'inspectReservedDischargeRecordsV10');
    const captured = pipeline.capture(source); expect(captured).not.toBeNull(); expect(query).toHaveBeenCalledTimes(1);
    const next = pipeline.advanceNormal(); expect(next).not.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledWith(captured!.world);
    expect(query).toHaveBeenCalledTimes(2); expect(fallback).not.toHaveBeenCalled();
    expect(records).toHaveBeenCalledTimes(1); expect(records).toHaveBeenCalledWith(captured!.world, next!.world);
    expect(pipeline.advanceNoOptional()).not.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(next!.world); expect(query).toHaveBeenCalledTimes(3);
    expect(records).toHaveBeenCalledTimes(2);
    expect(publicNormal).not.toHaveBeenCalled(); expect(publicFallback).not.toHaveBeenCalled();
  });
  it('matches real active gathering on consecutive exact immutable boundaries', () => {
    const source = sect(fresh(), { domain: 'production', command: { kind: 'production.start', commandId: 'owned.gather',
      expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2' } });
    const { pipeline, next } = exactNext(source); let previous = next;
    for (let tick = 0; tick < 5; tick++) {
      const oracle = strict(previous.world, 1); const actual = pipeline.advanceNormal()!;
      expect(oracle.stopped).toBeNull(); expect(actual.world).toEqual(oracle.world);
      expect(actual.assessment).toEqual(assess(oracle.world)); expect(allFrozen(actual)).toBe(true);
      previous = actual;
    }
    expect(source.clock.simulationTick).toBe(0); expect(Object.isFrozen(source)).toBe(false);
  });
  it('executes actual legacy manual and automatic work without manufacturing an idle carry', () => {
    const source = fresh(); const manual = apply(source, { kind: 'production.start', commandId: 'owned.legacy', sequence: 0,
      issuedTick: 0, payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    exactNext(manual); const result = exactNext(automatic()).next;
    expect(result.world.activeProductionTransactionIds).toHaveLength(1);
    expect(result.assessment.scope).toBe('v10-immediate-recovery-and-record-peaks');
    expect(result.assessment.fullyFundedContinuation).toBe(false);
  });
  it('detaches foreign frozen snapshots and cannot inject candidates, assessments, callbacks or this', () => {
    const first = createOwnedTickPipelineV10(); const second = createOwnedTickPipelineV10(); const source = fresh();
    const original = first.capture(source)!; const foreign = second.capture(original.world)!;
    expect(foreign.world).toEqual(original.world); expect(foreign.world).not.toBe(original.world);
    expect(foreign.world.history).not.toBe(original.world.history); expect(foreign.assessment).not.toBe(original.assessment);
    const forged = freeze({ ...cloneJson(original.world), seed: 'foreign-candidate' });
    let called = 0; const injected = (): WorldStateV10 => { called++; return forged; };
    const next = Reflect.apply(first.advanceNormal, { root: forged }, [forged, foreign.assessment, true, injected]) as OwnedTickBoundaryV10;
    expect(next.world).toEqual(normal(source)); expect(called).toBe(0);
    const other = Reflect.apply(second.advanceNoOptional, first, [next.world, injected]) as OwnedTickBoundaryV10;
    expect(other.world).toEqual(noOptional(source)); expect(called).toBe(0);
    first.clear(); expect(first.advanceNormal()).toBeNull(); expect(first.advanceNoOptional()).toBeNull();
    expect(second.advanceNormal()!.world.clock.simulationTick).toBe(2);
  });
  it('returns deeply frozen data while caller edits and copied diagnostics confer no authority', () => {
    const source = fresh(); const pipeline = createOwnedTickPipelineV10(); const captured = pipeline.capture(source)!;
    const before = cloneJson(source); source.inventory.wood.owned++; source.randomStreams.events.state = 99;
    expect(Object.isFrozen(source.inventory.wood)).toBe(false);
    expect(() => { captured.world.inventory.wood.owned++; }).toThrow();
    expect(() => { captured.assessment.current.wireBytes = 0; }).toThrow();
    expect(() => { captured.assessment.deficits.push({ dimension: 'wireBytes', current: 0, reserved: 0, cost: 0, limit: 0, excess: 0 }); }).toThrow();
    expect(() => { captured.assessment.fits = false; }).toThrow();
    const diagnostic = cloneJson(captured.assessment); diagnostic.fits = true; diagnostic.current.wireBytes = 0;
    const result = Reflect.apply(pipeline.advanceNormal, null, [diagnostic]) as OwnedTickBoundaryV10;
    expect(result.world).toEqual(normal(before)); expect(result.assessment).toEqual(assess(result.world));
    expect(allFrozen(result)).toBe(true);
  });
  it('rejects getters, shared references and malformed frozen input without inspecting hostile exceptions', () => {
    const pipeline = createOwnedTickPipelineV10(); let reads = 0;
    const getter = Object.defineProperty(cloneJson(fresh()), 'seed', { enumerable: true, get() { reads++; throw null; } });
    expect(pipeline.capture(getter)).toBeNull(); expect(reads).toBe(0);
    const source = fresh(); const repeated = { ...source, diagnostics: [source.clock, source.clock] };
    expect(pipeline.capture(repeated)).toBeNull();
    expect(pipeline.capture(source)).not.toBeNull();
    expect(pipeline.capture(freeze({ ...source, runtimeProtocol: 'foreign' }))).toBeNull();
    expect(pipeline.advanceNormal()).toBeNull();
    const thrown = Object.defineProperty({}, 'message', { get() { reads++; return 'untrusted'; } });
    expect(pipeline.capture(new Proxy({}, { ownKeys() { throw thrown; } }))).toBeNull(); expect(reads).toBe(0);
  });
  it('blocks reentrant reflection before nested capture, advance or clear changes state', () => {
    const pipeline = createOwnedTickPipelineV10(); let probes = 0;
    const hostile = new Proxy({}, { ownKeys() { probes++; throw null; } });
    const source = fresh(); const proxy = new Proxy(source, { ownKeys(target) {
      expect(pipeline.capture(hostile)).toBeNull(); expect(pipeline.advanceNormal()).toBeNull();
      expect(pipeline.advanceNoOptional()).toBeNull(); pipeline.clear(); return Reflect.ownKeys(target);
    } });
    expect(pipeline.capture(proxy)).not.toBeNull(); expect(probes).toBe(0);
    expect(pipeline.advanceNormal()!.world).toEqual(normal(source));
  });
  it('preserves both pause reasons and refuses persisted commands without executing them', () => {
    const source = fresh(); source.clock = setPauseReason(setPauseReason(source.clock, 'player', true), 'hidden', true);
    const pipeline = createOwnedTickPipelineV10(); const captured = pipeline.capture(source)!;
    expect(captured).not.toBeNull(); expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
    expect(captured.world.clock.pauseReasons).toEqual(['player', 'hidden']);
    const queued = fresh(); queued.pendingCommands.push({ kind: 'production.start', commandId: 'owned.queued', sequence: 0,
      issuedTick: 0, payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    expect(pipeline.capture(queued)).toBeNull(); expect(pipeline.advanceNormal()).toBeNull();
    expect(queued.activeProductionTransactionIds).toEqual([]);
  });
  it('excludes genuine fully fitting teaching sources rather than claiming a finite continuation', () => {
    const source = fresh(); const knowledgeId = 'knowledge.owned-ticks';
    source.cultivation = createCultivationStateV3(source.cultivation.disciples.map((profile, index) => ({ ...profile,
      knowledge: index === 0 ? [{ knowledgeId, teacherId: null, teachingId: null }] : [] })));
    const taught = apply(source, { kind: 'cultivation.command', commandId: 'owned.lesson', sequence: 0, issuedTick: 0,
      payload: { command: { kind: 'teaching.begin', commandId: 'owned.lesson', expectedRevision: source.cultivation.revision,
        discipleId: 'entity:1', studentId: 'entity:2', knowledgeId } } });
    expect(assess(taught)).toMatchObject({ supported: true, fits: true });
    const pipeline = createOwnedTickPipelineV10(); expect(pipeline.capture(taught)).toBeNull();
    expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
    expect(strict(taught, 1).stopped).toBeNull();
  }, 30000);
  it('retries no-optional growth from exactly the pre-failure boundary', () => {
    const source = atWireCost(automatic(), SAVE_FILE_LIMIT_BYTES - 100); const before = canonicalStringify(source);
    expect(assess(normal(source)).fits).toBe(false); expect(assess(noOptional(source)).fits).toBe(true);
    const pipeline = createOwnedTickPipelineV10(); const captured = pipeline.capture(source)!;
    expect(captured).not.toBeNull(); expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNormal()).toBeNull();
    expect(canonicalStringify(captured.world)).toBe(before); expect(captured.world.randomStreams).toEqual(source.randomStreams);
    const result = pipeline.advanceNoOptional()!; expect(result).not.toBeNull();
    expect(result.world).toEqual(noOptional(source)); expect(result.world).toEqual(strict(source, 1).world);
    expect(result.assessment).toEqual(assess(result.world));
    expect(result.world.sectEconomy).toEqual(source.sectEconomy); expect(result.world.automaticProduction).toEqual(source.automaticProduction);
    expect(canonicalStringify(source)).toBe(before);
  }, 60000);
  it('retains all state and RNG when both actual candidates exceed a future counter', () => {
    const source = fresh(); source.sectExpansion = { ...source.sectExpansion, construction: {
      ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER } };
    expect(assess(source)).toMatchObject({ supported: true, actualFits: true, fits: true });
    const pipeline = createOwnedTickPipelineV10(); const captured = pipeline.capture(source)!; const before = canonicalStringify(captured);
    expect(captured).not.toBeNull();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
      expect(canonicalStringify(captured)).toBe(before);
    }
    expect(captured.world).toEqual(source); expect(strict(source, 1).world).toEqual(source);
  }, 30000);
  it('rejects source future deficits and current hard limits even when wire data itself fits', () => {
    const source = atWireCost(fresh(), SAVE_FILE_LIMIT_BYTES + 1);
    expect(assess(source)).toMatchObject({ supported: true, actualFits: true, fits: false });
    const pipeline = createOwnedTickPipelineV10(); expect(pipeline.capture(source)).toBeNull();
    // Exceed the actual envelope independently of its (large) future reserve.
    const actualLimit = cloneJson(source); actualLimit.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 1);
    expect(assess(actualLimit).actualFits).toBe(false); expect(pipeline.capture(actualLimit)).toBeNull();
    expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
  }, 60000);
  it('keeps unsupported or unbounded obligations in strict fallback', () => {
    const source = fresh(); const malformed = cloneJson(source);
    malformed.cultivation.disciples[0]!.activityOwner = { kind: 'unknown', id: 'unbounded' } as never;
    expect(assess(malformed).supported).toBe(false); expect(createOwnedTickPipelineV10().capture(malformed)).toBeNull();
  });
});

describe('unchanged strict wrapper boundary around shared raw stages', () => {
  it('still runs complete source and candidate root inspection in both public preparations', () => {
    const source = fresh(); const paused = { ...source, clock: setPauseReason(source.clock, 'player', true) };
    const inspect = vi.spyOn(recordValidation, 'inspectUnregisteredWorldV10Records');
    for (const prepare of [normal, noOptional]) {
      inspect.mockClear(); const candidate = prepare(source);
      expect(inspect).toHaveBeenCalledTimes(2); expect(inspect.mock.calls[0]![0]).toEqual(source);
      expect(inspect.mock.calls[1]![0]).toBe(candidate);
      inspect.mockClear(); expect(prepare(paused)).toBe(paused); expect(inspect).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['normal', 'no-optional-growth'] as const)('keeps the %s wrapper detached and exact against the owned stage pipeline', mode => {
    const source = automatic(); const before = canonicalStringify(source);
    const prepare = mode === 'normal' ? normal : noOptional;
    const candidate = prepare(source); const { next } = exactNext(source, mode);
    expect(candidate).toEqual(next.world); expect(candidate).not.toBe(source);
    expect(candidate.inventory).not.toBe(source.inventory); expect(candidate.history).not.toBe(source.history);
    expect(inspectUnregisteredWorldV10Records(candidate)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
    candidate.inventory.wood.owned++; expect(source.inventory.wood.owned).not.toBe(candidate.inventory.wood.owned);
  });
  it.each(['normal', 'no-optional-growth'] as const)('validates before returning exact original paused identity in the %s wrapper', mode => {
    const prepare = mode === 'normal' ? normal : noOptional;
    const source = fresh(); source.clock = setPauseReason(setPauseReason(source.clock, 'player', true), 'hidden', true);
    const before = canonicalStringify(source); expect(prepare(source)).toBe(source);
    const frozen = freeze(cloneJson(source)); expect(prepare(frozen)).toBe(frozen);
    const invalid = cloneJson(source); invalid.inventory.wood.reserved = 1;
    expect(() => prepare(invalid)).toThrow(); expect(canonicalStringify(source)).toBe(before);
    const queued = cloneJson(source); queued.pendingCommands.push({ kind: 'inventory.discard', commandId: 'paused.invalid.queue',
      sequence: 0, issuedTick: 0, payload: { resourceId: 'grain', quantity: 1 } });
    expect(() => prepare(queued)).toThrow();
  });
  it.each(['normal', 'no-optional-growth'] as const)('still rejects hostile descriptors/aliases and frozen corruption in the %s wrapper', mode => {
    const prepare = mode === 'normal' ? normal : noOptional; const source = fresh(); let reads = 0;
    const hostile = Object.defineProperty(cloneJson(source), 'clock', { enumerable: true, get() { reads++; throw null; } });
    expect(() => prepare(hostile)).toThrow(); expect(reads).toBe(0);
    const alias = cloneJson(source); alias.disciples[1]!.position = alias.disciples[0]!.position;
    expect(() => prepare(alias)).toThrow();
    const invalid = freeze({ ...source, runtimeProtocol: 'forged-frozen-source' }) as unknown as WorldStateV10;
    expect(() => Reflect.apply(prepare, null, [invalid, true, assess(source), () => source])).toThrow();
    const thrown = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
    const proxy = new Proxy({}, { ownKeys() { throw thrown; } }) as WorldStateV10;
    // Catch directly: a test assertion's thrown-value formatter may inspect the
    // hostile object, whereas the real wrapper must simply propagate it unchanged.
    let caught: unknown = null; try { prepare(proxy); } catch (error) { caught = error; }
    expect(caught).toBe(thrown); expect(reads).toBe(0);
  });
  it('preserves strict arithmetic failure while the owned factory retains its complete source', () => {
    const source = fresh(); source.sectExpansion = { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER } };
    const before = canonicalStringify(source); expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    for (const prepare of [normal, noOptional]) expect(() => prepare(source)).toThrow();
    const pipeline = createOwnedTickPipelineV10(); const captured = pipeline.capture(source)!;
    expect(captured).not.toBeNull(); expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
    expect(canonicalStringify(captured.world)).toBe(before); expect(canonicalStringify(source)).toBe(before);
  });
  it('restores its actual captured archive and appends genuine completion with old receipts intact', () => {
    let source = fresh();
    for (let index = 0; index < 66; index++) source = apply(source, { kind: 'sect-economy.command', commandId: `owned.archive.${index}`,
      sequence: 0, issuedTick: source.clock.simulationTick, payload: { command: { kind: 'enabled.set', enabled: false } } });
    source = apply(source, { kind: 'production.start', commandId: 'owned.archive.production', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    const id = source.activeProductionTransactionIds[0]!;
    source = until(source, world => world.transactions[id]!.phase === 'AwaitingDelivery');
    const wireSource = freeze(cloneJson(source)); const oldReceipts = [...iterateArchivedCommandReceipts(wireSource.history)];
    expect(oldReceipts.length).toBeGreaterThan(0);
    const { pipeline, captured, next } = exactNext(wireSource);
    // A merely frozen foreign archive must be newly authenticated; the actual
    // retained objects, rather than a validator's throwaway copy, are indexed.
    expect(restoreHistoryArchive(wireSource.history)).not.toBe(wireSource.history);
    expect(restoreHistoryArchive(captured.world.history)).toBe(captured.world.history);
    expect(restoreHistoryArchive(next.world.history)).toBe(next.world.history);
    expect(next.world.history.production.count).toBe(wireSource.history.production.count + 1);
    expect(lookupArchivedProduction(next.world.history, id)?.transaction.state).toBe('Committed');
    expect([...iterateArchivedCommandReceipts(next.world.history)]).toEqual(oldReceipts);
    const following = pipeline.advanceNoOptional()!;
    expect(following.world).toEqual(noOptional(next.world));
    expect(restoreHistoryArchive(following.world.history)).toBe(following.world.history);
    expect(lookupArchivedProduction(following.world.history, id)).toEqual(lookupArchivedProduction(next.world.history, id));
    const corrupt = cloneJson(next.world); corrupt.history = { ...corrupt.history,
      production: { ...corrupt.history.production, count: corrupt.history.production.count + 1 } };
    freeze(corrupt); expect(createOwnedTickPipelineV10().capture(corrupt)).toBeNull();
    expect(() => normal(corrupt)).toThrow(); expect(() => noOptional(corrupt)).toThrow();
  }, 60000);
});

describe('public supplied-candidate gate remains strict', () => {
  it('does not turn residual record diagnostics into execution or candidate admission authority', () => {
    const source = fresh(); const forged = normal(source); forged.inventory.wood.owned++;
    const records = inspectReservedDischargeRecordsV10(source, forged);
    expect(records).toEqual({ scope: 'v10-cross-boundary-records-only', issues: [], discharged: [] });
    expect(records).not.toHaveProperty('supported'); expect(records).not.toHaveProperty('admitted');
    expect(Reflect.apply(verify, null, [source, forged, records])).toMatchObject({ ok: false, reason: 'unsupported-transition' });
    const pipeline = createOwnedTickPipelineV10(); pipeline.capture(source);
    const next = Reflect.apply(pipeline.advanceNormal, null, [forged, records]) as OwnedTickBoundaryV10;
    expect(next.world).toEqual(normal(source)); expect(next.world).not.toEqual(forged);
  });
  it.each(['inventory', 'rng-state', 'rng-draws', 'diagnostic', 'speed'] as const)('rejects a root-valid fitting %s splice into an actual tick', kind => {
    const source = fresh(); const real = exactNext(source).next; const forged = cloneJson(real.world);
    if (kind === 'inventory') forged.inventory.wood.owned++;
    if (kind === 'rng-state') forged.randomStreams.events.state = (forged.randomStreams.events.state + 1) >>> 0;
    if (kind === 'rng-draws') forged.randomStreams.events.draws++;
    if (kind === 'diagnostic') forged.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: forged.clock.simulationTick, message: 'splice' });
    if (kind === 'speed') forged.clock.speed = 3;
    expect(assess(forged)).toMatchObject({ supported: true, fits: true });
    expect(verify(source, forged)).toMatchObject({ ok: false, reason: 'unsupported-transition', discharged: [] });
    const forgedDecision = Reflect.apply(verify, null, [source, forged, real.assessment, real.diagnostic, true]);
    expect(forgedDecision).toMatchObject({ ok: false, reason: 'unsupported-transition', discharged: [] });
  });
  it('rejects an unrelated fitting root and authentic work spliced from a different source', () => {
    const source = fresh(); const other = fresh(); other.inventory.wood.owned++;
    const foreign = exactNext(other).next;
    expect(verify(source, other)).toMatchObject({ ok: false, reason: 'unsupported-transition' });
    expect(verify(source, foreign.world)).toMatchObject({ ok: false, reason: 'unsupported-transition' });
  });
  it('still rejects root-valid unpaid automatic retirement despite a genuine owned tick', () => {
    const source = normal(automatic()); const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`;
    const pair = source.automaticProduction.live[id]!; expect(pair).toBeDefined();
    let forged = cloneJson(exactNext(source).next.world); delete forged.automaticProduction.live[id];
    forged.activeProductionTransactionIds = [];
    forged.disciples = forged.disciples.map(actor => actor.assignmentTransactionId === id ? { ...actor, assignmentTransactionId: null, traveling: false } : actor);
    forged.buildings = forged.buildings.map(site => site.stationTransactionId === id ? { ...site, stationTransactionId: null } : site);
    for (const line of pair.reservation.lines) forged.inventory[line.resourceId].reserved -= line.quantity;
    forged = recordAutomaticNotice(forged, { cycle: pair.transaction.origin.cycle, workerId: pair.transaction.workerId,
      recipeId: pair.transaction.recipeId, kind: 'committed', reason: null });
    expect(assess(forged)).toMatchObject({ supported: true, fits: true });
    expect(verify(source, forged)).toMatchObject({ ok: false, reason: 'unsupported-transition', discharged: [] });
  });
});

let oldMedicine: WorldStateV9; let researching: WorldStateV10; let researchLast: WorldStateV10; let ready: WorldStateV10;
let started: WorldStateV10; let beforeHalf: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10; let completed: WorldStateV10;
let powder: WorldStateV10; let delivered: WorldStateV10; let care: WorldStateV10; let careLast: WorldStateV10; let maintenanceDue: WorldStateV10;
describe('genuine research, L2 upgrade, care and ordered boundary differentials', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let index = 0; index < 4; index++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  }
  beforeAll(() => {
    const source = records(oldMedicine);
    researching = sect(source, { domain: 'research', command: { kind: 'research.start', commandId: 'owned.herbal',
      expectedRevision: source.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } });
    researchLast = until(researching, world => world.sectExpansion.research.jobs.at(-1)!.activeTicks === 399);
    ready = normal(researchLast);
    started = sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'owned.upgrade',
      expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } });
    beforeHalf = until(started, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 199);
    half = normal(beforeHalf); almost = until(half, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
    completed = normal(almost);
  }, 180000);
  beforeAll(() => {
    powder = sect(completed, { domain: 'production', command: { kind: 'production.start', commandId: 'owned.alternative',
      expectedRevision: completed.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' } });
    delivered = until(powder, world => world.sectExpansion.production.jobs.at(-1)!.terminal !== null);
    care = sect(delivered, { domain: 'care', command: { kind: 'care.start', commandId: 'owned.care',
      expectedRevision: delivered.sectExpansion.care.revision, patientId: 'entity:4' } });
    careLast = until(care, world => world.sectExpansion.care.jobs.at(-1)!.activeTicks === 39);
    const l2Paid = until(completed, world => world.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2));
    const payment = l2Paid.sectExpansion.maintenance.payments.findLast(value => value.rate?.level === 2)!;
    maintenanceDue = until(l2Paid, world => world.clock.calendarTick === payment.dueCalendarTick - 1);
  }, 180000);
  it.each(['research', 'research-final', 'upgrade-start', 'upgrade-199', 'upgrade-399', 'L2-production', 'care', 'care-final'] as const)(
    'matches the exact public oracle on actual %s work', kind => {
      const source = kind === 'research' ? researching : kind === 'research-final' ? researchLast : kind === 'upgrade-start' ? started
        : kind === 'upgrade-199' ? beforeHalf : kind === 'upgrade-399' ? almost : kind === 'L2-production' ? powder : kind === 'care' ? care : careLast;
      const { next } = exactNext(source);
      if (kind === 'upgrade-199') { expect(next.world).toEqual(half); expect(next.world.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(1); }
      if (kind === 'upgrade-399') { expect(next.world).toEqual(completed); expect(next.world.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'completed', resultLevel: 2 }); }
      if (kind === 'L2-production') expect(next.world.sectExpansion.production.jobs.at(-1)!.productiveSite).toMatchObject({ level: 2,
        upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId });
      if (kind === 'care-final') expect(next.world.sectExpansion.care.jobs.at(-1)!.terminal?.kind).toBe('completed');
    }, 30000);
  it('executes the actual funded no-optional checkpoint and final upgrade work', () => {
    expect(exactNext(beforeHalf, 'no-optional-growth').next.world).toEqual(noOptional(beforeHalf));
    expect(exactNext(almost, 'no-optional-growth').next.world.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
  }, 30000);
  it('retains exact L2 payment rates and omits renewal only in the real no-optional reducer', () => {
    const source = maintenanceDue; const paid = exactNext(source).next;
    const skipped = exactNext(source, 'no-optional-growth').next;
    expect(paid.world.sectExpansion.maintenance.payments.length).toBeGreaterThan(source.sectExpansion.maintenance.payments.length);
    expect(paid.world.sectExpansion.maintenance.payments.at(-1)!.rate).toMatchObject({ level: 2 });
    expect(skipped.world.sectExpansion.maintenance).toEqual(source.sectExpansion.maintenance);
    expect(skipped.world.sectEconomy).toEqual(source.sectEconomy);
  }, 30000);
  it('reconciles month/death before upgrade completion and before any maintenance/work', () => {
    const source = cloneJson(almost); const target = Math.ceil((source.clock.calendarTick + 1) / MONTH) * MONTH;
    // Explicit validated near-lifespan boundary. Paid histories remain unchanged;
    // this fixture does not pretend to have simulated the skipped idle interval.
    source.clock.simulationTick = target - 1; source.clock.calendarTick = target - 1;
    const actor = source.disciples.find(member => member.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * MONTH;
    actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const { next, pipeline } = exactNext(source); const death = next.world.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    expect(next.world.cultivationClock.transitions.at(-1)).toMatchObject({ kind: 'month', tick: target });
    expect(next.world.clock.pauseReasons).toContain('cultivation');
    expect(next.world.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 399,
      terminal: { kind: 'cancelled', cancellation: { kind: 'death', deathId: death.deathId } } });
    expect(next.world.sectExpansion.maintenance).toEqual(source.sectExpansion.maintenance);
    expect(next.world.sectExpansion.production).toEqual(source.sectExpansion.production);
    expect(pipeline.advanceNormal()).toBeNull(); expect(pipeline.advanceNoOptional()).toBeNull();
  }, 30000);
  it('keeps genuine reserved-recovery completion exclusively on the unchanged strict path', () => {
    const source = atWireCost(almost, SAVE_FILE_LIMIT_BYTES + 200_000);
    expect(assess(source)).toMatchObject({ supported: true, actualFits: true, fits: false });
    const pipeline = createOwnedTickPipelineV10(); expect(pipeline.capture(source)).toBeNull(); expect(pipeline.advanceNormal()).toBeNull();
    const result = strict(source, 1); expect(result.stopped).toBeNull();
    expect(verify(source, result.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    expect(result.world.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
  }, 60000);
  it('still rejects a genuine fitting upgrade cancellation with unrelated resource or RNG edits', () => {
    const source = half; const actual = sect(source, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'owned.cancel',
      expectedRevision: source.sectExpansion.upgrade.revision, jobId: source.sectExpansion.upgrade.jobs[0]!.jobId } });
    expect(verify(source, actual)).toMatchObject({ ok: true, reason: 'ordinary' });
    const forged = cloneJson(actual); forged.inventory.wood.owned++; forged.randomStreams.events.state = (forged.randomStreams.events.state + 1) >>> 0;
    expect(assess(forged)).toMatchObject({ supported: true, fits: true });
    expect(verify(source, forged)).toMatchObject({ ok: false, reason: 'unsupported-transition', discharged: [] });
  }, 30000);
});

describe('exact natural clock transitions', () => {
  it('executes a real month row with ordinary lifecycle capacity freshly assessed', () => {
    const source = records(fundedRuntimeFixture()); source.clock.simulationTick = MONTH - 1; source.clock.calendarTick = MONTH - 1;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const { next } = exactNext(source); expect(next.world.cultivationClock.transitions.at(-1)).toMatchObject({ kind: 'month', tick: MONTH });
  });
});
