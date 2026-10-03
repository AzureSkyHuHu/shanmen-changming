import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ApplicationSessionV10, type PreparedSessionV10, type SessionCommandResultV10,
  type SessionRequestV10, type SessionValueV10 } from '../../src/application/session-v10';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { lookupCommandReceipt } from '../../src/core/world/history-access';
import * as owners from '../../src/core/world/runtime-instance-v10';
import type { PrivateRuntimeInstanceV10 } from '../../src/core/world/runtime-instance-v10';
import * as views from '../../src/core/world/runtime-views-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from '../sect-expansion/fixtures/v9-runtime';

const metadata = { buildId: 'private-session-v10-test', savedAt: '2026-10-02T22:00:00Z' };
const sessions: ApplicationSessionV10[] = [];
const fresh = (seed = 'private-session-v10'): WorldStateV10 => cloneJson(createUnregisteredWorldV10(seed));
const session = (source: unknown = fresh()): ApplicationSessionV10 => {
  const instance = new ApplicationSessionV10(source); sessions.push(instance); return instance;
};
function value<T>(outcome: SessionValueV10<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome)); return outcome.value;
}
function result(outcome: SessionCommandResultV10) {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome)); return outcome.result;
}
function accepted(outcome: SessionCommandResultV10) {
  const command = result(outcome); expect(command.status, JSON.stringify(command)).toBe('accepted'); return command;
}
function train(instance: ApplicationSessionV10, mode: 'duty' | 'rest' = 'duty') {
  return instance.dispatchCultivation({ kind: 'training.set', discipleId: 'entity:2', mode,
    expectedRevision: instance.getSnapshot().cultivation.revision });
}
function keys(input: unknown): string[] {
  return input !== null && typeof input === 'object' ? Object.entries(input).flatMap(([key, child]) => [key, ...keys(child)]) : [];
}
function wrapOwners(wrap: (owner: PrivateRuntimeInstanceV10, index: number) => PrivateRuntimeInstanceV10) {
  const actual = owners.createPrivateRuntimeV10; let index = 0;
  return vi.spyOn(owners, 'createPrivateRuntimeV10').mockImplementation(input => {
    const created = actual(input); return created.ok ? { ...created, instance: wrap(created.instance, index++) } : created;
  });
}
afterEach(() => { vi.restoreAllMocks(); for (const instance of sessions.splice(0)) instance.close(); });

