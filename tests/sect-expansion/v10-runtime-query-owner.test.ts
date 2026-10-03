import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { advanceCapacityLimitedTicksV10 } from '../../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10 } from '../../src/core/world/runtime-instance-v10';
import { RUNTIME_VIEW_LIMITS_V10, type RuntimeReadV10, type RuntimeReadonlyV10 } from '../../src/core/world/runtime-view-types-v10';
import * as views from '../../src/core/world/runtime-views-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Plain forwarding mocks deliberately do not inspect thrown values as a spy
 * wrapper might. Fault injection is test-only, never a runtime input port. */
const hooks = vi.hoisted(() => ({ captures: null as unknown[] | null, frameError: null as null | { thrown: unknown },
  cultivationError: null as null | { discipleId: string; thrown: unknown } }));
vi.mock('../../src/core/world/v10-sect-records', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/world/v10-sect-records')>();
  return { ...actual, captureV10RecordData(input: unknown): unknown {
    hooks.captures?.push(input); return actual.captureV10RecordData(input);
  } };
});
vi.mock('../../src/core/world/runtime-views-v10', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/world/runtime-views-v10')>();
  return { ...actual,
    projectRuntimeFrameV10(world: WorldStateV10) {
      if (hooks.frameError) throw hooks.frameError.thrown;
      return actual.projectRuntimeFrameV10(world);
    },
    projectRuntimeCultivationV10(world: WorldStateV10, discipleId: string | null) {
      if (hooks.cultivationError?.discipleId === discipleId) throw hooks.cultivationError.thrown;
      return actual.projectRuntimeCultivationV10(world, discipleId);
    },
  };
});
afterEach(() => { hooks.captures = null; hooks.frameError = null; hooks.cultivationError = null; vi.restoreAllMocks(); });

// The constructor returns a frozen valid root; this test entrance deliberately
// supplies ordinary mutable JSON to check that owner capture does not freeze it.
const fresh = (): WorldStateV10 => cloneJson(createUnregisteredWorldV10('v10-query-owner'));
const breakthrough = () => ({ discipleId: 'entity:2', preparation: { method: 'standard' as const, arraySupport: 0 as const } });
const placement = () => ({ definitionId: 'library.v9' as const, anchor: { x: 1, y: 1 }, rotation: 0 as const });
const upgrade = (world: WorldStateV10) => ({ buildingId: world.sectExpansion.construction.buildings
  .find(row => row.definitionId === 'alchemy.v9')?.buildingId ?? 'sect-building:1', workerId: 'entity:2' });
