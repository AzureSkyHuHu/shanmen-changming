import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createCultivationStateV3, previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import type { CommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { cultivationFrameOf } from '../../src/core/world/cultivation-preparation';
import { lookupCommandReceipt } from '../../src/core/world/history-access';
import { assessTeachingManagementCapacityV9 as capacity } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9 } from '../../src/core/world/runtime-capacity-v9';
import { createPrivateRuntimeV9, type PrivateRuntimeInstanceV9, type RuntimeOperationV9 } from '../../src/core/world/runtime-instance-v9';
import * as internals from '../../src/core/world/runtime-owned-internals-v9';
import { RUNTIME_VIEW_LIMITS_V9, type RuntimeReadV9, type RuntimeReadonlyV9 } from '../../src/core/world/runtime-view-types-v9';
import * as views from '../../src/core/world/runtime-views-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCommand, fixturePlace, fixtureProduce, fixtureSectCommand,
  fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

function runtime(world = createUnregisteredWorldV9('runtime-views')): PrivateRuntimeInstanceV9 {
  const result = createPrivateRuntimeV9(world); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error); return result.instance;
}
function value<T>(result: RuntimeReadV9<T>): RuntimeReadonlyV9<T> {
  expect(result.ok, result.error ?? '').toBe(true); if (!result.ok) throw new Error(result.error); return result.value;
}
function world(instance: PrivateRuntimeInstanceV9): WorldStateV9 {
  const result = instance.snapshot(); expect(result.ok).toBe(true); if (!result.world) throw new Error('Missing explicit export'); return result.world;
}
function training(source: WorldStateV9, commandId: string): CommandV9 {
  return fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId,
    expectedRevision: source.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, commandId);
}
function dataKeys(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return [];
  return Object.entries(input).flatMap(([key, child]) => [key, ...dataKeys(child)]);
}
function teachingWorld(): WorldStateV9 {
  let source = fundedRuntimeFixture();
  source.cultivation = createCultivationStateV3(source.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? 'knowledge.b' : 'knowledge.a', teacherId: null, teachingId: null }] })));
  source = recordChecked(source);
  const command = fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin',
    commandId: 'view.lesson', expectedRevision: source.cultivation.revision, discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.a' } } }, 'view.lesson');
  const started = dispatchCapacityLimitedCommandV9(source, command); expect(started.result.status).toBe('accepted'); return recordChecked(started.world);
}

