import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as sessionEngine from '../../src/application/world-engine';
import { ApplicationSession, type EmergencyRetreatReview } from '../../src/application/session';
import { createWorld, cloneJson } from '../../src/core/kernel';
import { createWorldV8, dispatchCommandV8, advanceTicksWithStatusV8, previewWorldEmergencyRetreatV8, validateWorldStateV8 } from '../../src/core/kernel/v8';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { lookupCommandReceipt } from '../../src/core/world/history-access';

let encounter: WorldStateV8;
beforeAll(() => {
  let world = createWorldV8('session-emergency-review');
  const departed = dispatchCommandV8(world, { commandId: 'review:depart', sequence: 0, issuedTick: 0, kind: 'expedition.command',
    payload: { command: { commandId: 'review:depart', kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: world.disciples.slice(0, 2).map(member => member.id) } } } });
  expect(departed.result.status).toBe('accepted');
  const traveled = advanceTicksWithStatusV8(departed.world, 1200);
  expect(traveled.capacityStop).toBeNull(); expect(traveled.invariantStop).toBeNull(); world = traveled.world;
  const entered = dispatchCommandV8(world, { commandId: 'review:enter', sequence: 1, issuedTick: world.clock.simulationTick,
    kind: 'expedition.command', payload: { command: { commandId: 'review:enter', kind: 'expedition.continue' } } });
  expect(entered.result.status).toBe('accepted');
  const fought = advanceTicksWithStatusV8(entered.world, 17);
  expect(fought.capacityStop).toBeNull(); expect(fought.invariantStop).toBeNull(); encounter = fought.world;
  expect(encounter.expedition.battle?.controller.elapsedTicks).toBe(17);
  expect(validateWorldStateV8(encounter)).toEqual([]);
}, 30_000);

function review(session: ApplicationSession) {
  const prepared = session.prepareEmergencyRetreat(); expect(prepared).not.toBeNull(); return prepared!;
}

