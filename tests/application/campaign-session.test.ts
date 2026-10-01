import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as sessionEngine from '../../src/application/world-engine';
import { ApplicationSession, type CampaignProposal } from '../../src/application/session';
import { createWorld, CALENDAR_TICKS_PER_MONTH, cloneJson } from '../../src/core/kernel';
import { createWorldV8, migrateWorldV7ToV8, advanceTicksWithStatusV8, dispatchCommandV8, validateWorldStateV8 } from '../../src/core/kernel/v8';
import { previewWorldCampaign, projectWorldCampaign } from '../../src/core/world/campaign-queries';
import { lookupCommandReceipt } from '../../src/core/world/history-access';
import type { WorldState } from '../../src/core/world/types';
import type { CampaignPlayerRequest } from '../../src/core/world/campaign-types';
import type { PlayerExpeditionCommandV8 } from '../../src/core/expeditions/v8-world-types';

const equipment: CampaignPlayerRequest = { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' };
function earnedWorld() {
  // Captured actual v7 expedition settlement, never a fabricated victory/claim.
  const source = JSON.parse(readFileSync(new URL('../integration/fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: WorldState };
  return migrateWorldV7ToV8(source.payload);
}
function proposal(session: ApplicationSession, request = equipment) {
  const value = session.prepareCampaign(request);
  expect(value).not.toBeNull();
  return value!;
}

describe('campaign application authority and proposals', () => {
  it('queries a genuine fresh v8 through an immutable narrow cache without reserving IDs', () => {
    const world = createWorldV8('fresh-campaign-session'); const before = JSON.stringify(world);
    const session = new ApplicationSession(world); const projection = session.getCampaignProjection()!;
    expect(projection).toEqual(projectWorldCampaign(world)); expect(projection.routes).toHaveLength(5);
    expect(Object.isFrozen(projection.routes[0])).toBe(true);
    expect(Reflect.set(projection.routes[0]!, 'cleared', true)).toBe(false);
    expect(projection).not.toHaveProperty('settledRunEvidence'); expect(projection).not.toHaveProperty('history');
    expect(session.getCampaignProjection()).toBe(projection);
    session.select({ kind: 'building', id: world.buildings[0]!.id });
    session.setStorageReadOnly(true); session.setOverlayPaused(true);
    expect(session.getCampaignProjection()).toBe(projection);
    session.setStorageReadOnly(false); session.setOverlayPaused(false);
    session.frame(0); session.frame(50);
    expect(session.getCampaignProjection()).toBe(projection);
    const request: CampaignPlayerRequest = { kind: 'campaign.relief', school: 'sword' };
    const prepared = proposal(session, request);
    expect(prepared.preview).toEqual(previewWorldCampaign(world, request));
    expect(prepared.preview.basisStamp).not.toBe(prepared.basisStamp);
    expect(Object.isFrozen(prepared.preview.request)).toBe(true);
    expect(session.exportWorld().sequences).toEqual(world.sequences);
    expect(JSON.stringify(world)).toBe(before);
    expect(session.getDiscipleNameKey(world.disciples[0]!.id)).toBe(world.disciples[0]!.nameKey);
    expect(session.getDiscipleNameKey('unknown')).toBeNull();
  });

  it('commits a genuine earned claim with the exact request stamp once and keeps repeat guards outside command allocation', () => {
    const world = earnedWorld(); const session = new ApplicationSession(world);
    const displayed = proposal(session); expect(displayed.preview.blockers).toEqual([]);
    const result = session.confirmCampaign(displayed);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.result.commandId).toBe('app-command.0');
    const receipt = lookupCommandReceipt(session.exportWorld(), result.result.commandId)!;
    expect(JSON.parse(receipt.fingerprint).payload.command.expectedBasisStamp).toBe(displayed.preview.basisStamp);
    expect(result.result.campaignResult?.itemInstanceIds).toHaveLength(1);
    expect(validateWorldStateV8(session.exportWorld())).toEqual([]);
    const committed = session.exportWorld();
    expect(session.confirmCampaign(displayed)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.exportWorld()).toEqual(committed);
    const rejected = session.confirmCampaign(proposal(session));
    expect(rejected).toMatchObject({ ok: false, code: 'ALREADY_CLAIMED', result: { commandId: 'app-command.1' } });
  });

  it('rejects changed display costs, swapped requests and global stock changes without submitting', () => {
    const session = new ApplicationSession(earnedWorld()); const displayed = proposal(session);
    const tampered = cloneJson(displayed) as CampaignProposal;
    tampered.preview.costs.push({ resourceId: 'wood', quantity: 1 });
    const swapped = cloneJson(displayed) as CampaignProposal;
    swapped.request = { kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'body' };
    const before = session.exportWorld();
    for (const invalid of [tampered, swapped, { ...displayed, basisStamp: '00000000' }]) {
      expect(session.isCampaignProposalCurrent(invalid)).toBe(false);
      expect(session.confirmCampaign(invalid)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    }
    expect(session.exportWorld()).toEqual(before);
    const stock = session.getSnapshot().resources.find(row => row.resourceId === 'wood')!;
    expect(session.dispatchInventoryDiscard({ resourceId: 'wood', quantity: 1 }, { sessionEpoch: 0,
      resourceId: 'wood', owned: stock.owned, reserved: stock.reserved, capacity: stock.capacity })).toEqual({ ok: true });
    expect(session.getSnapshot().lastCommand?.commandId).toBe('app-command.0');
    expect(session.confirmCampaign(displayed)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.confirmCampaign(proposal(session))).toMatchObject({ ok: true, result: { commandId: 'app-command.1' } });
  });

  it('invalidates an exact same-world proposal across replacement epochs without allocating a command', () => {
    const world = earnedWorld(); const session = new ApplicationSession(world); const displayed = proposal(session);
    session.replaceWorld(world);
    expect(session.getCampaignProjection()?.basisStamp).toBe(displayed.basisStamp);
    expect(session.confirmCampaign(displayed)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(session.confirmCampaign(proposal(session))).toMatchObject({ ok: true, result: { commandId: 'app-command.0' } });
  });

  it('blocks read-only, overlay and error pauses before issuing IDs, while player pause allows management', () => {
    const session = new ApplicationSession(earnedWorld()); const displayed = proposal(session); const before = session.exportWorld();
    session.setStorageReadOnly(true);
    expect(session.confirmCampaign(displayed)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    session.setStorageReadOnly(false); session.setOverlayPaused(true);
    expect(session.confirmCampaign(displayed)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    session.setOverlayPaused(false);
    expect(session.exportWorld()).toEqual(before);
    session.setPaused('error', true);
    expect(session.confirmCampaign(proposal(session))).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    session.setPaused('error', false); session.setPaused('player', true);
    expect(session.confirmCampaign(displayed)).toMatchObject({ ok: true, result: { commandId: 'app-command.0' } });
  });

  it('fault injection: retains an engine-boundary invariant stop without a persisted error pause', () => {
    const world = createWorldV8('campaign-invariant-stop');
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
    expect(session.getSnapshot().clock.pauseReasons).toContain('error');
    const before = session.exportWorld();
    expect(session.confirmCampaign(proposal(session, { kind: 'campaign.relief', school: 'sword' })))
      .toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    expect(session.exportWorld()).toEqual(before);
    expect(session.getSnapshot().lastCommand).toBeNull();
  });

  it('never migrates a v7 session or exposes campaign actions through it', () => {
    const legacy = createWorld('legacy-campaign-session'); const session = new ApplicationSession(legacy);
    expect(session.getCampaignProjection()).toBeNull(); expect(session.prepareCampaign(equipment)).toBeNull();
    const foreign = proposal(new ApplicationSession(earnedWorld()));
    expect(session.confirmCampaign(foreign)).toEqual({ ok: false, code: 'INVALID_COMMAND' });
    expect(session.exportWorld()).toEqual(legacy); expect(session.getEngineVersion()).toBe(7);
    const workerId = legacy.disciples.find(member => member.canWork)!.id;
    expect(session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId } }).commandId).toBe('app-command.0');
  });

  it('resolves a genuinely deceased archived identity after authority retires the live actor', () => {
    const world = createWorldV8('campaign-name-archive'); const actor = world.disciples[0]!; const profile = world.cultivation.disciples[0]!;
    actor.birthCalendarTick = world.clock.calendarTick + 17 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    const session = new ApplicationSession(world); session.frame(0); session.frame(850);
    const pending = session.exportWorld().cultivation.disciples.find(member => member.discipleId === actor.id)!;
    expect(pending.pendingDeathId).not.toBeNull();
    expect(session.dispatchCultivation({ kind: 'death.finalize', expectedRevision: session.getSnapshot().cultivation.revision,
      discipleId: actor.id, deathId: pending.pendingDeathId!, cause: 'lifespan', acknowledgeDeath: true }).status).toBe('accepted');
    session.frame(1000); session.frame(1050);
    const retired = session.exportWorld();
    expect(retired.disciples.some(member => member.id === actor.id)).toBe(false);
    expect(session.getDiscipleNameKey(actor.id)).toBe(actor.nameKey);
    expect(validateWorldStateV8(retired)).toEqual([]);
  });

  it('claims from a fresh v8 campaign only after three actual engine battles and settlement', () => {
    let world = createWorldV8('expedition-world'); let serial = 0; let battles = 0;
    type Body<T> = T extends unknown ? Omit<T, 'commandId'> : never;
    const expedition = (request: Body<PlayerExpeditionCommandV8>) => {
      const sequence = serial++; const commandId = `session-journey:${sequence}`;
      const outcome = dispatchCommandV8(world, { commandId, sequence, issuedTick: world.clock.simulationTick,
        kind: 'expedition.command', payload: { command: { ...request, commandId } as PlayerExpeditionCommandV8 } });
      expect(outcome.result.status, JSON.stringify(outcome.result)).toBe('accepted'); world = outcome.world;
    };
    const advance = (ticks: number) => {
      const outcome = advanceTicksWithStatusV8(world, ticks);
      expect(outcome.invariantStop).toBeNull(); expect(outcome.capacityStop).toBeNull(); world = outcome.world;
    };
    expedition({ kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: world.disciples.slice(0, 2).map(member => member.id) } });
    for (let guard = 0; guard < 40 && world.expedition.run?.phase !== 'Ended'; guard++) {
      const run = world.expedition.run!;
      if (run.phase === 'InEncounter') { advance(5000); battles++; }
      else if (run.phase === 'RewardPending') {
        const offer = run.offers.find(entry => entry.offerId === run.currentOfferId)!;
        expedition({ kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision });
      } else if (world.expedition.travel) advance(1200);
      else expedition({ kind: 'expedition.continue' });
    }
    expect(battles).toBe(3); expect(world.expedition.run?.settlement?.reason).toBe('victory');
    const session = new ApplicationSession(world); const prepared = proposal(session);
    expect(prepared.preview.blockers).toEqual([]);
    expect(session.confirmCampaign(prepared)).toMatchObject({ ok: true });
    expect(validateWorldStateV8(session.exportWorld())).toEqual([]);
  }, 120_000);
});