describe('fixed detached v9 views, bounded output and explicit cold export', () => {
  it('returns detached fixed frame/cultivation/build/expansion views without any implicit World export', () => {
    const source = createUnregisteredWorldV9('no-implicit-snapshot'); const before = canonicalStringify(source); const instance = runtime(source);
    const detach = vi.spyOn(internals, 'detachData');
    const frame = instance.frame(); const cultivation = instance.cultivation('entity:4'); const build = instance.build('entity:2'); const expansion = instance.expansion();
    for (const result of [frame, cultivation, build, expansion]) {
      expect(result.ok).toBe(true); expect(result.metrics.exports).toBe(0); expect(result.metrics.fullQueries).toBe(0); expect('world' in result).toBe(false);
    }
    const DTOs = [value(frame), value(cultivation), value(build), value(expansion)];
    const forbidden = ['history', 'receipts', 'commandReceipts', 'reservations', 'randomStreams', 'sequences', 'workSpans', 'visits', 'payments', 'authorityReceipts', 'legacyStateExtras', 'retiredDisciples'];
    for (const DTO of DTOs) for (const key of forbidden) expect(dataKeys(DTO)).not.toContain(key);
    expect(detach.mock.calls.some(([input]) => input !== null && typeof input === 'object' && Object.hasOwn(input, 'runtimeProtocol'))).toBe(false);
    expect(value(frame).map).not.toBe(source.map); expect(value(frame).disciples[0]).not.toBe(source.disciples[0]);
    expect(value(cultivation).selected?.injury).toBe(25); expect(value(build).selected?.equipment).toHaveLength(3);
    expect(value(expansion).stock.every(row => row.owned === 0)).toBe(true);
    expect(Reflect.set(value(frame).disciples[0]!.position, 'x', 99)).toBe(false);
    expect(Reflect.set(value(build).selected!.loadout.equipment, 'weaponId', 'fake')).toBe(false);
    expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
    expect(instance.snapshot().metrics.exports).toBe(1); expect(instance.snapshot().metrics.exports).toBe(0);
  });
  it('caches four fixed views and preserves unaffected build/cultivation identity across scalar ticks', () => {
    const instance = runtime(); const frame = value(instance.frame()); const build = value(instance.build('entity:2'));
    const cultivation = value(instance.cultivation('entity:2')); const expansion = value(instance.expansion());
    expect(value(instance.frame())).toBe(frame); expect(value(instance.build('entity:2'))).toBe(build);
    expect(value(instance.cultivation('entity:2'))).toBe(cultivation); expect(value(instance.expansion())).toBe(expansion);
    const step = instance.advance(1); expect(step.advancedTicks).toBe(1); expect(step.metrics.exports).toBe(0);
    expect(value(instance.frame())).not.toBe(frame); expect(value(instance.expansion())).not.toBe(expansion);
    expect(value(instance.build('entity:2'))).toBe(build); expect(value(instance.cultivation('entity:2'))).toBe(cultivation);
    expect(frame.clock.simulationTick).toBe(0); expect(value(instance.frame()).clock.simulationTick).toBe(1);
    const buildProject = vi.spyOn(views, 'projectRuntimeBuildV9');
    for (const id of ['entity:1', 'entity:2', 'entity:1']) value(instance.build(id));
    expect(buildProject).toHaveBeenCalledTimes(3); // one selected-build cache slot, not an unbounded ID cache
    expect(RUNTIME_VIEW_LIMITS_V9.cacheEntries).toBe(4);
  });
  it('invalidates cultivation and build caches after real accepted commands in the same instance', () => {
    const source = createUnregisteredWorldV9('view-cache-commands'); const instance = runtime(source);
    const oldCultivation = value(instance.cultivation('entity:4')); const oldBuild = value(instance.build('entity:2'));
    const rest = fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set',
      commandId: 'view.cache.rest', expectedRevision: oldCultivation.revision, discipleId: 'entity:4', mode: 'rest' } } }, 'view.cache.rest');
    expect(instance.command(rest)).toMatchObject({ ok: true, published: true, result: { status: 'accepted' } });
    const rested = value(instance.cultivation('entity:4')); expect(rested).not.toBe(oldCultivation);
    expect(rested.selected?.trainingMode).toBe('rest'); expect(rested.revision).toBe(oldCultivation.revision + 1);
    expect(oldCultivation.selected?.trainingMode).toBe('duty'); expect(value(instance.cultivation('entity:4'))).toBe(rested);
    const beforeBuild = value(instance.build('entity:2')); expect(beforeBuild).not.toBe(oldBuild);
    const loadout = cloneJson(source.builds.disciples.find(row => row.discipleId === 'entity:2')!.loadout);
    loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    const equip = fixtureCommand(source, { kind: 'build.command', payload: { command: { kind: 'loadout.set', commandId: 'view.cache.loadout',
      expectedRevision: beforeBuild.revision, discipleId: 'entity:2', loadout } } }, 'view.cache.loadout');
    expect(instance.command(equip)).toMatchObject({ ok: true, published: true, result: { status: 'accepted' } });
    const equipped = value(instance.build('entity:2')); expect(equipped).not.toBe(beforeBuild);
    expect(equipped.revision).toBe(beforeBuild.revision + 1); expect(equipped.selected?.loadout.activeSkillIds).toEqual(loadout.activeSkillIds);
    expect(beforeBuild.selected?.loadout.activeSkillIds).not.toEqual(loadout.activeSkillIds); expect(value(instance.build('entity:2'))).toBe(equipped);
    expect(value(instance.cultivation('entity:4'))).not.toBe(rested); // its enclosing build-availability source also changed
  });
  it('invalidates the same-instance cultivation/build views at a real month transition', () => {
    let source = createUnregisteredWorldV9('view-cache-month');
    // Explicit within-month clock fixture. The transition itself is the real tick.
    source.clock = { ...source.clock, simulationTick: CALENDAR_TICKS_PER_MONTH - 1, calendarTick: CALENDAR_TICKS_PER_MONTH - 1 };
    source = fixtureApply(recordChecked(source), fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set',
      commandId: 'view.month.rest', expectedRevision: source.cultivation.revision, discipleId: 'entity:4', mode: 'rest' } } }, 'view.month.rest'));
    const instance = runtime(source); const oldCultivation = value(instance.cultivation('entity:4')); const oldBuild = value(instance.build('entity:4'));
    const strict = advanceCapacityLimitedTicksV9(source, 1); expect(instance.advance(1)).toMatchObject({ advancedTicks: 1, stopped: strict.stopped });
    const current = value(instance.cultivation('entity:4')); expect(current).not.toBe(oldCultivation);
    expect(current.selected?.injury).toBe(strict.world.cultivation.disciples.find(row => row.discipleId === 'entity:4')!.injury);
    expect(current.selected?.injury).toBe(17); expect(oldCultivation.selected?.injury).toBe(25);
    expect(value(instance.build('entity:4'))).not.toBe(oldBuild); expect(value(instance.cultivation('entity:4'))).toBe(current);
    expect(world(instance)).toEqual(strict.world);
  });
  it('caps teaching choices at 64 while retaining a truthful total and no knowledge provenance', () => {
    const source = createUnregisteredWorldV9('view-teaching-choices');
    source.cultivation = createCultivationStateV3(source.cultivation.disciples.map((profile, index) => ({ ...profile,
      knowledge: index === 0 ? Array.from({ length: 80 }, (_, id) => ({ knowledgeId: `knowledge.choice-${id}`, teacherId: null, teachingId: null })) : [] })));
    const selected = value(runtime(recordChecked(source)).cultivation('entity:1')).selected!;
    expect(selected.teachingChoices).toHaveLength(64); expect(selected.totalTeachableKnowledge).toBe(80);
    expect(selected.teachingChoices.every(choice => choice.studentIds.length <= 35)).toBe(true);
    expect(dataKeys(selected)).not.toContain('knowledge');
  });
  it('reads archive-heavy command history without returning or exporting any of it', () => {
    let source = fundedRuntimeFixture();
    for (let index = 0; index < 70; index++) source = fixtureApply(source, training(source, `app-command.${index}`));
    expect(source.history.commandReceipts.count).toBeGreaterThan(0);
    const instance = runtime(source); const frame = value(instance.frame());
    expect(frame.recentEvents.length).toBeLessThanOrEqual(5); expect(frame.transactions.length).toBeLessThanOrEqual(41);
    expect(dataKeys(frame)).not.toContain('commandReceipts');
    expect(value(instance.nextApplicationCommand(0))).toEqual({ commandId: 'app-command.70', sequence: 70, issuedTick: source.clock.simulationTick });
    expect(value(instance.nextApplicationCommand(0)).sequence).toBe(70); // read-only, no allocation
  });
  it('returns typed success/failure values, supports null selection, and omits unknown clock extensions from DTOs', () => {
    const source = createUnregisteredWorldV9('view-extensions'); Object.assign(source.clock, { retainedExtension: { bytes: 'legal data' } });
    const instance = runtime(recordChecked(source));
    const read = instance.frame(); if (read.ok) { expectTypeOf(read.error).toEqualTypeOf<null>(); expect(read.value.seed).toBe(source.seed); }
    else { expectTypeOf(read.value).toEqualTypeOf<null>(); }
    expect(value(instance.build(null)).selected).toBeNull(); expect(value(instance.cultivation('entity:999')).selected).toBeNull();
    expect(Object.keys(value(read).clock)).not.toContain('retainedExtension');
    expect(instance.controlClock({ kind: 'speed', speed: 3 }).ok).toBe(true);
    expect(Object.getOwnPropertyDescriptor(world(instance).clock, 'retainedExtension')?.value).toEqual({ bytes: 'legal data' });
  });
  it('reauthenticates once after invalidate, without exporting, and preserves old views after replacement', () => {
    const instance = runtime(); const old = value(instance.frame()); instance.invalidate();
    expect(instance.frame().metrics).toMatchObject({ fullQueries: 1, exports: 0 }); expect(instance.frame().metrics.fullQueries).toBe(0);
    const replacement = createUnregisteredWorldV9('other-world'); expect(instance.replace(replacement).ok).toBe(true);
    expect(value(instance.frame()).seed).toBe('other-world'); expect(old.seed).toBe('runtime-views');
    expect(value(instance.frame())).not.toBe(old); expect(Object.isFrozen(replacement)).toBe(false);
  });
  it('contains projection and detachment failures without changing old views, world, stamps or stop', () => {
    const instance = runtime(); const old = instance.snapshot(); const frame = value(instance.frame());
    const map = vi.spyOn(views, 'projectRuntimeCultivationV9').mockImplementationOnce(() => { throw Object.create(null); });
    expect(instance.cultivation('entity:1')).toMatchObject({ ok: false, error: 'query-failed', value: null, stamp: old.stamp }); map.mockRestore();
    const detach = vi.spyOn(internals, 'detachData').mockImplementationOnce(() => { throw new Error('Capture allocation'); });
    expect(instance.previewPlacement({})).toMatchObject({ ok: false, error: 'invalid-query', value: null }); detach.mockRestore();
    expect(instance.snapshot().world).toBe(old.world); expect(value(instance.frame())).toBe(frame);
    expect(instance.cultivation('entity:1').ok).toBe(true);
  });
  it('keeps every cached view and the old generation when a replacement is rejected', () => {
    const instance = runtime(); const before = instance.snapshot();
    const frame = value(instance.frame()); const cultivation = value(instance.cultivation('entity:2'));
    const build = value(instance.build('entity:2')); const expansion = value(instance.expansion());
    const forged = cloneJson(before.world!); forged.cultivation.revision++;
    expect(instance.replace(forged)).toMatchObject({ ok: false, stamp: before.stamp, stopped: before.stopped });
    expect(value(instance.frame())).toBe(frame); expect(value(instance.cultivation('entity:2'))).toBe(cultivation);
    expect(value(instance.build('entity:2'))).toBe(build); expect(value(instance.expansion())).toBe(expansion);
    expect(instance.snapshot().world).toBe(before.world);
  });
});

