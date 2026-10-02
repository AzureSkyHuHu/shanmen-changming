import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ApplicationSessionV9, type SessionCommandResultV9, type SessionRequestV9, type SessionValueV9 } from '../../src/application/session-v9';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH } from '../../src/core/kernel/clock';
import { parseSaveV9 } from '../../src/core/kernel/save-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessTeachingManagementCapacityV9 as capacity } from '../../src/core/world/management-capacity-v9';
import { lookupCommandReceipt } from '../../src/core/world/history-access';
import * as owners from '../../src/core/world/runtime-instance-v9';
import type { PrivateRuntimeInstanceV9 } from '../../src/core/world/runtime-instance-v9';
import * as views from '../../src/core/world/runtime-views-v9';
import { admitSaveWorldV9 } from '../../src/core/world/save-admission-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCommand, fixturePlace, fixtureSectCommand, fundedRuntimeFixture, recordChecked } from '../sect-expansion/fixtures/v9-runtime';

const metadata = { buildId: 'internal-session-v9-test', savedAt: '2026-10-02T12:00:00Z' };
const sessions: ApplicationSessionV9[] = [];
const session = (world: unknown = createUnregisteredWorldV9('session-v9')): ApplicationSessionV9 => {
  const result = new ApplicationSessionV9(world); sessions.push(result); return result;
};
afterEach(() => { vi.restoreAllMocks(); for (const instance of sessions.splice(0)) instance.close(); });
function value<T>(result: SessionValueV9<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
}
function result(outcome: SessionCommandResultV9) {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true); if (!outcome.ok) throw new Error(JSON.stringify(outcome)); return outcome.result;
}
function accepted(outcome: SessionCommandResultV9) { const command = result(outcome); expect(command.status, JSON.stringify(command)).toBe('accepted'); return command; }
function keys(input: unknown): string[] {
  return input !== null && typeof input === 'object' ? Object.entries(input).flatMap(([key, child]) => [key, ...keys(child)]) : [];
}
function teachingOrigin(): WorldStateV9 {
  const source = fundedRuntimeFixture();
  source.cultivation = createCultivationStateV3(source.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? 'knowledge.b' : 'knowledge.a', teacherId: null, teachingId: null }] })));
  return recordChecked(source);
}
function teachingCommand(source: WorldStateV9, teacher = 'entity:1', student = 'entity:2', knowledgeId = 'knowledge.a', commandId = 'fixture.lesson') {
  return fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId,
    expectedRevision: source.cultivation.revision, discipleId: teacher, studentId: student, knowledgeId } } }, commandId);
}
function wrapOwners(wrap: (instance: PrivateRuntimeInstanceV9, index: number) => PrivateRuntimeInstanceV9) {
  const actual = owners.createPrivateRuntimeV9; let index = 0;
  return vi.spyOn(owners, 'createPrivateRuntimeV9').mockImplementation(input => {
    const created = actual(input); return created.ok ? { ...created, instance: wrap(created.instance, index++) } : created;
  });
}