describe('owned emergency retreat review pause', () => {
  it('captures actual immutable losses and holds battle only ephemerally without allocating IDs', () => {
    const session = new ApplicationSession(encounter); const before = session.exportWorld(); const prepared = review(session);
    expect(prepared.preview).toEqual(previewWorldEmergencyRetreatV8(encounter));
    expect(Object.isFrozen(prepared.preview.losses.injuryByDisciple[0])).toBe(true);
    expect(session.prepareEmergencyRetreat()).toBe(prepared); expect(session.getEmergencyRetreatReview()).toBe(prepared);
    expect(session.getSnapshot().paused).toBe(true); expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    session.frame(0); session.frame(100_000); session.setSpeed(3); session.togglePlayerPause();
    expect(session.exportWorld()).toEqual(before); expect(session.getSnapshot().lastCommand).toBeNull();
    expect(session.cancelEmergencyRetreat('not-this-review')).toBe(false);
    expect(session.getEmergencyRetreatReview()).toBe(prepared);
    expect(session.cancelEmergencyRetreat(prepared.reviewId)).toBe(true);
    expect(session.exportWorld()).toEqual(before); expect(session.getSnapshot().paused).toBe(false);
    session.frame(100_000); expect(session.exportWorld()).toEqual(before);
    session.frame(100_050); expect(session.getBattleController()?.elapsedTicks).toBe(18);
  });

  it('requires loss acknowledgement and commits once from the frozen actual preview', () => {
    const session = new ApplicationSession(encounter); const prepared = review(session); const before = session.exportWorld();
    expect(session.confirmEmergencyRetreat(prepared, false)).toEqual({ ok: false, code: 'LOSS_ACKNOWLEDGEMENT_REQUIRED' });
    expect(session.exportWorld()).toEqual(before); expect(session.getEmergencyRetreatReview()).toBe(prepared);
    const result = session.confirmEmergencyRetreat(prepared, true);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.result.commandId).toBe('app-command.0');
    const after = session.exportWorld();
    expect(after.expedition.run?.settlement?.reason).toBe('emergencyRetreat');
    expect(validateWorldStateV8(after)).toEqual([]); expect(session.getEmergencyRetreatReview()).toBeNull();
    const receipt = lookupCommandReceipt(after, result.result.commandId)!;
    expect(JSON.parse(receipt.fingerprint).payload.command).toMatchObject({ expectedBasisStamp: prepared.preview.basisStamp, acknowledgeLoss: true });
    expect(session.confirmEmergencyRetreat(prepared, true)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.exportWorld()).toEqual(after);
  });

  it('rejects tampered losses, cancelled tokens and replacement epochs without consuming command IDs', () => {
    const session = new ApplicationSession(encounter); const first = review(session); const forged = cloneJson(first) as EmergencyRetreatReview;
    forged.preview.losses.injuryByDisciple[0]!.addedInjury += 1;
    expect(session.confirmEmergencyRetreat(forged, true)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.cancelEmergencyRetreat(first.reviewId)).toBe(true);
    const second = review(session); expect(second.reviewId).not.toBe(first.reviewId);
    expect(session.cancelEmergencyRetreat(first.reviewId)).toBe(false);
    expect(session.confirmEmergencyRetreat(first, true)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    session.replaceWorld(encounter);
    expect(session.getEmergencyRetreatReview()).toBeNull();
    const third = review(session); expect(third.sessionEpoch).not.toBe(second.sessionEpoch);
    expect(session.confirmEmergencyRetreat(second, true)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.confirmEmergencyRetreat(third, true)).toMatchObject({ ok: true, result: { commandId: 'app-command.0' } });
    expect(session.exportWorld().clock.pauseReasons).toContain('player');
  });

  it('does not steal outer overlay, storage, player or hidden pause ownership on cancel', () => {
    const session = new ApplicationSession(encounter);
    session.setPaused('player', true); session.setForeground({ focused: false });
    const before = session.exportWorld(); const prepared = review(session);
    session.setOverlayPaused(true); session.setStorageReadOnly(true);
    expect(session.confirmEmergencyRetreat(prepared, true)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    session.setStorageReadOnly(false);
    expect(session.confirmEmergencyRetreat(prepared, true)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    expect(session.cancelEmergencyRetreat(prepared.reviewId)).toBe(true);
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    expect(session.exportWorld()).toEqual(before);
    session.setOverlayPaused(false);
    expect(session.getSnapshot().clock.pauseReasons).toEqual(before.clock.pauseReasons);
    expect(session.getSnapshot().clock.pauseReasons).toEqual(expect.arrayContaining(['player', 'hidden']));
  });

  it('keeps App overlay held when replacement cancels a review', () => {
    const session = new ApplicationSession(encounter); const prepared = review(session); session.setOverlayPaused(true);
    session.replaceWorld(encounter);
    expect(session.getEmergencyRetreatReview()).toBeNull(); expect(session.cancelEmergencyRetreat(prepared.reviewId)).toBe(false);
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    expect(session.exportWorld().clock.pauseReasons).toEqual(['player']);
    session.setOverlayPaused(false); expect(session.getSnapshot().clock.pauseReasons).toEqual(['player']);
  });

  it('holds ordinary dispatches and respects persisted error pauses without releasing the review', () => {
    const session = new ApplicationSession(encounter); const prepared = review(session); const before = session.exportWorld();
    const result = session.dispatchExpedition({ kind: 'expedition.continue' });
    expect(result.rejection?.code).toBe('CORE_PAUSED_ERROR'); expect(session.exportWorld()).toEqual(before);
    session.setPaused('error', true);
    expect(session.confirmEmergencyRetreat(prepared, true)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    expect(session.getEmergencyRetreatReview()).toBe(prepared);
    session.setPaused('error', false);
    expect(session.confirmEmergencyRetreat(prepared, true)).toMatchObject({ ok: true });
  });

  it('fault injection: rejects emergency confirmation after an engine-boundary invariant stop', () => {
    const world = cloneJson(encounter);
    expect(validateWorldStateV8(world)).toEqual([]);
    const session = new ApplicationSession(world);
    // Inject only the engine's reported stop at its public adapter boundary.
    // The validated World and real encounter remain unchanged; this is not gameplay evidence.
    const fault = vi.spyOn(sessionEngine, 'advanceEngineTicks').mockImplementationOnce(state => {
      if (state.version !== 8) throw new Error('Expected the genuine v8 test boundary');
      return { state, capacityStop: null,
        invariantStop: { code: 'INVARIANT_FAILURE', tick: state.world.clock.simulationTick, message: 'Injected boundary failure' } };
    });
    try {
      session.frame(0); session.frame(50);
      expect(fault).toHaveBeenCalledOnce();
    } finally { fault.mockRestore(); }
    expect(session.exportWorld()).toEqual(world);
    session.setPaused('error', false);
    const prepared = review(session); const before = session.exportWorld();
    expect(session.confirmEmergencyRetreat(prepared, true)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    expect(session.getSnapshot().lastCommand).toBeNull(); expect(session.exportWorld()).toEqual(before);
    expect(session.getEmergencyRetreatReview()).toBe(prepared);
  });

  it('returns no review outside an eligible real v8 encounter and never upgrades v7', () => {
    const legacy = new ApplicationSession(createWorld('no-legacy-emergency')); const before = legacy.exportWorld();
    expect(legacy.prepareEmergencyRetreat()).toBeNull(); expect(legacy.getEmergencyRetreatReview()).toBeNull();
    const actual = review(new ApplicationSession(encounter));
    expect(legacy.confirmEmergencyRetreat(actual, true)).toEqual({ ok: false, code: 'INVALID_COMMAND' });
    expect(legacy.exportWorld()).toEqual(before);
    expect(new ApplicationSession(createWorldV8('no-encounter')).prepareEmergencyRetreat()).toBeNull();
  });
});