describe('read-only previews and exact local command identities', () => {
  it('uses the real cultivation preview and registered placement geometry without publishing IDs or RNG', () => {
    const source = createUnregisteredWorldV9('view-previews'); const instance = runtime(source); const before = instance.snapshot();
    const preview = value(instance.previewBreakthrough({ discipleId: 'entity:4', preparation: { method: 'standard', arraySupport: 0 } }));
    const expected = previewBreakthroughV3(cultivationFrameOf(source), 'entity:4', { method: 'standard', arraySupport: 0 });
    // 0 tribulation × the negative coefficient is -0 in the pure calculation.
    // The runtime's data-only export deliberately normalizes it to JSON's 0.
    expect(Object.is(expected.factors.find(row => row.key === 'tribulation')!.contributionBps, -0)).toBe(true);
    expect(Object.is(preview.preview.factors.find(row => row.key === 'tribulation')!.contributionBps, 0)).toBe(true);
    expect(canonicalStringify(preview.preview)).toBe(canonicalStringify(expected));
    const request = { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 };
    const placement = value(instance.previewPlacement(request)); expect(placement).toMatchObject({ allowed: true, requiredTicks: 320, scope: 'placement-and-research' });
    expect(placement.footprint?.cells).toHaveLength(4); expect(Object.isFrozen(request.anchor)).toBe(false);
    expect(value(instance.previewPlacement({ ...request, definitionId: 'alchemy.v9' }))).toMatchObject({ allowed: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
    expect(value(instance.previewPlacement({ ...request, anchor: { x: 255, y: 255 } }))).toMatchObject({ allowed: false, code: 'PLACEMENT_CHANGED' });
    expect(instance.snapshot().world).toBe(before.world); expect(instance.advance(0).stamp).toEqual(before.stamp);
  });
  it('skips construction and production local receipts absent from World commandReceipts', () => {
    let source = fundedRuntimeFixture();
    source = fixtureApply(source, fixtureSectCommand(source, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'app-command.0',
      expectedRevision: source.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
    source = fixtureApply(source, fixtureSectCommand(source, { domain: 'production', command: { kind: 'production.start', commandId: 'app-command.1',
      expectedRevision: source.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    expect(lookupCommandReceipt(source, 'app-command.0')).toBeUndefined(); expect(lookupCommandReceipt(source, 'app-command.1')).toBeUndefined();
    const instance = runtime(source); expect(value(instance.nextApplicationCommand(0)).sequence).toBe(2);
    expect(value(instance.cultivation('entity:2')).selected).toMatchObject({ workerAvailable: false, workOwner: { kind: 'sect-production' } });
    expect(value(instance.previewBreakthrough({ discipleId: 'entity:2', preparation: { method: 'standard', arraySupport: 0 } })).workOwner?.kind).toBe('sect-production');
  });
  for (const start of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it(`rejects unsafe application cursor ${start}`, () => {
    const instance = runtime(); const before = instance.snapshot(); expect(instance.nextApplicationCommand(start).error).toBe('invalid-query');
    expect(instance.snapshot().world).toBe(before.world);
  });
  it('does not parse huge receipt suffixes into a numeric cursor', () => {
    let source = fundedRuntimeFixture(); source = fixtureApply(source, training(source, 'app-command.999999999999999999999999999999999999999'));
    expect(value(runtime(source).nextApplicationCommand(0)).sequence).toBe(0);
  });
  it('reports cursor exhaustion without overflowing or exposing a falsely available final ID', () => {
    let source = fundedRuntimeFixture(); source = fixtureApply(source, training(source, `app-command.${Number.MAX_SAFE_INTEGER - 1}`));
    const instance = runtime(source); const before = instance.snapshot();
    expect(instance.nextApplicationCommand(Number.MAX_SAFE_INTEGER - 1)).toMatchObject({ ok: false, error: 'capacity', value: null });
    expect(instance.nextApplicationCommand(Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false, error: 'capacity', value: null });
    expect(instance.snapshot().world).toBe(before.world);
  });
});

describe('hostile fixed query/control arguments', () => {
  it('rejects getters, sparse arrays, callbacks, inherited/extra fields and non-data values without executing them', () => {
    const instance = runtime(); const before = instance.snapshot(); let reads = 0;
    const getter = { get discipleId() { reads++; return 'entity:1'; }, preparation: { method: 'standard', arraySupport: 0 } };
    expect(instance.previewBreakthrough(getter).error).toBe('invalid-query');
    for (const input of [() => { reads++; }, new Array(2), { discipleId: 'entity:1', preparation: { method: 'standard', arraySupport: 0 }, trusted: true },
      Object.assign(Object.create({ inherited: true }), { discipleId: 'entity:1', preparation: { method: 'standard', arraySupport: 0 } })]) {
      expect(instance.previewBreakthrough(input).error).toBe('invalid-query');
    }
    expect(instance.controlClock({ get kind() { reads++; return 'speed'; }, speed: 3 }).error).toBe('invalid-control');
    expect(reads).toBe(0); expect(instance.snapshot().world).toBe(before.world);
  });
  it('sets the guard before proxy reflection and rejects every nested operation, including the new methods', () => {
    const instance = runtime(); const before = instance.snapshot(); const nested: RuntimeOperationV9[] = []; let captured = false;
    const input = new Proxy({ kind: 'speed', speed: 3 }, { ownKeys(target) {
      if (!captured) { captured = true; nested.push(instance.frame(), instance.cultivation(null), instance.build(null), instance.expansion(),
        instance.previewPlacement({}), instance.previewBreakthrough({}), instance.nextApplicationCommand(0), instance.controlClock({ kind: 'speed', speed: 1 }),
        instance.snapshot(), instance.advance(1), instance.command({}), instance.invalidate(), instance.close()); }
      return Reflect.ownKeys(target);
    } });
    expect(instance.controlClock(input).ok).toBe(true); expect(nested).toHaveLength(13);
    expect(nested.every(result => result.error === 'reentrant')).toBe(true);
    expect(world(instance).clock.simulationTick).toBe(before.world!.clock.simulationTick);
  });
  it('rejects post-close hostile input before observing it', () => {
    const instance = runtime(); instance.close(); let observed = 0;
    const input = new Proxy({}, { ownKeys() { observed++; throw new Error('Must not reflect'); } });
    expect(instance.previewPlacement(input).error).toBe('closed'); expect(instance.controlClock(input).error).toBe('closed');
    expect(instance.frame().error).toBe('closed'); expect(instance.cultivation(null).error).toBe('closed');
    expect(instance.build(null).error).toBe('closed'); expect(instance.expansion().error).toBe('closed'); expect(observed).toBe(0);
  });
});

describe('strict clock-only transition and stop ownership', () => {
  it('changes only speed/player/hidden membership while preserving ticks, all domain pauses and their order', () => {
    const source = createUnregisteredWorldV9('clock-order'); source.clock.pauseReasons = ['error', 'choice', 'save-capacity', 'danger'];
    const instance = runtime(recordChecked(source)); const before = cloneJson(world(instance));
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: true })).toMatchObject({ ok: true, changed: true });
    expect(instance.controlClock({ kind: 'pause', reason: 'hidden', paused: true }).ok).toBe(true);
    expect(instance.controlClock({ kind: 'speed', speed: 3 }).ok).toBe(true);
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: false }).ok).toBe(true);
    const after = world(instance); expect(after.clock.pauseReasons).toEqual(['error', 'choice', 'save-capacity', 'danger', 'hidden']);
    expect({ ...after, clock: before.clock }).toEqual(before); expect(after.clock).toMatchObject({ simulationTick: 0, calendarTick: 0, encounterTick: 0, mode: 'management', speed: 3 });
    expect(instance.advance(3).advancedTicks).toBe(0);
  });
  for (const input of [
    { kind: 'pause', reason: 'cultivation', paused: false }, { kind: 'pause', reason: 'save-capacity', paused: false },
    { kind: 'pause', reason: 'error', paused: false }, { kind: 'pause', reason: 'player', paused: 1 }, { kind: 'speed', speed: 2 },
    { kind: 'speed', speed: 3, simulationTick: 1 }, { kind: 'clock', clock: { simulationTick: 0 } },
    { kind: 'pause', reason: 'hidden', paused: true, trusted: true },
  ]) it(`refuses extra authority ${JSON.stringify(input)}`, () => {
    const instance = runtime(); const before = instance.snapshot(); const oldFrame = value(instance.frame());
    expect(instance.controlClock(input)).toMatchObject({ ok: false, error: 'invalid-control', changed: false, stamp: before.stamp });
    expect(instance.snapshot().world).toBe(before.world); expect(value(instance.frame())).toBe(oldFrame);
  });
  it('does not publish no-op controls or disturb a carry, and normal resume matches the strict oracle', () => {
    const instance = runtime(); instance.advance(1); const before = instance.snapshot();
    expect(instance.controlClock({ kind: 'speed', speed: 1 })).toMatchObject({ ok: true, changed: false, stamp: before.stamp });
    expect(instance.advance(1).metrics.fullQueries).toBe(0);
    instance.controlClock({ kind: 'pause', reason: 'player', paused: true }); expect(instance.advance(20).advancedTicks).toBe(0);
    instance.controlClock({ kind: 'pause', reason: 'player', paused: false }); const resumed = world(instance);
    expect(instance.advance(1).advancedTicks).toBe(1); expect(world(instance)).toEqual(advanceCapacityLimitedTicksV9(resumed, 1).world);
  });
  it('preserves the actual record-boundary stop across controls, reads, invalidation and retries', () => {
    let source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    source = { ...source, sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    const strict = advanceCapacityLimitedTicksV9(recordChecked(source), 1);
    // The next revision would consume the planned blueprint's remaining cancel
    // revision. The real validator calls that an invalid record, not a byte cap.
    expect(strict.stopped?.kind).toBe('invalid-records');
    const instance = runtime(source); const stopped = instance.advance(1); expect(stopped.stopped).toEqual(strict.stopped);
    const changed = instance.controlClock({ kind: 'speed', speed: 3 }); expect(changed).toMatchObject({ ok: true, changed: true });
    expect(changed.stopped).toBe(stopped.stopped);
    expect(instance.controlClock({ kind: 'pause', reason: 'hidden', paused: false }).stopped).toBe(stopped.stopped);
    expect(instance.frame().stopped).toBe(stopped.stopped); expect(instance.invalidate().stopped).toBe(stopped.stopped);
    expect(instance.advance(1)).toMatchObject({ advancedTicks: 0, stopped: stopped.stopped });
    const current = world(instance); const cancellation = fixtureSectCommand(current, { domain: 'construction', command: { kind: 'construction.cancel',
      commandId: 'view.recovery', expectedRevision: current.sectExpansion.construction.revision, blueprintId: current.sectExpansion.construction.blueprints[0]!.blueprintId } });
    expect(instance.command(cancellation).result?.status).toBe('accepted'); expect(instance.frame().stopped).toBeNull();
  });
  it('preserves the actual byte-capacity stop object across successful equal-width clock controls', () => {
    const source = createUnregisteredWorldV9('view-byte-stop'); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 1 - capacity(source).costs.wireBytes!);
    recordChecked(source); expect(capacity(source).actualFits).toBe(true); expect(capacity(source).fits).toBe(false);
    const strict = advanceCapacityLimitedTicksV9(source, 1); expect(strict.stopped?.kind).toBe('capacity');
    const instance = runtime(source); const before = instance.snapshot(); const stopped = instance.advance(1);
    expect(stopped).toMatchObject({ advancedTicks: 0, stopped: strict.stopped }); expect(instance.snapshot().world).toBe(before.world);
    const speed = instance.controlClock({ kind: 'speed', speed: 3 }); expect(speed).toMatchObject({ ok: true, changed: true });
    expect(speed.stopped).toBe(stopped.stopped); expect(instance.frame().stopped).toBe(stopped.stopped);
    expect(instance.advance(1)).toMatchObject({ advancedTicks: 0, stopped: strict.stopped });
    expect(instance.advance(1).stopped).toBe(stopped.stopped);
  });
  it('supports legal controls with a real finite lesson without rewriting lesson progress or budget', () => {
    const source = teachingWorld(); const instance = runtime(source); const before = world(instance); const reserved = capacity(before).reserved;
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: true }).ok).toBe(true);
    expect(instance.controlClock({ kind: 'speed', speed: 3 }).ok).toBe(true); expect(instance.advance(CALENDAR_TICKS_PER_MONTH).advancedTicks).toBe(0);
    const paused = world(instance); expect({ ...paused, clock: before.clock }).toEqual(before); expect(capacity(paused).reserved).toEqual(reserved);
    expect(value(instance.cultivation('entity:1')).selected?.teaching?.completedMonths).toBe(0);
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: false }).ok).toBe(true);
    const resumed = world(instance); expect(instance.advance(1).advancedTicks).toBe(1);
    expect(world(instance)).toEqual(advanceCapacityLimitedTicksV9(resumed, 1).world);
  });
  it('refuses a pause that increases an already deficient byte dimension and preserves the exact old boundary', () => {
    const source = createUnregisteredWorldV9('clock-byte-pressure'); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const before = capacity(source); const target = SAVE_FILE_LIMIT_BYTES + 10;
    source.diagnostics[0]!.message = 'x'.repeat(target - before.costs.wireBytes!);
    recordChecked(source); expect(capacity(source).actualFits).toBe(true); expect(capacity(source).fits).toBe(false);
    const instance = runtime(source); const old = instance.snapshot(); const frame = value(instance.frame());
    expect(instance.controlClock({ kind: 'pause', reason: 'player', paused: true })).toMatchObject({ ok: false, error: 'capacity', changed: false, stamp: old.stamp });
    expect(instance.snapshot().world).toBe(old.world); expect(value(instance.frame())).toBe(frame);
    expect(instance.controlClock({ kind: 'speed', speed: 3 }).ok).toBe(true);
  });
  it('contains a clock-candidate assessment failure before publication', () => {
    const instance = runtime(); const before = instance.snapshot(); const frame = value(instance.frame());
    // The source is already exact, so this first intercepted freeze is the newly
    // prepared clock root, after source/candidate measurement but before swap.
    const freeze = vi.spyOn(internals, 'ownFrozenTree').mockImplementationOnce(() => { throw new Error('Allocation failure'); });
    expect(instance.controlClock({ kind: 'speed', speed: 3 })).toMatchObject({ ok: false, error: 'internal-failure', changed: false, stamp: before.stamp });
    freeze.mockRestore(); expect(instance.snapshot().world).toBe(before.world); expect(value(instance.frame())).toBe(frame);
    expect(instance.controlClock({ kind: 'speed', speed: 3 }).ok).toBe(true);
  });
  it('keeps the old idle carry after a fully assessed clock-control capacity refusal', () => {
    const source = createUnregisteredWorldV9('view-carry-refusal'); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - 1 - capacity(source).costs.wireBytes!);
    const instance = runtime(recordChecked(source)); expect(instance.advance(1).metrics).toMatchObject({ fullQueries: 0, fastQueries: 1 });
    const before = instance.snapshot(); const refused = instance.controlClock({ kind: 'pause', reason: 'player', paused: true });
    expect(refused).toMatchObject({ ok: false, error: 'capacity', changed: false, stamp: before.stamp });
    expect(refused.metrics.fullQueries).toBe(2); expect(instance.snapshot().world).toBe(before.world);
    const continued = instance.advance(1); expect(continued).toMatchObject({ advancedTicks: 1, metrics: { fullQueries: 0, fastQueries: 1, exports: 0 } });
    expect(value(instance.frame()).clock.simulationTick).toBe(2);
  });
});