function runtime(world = fresh()): PrivateRuntimeInstanceV10 {
  const created = createPrivateRuntimeV10(world); expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error); return created.instance;
}
function value<T>(read: RuntimeReadV10<T>): RuntimeReadonlyV10<T> {
  expect(read.ok, read.error ?? '').toBe(true); if (!read.ok) throw new Error(read.error); return read.value;
}
function snapshot(instance: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = instance.snapshot(); expect(result.ok).toBe(true);
  if (!result.world) throw new Error('Missing explicit snapshot'); return result.world;
}
function frozenTree(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozenTree);
}
function dataKeys(value: unknown): string[] {
  return value === null || typeof value !== 'object' ? [] : Object.entries(value).flatMap(([key, child]) => [key, ...dataKeys(child)]);
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 {
  return { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload };
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const next = prepareUnregisteredCommandCandidateV10(world, command);
  expect(next.result.status, JSON.stringify(next.result)).toBe('accepted'); return next.world;
}
function training(world: WorldStateV10, commandId: string, mode: 'duty' | 'rest' = 'duty'): CommandV10 {
  return { kind: 'cultivation.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'training.set', commandId, expectedRevision: world.cultivation.revision, discipleId: 'entity:2', mode } } };
}
function assertLeaves(instance: PrivateRuntimeInstanceV10, world: WorldStateV10): void {
  expect(value(instance.frame())).toEqual(views.projectRuntimeFrameV10(world));
  expect(value(instance.cultivation('entity:2'))).toEqual(views.projectRuntimeCultivationV10(world, 'entity:2'));
  expect(value(instance.build('entity:2'))).toEqual(views.projectRuntimeBuildV10(world, 'entity:2'));
  expect(value(instance.expansion())).toEqual(views.projectRuntimeExpansionV10(world));
  expect(value(instance.previewBreakthrough(breakthrough()))).toEqual(views.projectRuntimeBreakthroughV10(world, breakthrough()));
  expect(value(instance.previewPlacement(placement()))).toEqual(views.projectRuntimePlacementV10(world, placement()));
  expect(value(instance.previewUpgrade(upgrade(world)))).toEqual(views.projectRuntimeUpgradeV10(world, upgrade(world)));
  expect(value(instance.nextApplicationCommand(0))).toEqual(views.nextRuntimeApplicationCommandV10(world, 0));
}
function allReads(instance: PrivateRuntimeInstanceV10, world: WorldStateV10) {
  return [instance.frame(), instance.cultivation('entity:2'), instance.build('entity:2'), instance.expansion(),
    instance.previewBreakthrough(breakthrough()), instance.previewPlacement(placement()), instance.previewUpgrade(upgrade(world)),
    instance.nextApplicationCommand(0)];
}

describe('fixed v10 queries through the actual private owner', () => {
  it('equals all eight fixed leaf projections without a cold World export or implicit source query', () => {
    const source = fresh(); const before = canonicalStringify(source); const instance = runtime(source);
    for (const stage of ['uncached', 'cached']) {
      hooks.captures = [];
      const reads = allReads(instance, source);
      for (const read of reads) {
        expect(read, stage).toMatchObject({ ok: true, error: null, stamp: { generation: 1, publication: 0 }, stopped: null,
          recoveryOnly: false, metrics: { sourceChecks: 0, candidateChecks: 0, exports: 0, fastTicks: 0 } });
        expect('world' in read, stage).toBe(false); expect(frozenTree(read), stage).toBe(true);
      }
      // Both the first projections and their repeated reads capture only query
      // arguments, with no private World or result descriptor traversal.
      expect(hooks.captures, stage).toHaveLength(8);
      expect(hooks.captures, stage).toEqual([null, 'entity:2', 'entity:2', null, breakthrough(), placement(), upgrade(source), 0]);
    }
    hooks.captures = null; assertLeaves(instance, source);
    expect(snapshot(instance)).toEqual(source); expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
  });
  it('deep-freezes detached outputs and accepts null/absent selections without freezing requests', () => {
    const source = fresh(); const instance = runtime(source); const before = canonicalStringify(source);
    const frame = value(instance.frame()); const build = value(instance.build('entity:2')); const request = placement();
    const preview = value(instance.previewPlacement(request));
    expect(frame.map).not.toBe(source.map); expect(frame.disciples[0]!.position).not.toBe(source.disciples[0]!.position);
    expect(Reflect.set(frame.disciples[0]!.position, 'x', 255)).toBe(false);
    expect(Reflect.set(build.selected!.loadout.equipment, 'weaponId', 'forged')).toBe(false);
    expect(Reflect.set(preview.request.anchor, 'x', 255)).toBe(false); expect(Object.isFrozen(request.anchor)).toBe(false);
    request.anchor.x = 9; expect(preview.request.anchor.x).toBe(1);
    expect(value(instance.build(null)).selected).toBeNull(); expect(value(instance.cultivation(null)).selected).toBeNull();
    expect(value(instance.build('entity:999')).selected).toBeNull(); expect(value(instance.cultivation('entity:999')).selected).toBeNull();
    expect(canonicalStringify(source)).toBe(before); expect(snapshot(instance)).toEqual(source);
  });
  it('uses exactly four fixed bounded slots, never an ID or preview-result registry', () => {
    const instance = runtime(); const frame = value(instance.frame()); const expansion = value(instance.expansion());
    const cultivation = value(instance.cultivation('entity:2')); const build = value(instance.build('entity:2'));
    expect(value(instance.frame())).toBe(frame); expect(value(instance.expansion())).toBe(expansion);
    expect(value(instance.cultivation('entity:2'))).toBe(cultivation); expect(value(instance.build('entity:2'))).toBe(build);
    const projectBuild = vi.spyOn(views, 'projectRuntimeBuildV10'); const projectCultivation = vi.spyOn(views, 'projectRuntimeCultivationV10');
    for (let index = 3; index < 83; index++) { value(instance.build(`entity:${index}`)); value(instance.cultivation(`entity:${index}`)); }
    expect(value(instance.build('entity:2'))).not.toBe(build); expect(value(instance.cultivation('entity:2'))).not.toBe(cultivation);
    expect(projectBuild).toHaveBeenCalledTimes(81); expect(projectCultivation).toHaveBeenCalledTimes(81);
    expect(value(instance.frame())).toBe(frame); expect(value(instance.expansion())).toBe(expansion);
    expect(value(instance.previewPlacement(placement()))).not.toBe(value(instance.previewPlacement(placement())));
    expect(value(instance.previewUpgrade(upgrade(fresh())))).not.toBe(value(instance.previewUpgrade(upgrade(fresh()))));
    expect(value(instance.nextApplicationCommand(0))).not.toBe(value(instance.nextApplicationCommand(0)));
    expect(RUNTIME_VIEW_LIMITS_V10.cacheEntries).toBe(4);
  });
  it('invalidates every root-bound slot after real idle carry, commands and clock publication', () => {
    let source = fresh(); const instance = runtime(source);
    const old = [value(instance.frame()), value(instance.cultivation('entity:2')), value(instance.build('entity:2')), value(instance.expansion())];
    const step = instance.advance(2); expect(step).toMatchObject({ ok: true, advancedTicks: 2, metrics: { fastTicks: 2 } });
    source = advanceCapacityLimitedTicksV10(source, 2).world; assertLeaves(instance, source);
    const current = [value(instance.frame()), value(instance.cultivation('entity:2')), value(instance.build('entity:2')), value(instance.expansion())];
    current.forEach((row, index) => expect(row).not.toBe(old[index]));
    expect(instance.previewUpgrade({})).toMatchObject({ error: 'invalid-query' });
    hooks.cultivationError = { discipleId: 'entity:3', thrown: new Error('Test-only projection failure') };
    expect(instance.cultivation('entity:3')).toMatchObject({ error: 'query-failed' }); hooks.cultivationError = null;
    const continued = instance.advance(1);
    expect(continued).toMatchObject({ ok: true, advancedTicks: 1,
      metrics: { fastTicks: 1, sourceChecks: 0, candidateChecks: 0, normalCandidates: 0, noOptionalCandidates: 0, exports: 0 } });
    source = advanceCapacityLimitedTicksV10(source, 1).world; assertLeaves(instance, source);
    const command = training(source, 'query.training', 'rest'); const response = instance.command(command);
    expect(response).toMatchObject({ ok: true, published: true, result: { status: 'accepted' } }); source = apply(source, command);
    assertLeaves(instance, source); const rested = value(instance.cultivation('entity:2'));
    expect(rested.selected?.trainingMode).toBe('rest'); expect(rested).not.toBe(current[1]);
    expect(instance.command(command)).toMatchObject({ published: false, stamp: response.stamp });
    expect(value(instance.cultivation('entity:2'))).toBe(rested);
    expect(instance.controlClock({ kind: 'speed', speed: 3 })).toMatchObject({ changed: true });
    expect(value(instance.cultivation('entity:2'))).not.toBe(rested); expect(value(instance.frame()).clock.speed).toBe(3);
    expect((old[0] as typeof current[0])).toEqual(views.projectRuntimeFrameV10(fresh()));
  });
  it('preserves cache identities on no-write operations and invalidates only the lifetime on invalidate', () => {
    const source = fresh(); const instance = runtime(source); const frame = value(instance.frame()); const initial = instance.frame().stamp;
    expect(instance.advance(0)).toMatchObject({ ok: true, advancedTicks: 0, stamp: initial });
    expect(instance.command({})).toMatchObject({ published: false, stamp: initial });
    expect(instance.controlClock({ kind: 'speed', speed: 1 })).toMatchObject({ changed: false, stamp: initial });
    expect(instance.controlClock({ kind: 'speed', speed: 4 })).toMatchObject({ changed: false, error: 'invalid-control', stamp: initial });
    expect(instance.replace({})).toMatchObject({ ok: false, error: 'invalid-source', stamp: initial });
    expect(snapshot(instance)).toEqual(source); expect(value(instance.frame())).toBe(frame);
    const invalidated = instance.invalidate(); expect(invalidated.stamp).toEqual({ generation: 2, publication: 0 });
    const after = instance.frame(); expect(after.metrics.sourceChecks).toBe(0); expect(value(after)).toEqual(frame); expect(value(after)).not.toBe(frame);
    const replacement = fresh(); const replaced = instance.replace(replacement);
    expect(replaced.stamp).toEqual({ generation: 3, publication: 1 }); expect(value(instance.frame())).not.toBe(value(after));
    expect(frame).toEqual(views.projectRuntimeFrameV10(source)); expect(Object.isFrozen(replacement)).toBe(false);
  });
  it('keeps a real retained stop and recovery flag intact through all successful and failed reads', () => {
    let source = fresh(); source = apply(source, sect(source, { domain: 'construction', command: { kind: 'blueprint.place',
      commandId: 'query.stop.plan', expectedRevision: 0, placement: placement() } }));
    source = { ...source, sectExpansion: { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const instance = runtime(source); const stopped = instance.advance(1);
    expect(stopped).toMatchObject({ ok: false, advancedTicks: 0, recoveryOnly: true, stopped: { kind: 'invalid-records' } });
    const before = snapshot(instance);
    for (const read of allReads(instance, source)) expect(read).toMatchObject({ ok: true, stamp: stopped.stamp,
      stopped: stopped.stopped, recoveryOnly: true, metrics: { sourceChecks: 0, exports: 0 } });
    expect(instance.previewUpgrade({})).toMatchObject({ ok: false, error: 'invalid-query', stamp: stopped.stamp, stopped: stopped.stopped });
    expect(snapshot(instance)).toEqual(before); expect(instance.advance(1)).toMatchObject({ advancedTicks: 0, stopped: stopped.stopped });
  });
  it('rejects malformed queries, accessors and caller authority without invoking getters or callbacks', () => {
    const instance = runtime(); const before = snapshot(instance); let reads = 0;
    const getter = { get buildingId() { reads++; return 'sect-building:1'; }, workerId: 'entity:2' };
    const invalid = [undefined, {}, [], () => { reads++; }, new Date(), Object.create({ buildingId: 'sect-building:1' }), getter];
    for (const argument of invalid) {
      expect(instance.previewUpgrade(argument)).toMatchObject({ ok: false, error: 'invalid-query', value: null });
      expect(instance.cultivation(argument as never)).toMatchObject({ ok: false, error: 'invalid-query', value: null });
      expect(instance.build(argument as never)).toMatchObject({ ok: false, error: 'invalid-query', value: null });
      expect(instance.nextApplicationCommand(argument as never)).toMatchObject({ ok: false, error: 'invalid-query', value: null });
    }
    for (const argument of [null, { ...upgrade(before), world: before }, { ...upgrade(before), costs: [] },
      { ...upgrade(before), researchGate: {} }, { ...upgrade(before), workerId: null }, { ...upgrade(before), buildingId: 'sect-building:01' }])
      expect(instance.previewUpgrade(argument)).toMatchObject({ error: 'invalid-query' });
    expect(instance.previewBreakthrough({ ...breakthrough(), preparation: { get method() { reads++; return 'standard'; }, arraySupport: 0 } }))
      .toMatchObject({ error: 'invalid-query' });
    expect(instance.previewPlacement({ ...placement(), anchor: { get x() { reads++; return 1; }, y: 1 } })).toMatchObject({ error: 'invalid-query' });
    for (const id of ['', 'entity:0', 'entity:01', 'entity:1'.repeat(20)]) expect(instance.build(id)).toMatchObject({ error: 'invalid-query' });
    for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(instance.nextApplicationCommand(cursor)).toMatchObject({ error: 'invalid-query' });
    expect(instance.nextApplicationCommand(Number.MAX_SAFE_INTEGER)).toMatchObject({ error: 'capacity' });
    expect(value(instance.nextApplicationCommand(Number.MAX_SAFE_INTEGER - 1)).sequence).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(reads).toBe(0); expect(snapshot(instance)).toEqual(before);
  });
  it('guards closed and reentrant reads before reflecting on any query input', () => {
    const instance = runtime(); const before = snapshot(instance); let reflections = 0; const nested: unknown[] = [];
    const hostile = new Proxy({}, { ownKeys() { reflections++; throw new Error('Must not reflect on blocked input'); } });
    const trigger = new Proxy(upgrade(before), { ownKeys(target) {
      nested.push(instance.previewUpgrade(hostile), instance.previewPlacement(hostile), instance.previewBreakthrough(hostile),
        instance.cultivation(hostile as never), instance.build(hostile as never), instance.nextApplicationCommand(hostile as never),
        instance.frame(), instance.expansion(), instance.close(), instance.command(hostile), instance.replace(hostile), instance.invalidate());
      return Reflect.ownKeys(target);
    } });
    expect(instance.previewUpgrade(trigger).ok).toBe(true);
    for (const result of nested) expect(result).toMatchObject({ ok: false, error: 'reentrant' });
    expect(reflections).toBe(0); expect(snapshot(instance)).toEqual(before);
    const retained = value(instance.frame()); const closed = instance.close();
    for (const read of [instance.previewUpgrade(hostile), instance.previewPlacement(hostile), instance.previewBreakthrough(hostile),
      instance.cultivation(hostile as never), instance.build(hostile as never), instance.nextApplicationCommand(hostile as never),
      instance.frame.call({}), instance.expansion.call({})]) expect(read).toMatchObject({ error: 'closed', value: null, stamp: closed.stamp });
    expect(reflections).toBe(0); expect(retained).toEqual(views.projectRuntimeFrameV10(before));
  });
  it('contains hostile thrown values without reading their properties and does not poison good caches', () => {
    const instance = runtime(); const before = snapshot(instance); const good = value(instance.cultivation('entity:2')); let errorReads = 0;
    const thrown = new Proxy({}, { get() { errorReads++; throw new Error('Do not inspect thrown data'); },
      getPrototypeOf() { errorReads++; throw new Error('Do not classify thrown data'); } });
    const argument = new Proxy({}, { ownKeys() { throw thrown; } });
    expect(instance.previewUpgrade(argument)).toMatchObject({ error: 'invalid-query', value: null });
    hooks.cultivationError = { discipleId: 'entity:3', thrown };
    expect(instance.cultivation('entity:3')).toMatchObject({ error: 'query-failed', value: null });
    expect(value(instance.cultivation('entity:2'))).toBe(good);
    hooks.frameError = { thrown }; expect(instance.frame()).toMatchObject({ error: 'query-failed', value: null });
    hooks.frameError = null; hooks.cultivationError = null;
    expect(value(instance.frame())).toEqual(views.projectRuntimeFrameV10(before));
    expect(value(instance.cultivation('entity:3')).selected?.discipleId).toBe('entity:3');
    expect(errorReads).toBe(0); expect(snapshot(instance)).toEqual(before);
  });
  it('skips exact live and archived command IDs without allocating or leaking retained history', () => {
    let source = fresh();
    for (let index = 0; index < 70; index++) source = apply(source, training(source, `app-command.${index}`));
    expect(source.history.commandReceipts.count).toBeGreaterThan(0);
    const instance = runtime(source); const before = snapshot(instance); const first = instance.nextApplicationCommand(0);
    expect(value(first)).toEqual({ commandId: 'app-command.70', sequence: 70, issuedTick: source.clock.simulationTick });
    expect(value(instance.nextApplicationCommand(0))).toEqual(value(first));
    const forbidden = ['history', 'receipts', 'commandReceipts', 'reservations', 'randomStreams', 'sequences', 'workSpans',
      'siteVisits', 'payments', 'authorityReceipts', 'retiredDisciples', 'archivedDisciples'];
    for (const read of allReads(instance, source)) for (const key of forbidden) expect(dataKeys(read.value)).not.toContain(key);
    expect(value(instance.frame()).recentEvents.length).toBeLessThanOrEqual(RUNTIME_VIEW_LIMITS_V10.recentEvents);
    expect(snapshot(instance)).toEqual(before);
  });
});

/** Record-only lift, never a migration claim. Historical sect resources and L1
 * buildings are earned by real reducers; base-stock funding is explicit in the
 * existing fixture. Research, active upgrade and L2 completion are real v10. */
function records(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No alternative medicine in old fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean): WorldStateV10 {
  let next = world;
  for (let tick = 0; tick < 1600 && !done(next); tick++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Actual query-owner fixture did not finish');
  expect(inspectUnregisteredWorldV10Records(next)).toEqual([]); return next;
}
describe('genuine active upgrade and L2 owner queries', () => {
  let old: WorldStateV9; let ready: WorldStateV10; let active: WorldStateV10; let completed: WorldStateV10;
  beforeAll(() => { old = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const)
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  beforeAll(() => {
    let world = records(old);
    world = apply(world, sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'app-command.0',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    ready = until(world, next => next.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    active = apply(ready, sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'app-command.1',
      expectedRevision: ready.sectExpansion.upgrade.revision, ...upgrade(ready) } }));
    completed = until(active, next => next.sectExpansion.upgrade.jobs[0]!.terminal !== null);
  }, 120000);
  it('matches every fixed leaf for actual fresh, active-upgrade and completed L2 boundaries', () => {
    for (const world of [ready, active, completed]) {
      const before = canonicalStringify(world); const instance = runtime(world); assertLeaves(instance, world);
      for (const read of allReads(instance, world)) expect(frozenTree(read)).toBe(true);
      expect(snapshot(instance)).toEqual(world); expect(canonicalStringify(world)).toBe(before);
    }
    const activeOwner = runtime(active);
    expect(value(activeOwner.cultivation('entity:2')).selected?.workOwner?.kind).toBe('upgrade');
    expect(value(activeOwner.expansion()).jobs.some(job => job.domain === 'upgrade')).toBe(true);
    expect(value(activeOwner.nextApplicationCommand(0)).sequence).toBe(2);
    const completedOwner = runtime(completed); const expansion = value(completedOwner.expansion());
    const building = expansion.buildings.find(row => row.definitionId === 'alchemy.v9')!;
    expect(building.level).toBe(2); expect(building.levelEvidence.level).toBe(2); expect(building.activeUpgradeJobId).toBeNull();
    expect(building.maintenance.currentPeriod?.level).toBe(1); expect(expansion.recipes.some(recipe => recipe.sites.some(site => site.level === 2))).toBe(true);
    expect(Reflect.set(building.levelEvidence, 'upgradeJobId', 'forged')).toBe(false);
    expect(Reflect.set(building.maintenance.nextMaintenanceCosts[0]!, 'quantity', 999)).toBe(false);
    expect(Reflect.set(expansion.recipes[0]!.inputs[0]!, 'quantity', 999)).toBe(false);
    expect(value(completedOwner.expansion())).toBe(expansion); expect(snapshot(completedOwner)).toEqual(completed);
  });
  it('treats a positive upgrade preview only as information and recomputes the command against current state', () => {
    const instance = runtime(ready); const preview = value(instance.previewUpgrade(upgrade(ready)));
    expect(preview).toMatchObject({ eligible: true, rejection: null, scope: 'upgrade-start-conditions' });
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: true })).toMatchObject({ changed: true });
    const before = snapshot(instance); const command = sect(before, { domain: 'upgrade', command: { kind: 'upgrade.start',
      commandId: 'query.stale-preview', expectedRevision: preview.revision, ...upgrade(before) } });
    const actual = prepareUnregisteredCommandCandidateV10(before, command);
    expect(actual.result.status).toBe('rejected'); expect(instance.command(command)).toMatchObject({ published: false, result: actual.result });
    expect(snapshot(instance)).toEqual(before); expect(value(instance.previewUpgrade(upgrade(before))).eligible).toBe(false);
    expect(preview.eligible).toBe(true);
  });
});