describe('separate private-owner Session and bounded immutable UI cache', () => {
  it('never exports a full World for projection, selection, ticks or dispatch', () => {
    const exports: ReturnType<typeof vi.fn>[] = [];
    wrapOwners(instance => { const snapshot = vi.fn(() => instance.snapshot()); exports.push(snapshot); return { ...instance, snapshot }; });
    const input = createUnregisteredWorldV9('session-owned'); const instance = session(input); exports.forEach(spy => spy.mockClear());
    const before = instance.getSnapshot(); input.inventory.wood.owned = 0;
    instance.frame(0); instance.frame(1000); instance.select({ kind: 'disciple', id: 'entity:4' });
    accepted(instance.dispatchCultivation({ kind: 'training.set', discipleId: 'entity:2', expectedRevision: instance.getSnapshot().cultivation.revision, mode: 'duty' }));
    expect(exports.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(20); expect(before.frame.clock.simulationTick).toBe(0);
    expect(instance.getSnapshot().frame.resources.find(row => row.resourceId === 'wood')?.owned).not.toBe(0);
    for (const forbidden of ['history', 'commandReceipts', 'receipts', 'randomStreams', 'sequences', 'workSpans', 'payments']) {
      expect(keys(instance.getSnapshot())).not.toContain(forbidden);
    }
    expect(Reflect.set(before.frame.disciples[0]!.position, 'x', 999)).toBe(false);
    expect(Object.keys(instance).some(key => /owner|world|engine/i.test(key) && key !== 'getEngineVersion')).toBe(false);
    const world = value(instance.exportWorld()); expect(exports.at(-1)).toHaveBeenCalledTimes(1);
    expect(Reflect.set(world.inventory.wood, 'owned', 1)).toBe(false);
    expect(instance.getEngineVersion()).toBe(9);
  });
  it('preserves stable snapshots and unaffected DTO identity through partial frames and no-op controls', () => {
    const instance = session(); const before = instance.getSnapshot();
    instance.frame(0); instance.frame(24); instance.frame(49); instance.setSpeed(1);
    expect(instance.getSnapshot()).toBe(before);
    instance.frame(50); const after = instance.getSnapshot(); expect(after).not.toBe(before);
    expect(after.frame.clock.simulationTick).toBe(1); expect(after.build).toBe(before.build); expect(after.cultivation).toBe(before.cultivation);
    const worldRevision = after.worldRevision; instance.select({ kind: 'building', id: after.frame.buildings[0]!.id });
    expect(instance.getSnapshot().worldRevision).toBe(worldRevision); expect(instance.getSnapshot().cultivation.selected).toBeNull();
    const selected = instance.getSnapshot(); expect(instance.select({ kind: 'disciple', id: 'absent' }).ok).toBe(false); expect(instance.getSnapshot()).toBe(selected);
  });
  it('contains a live projection fault with an explicit hold and a whole old DTO cache', () => {
    const instance = session(); const before = instance.getSnapshot();
    const spy = vi.spyOn(views, 'projectRuntimeFrameV9').mockImplementationOnce(() => { throw new Error('Injected DTO failure'); });
    instance.frame(0); instance.frame(50); expect(instance.getSnapshot()).toMatchObject({ paused: true, runtimeFailure: 'query-failed' });
    expect(instance.getSnapshot().frame).toBe(before.frame); expect(instance.getSnapshot().expansion).toBe(before.expansion);
    expect(value(instance.exportWorld()).clock.simulationTick).toBe(1); spy.mockRestore();
    const failed = instance.getSnapshot();
    expect(instance.select({ kind: 'disciple', id: 'entity:4' })).toMatchObject({ ok: false, code: 'SESSION_HELD' });
    expect(instance.getSnapshot()).toBe(failed); expect(failed.stamp).toEqual(before.stamp); expect(failed.worldRevision).toBe(before.worldRevision);
    expect(instance.refresh().ok).toBe(true); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1); expect(instance.getSnapshot().runtimeFailure).toBeNull();
  });
  it('contains subscriber exceptions and blocks reentrant mutations while notifying every subscriber', () => {
    const instance = session(); const nested: unknown[] = []; const other = vi.fn();
    instance.subscribe(() => { nested.push(instance.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } })); throw new Error('UI callback'); });
    const unsubscribe = instance.subscribe(other); expect(instance.setSpeed(3).ok).toBe(true);
    expect(nested).toEqual([{ ok: false, kind: 'session-rejection', code: 'BUSY' }]); expect(other).toHaveBeenCalledTimes(1);
    unsubscribe(); unsubscribe(); instance.setSpeed(1); expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('fixed-tick timing, ordinary controls and ephemeral holds', () => {
  it('uses 1x/3x fixed ticks and a twenty-tick catch-up budget without dropping backlog', () => {
    const instance = session(); instance.setSpeed(3); instance.frame(0); instance.frame(50);
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(3);
    instance.setSpeed(1); instance.frame(100); instance.frame(3100);
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(23);
    instance.frame(3100); instance.frame(3100); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(63);
    expect(instance.frame(NaN)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    instance.frame(2000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(63);
  });
  it('retains incomplete pre-pause time and discards hidden and unpause wall time', () => {
    const instance = session(); instance.frame(0); instance.frame(25);
    instance.togglePlayerPause(); instance.frame(100_000); instance.togglePlayerPause();
    instance.frame(200_000); instance.frame(200_025); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
    instance.setForeground({ visible: false }); instance.frame(300_000); instance.setForeground({ focused: false, visible: true });
    expect(instance.getSnapshot().paused).toBe(true); instance.setForeground({ focused: true });
    instance.frame(400_000); instance.frame(400_050); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(2);
  });
  it('cannot clear a domain pause through player/speed/foreground controls', () => {
    const source = createUnregisteredWorldV9(); source.clock.pauseReasons = ['danger', 'choice', 'error', 'save-capacity'];
    const instance = session(source); instance.setPaused('player', true); instance.setSpeed(3); instance.setForeground({ visible: false });
    instance.setPaused('player', false); instance.setForeground({ visible: true });
    expect(instance.getSnapshot().frame.clock.pauseReasons).toEqual(['danger', 'choice', 'error', 'save-capacity']);
    instance.frame(0); instance.frame(100_000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(0);
    // The type has no domain-pause escape hatch; runtime validation agrees.
    // @ts-expect-error Only player and hidden belong to the Session controls.
    expect(instance.setPaused('danger', false)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
  for (const hold of ['setStorageReadOnly', 'setStorageBusy', 'setOverlayPaused', 'setReviewPaused'] as const) {
    it(`keeps ${hold} ephemeral, blocks commands, and discards held wall time`, () => {
      const instance = session(); const before = value(instance.exportWorld()); instance[hold](true);
      expect(instance.getSnapshot().paused).toBe(true); expect(value(instance.exportWorld())).toBe(before);
      instance.frame(0); instance.frame(1_000_000);
      expect(instance.dispatch({ kind: 'production.start', payload: { workerId: 'entity:2', recipeId: 'gather.wood' } })).toMatchObject({ ok: false, code: 'SESSION_HELD' });
      instance[hold](false); instance.frame(2_000_000); instance.frame(2_000_050);
      expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
    });
  }
  it('uses a real byte-limit ephemeral player/hidden pause without poisoning export', () => {
    const source = createUnregisteredWorldV9('session-byte-edge'); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - capacity(source).costs.wireBytes!);
    recordChecked(source); expect(capacity(source).fits).toBe(true); const instance = session(source); const before = value(instance.exportWorld());
    expect(instance.setPaused('player', true)).toMatchObject({ ok: true, ephemeral: true });
    expect(instance.getSnapshot().holds.player).toBe(true); expect(instance.getSnapshot().frame.clock.pauseReasons).not.toContain('player');
    expect(value(instance.exportWorld())).toBe(before); instance.setForeground({ visible: false }); expect(instance.getSnapshot().holds.hidden).toBe(true);
    instance.frame(0); instance.frame(10000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(0);
    instance.setForeground({ visible: true }); instance.setPaused('player', false); expect(instance.getSnapshot().paused).toBe(false);
  });
  it('keeps an actual counter-capacity stop latched across clock controls and failed replacement', () => {
    const source = createUnregisteredWorldV9('session-counter-edge');
    source.sectExpansion = { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER } };
    recordChecked(source); expect(capacity(source).fits).toBe(true); const instance = session(source);
    instance.frame(0); expect(instance.frame(50).ok).toBe(false); const stopped = instance.getSnapshot().stopped; expect(stopped?.kind).toBe('capacity');
    instance.setSpeed(3); instance.setPaused('player', true); instance.setPaused('player', false);
    instance.setForeground({ visible: false }); instance.setForeground({ visible: true }); expect(instance.getSnapshot().stopped).toBe(stopped);
    const before = instance.getSnapshot(); expect(instance.replaceWorld(createWorld()).ok).toBe(false); expect(instance.getSnapshot()).toBe(before);
    instance.frame(100_000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(0);
    expect(instance.replaceWorld(createUnregisteredWorldV9('recovered')).ok).toBe(true); expect(instance.getSnapshot().stopped).toBeNull();
  });
});

describe('typed v9 commands, previews and collision-safe reload', () => {
  it('retains sect, cultivation, build, legacy and runtime failure discriminants', () => {
    const instance = session();
    const sect = result(instance.dispatchSect({ domain: 'construction', command: { kind: 'construction.start', blueprintId: 'unknown', workerId: 'entity:2', expectedRevision: 0 } }));
    expect(sect.rejection).toMatchObject({ code: 'SECT_EXPANSION_REJECTED', detail: 'UNKNOWN_BLUEPRINT' });
    const cultivation = result(instance.dispatchCultivation({ kind: 'training.set', discipleId: 'entity:2', expectedRevision: 999, mode: 'duty' }));
    expect(cultivation.rejection?.code).toBe('CULTIVATION_REJECTED');
    const build = result(instance.dispatchBuild({ kind: 'tree.respec', discipleId: 'missing', expectedRevision: 0, nodeIds: [] }));
    expect(build.rejection?.code).toBe('BUILD_REJECTED');
    const legacy = result(instance.dispatch({ kind: 'production.start', payload: { recipeId: 'missing', workerId: 'entity:2' } }));
    expect(legacy.rejection?.code).toBe('UNKNOWN_RECIPE');
    expectTypeOf<Extract<SessionRequestV9, { kind: 'expedition.command' | 'campaign.command' | 'sect-economy.command' }>>().toEqualTypeOf<never>();
    const actual = owners.createPrivateRuntimeV9;
    vi.spyOn(owners, 'createPrivateRuntimeV9').mockImplementation(input => {
      const made = actual(input); if (!made.ok) return made;
      return { ...made, instance: { ...made.instance, command: () => ({ ...made.instance.advance(0), ok: false, error: 'internal-failure', published: false, result: null }) } };
    });
    const broken = session(); expect(broken.dispatch({ kind: 'production.cancel', payload: { transactionId: 'missing' } })).toMatchObject({ ok: false, kind: 'runtime-failure', error: 'internal-failure' });
  });
  it('rejects forbidden command families, commandId injection and getters before execution', () => {
    const instance = session(); let reads = 0; const before = instance.getSnapshot();
    const getter = { kind: 'production.start' as const, get payload() { reads++; return { recipeId: 'gather.wood', workerId: 'entity:2' }; } };
    expect(instance.dispatch(getter)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' }); expect(reads).toBe(0);
    // @ts-expect-error The v9 management facade does not advertise expedition commands.
    expect(instance.dispatch({ kind: 'expedition.command', payload: {} })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    const withId = { kind: 'training.set' as const, expectedRevision: 0, discipleId: 'entity:2', mode: 'duty' as const, commandId: 'stolen' };
    expect(instance.dispatchCultivation(withId)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' }); expect(instance.getSnapshot()).toBe(before);
  });
  it('only accepts issued, current proposals; readonly review holds permit their exact confirmation', () => {
    const instance = session(fundedRuntimeFixture());
    const placement = value(instance.preparePlacement({ definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 }));
    expect(placement.view.scope).toBe('placement-and-research'); expect(instance.isProposalCurrent(placement)).toBe(true);
    expect(instance.confirmPlacement({ ...placement })).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    const breakthrough = value(instance.prepareBreakthrough('entity:2')); instance.setReviewPaused(true);
    expect(instance.isProposalCurrent(placement)).toBe(true); accepted(instance.confirmPlacement(placement));
    expect(instance.isProposalCurrent(breakthrough)).toBe(false); expect(instance.confirmBreakthrough(breakthrough)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    instance.setReviewPaused(false); const preview = value(instance.prepareBreakthrough('entity:2'));
    const copy = { ...preview, view: { ...preview.view, preview: { ...preview.view.preview, stateRevision: 100 } } };
    expect(instance.confirmBreakthrough(copy)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    instance.replaceWorld(value(instance.exportWorld())); expect(instance.confirmBreakthrough(preview)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
  });
  it('retains unsupported teaching continuation as a typed gate rejection without publishing', () => {
    const instance = session(teachingOrigin());
    accepted(instance.dispatchCultivation({ kind: 'teaching.begin', expectedRevision: 0, discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.a' }));
    const before = value(instance.exportWorld());
    const chained = result(instance.dispatchCultivation({ kind: 'teaching.begin', expectedRevision: instance.getSnapshot().cultivation.revision, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.b' }));
    expect(chained.rejection?.code).toBe('UNSUPPORTED_CONTINUATION'); expect(value(instance.exportWorld())).toBe(before);
    instance.setPaused('player', true); instance.setSpeed(3); instance.frame(0); instance.frame(10000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(0);
    instance.setPaused('player', false); instance.frame(20000); instance.frame(20050); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(3);
    expect(instance.getSnapshot().cultivation.summaries.find(row => row.discipleId === 'entity:1')?.teaching).toBe(true);
    const reloaded = parseSaveV9(value(instance.exportSave(metadata))); expect(reloaded.ok).toBe(true);
  });
  it('skips genuine archived World receipts and sect receipts after explicit save/reload', () => {
    let source = fundedRuntimeFixture();
    for (let index = 0; index < 70; index++) source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: {
      kind: 'training.set', commandId: `app-command.${index}`, expectedRevision: source.cultivation.revision, discipleId: 'entity:2', mode: 'duty',
    } } }, `app-command.${index}`));
    source = fixtureApply(source, fixtureSectCommand(source, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'app-command.70',
      expectedRevision: source.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
    source = fixtureApply(source, fixtureSectCommand(source, { domain: 'production', command: { kind: 'production.start', commandId: 'app-command.71',
      expectedRevision: source.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    expect(source.history.commandReceipts.count).toBeGreaterThan(0); expect(lookupCommandReceipt(source, 'app-command.70')).toBeUndefined();
    const original = session(source); const parsed = parseSaveV9(value(original.exportSave(metadata))); if (!parsed.ok) throw new Error(parsed.error.message);
    const loaded = session(parsed.world); const jobId = loaded.getSnapshot().expansion.jobs.find(row => row.domain === 'production')!.jobId;
    const cancelled = accepted(loaded.dispatchSect({ domain: 'production', command: { kind: 'production.cancel', expectedRevision: loaded.getSnapshot().expansion.revisions.production, jobId } }));
    expect(cancelled.commandId).toBe('app-command.72'); expect('sectResult' in cancelled && cancelled.sectResult?.domain).toBe('production');
  });
});

describe('fully prepared atomic replacement and persistence token lifetime', () => {
  it('uses the exact save-admission subset and never replaces a working session with unsupported real records', () => {
    let unsupported = teachingOrigin(); unsupported = fixtureApply(unsupported, teachingCommand(unsupported));
    unsupported = fixtureApply(unsupported, teachingCommand(unsupported, 'entity:2', 'entity:3', 'knowledge.b', 'fixture.chain'));
    recordChecked(unsupported); expect(admitSaveWorldV9(unsupported)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(() => new ApplicationSessionV9(unsupported)).toThrow(expect.objectContaining({ failure: { ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' } }));
    const instance = session(); const before = instance.getSnapshot(); const exported = value(instance.exportWorld());
    expect(instance.replaceWorld(unsupported)).toMatchObject({ ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' });
    expect(instance.getSnapshot()).toBe(before); expect(value(instance.exportWorld())).toBe(exported);
    for (const older of [createWorld(), createWorldV8()]) {
      expect(instance.replaceWorld(older)).toMatchObject({ ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SIMULATION_VERSION' });
      expect(instance.getSnapshot()).toBe(before);
    }
    let recoveryOnly = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    recoveryOnly = { ...recoveryOnly, sectExpansion: { ...recoveryOnly.sectExpansion, construction: { ...recoveryOnly.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    recordChecked(recoveryOnly); expect(instance.replaceWorld(recoveryOnly)).toMatchObject({ ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' });
    expect(instance.getSnapshot()).toBe(before);
  });
  for (const injected of ['frame', 'cultivation', 'build', 'expansion', 'identity', 'clock'] as const) {
    it(`preserves live cache, selection, epoch, sequence, remainder, holds and proposals after injected ${injected} preparation failure`, () => {
      const instance = session(); instance.frame(0); instance.frame(25); instance.select({ kind: 'disciple', id: 'entity:4' });
      const proposal = value(instance.prepareBreakthrough('entity:4')); instance.setReviewPaused(true);
      const before = instance.getSnapshot(); const exported = value(instance.exportWorld()); const closes: ReturnType<typeof vi.fn>[] = [];
      wrapOwners((owner, index) => {
        const close = vi.fn(() => owner.close()); closes.push(close); if (index === 0) return { ...owner, close };
        const failed = { ok: false as const, error: 'query-failed' as const, value: null };
        return { ...owner, close,
          ...(injected === 'frame' ? { frame: () => ({ ...owner.frame(), ...failed }) } : {}),
          ...(injected === 'cultivation' ? { cultivation: () => ({ ...owner.cultivation(null), ...failed }) } : {}),
          ...(injected === 'build' ? { build: () => ({ ...owner.build(null), ...failed }) } : {}),
          ...(injected === 'expansion' ? { expansion: () => ({ ...owner.expansion(), ...failed }) } : {}),
          ...(injected === 'identity' ? { nextApplicationCommand: () => ({ ...owner.nextApplicationCommand(0), ...failed }) } : {}),
          ...(injected === 'clock' ? { controlClock: () => ({ ...owner.controlClock({ kind: 'speed', speed: 1 }), ok: false as const, error: 'internal-failure' as const, changed: false as const }) } : {}),
        };
      });
      expect(instance.replaceWorld(createUnregisteredWorldV9('injected-replacement')).ok).toBe(false);
      expect(instance.getSnapshot()).toBe(before); expect(value(instance.exportWorld())).toBe(exported); expect(instance.isProposalCurrent(proposal)).toBe(true);
      expect(closes).toHaveLength(2); for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
      instance.setReviewPaused(false); instance.frame(100_000); instance.frame(100_025); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
      const command = accepted(instance.dispatchCultivation({ kind: 'training.set', expectedRevision: instance.getSnapshot().cultivation.revision, discipleId: 'entity:2', mode: 'duty' }));
      expect(command.commandId).toBe('app-command.0');
    });
  }
  it('captures the replacement before hostile getter/reflection code can reenter or change the live owner', () => {
    const instance = session(); const before = instance.getSnapshot(); const nested: unknown[] = [];
    const input = new Proxy(createUnregisteredWorldV9('guarded'), { ownKeys(target) {
      nested.push(instance.replaceWorld(createUnregisteredWorldV9()), instance.setSpeed(3), instance.exportWorld()); return Reflect.ownKeys(target);
    } });
    const prepared = value(instance.prepareReplacement(input)); expect(instance.getSnapshot()).toBe(before);
    expect(nested.every(outcome => typeof outcome === 'object' && outcome !== null && 'code' in outcome && outcome.code === 'BUSY')).toBe(true);
    expect(instance.discardReplacement(prepared).ok).toBe(true);
    let reads = 0; const hostile = Object.defineProperty(createUnregisteredWorldV9(), 'clock', { enumerable: true, get() { reads++; throw new Error('No getter'); } });
    expect(instance.replaceWorld(hostile).ok).toBe(false); expect(reads).toBe(0); expect(instance.getSnapshot()).toBe(before);
  });
  it('prepares all DTOs and clock policy before swapping, closes old owner afterward, and contains subscriber errors', () => {
    const closes: Array<{ seed: string; close: ReturnType<typeof vi.fn> }> = [];
    wrapOwners(owner => { const seed = owner.frame(); const close = vi.fn(() => owner.close()); closes.push({ seed: seed.ok ? seed.value.seed : '', close }); return { ...owner, close }; });
    const instance = session(createUnregisteredWorldV9('old-live')); instance.setForeground({ visible: false }); instance.setStorageReadOnly(true);
    const before = instance.getSnapshot(); const observer = vi.fn(() => { throw new Error('subscriber'); }); instance.subscribe(observer);
    const next = createUnregisteredWorldV9('new-live'); next.clock.pauseReasons = ['danger', 'hidden'];
    const token = value(instance.prepareReplacement(next)); expect(instance.getSnapshot()).toBe(before); expect(closes[1]!.close).not.toHaveBeenCalled();
    expect(instance.commitReplacement(token).ok).toBe(true); expect(observer).toHaveBeenCalledTimes(1); expect(closes[1]!.close).toHaveBeenCalledTimes(1);
    expect(instance.getSnapshot()).toMatchObject({ sessionEpoch: 1, holds: { storage: true, review: false }, selection: { kind: 'disciple', id: 'entity:2' } });
    expect(instance.getSnapshot().frame).toMatchObject({ seed: 'new-live', clock: { pauseReasons: ['danger', 'hidden', 'player'] } });
    expect(instance.commitReplacement(token)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    next.inventory.wood.owned = 0; expect(instance.getSnapshot().frame.resources.find(row => row.resourceId === 'wood')?.owned).not.toBe(0);
  });
  it('makes repeated discard/commit harmless, releases superseded candidates, and invalidates on any publication', () => {
    const closes: ReturnType<typeof vi.fn>[] = []; wrapOwners(owner => { const close = vi.fn(() => owner.close()); closes.push(close); return { ...owner, close }; });
    const instance = session(); const first = value(instance.prepareReplacement(createUnregisteredWorldV9('first')));
    const second = value(instance.prepareReplacement(createUnregisteredWorldV9('second'))); expect(closes[3]).toHaveBeenCalledTimes(1);
    expect(instance.commitReplacement(first)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(instance.commitReplacement({ ...second })).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    instance.select({ kind: 'disciple', id: 'entity:4' }); expect(closes[5]).toHaveBeenCalledTimes(1);
    expect(instance.commitReplacement(second)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    const third = value(instance.prepareReplacement(createUnregisteredWorldV9('third')));
    expect(instance.discardReplacement(third).ok).toBe(true); expect(instance.discardReplacement(third)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    const fourth = value(instance.prepareReplacement(createUnregisteredWorldV9('fourth'))); instance.close();
    expect(instance.commitReplacement(fourth)).toMatchObject({ ok: false, code: 'CLOSED' }); expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
  });
  it('keeps a prepared token valid across the storage-busy write interval including visibility changes', () => {
    const instance = session(); instance.setStorageBusy(true); const token = value(instance.prepareReplacement(createUnregisteredWorldV9('durable')));
    const before = instance.getSnapshot(); const blocked = [instance.select(null), instance.setSpeed(3), instance.setPaused('player', true),
      instance.setPaused('hidden', true), instance.setOverlayPaused(true), instance.setReviewPaused(true), instance.setStorageReadOnly(true), instance.refresh(),
      instance.prepareReplacement(createUnregisteredWorldV9('competing'))];
    expect(blocked.every(outcome => !outcome.ok && outcome.kind === 'session-rejection' && outcome.code === 'SESSION_HELD')).toBe(true);
    instance.setStorageBusy(true); instance.setForeground({ visible: false }); instance.frame(9000); expect(instance.getSnapshot()).toBe(before);
    expect(instance.commitReplacement(token).ok).toBe(true); expect(instance.getSnapshot().frame.seed).toBe('durable');
    expect(instance.getSnapshot().holds.storageBusy).toBe(true); instance.setStorageBusy(false);
    expect(instance.getSnapshot().frame.clock.pauseReasons).toContain('hidden'); expect(instance.getSnapshot().paused).toBe(true);
    instance.setForeground({ visible: true }); instance.setPaused('player', false); instance.frame(100_000); instance.frame(100_050);
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
  });
  it('rejects post-close operations before observing hostile input and releases subscriptions', () => {
    const instance = session(); const listener = vi.fn(); instance.subscribe(listener); instance.close(); expect(listener).toHaveBeenCalledTimes(1);
    let observed = 0; const hostile = new Proxy({}, { ownKeys() { observed++; throw new Error('No reflection'); } });
    expect(instance.replaceWorld(hostile)).toMatchObject({ ok: false, code: 'CLOSED' }); expect(instance.exportWorld()).toMatchObject({ ok: false, code: 'CLOSED' });
    // @ts-expect-error Invalid inputs must still be rejected before descriptor reads when closed.
    expect(instance.dispatch(hostile)).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(instance.frame(1000)).toMatchObject({ ok: false, code: 'CLOSED' }); expect(observed).toBe(0); expect(listener).toHaveBeenCalledTimes(1);
  });
});

// A real Session-only management path, split into bounded tick checkpoints. The
// initial base stock is explicitly a fixture; new stock/unlocks/medicine are paid
// genuine operations. No fixture tick preparation or root mutation occurs below.
let flow: ApplicationSessionV9; let time = 0; let job = ''; let previousStock = 0;
function flowCommand(command: SessionCommandResultV9): void { const outcome = accepted(command); job = outcome.transactionId ?? ''; }
function flowTicks(max = 60): void {
  for (let used = 0; used < max && flow.getSnapshot().expansion.jobs.some(row => row.jobId === job); used += 20) {
    time += 1000; expect(value(flow.frame(time))).toBe(20); expect(flow.getSnapshot().stopped).toBeNull();
  }
}
function checkpointSave(): void {
  const snapshot = flow.getSnapshot(); const text = value(flow.exportSave(metadata)); const parsed = parseSaveV9(text);
  expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
  expect(flow.replaceWorld(parsed.world).ok).toBe(true); expect(flow.getSnapshot().sessionEpoch).toBe(snapshot.sessionEpoch + 1);
  flow.setPaused('player', false); time += 1000; flow.frame(time);
}
function recipeStart(recipeId: 'gather.stone.v9' | 'extract.spirit-stone.v9' | 'study.basic-insight.v9' | 'craft.wound-powder.v9'): void {
  flowCommand(flow.dispatchSect({ domain: 'production', command: { kind: 'production.start', recipeId, workerId: 'entity:2', expectedRevision: flow.getSnapshot().expansion.revisions.production } }));
}
function completed(): void {
  const snapshot = flow.getSnapshot(); const active = snapshot.expansion.jobs.find(row => row.jobId === job);
  expect(active, JSON.stringify({ clock: snapshot.frame.clock, active, paused: snapshot.paused, stopped: snapshot.stopped })).toBeUndefined();
}
function pumpTests(label: string, count: number): void {
  for (let part = 0; part < count; part++) it(`${label}: real fixed-tick checkpoint ${part + 1}`, () => flowTicks());
}
describe('genuine Session gather → construction → paid research → medicine → care with cold reloads', () => {
  it('starts genuine new-domain stone gathering and exposes its typed sect result', () => {
    flow = new ApplicationSessionV9(fundedRuntimeFixture()); time = 0; flow.frame(time);
    previousStock = flow.getSnapshot().frame.resources.find(row => row.resourceId === 'stone')!.owned; recipeStart('gather.stone.v9');
    expect(flow.getSnapshot().expansion.jobs[0]).toMatchObject({ domain: 'production', recipeId: 'gather.stone.v9', activeTicks: 0 });
  });
  pumpTests('stone gathering', 4);
  it('commits actual gathered stone, changes a permanent loadout, and saves/reloads', () => {
    completed(); expect(flow.getSnapshot().frame.resources.find(row => row.resourceId === 'stone')!.owned).toBe(previousStock + 3);
    const selected = flow.getSnapshot().build.selected!; const active = selected.loadout.activeSkillIds;
    accepted(flow.dispatchBuild({ kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: flow.getSnapshot().build.revision,
      loadout: { ...selected.loadout, activeSkillIds: [active[1], active[0]] } }));
    checkpointSave();
  });
  it('places, selects and starts the actual library blueprint', () => {
    const proposal = value(flow.preparePlacement({ definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 }));
    const placement = accepted(flow.confirmPlacement(proposal)); const blueprintId = placement.transactionId!;
    expect(flow.select({ kind: 'blueprint', id: blueprintId }).ok).toBe(true);
    flowCommand(flow.dispatchSect({ domain: 'construction', command: { kind: 'construction.start', blueprintId, workerId: 'entity:2', expectedRevision: flow.getSnapshot().expansion.revisions.construction } }));
  });
  pumpTests('library construction', 7);
  it('clears completed blueprint selection, selects the real building, and saves it', () => {
    completed(); expect(flow.getSnapshot().selection).toBeNull(); const library = flow.getSnapshot().expansion.buildings.find(row => row.definitionId === 'library.v9')!;
    expect(flow.select({ kind: 'sect-building', id: library.buildingId }).ok).toBe(true); expect(flow.getSnapshot().cultivation.selected).toBeNull(); checkpointSave();
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`starts genuine research material production ${index + 1}`, () => recipeStart(recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9'));
    // Library (1,3) to storage (7,5) is eight cells each way: at four
    // ticks/cell, genuine study takes 240 work + 64 travel + phase ticks.
    // Six bounded checkpoints cover that journey; no later ticks run once done.
    pumpTests(`research material ${index + 1}`, 6);
    it(`finishes genuine research material production ${index + 1}`, completed);
  }
  it('starts real funded research and saves/reloads the active reservation', () => {
    expect(flow.getSnapshot().expansion.stock.filter(row => ['spirit-stone', 'basic-insight'].includes(row.resourceId)).every(row => row.owned === 2)).toBe(true);
    flowCommand(flow.dispatchSect({ domain: 'research', command: { kind: 'research.start', researchId: 'basic-medicine.v9', workerId: 'entity:2', expectedRevision: flow.getSnapshot().expansion.revisions.research } }));
    checkpointSave(); expect(flow.getSnapshot().expansion.jobs[0]?.domain).toBe('research');
  });
  pumpTests('paid research', 5);
  it('unlocks and starts the real alchemy hall without a synthetic unlock flag', () => {
    completed(); expect(flow.getSnapshot().expansion.completedResearch[0]?.researchId).toBe('basic-medicine.v9');
    const placement = accepted(flow.confirmPlacement(value(flow.preparePlacement({ definitionId: 'alchemy.v9', anchor: { x: 10, y: 1 }, rotation: 0 }))));
    flowCommand(flow.dispatchSect({ domain: 'construction', command: { kind: 'construction.start', blueprintId: placement.transactionId!, workerId: 'entity:2', expectedRevision: flow.getSnapshot().expansion.revisions.construction } }));
  });
  pumpTests('alchemy hall construction', 7);
  it('starts genuine wound-powder production at the finished alchemy hall', () => { completed(); recipeStart('craft.wound-powder.v9'); });
  pumpTests('medicine production', 4);
  it('delivers the real medicine, cancels care without consuming it, then restarts and reloads', () => {
    completed(); expect(flow.getSnapshot().expansion.stock.find(row => row.resourceId === 'wound-powder')?.owned).toBe(1);
    flowCommand(flow.dispatchSect({ domain: 'care', command: { kind: 'care.start', patientId: 'entity:4', expectedRevision: flow.getSnapshot().expansion.revisions.care } }));
    accepted(flow.dispatchSect({ domain: 'care', command: { kind: 'care.cancel', jobId: job, expectedRevision: flow.getSnapshot().expansion.revisions.care } }));
    expect(flow.getSnapshot().expansion.stock.find(row => row.resourceId === 'wound-powder')).toMatchObject({ owned: 1, reserved: 0 });
    flowCommand(flow.dispatchSect({ domain: 'care', command: { kind: 'care.start', patientId: 'entity:4', expectedRevision: flow.getSnapshot().expansion.revisions.care } }));
    checkpointSave(); flow.select({ kind: 'disciple', id: 'entity:4' }); expect(flow.getSnapshot().cultivation.selected?.workOwner?.kind).toBe('care');
  });
  pumpTests('medicine care', 2);
  it('consumes one medicine, heals actual injury, preserves all four sect-domain IDs and roundtrips', () => {
    completed(); expect(flow.getSnapshot().cultivation.selected?.injury).toBe(5);
    expect(flow.getSnapshot().expansion.stock.find(row => row.resourceId === 'wound-powder')).toMatchObject({ owned: 0, reserved: 0 });
    expect(flow.getSnapshot().expansion.recentTerminals.find(row => row.domain === 'care' && row.kind === 'completed')).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
    const exported = value(flow.exportWorld()); const ids = new Set([...Object.keys(exported.commandReceipts), ...exported.sectExpansion.construction.receipts.map(row => row.command.commandId),
      ...exported.sectExpansion.production.receipts.map(row => row.command.commandId), ...exported.sectExpansion.research.receipts.map(row => row.command.commandId), ...exported.sectExpansion.care.receipts.map(row => row.command.commandId)]);
    checkpointSave(); const command = accepted(flow.dispatchCultivation({ kind: 'training.set', discipleId: 'entity:2', expectedRevision: flow.getSnapshot().cultivation.revision, mode: 'duty' }));
    expect(ids.has(command.commandId)).toBe(false); flow.close();
  });
});

describe('real lifecycle selection safety', () => {
  it('stops at a genuine death decision, archives through Session, and clears only the removed selection', () => {
    const source = createUnregisteredWorldV9('session-death'); const actor = source.disciples.find(row => row.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(row => row.discipleId === actor.id)!;
    // Explicit near-birthday source fixture, followed by real fixed ticks.
    actor.birthCalendarTick = 2 - profile.lifespanMonths * MONTH;
    actor.ageMonths = Math.floor((source.clock.calendarTick - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
    const instance = session(recordChecked(source)); const before = instance.getSnapshot();
    instance.frame(0); instance.frame(1000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(2);
    const selected = instance.getSnapshot().cultivation.selected!; expect(selected.pendingDeath).not.toBeNull(); expect(instance.getSnapshot().paused).toBe(true);
    const death = selected.pendingDeath!; accepted(instance.dispatchCultivation({ kind: 'death.finalize', expectedRevision: instance.getSnapshot().cultivation.revision,
      discipleId: selected.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true }));
    expect(instance.getSnapshot().selection).toBeNull(); expect(instance.getSnapshot().cultivation.selected).toBeNull();
    expect(before.frame.disciples.some(row => row.id === selected.discipleId)).toBe(true);
    const world = value(instance.exportWorld()); expect(world.disciples.some(row => row.id === selected.discipleId)).toBe(false);
    expect(world.legacy.archivedIdentities.some(row => row.discipleId === selected.discipleId)).toBe(true);
    expect(parseSaveV9(value(instance.exportSave(metadata))).ok).toBe(true);
  });
});