let medicine: WorldStateV9;
describe('real expansion checkpoints and all sect command-ID domains', () => {
  it('projects actual construction before and after its travel and paid work', () => {
    const source = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1)); const instance = runtime(source);
    const active = value(instance.expansion()); expect(active.jobs[0]).toMatchObject({ domain: 'construction', requiredTicks: 320, activeTicks: 0 });
    expect(active.blueprints[0]?.status).toBe('started'); expect(active.workOwners[0]?.kind).toBe('construction');
    medicine = fixtureUntil(source, current => !!current.sectExpansion.construction.jobs[0]!.terminal);
    const complete = value(runtime(medicine).expansion()); expect(complete.jobs).toEqual([]); expect(complete.blueprints).toEqual([]);
    expect(complete.buildings[0]).toMatchObject({ definitionId: 'library.v9', level: 1 });
    expect(complete.buildings[0]?.maintenance.dueCalendarTick).toBeGreaterThan(medicine.clock.calendarTick);
    expect(dataKeys(complete)).not.toContain('workSpans'); expect(dataKeys(complete)).not.toContain('sourceJobId');
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`prepares actual study/research materials ${index + 1}`, () => { medicine = fixtureProduce(medicine, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9'); });
  }
  it('skips the genuine research receipt and exposes its active and completed summary only', () => {
    medicine = fixtureApply(medicine, fixtureSectCommand(medicine, { domain: 'research', command: { kind: 'research.start', commandId: 'app-command.0',
      expectedRevision: medicine.sectExpansion.research.revision, researchId: 'basic-medicine.v9', workerId: 'entity:2' } }));
    const instance = runtime(medicine); expect(value(instance.nextApplicationCommand(0)).sequence).toBe(1);
    expect(value(instance.expansion()).jobs[0]).toMatchObject({ domain: 'research', requiredTicks: 240 });
    medicine = fixtureUntil(medicine, current => !!current.sectExpansion.research.jobs[0]!.terminal);
    expect(value(runtime(medicine).expansion()).completedResearch[0]?.researchId).toBe('basic-medicine.v9');
    const placement = value(runtime(medicine).previewPlacement({ definitionId: 'alchemy.v9', anchor: { x: 10, y: 1 }, rotation: 0 }));
    expect(placement.allowed).toBe(true);
  });
  it('builds and delivers actual medicine while keeping terminal summaries bounded', () => {
    medicine = fixtureStartConstruction(fixturePlace(medicine, 'alchemy.v9', 10));
    medicine = fixtureUntil(medicine, current => !!current.sectExpansion.construction.jobs.at(-1)!.terminal);
    medicine = fixtureProduce(medicine, 'craft.wound-powder.v9');
    const view = value(runtime(medicine).expansion()); expect(view.stock.find(row => row.resourceId === 'wound-powder')?.owned).toBe(1);
    expect(view.recentTerminals.length).toBeLessThanOrEqual(8); expect(view.totalTerminals).toBe(8);
  });
  it('skips the care receipt, reports true care ownership and shows actual before/after injury', () => {
    medicine = fixtureApply(medicine, fixtureSectCommand(medicine, { domain: 'care', command: { kind: 'care.start', commandId: 'app-command.1',
      expectedRevision: medicine.sectExpansion.care.revision, patientId: 'entity:4' } }));
    const instance = runtime(medicine); expect(value(instance.nextApplicationCommand(0)).sequence).toBe(2);
    expect(value(instance.expansion()).jobs[0]).toMatchObject({ domain: 'care', patientId: 'entity:4', requiredTicks: 40 });
    expect(value(instance.build('entity:4')).selected?.locked).toBe(true);
    expect(value(instance.cultivation('entity:4')).selected?.workOwner?.kind).toBe('care');
    medicine = fixtureUntil(medicine, current => !!current.sectExpansion.care.jobs[0]!.terminal);
    const result = value(runtime(medicine).expansion()); expect(result.totalTerminals).toBe(9); expect(result.recentTerminals).toHaveLength(8);
    expect(result.recentTerminals.find(row => row.domain === 'care')).toMatchObject({ kind: 'completed', beforeInjury: 25, afterInjury: 5 });
    expect(value(runtime(medicine).cultivation('entity:4')).selected?.injury).toBe(5);
  });
});