describe('private v10 Session projections and fixed scheduling', () => {
  it('uses bounded frozen DTOs without cold exports during queries, frames or commands', () => {
    const source = fresh(); const snapshots: ReturnType<typeof vi.fn>[] = [];
    wrapOwners(owner => { const snapshot = vi.fn(() => owner.snapshot()); snapshots.push(snapshot); return { ...owner, snapshot }; });
    const instance = session(source); snapshots.forEach(spy => spy.mockClear()); const before = instance.getSnapshot();
    source.inventory.wood.owned = 0; instance.frame(0); expect(value(instance.frame(1000))).toBe(20);
    instance.select({ kind: 'disciple', id: 'entity:4' }); accepted(train(instance));
    expect(snapshots.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(before.frame.clock.simulationTick).toBe(0); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(20);
    expect(instance.getSnapshot().frame.resources.find(row => row.resourceId === 'wood')?.owned).not.toBe(0);
    for (const forbidden of ['history', 'commandReceipts', 'receipts', 'randomStreams', 'sequences', 'workSpans', 'payments'])
      expect(keys(instance.getSnapshot())).not.toContain(forbidden);
    expect(Reflect.set(before.frame.disciples[0]!.position, 'x', 999)).toBe(false);
    expect(Object.keys(instance).some(key => /owner|world|engine/i.test(key) && key !== 'getEngineVersion')).toBe(false);
    const exported = value(instance.exportWorld()); expect(snapshots.at(-1)).toHaveBeenCalledTimes(1);
    expect(Reflect.set(exported.inventory.wood, 'owned', 1)).toBe(false); expect(instance.getEngineVersion()).toBe(10);
  });
  it('preserves snapshots across partial/no-op frames and uses 1x/3x plus a twenty-tick cap', () => {
    const instance = session(); const before = instance.getSnapshot();
    instance.frame(0); instance.frame(24); instance.frame(49); instance.setSpeed(1); expect(instance.getSnapshot()).toBe(before);
    instance.frame(50); const stepped = instance.getSnapshot(); expect(stepped.frame.clock.simulationTick).toBe(1);
    expect(stepped.frame).not.toBe(before.frame); expect(stepped.worldRevision).toBe(1);
    instance.setSpeed(3); instance.frame(100); expect(value(instance.frame(150))).toBe(3);
    instance.setSpeed(1); instance.frame(200); expect(value(instance.frame(3200))).toBe(20);
    expect(value(instance.frame(3200))).toBe(20); expect(value(instance.frame(3200))).toBe(20);
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(64);
    expect(instance.frame(NaN)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    instance.frame(2000); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(64);
  });
  it('keeps selection changes local to revision and rejects malformed selections', () => {
    const instance = session(); const before = instance.getSnapshot();
    instance.select({ kind: 'building', id: before.frame.buildings[0]!.id });
    expect(instance.getSnapshot()).toMatchObject({ worldRevision: before.worldRevision, revision: before.revision + 1 });
    expect(instance.getSnapshot().cultivation.selected).toBeNull(); const selected = instance.getSnapshot();
    expect(instance.select({ kind: 'disciple', id: 'absent' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(instance.getSnapshot()).toBe(selected);
  });
  it('contains a projection fault with a complete old view set and a refreshable safety hold', () => {
    const instance = session(); const before = instance.getSnapshot();
    vi.spyOn(views, 'projectRuntimeFrameV10').mockImplementationOnce(() => { throw new Error('Injected DTO failure'); });
    instance.frame(0); instance.frame(50); const failed = instance.getSnapshot();
    expect(failed).toMatchObject({ paused: true, runtimeFailure: 'query-failed', worldRevision: 0 });
    expect(failed.frame).toBe(before.frame); expect(failed.expansion).toBe(before.expansion);
    expect(value(instance.exportWorld()).clock.simulationTick).toBe(1);
    expect(train(instance)).toMatchObject({ ok: false, code: 'SESSION_HELD' });
    expect(instance.refresh().ok).toBe(true); expect(instance.getSnapshot()).toMatchObject({ runtimeFailure: null, worldRevision: 1 });
  });
  it('contains subscriber errors and blocks reentrant mutation without starving other listeners', () => {
    const instance = session(); const nested: unknown[] = []; const listener = vi.fn();
    instance.subscribe(() => { nested.push(train(instance), instance.close()); throw new Error('subscriber'); });
    const unsubscribe = instance.subscribe(listener); expect(instance.setSpeed(3)).toMatchObject({ ok: true, changed: true });
    expect(nested).toEqual([{ ok: false, kind: 'session-rejection', code: 'BUSY' }, { ok: false, kind: 'session-rejection', code: 'BUSY' }]);
    expect(listener).toHaveBeenCalledTimes(1); unsubscribe(); unsubscribe(); instance.setSpeed(1); expect(listener).toHaveBeenCalledTimes(1);
  });
  it('keeps foreground ephemeral and discards hidden time while retaining incomplete pre-pause time', () => {
    const instance = session(); instance.frame(0); instance.frame(25); const before = value(instance.exportWorld());
    instance.setForeground({ visible: false }); expect(instance.getSnapshot().paused).toBe(true);
    expect(canonicalStringify(value(instance.exportWorld()))).toBe(canonicalStringify(before));
    expect(train(instance)).toMatchObject({ ok: false, code: 'SESSION_HELD' }); instance.frame(100000);
    instance.setForeground({ visible: true, focused: false }); instance.frame(200000); instance.setForeground({ focused: true });
    instance.frame(300000); instance.frame(300025); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
    expect(accepted(train(instance)).commandId).toBe('app-command.0');
  });
  for (const hold of ['setStorageReadOnly', 'setStorageBusy', 'setOverlayPaused', 'setReviewPaused'] as const) {
    it(`${hold} blocks time and command identity allocation without changing World`, () => {
      const source = fresh(); let ids = 0; let advances = 0;
      wrapOwners(owner => ({ ...owner, nextApplicationCommand(start) { ids++; return owner.nextApplicationCommand(start); },
        advance(count) { advances++; return owner.advance(count); } }));
      const instance = session(source); const before = canonicalStringify(value(instance.exportWorld())); ids = 0;
      instance[hold](true); const held = instance.getSnapshot(); instance.frame(0); instance.frame(1e6);
      expect(train(instance)).toMatchObject({ ok: false, code: 'SESSION_HELD' }); expect(ids).toBe(0); expect(advances).toBe(0);
      expect(instance.getSnapshot()).toBe(held); expect(canonicalStringify(value(instance.exportWorld()))).toBe(before);
      instance[hold](false); expect(accepted(train(instance)).commandId).toBe('app-command.0');
    });
  }
  it('preserves domain pauses and only explicit clock controls change persisted player/hidden reasons', () => {
    const source = fresh(); source.clock.pauseReasons = ['danger', 'choice', 'error', 'save-capacity', 'hidden'];
    const instance = session(source); instance.setForeground({ visible: false }); instance.setForeground({ visible: true });
    expect(instance.getSnapshot().frame.clock.pauseReasons).toEqual(source.clock.pauseReasons);
    instance.setPaused('hidden', false); instance.setPaused('player', true); instance.setSpeed(3); instance.setPaused('player', false);
    expect(instance.getSnapshot().frame.clock.pauseReasons).toEqual(['danger', 'choice', 'error', 'save-capacity']);
    instance.frame(0); expect(value(instance.frame(1e6))).toBe(0);
    // @ts-expect-error No domain-pause escape hatch.
    expect(instance.setPaused('danger', false)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
  it('retains a real partial tick and latched numeric stop through controls and a refused replacement', () => {
    const source = fresh(); source.sectExpansion = { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } };
    const instance = session(source); instance.frame(0);
    expect(instance.frame(100)).toMatchObject({ ok: false, kind: 'runtime-failure', error: 'internal-failure' });
    expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1); const stopped = instance.getSnapshot().stopped;
    expect(stopped?.kind).toBe('invalid-records'); instance.setSpeed(3); instance.setPaused('player', true); instance.setPaused('player', false);
    instance.setForeground({ visible: false }); instance.setForeground({ visible: true }); expect(instance.getSnapshot().stopped).toEqual(stopped);
    const before = instance.getSnapshot(); expect(instance.replaceWorld(createUnregisteredWorldV9()).ok).toBe(false);
    expect(instance.getSnapshot()).toBe(before); expect(value(instance.frame(1e6))).toBe(0);
    expect(instance.replaceWorld(fresh('recovered')).ok).toBe(true); expect(instance.getSnapshot().stopped).toBeNull();
  });
});

describe('typed real commands and identity-owned one-use proposals', () => {
  it('preserves v10 domain, cultivation, build and legacy rejection unions', () => {
    const instance = session();
    expect(result(instance.dispatchSect({ domain: 'upgrade', command: { kind: 'upgrade.start', expectedRevision: 0,
      buildingId: 'sect-building:1', workerId: 'entity:2' } })).rejection).toMatchObject({ code: 'SECT_EXPANSION_REJECTED', detail: 'UNKNOWN_BUILDING' });
    expect(result(instance.dispatchCultivation({ kind: 'training.set', expectedRevision: 999, discipleId: 'entity:2', mode: 'duty' })).rejection?.code).toBe('CULTIVATION_REJECTED');
    expect(result(instance.dispatchBuild({ kind: 'tree.respec', expectedRevision: 0, discipleId: 'missing', nodeIds: [] })).rejection?.code).toBe('BUILD_REJECTED');
    expect(result(instance.dispatch({ kind: 'production.start', payload: { recipeId: 'missing', workerId: 'entity:2' } })).rejection?.code).toBe('UNKNOWN_RECIPE');
    expectTypeOf<Extract<SessionRequestV10, { kind: 'expedition.command' | 'campaign.command' | 'sect-economy.command' }>>().toEqualTypeOf<never>();
  });
  it('issues exact IDs and avoids real current receipt collisions after reload', () => {
    const instance = session(); const first = accepted(train(instance)); expect(first.commandId).toBe('app-command.0');
    const exported = value(instance.exportWorld()); expect(lookupCommandReceipt(exported, first.commandId)?.result).toEqual(first);
    expect(instance.replaceWorld(exported).ok).toBe(true); const second = accepted(train(instance, 'rest'));
    expect(second.commandId).toBe('app-command.1');
    expect(lookupCommandReceipt(value(instance.exportWorld()), second.commandId)?.result).toEqual(second);
  });
  it('rejects hostile requests without getters or IDs and holds a reentrancy fence during capture', () => {
    const instance = session(); let getters = 0; const nested: unknown[] = [];
    const payload = Object.defineProperty({}, 'kind', { enumerable: true, get() { getters++; return 'inventory.discard'; } });
    // @ts-expect-error Runtime malformed request coverage.
    expect(instance.dispatch(payload)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' }); expect(getters).toBe(0);
    const request = new Proxy({ kind: 'inventory.discard' as const, payload: { resourceId: 'wood' as const, quantity: 1 } }, {
      ownKeys(target) { nested.push(instance.setSpeed(3)); return Reflect.ownKeys(target); },
    });
    expect(accepted(instance.dispatch(request)).commandId).toBe('app-command.0');
    expect(nested.every(row => JSON.stringify(row) === JSON.stringify({ ok: false, kind: 'session-rejection', code: 'BUSY' }))).toBe(true);
  });
  it('uses exact stamps, not copies or cross-Session proposals, and consumes rejected upgrade proposals once', () => {
    const instance = session(); const other = session();
    const proposal = value(instance.prepareUpgrade({ buildingId: 'sect-building:1', workerId: 'entity:2' }));
    expect(proposal.view).toMatchObject({ eligible: false, scope: 'upgrade-start-conditions' });
    expect(other.confirmUpgrade(proposal)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    expect(instance.confirmUpgrade({ ...proposal })).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    instance.setOverlayPaused(true); expect(instance.confirmUpgrade(proposal)).toMatchObject({ ok: false, code: 'SESSION_HELD' });
    expect(instance.isProposalCurrent(proposal)).toBe(true); instance.setOverlayPaused(false);
    expect(result(instance.confirmUpgrade(proposal)).status).toBe('rejected');
    expect(instance.confirmUpgrade(proposal)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    const stale = value(instance.prepareUpgrade({ buildingId: 'sect-building:1', workerId: 'entity:2' }));
    instance.setSpeed(3); expect(instance.confirmUpgrade(stale)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
  });
  it('confirms a real placement under review hold and stales breakthrough previews after owner publication', () => {
    const instance = session(); const breakthrough = value(instance.prepareBreakthrough('entity:2'));
    const proposal = value(instance.preparePlacement({ definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 }));
    instance.setReviewPaused(true); const placed = accepted(instance.confirmPlacement(proposal));
    expect('sectResult' in placed ? placed.sectResult : null).toMatchObject({ domain: 'construction', repeated: false });
    expect(instance.getSnapshot().expansion.blueprints.some(row => row.blueprintId === placed.transactionId)).toBe(true);
    expect(instance.confirmPlacement(proposal)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    expect(instance.confirmBreakthrough(breakthrough)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
  });
});

describe('cold save and fully prepared atomic replacement', () => {
  it('rejects a genuinely unfunded recovery-only source at every cold Session entrance', () => {
    const instance = session(); accepted(instance.confirmPlacement(value(instance.preparePlacement({ definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 }))));
    const planned = value(instance.exportWorld()); const source: WorldStateV10 = { ...planned, sectExpansion: { ...planned.sectExpansion,
      construction: { ...planned.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]); const before = instance.getSnapshot();
    expect(() => new ApplicationSessionV10(source)).toThrow(expect.objectContaining({ failure: { ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' } }));
    expect(instance.prepareReplacement(source)).toMatchObject({ ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' });
    expect(ApplicationSessionV10.prepareSession(source)).toMatchObject({ ok: false, kind: 'save-rejection', code: 'UNSUPPORTED_SCOPE' });
    expect(instance.getSnapshot()).toBe(before);
  });
  it('roundtrips exact admitted World, including persisted pauses, speed, training and history', () => {
    const donor = session(); accepted(train(donor, 'rest')); donor.setSpeed(3); donor.setPaused('player', true); donor.setPaused('hidden', true);
    const source = value(donor.exportWorld()); const bytes = canonicalStringify(source); const instance = session();
    instance.setStorageBusy(true); const token = value(instance.prepareReplacement(source)); const before = instance.getSnapshot();
    instance.setForeground({ visible: false }); expect(instance.getSnapshot()).toBe(before);
    expect(instance.commitReplacement(token)).toMatchObject({ ok: true, changed: true });
    expect(canonicalStringify(value(instance.exportWorld()))).toBe(bytes); instance.setStorageBusy(false);
    instance.setForeground({ visible: true }); expect(canonicalStringify(value(instance.exportWorld()))).toBe(bytes);
    expect(instance.getSnapshot()).toMatchObject({ sessionEpoch: 1, paused: true, frame: { clock: { speed: 3, pauseReasons: ['player', 'hidden'] } } });
    expect(instance.getSnapshot().cultivation.summaries.find(row => row.discipleId === 'entity:2')?.trainingMode).toBe('rest');
    const text = value(instance.exportSave(metadata)); expect(text).toBe(serializeSaveV10(createSaveEnvelopeV10(source, metadata)));
    const parsed = parseSaveV10(text); expect(parsed.ok).toBe(true); if (parsed.ok) expect(canonicalStringify(parsed.world)).toBe(bytes);
  });
  it('binds a wholly preallocated new Session once without exposing an advanceable staged instance', () => {
    const source = fresh('staged'); source.clock.speed = 3; source.clock.pauseReasons = ['hidden', 'player'];
    const token = value(ApplicationSessionV10.prepareSession(source)); expect(Object.keys(token).sort()).toEqual(['kind', 'preview']);
    expect(token.preview).toMatchObject({ paused: true, holds: { staging: true } }); expect(Object.isFrozen(token.preview.frame)).toBe(true);
    const create = vi.spyOn(owners, 'createPrivateRuntimeV10');
    expect(ApplicationSessionV10.bindPreparedSession({ ...token })).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    const instance = value(ApplicationSessionV10.bindPreparedSession(token)); sessions.push(instance);
    expect(create).not.toHaveBeenCalled(); expect(instance.getSnapshot().holds.staging).toBe(false);
    expect(canonicalStringify(value(instance.exportWorld()))).toBe(canonicalStringify(source));
    expect(ApplicationSessionV10.bindPreparedSession(token)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(ApplicationSessionV10.discardPreparedSession(token)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
  });
  it('requires explicit hidden resume after staged binding and preserves real cultivation/capacity pause owners', () => {
    const plain = fresh('hidden-resume'); plain.clock.pauseReasons = ['hidden'];
    const instance = value(ApplicationSessionV10.bindPreparedSession(value(ApplicationSessionV10.prepareSession(plain)))); sessions.push(instance);
    instance.setForeground({ visible: false }); instance.setForeground({ visible: true });
    expect(canonicalStringify(value(instance.exportWorld()))).toBe(canonicalStringify(plain));
    expect(instance.getSnapshot().paused).toBe(true); instance.setPaused('hidden', false);
    instance.frame(0); expect(value(instance.frame(50))).toBe(1);

    const imminent = fresh('real-decision-resume'); const actor = imminent.disciples.find(row => row.id === 'entity:2')!;
    const profile = imminent.cultivation.disciples.find(row => row.discipleId === actor.id)!;
    actor.birthCalendarTick = 2 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((imminent.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    const donor = session(imminent); donor.frame(0); donor.frame(100); const pending = cloneJson(value(donor.exportWorld()));
    expect(pending.clock.pauseReasons).toContain('cultivation'); expect(pending.cultivation.pendingDeaths).toHaveLength(1);
    pending.clock.pauseReasons.push('hidden', 'save-capacity');
    const retained = value(ApplicationSessionV10.bindPreparedSession(value(ApplicationSessionV10.prepareSession(pending)))); sessions.push(retained);
    retained.setForeground({ visible: false }); retained.setForeground({ visible: true });
    expect(canonicalStringify(value(retained.exportWorld()))).toBe(canonicalStringify(pending));
    expect(retained.setPaused('hidden', false)).toMatchObject({ ok: true, changed: true });
    expect(retained.getSnapshot().frame.clock.pauseReasons).toEqual(['cultivation', 'save-capacity']);
    expect(retained.getSnapshot().paused).toBe(true); retained.frame(0); expect(value(retained.frame(1000))).toBe(0);
    expect(value(retained.exportWorld()).cultivation.pendingDeaths).toEqual(pending.cultivation.pendingDeaths);
  });
  it('closes discarded staged owners and rejects hostile token lookalikes without reflection', () => {
    const source = fresh(); const closes: ReturnType<typeof vi.fn>[] = [];
    wrapOwners(owner => { const close = vi.fn(() => owner.close()); closes.push(close); return { ...owner, close }; });
    const token = value(ApplicationSessionV10.prepareSession(source)); let reads = 0;
    const hostile = new Proxy({}, { get() { reads++; throw new Error('No reads'); }, getPrototypeOf() { reads++; throw new Error('No prototype'); } });
    expect(ApplicationSessionV10.bindPreparedSession(hostile as PreparedSessionV10)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(reads).toBe(0); expect(ApplicationSessionV10.discardPreparedSession(token)).toMatchObject({ ok: true });
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
    expect(ApplicationSessionV10.bindPreparedSession(token)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
  });
  for (const injected of ['frame', 'cultivation', 'build', 'expansion', 'identity'] as const) {
    it(`closes both temporary owners and preserves all live state on ${injected} preparation failure`, () => {
      const source = fresh('failing-candidate'); const instance = session(); instance.frame(0); instance.frame(25);
      const proposal = value(instance.prepareBreakthrough('entity:2')); const before = instance.getSnapshot(); const exported = value(instance.exportWorld());
      const closes: ReturnType<typeof vi.fn>[] = [];
      wrapOwners((owner, index) => {
        const close = vi.fn(() => owner.close()); closes.push(close); if (index === 0) return { ...owner, close };
        const failed = { ...owner.frame(), ok: false as const, error: 'query-failed' as const, value: null };
        return { ...owner, close, ...(injected === 'frame' ? { frame: () => failed } : {}),
          ...(injected === 'cultivation' ? { cultivation: () => failed } : {}), ...(injected === 'build' ? { build: () => failed } : {}),
          ...(injected === 'expansion' ? { expansion: () => failed } : {}), ...(injected === 'identity' ? { nextApplicationCommand: () => failed } : {}) };
      });
      expect(instance.replaceWorld(source)).toMatchObject({ ok: false, kind: 'runtime-failure', error: 'query-failed' });
      expect(instance.getSnapshot()).toBe(before); expect(value(instance.exportWorld())).toEqual(exported); expect(instance.isProposalCurrent(proposal)).toBe(true);
      expect(closes).toHaveLength(2); expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
      instance.frame(50); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
      expect(accepted(train(instance)).commandId).toBe('app-command.0');
    });
  }
  it('never runs candidate clock controls and rejects old/malformed worlds without touching the live cache', () => {
    const instance = session(); const source = fresh(); const controls: ReturnType<typeof vi.fn>[] = [];
    wrapOwners(owner => { const controlClock = vi.fn(() => { throw new Error('Preparation must not control clock'); });
      controls.push(controlClock); return { ...owner, controlClock }; });
    const token = value(instance.prepareReplacement(source)); expect(instance.commitReplacement(token).ok).toBe(true);
    expect(controls.every(control => control.mock.calls.length === 0)).toBe(true);
    const before = instance.getSnapshot(); expect(instance.replaceWorld(createUnregisteredWorldV9())).toMatchObject({ ok: false, code: 'UNSUPPORTED_SIMULATION_VERSION' });
    let getters = 0; const hostile = Object.defineProperty({}, 'clock', { enumerable: true, get() { getters++; throw null; } });
    expect(instance.replaceWorld(hostile)).toMatchObject({ ok: false, kind: 'save-rejection' }); expect(getters).toBe(0); expect(instance.getSnapshot()).toBe(before);
  });
  it('rejects copied, superseded, published, discarded and cross-session replacement tokens', () => {
    const instance = session(); const other = session(); const next = fresh('replacement'); const closes: ReturnType<typeof vi.fn>[] = [];
    wrapOwners(owner => { const close = vi.fn(() => owner.close()); closes.push(close); return { ...owner, close }; });
    const first = value(instance.prepareReplacement(next)); const second = value(instance.prepareReplacement(next));
    expect(instance.commitReplacement(first)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(instance.commitReplacement({ ...second })).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(other.commitReplacement(second)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    instance.select({ kind: 'disciple', id: 'entity:4' }); expect(instance.commitReplacement(second)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    const third = value(instance.prepareReplacement(next)); instance.discardReplacement(third);
    expect(instance.discardReplacement(third)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    const fourth = value(instance.prepareReplacement(next)); instance.close();
    expect(instance.commitReplacement(fourth)).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
  });
  it('keeps a stable source fence through storage-busy visibility changes and finishes one atomic bind despite listeners', () => {
    const instance = session(); const next = fresh('durable-candidate'); instance.setStorageBusy(true);
    const token = value(instance.prepareReplacement(next)); const source = instance.getSnapshot();
    expect(token).toMatchObject({ sessionEpoch: source.sessionEpoch, worldRevision: source.worldRevision, revision: source.revision });
    const blocked = [instance.select(null), instance.setSpeed(3), instance.setPaused('hidden', true), instance.refresh(), instance.prepareReplacement(next)];
    expect(blocked.every(row => !row.ok && row.kind === 'session-rejection' && row.code === 'SESSION_HELD')).toBe(true);
    instance.setForeground({ visible: false }); instance.frame(1e6); expect(instance.getSnapshot()).toBe(source);
    const nested: unknown[] = []; const seen: string[] = [];
    instance.subscribe(() => { seen.push(instance.getSnapshot().frame.seed); nested.push(instance.commitReplacement(token)); throw new Error('subscriber'); });
    expect(instance.commitReplacement(token)).toMatchObject({ ok: true }); expect(seen).toEqual(['durable-candidate']);
    expect(nested).toEqual([{ ok: false, kind: 'session-rejection', code: 'BUSY' }]);
    expect(instance.getSnapshot()).toMatchObject({ sessionEpoch: source.sessionEpoch + 1, worldRevision: source.worldRevision + 1, revision: source.revision + 1 });
    expect(instance.commitReplacement(token)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    instance.setStorageBusy(false); expect(instance.getSnapshot().paused).toBe(true);
    expect(canonicalStringify(value(instance.exportWorld()))).toBe(canonicalStringify(next));
    instance.setForeground({ visible: true }); instance.frame(2e6); instance.frame(2e6 + 50); expect(instance.getSnapshot().frame.clock.simulationTick).toBe(1);
  });
  it('closes before observing hostile post-close input and releases subscriptions', () => {
    const instance = session(); const listener = vi.fn(); instance.subscribe(listener); instance.close(); let reads = 0;
    const hostile = new Proxy({}, { ownKeys() { reads++; throw new Error('No reflection'); } });
    expect(instance.replaceWorld(hostile)).toMatchObject({ ok: false, code: 'CLOSED' });
    // @ts-expect-error Closed runtime input.
    expect(instance.dispatch(hostile)).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(instance.frame(100)).toMatchObject({ ok: false, code: 'CLOSED' }); expect(instance.exportWorld()).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(reads).toBe(0); expect(listener).toHaveBeenCalledTimes(1);
  });
});

/** Test-only record lift of real, paid old history. This is not a migration API.
 * New research and the Session upgrade below use real v10 reducers/owner calls. */
function records(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected L1 construction origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Unexpected alternative old medicine'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
describe('actual funded v10 upgrade through Session', () => {
  let old: WorldStateV9; let ready: WorldStateV10;
  beforeAll(() => { old = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const)
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  beforeAll(() => {
    let world = records(old); const commandId = 'app-command.0';
    const next = prepareUnregisteredCommandCandidateV10(world, { kind: 'sect.command', commandId, sequence: 0, issuedTick: world.clock.simulationTick,
      payload: { domain: 'research', command: { kind: 'research.start', commandId, expectedRevision: world.sectExpansion.research.revision,
        researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } } });
    expect(next.result.status).toBe('accepted'); world = next.world;
    for (let tick = 0; tick < 1600 && !world.sectExpansion.research.jobs.at(-1)!.terminal; tick++) world = prepareNormalTickCandidateV10(world);
    expect(world.sectExpansion.research.jobs.at(-1)!.terminal).not.toBeNull(); expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); ready = world;
  }, 120000);
  it('previews, starts, projects, saves/reloads and cancels an actual L1→L2 upgrade', () => {
    const instance = session(ready); const buildingId = ready.sectExpansion.construction.buildings.find(row => row.definitionId === 'alchemy.v9')!.buildingId;
    const request = { buildingId, workerId: 'entity:2' }; const stale = value(instance.prepareUpgrade(request));
    expect(stale.view).toMatchObject({ eligible: true, requiredTicks: 400, scope: 'upgrade-start-conditions' });
    instance.setSpeed(3); expect(instance.confirmUpgrade(stale)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    const preview = value(instance.prepareUpgrade(request)); instance.setReviewPaused(true);
    const started = accepted(instance.confirmUpgrade(preview)); expect(started.commandId).toBe('app-command.1');
    expect('sectResult' in started ? started.sectResult : null).toMatchObject({ domain: 'upgrade', repeated: false });
    expect(instance.confirmUpgrade(preview)).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    expect(instance.getSnapshot().cultivation.selected?.workOwner?.kind).toBe('upgrade');
    expect(instance.getSnapshot().expansion.jobs.find(row => row.jobId === started.transactionId)).toMatchObject({ domain: 'upgrade', activeTicks: 0 });
    instance.setReviewPaused(false); instance.frame(0); expect(value(instance.frame(50))).toBe(3);
    const before = value(instance.exportWorld()); const parsed = parseSaveV10(value(instance.exportSave(metadata)));
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    expect(instance.replaceWorld(parsed.world).ok).toBe(true); expect(canonicalStringify(value(instance.exportWorld()))).toBe(canonicalStringify(before));
    const cancelled = accepted(instance.dispatchSect({ domain: 'upgrade', command: { kind: 'upgrade.cancel', jobId: started.transactionId!,
      expectedRevision: instance.getSnapshot().expansion.revisions.upgrade } }));
    expect(cancelled.commandId).toBe('app-command.2'); expect('sectResult' in cancelled ? cancelled.sectResult?.domain : null).toBe('upgrade');
    expect(instance.getSnapshot().expansion.jobs.some(row => row.domain === 'upgrade')).toBe(false);
    expect(instance.getSnapshot().expansion.recentTerminals.some(row => row.domain === 'upgrade' && row.kind === 'cancelled')).toBe(true);
  }, 60000);
});
