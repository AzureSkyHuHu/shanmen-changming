import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advanceTicksWithStatusV8, createWorldV8, dispatchCommandV8, createSaveEnvelopeV8, serializeSaveV8, parseSaveV8,
  previewWorldCampaign, previewWorldExpeditionV8, previewWorldEmergencyRetreatV8, projectWorldExpeditionV8, validateWorldStateV8, migrateWorldV7ToV8,
  type WorldStateV8, type CommandV8, type PlayerExpeditionCommandV8 } from '../../src/core/kernel/v8';
import { parseSave } from '../../src/core/kernel/save';
import { stableHash } from '../../src/core/kernel/serialization';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import type { CampaignRouteId } from '../../src/core/campaign/types';
const metadata = { buildId: 'v8-real-journey', savedAt: '2026-10-01T17:00:00Z' };
type Body<T> = T extends T ? Omit<T, 'commandId'> : never;
function expedition(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>, suffix = '') {
  const commandId = `journey:${world.clock.simulationTick}:${world.expedition.run?.revision ?? 0}:${world.sequences.nextAction}${suffix}`;
  const command: CommandV8 = { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, kind: 'expedition.command', payload: { command: { ...body, commandId } as PlayerExpeditionCommandV8 } };
  const result = dispatchCommandV8(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
  expect(validateWorldStateV8(result.world)).toEqual([]); return { ...result, command };
}
function step(world: WorldStateV8, ticks: number) {
  const stepped = advanceTicksWithStatusV8(world, ticks);
  expect(stepped.invariantStop).toBeNull(); expect(stepped.capacityStop).toBeNull(); return stepped.world;
}
function restore(world: WorldStateV8) {
  const parsed = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message); return parsed.world;
}
function playToEnd(world: WorldStateV8) {
  let next = world; let realBattles = 0;
  for (let guard = 0; guard < 40 && next.expedition.run?.phase !== 'Ended'; guard++) {
    const run = next.expedition.run!;
    if (run.phase === 'InEncounter') { const tick = next.clock.calendarTick; next = step(next, 5000); expect(next.clock.calendarTick).toBe(tick); realBattles++; }
    else if (run.phase === 'RewardPending') {
      const offer = run.offers.find(entry => entry.offerId === run.currentOfferId)!;
      expect(offer.candidateDefinitionIds.every(id => id !== 'talent.zoumai-chengfu')).toBe(true);
      next = expedition(next, { kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision }).world;
    } else if (next.expedition.travel) next = step(next, 1200);
    else next = expedition(next, { kind: 'expedition.continue' }).world;
  }
  expect(next.expedition.run?.phase).toBe('Ended'); expect(validateWorldStateV8(next)).toEqual([]);
  return { world: next, realBattles };
}

describe('explicit executable v8 World candidate', () => {
  it('creates and saves a fresh distinct version, without granting optional support skills', () => {
    const world = createWorldV8('fresh-v8'); expect(validateWorldStateV8(world)).toEqual([]);
    expect(world.builds.migration).toBeNull(); expect(world.legacy.migrationLifecycle).toBeNull();
    expect(world.contentIdentity).toEqual(contentIdentity(RELEASE_V8_CANDIDATE));
    expect(restore(world)).toEqual(world);
    expect(parseSave(serializeSaveV8(createSaveEnvelopeV8(world, metadata)))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    for (const build of world.builds.disciples) expect(build.learnedSkills).toHaveLength(3);
  });

  it('blocks unavailable routes before spending, then resumes the exact real battle after save', () => {
    let world = createWorldV8('v8-battle-roundtrip'); const ids = world.disciples.slice(0, 2).map(actor => actor.id);
    expect(previewWorldExpeditionV8(world, { squadIds: ids, routeId: 'route.everbright-finale' }).blockers).toContain('CONTENT_MISMATCH');
    const before = stableHash(world);
    const denied = dispatchCommandV8(world, { commandId: 'locked-route', sequence: 0, issuedTick: 0, kind: 'expedition.command', payload: {
      command: { commandId: 'locked-route', kind: 'expedition.depart', request: { squadIds: ids, routeId: 'route.everbright-finale' } } } });
    expect(denied.result.status).toBe('rejected'); expect(stableHash(world)).toBe(before); expect(denied.world.inventory).toEqual(world.inventory);
    world = expedition(world, { kind: 'expedition.depart', request: { squadIds: ids, routeId: 'route.qingfeng-trial' } }).world;
    world = step(world, 1200); world = expedition(world, { kind: 'expedition.continue' }).world; world = step(world, 31);
    expect(world.expedition.battle?.controller.elapsedTicks).toBe(31);
    const restored = restore(world); expect(step(restored, 100)).toEqual(step(world, 100));
    expect(projectWorldExpeditionV8(world).routeId).toBe('route.qingfeng-trial');
  }, 30_000);

  it('runs three genuine encounters, settles once, claims gear and starts an unlocked route', () => {
    let world = createWorldV8('expedition-world'); const ids = world.disciples.slice(0, 2).map(actor => actor.id);
    world = expedition(world, { kind: 'expedition.depart', request: { squadIds: ids, routeId: 'route.qingfeng-trial' } }).world;
    const played = playToEnd(world); world = played.world;
    expect(played.realBattles).toBe(3); expect(world.expedition.run?.settlement?.reason).toBe('victory');
    expect(world.campaign.progress.clears.map(clear => clear.routeId)).toEqual(['route.qingfeng-trial']);
    expect(world.campaign.settledRunEvidence).toHaveLength(1); expect(world.campaign.clearEvidence[0]?.runId).toBe(world.expedition.run?.runId);
    expect(world.builds.awards.filter(award => award.ruleId === 'expedition.first-victory')).toHaveLength(2);
    expect(world.builds.disciples.every(build => build.lock === null)).toBe(true);
    const request = { kind: 'campaign.equipment.claim' as const, routeId: 'route.qingfeng-trial' as CampaignRouteId, discipleId: ids[0]! };
    const preview = previewWorldCampaign(world, request); expect(preview.blockers).toEqual([]);
    const command: CommandV8 = { commandId: 'claim-first-gear', sequence: 100, issuedTick: world.clock.simulationTick, kind: 'campaign.command', payload: {
      command: { ...request, commandId: 'claim-first-gear', expectedBasisStamp: preview.basisStamp } } };
    const claimed = dispatchCommandV8(world, command); expect(claimed.result.status, JSON.stringify(claimed.result)).toBe('accepted'); world = restore(claimed.world);
    const replay = dispatchCommandV8(world, command); expect(replay.result).toEqual(claimed.result); expect(replay.world).toBe(world);
    // Food is replenished through the real recipe and ordinary worker delivery.
    const workerId = world.disciples[1]!.id;
    for (let i = 0; world.inventory.meal.owned < 8 && i < 8; i++) {
      const cooked = dispatchCommandV8(world, { commandId: `cook-next:${i}`, sequence: 110 + i, issuedTick: world.clock.simulationTick,
        kind: 'production.start', payload: { recipeId: 'cook.meal', workerId } });
      expect(cooked.result.status).toBe('accepted'); world = step(cooked.world, 500);
    }
    expect(previewWorldExpeditionV8(world, { squadIds: ids, routeId: 'route.miasma-seal' }).blockers).toEqual([]);
    const nextRun = expedition(world, { kind: 'expedition.depart', request: { squadIds: ids, routeId: 'route.miasma-seal' } }).world;
    expect(nextRun.expedition.routeId).toBe('route.miasma-seal'); expect(nextRun.expedition.contentIdentity).toEqual(contentIdentity(RELEASE_V8_CANDIDATE));
    expect(restore(nextRun)).toEqual(nextRun);
  }, 120_000);

  it('continues a genuine legacy pending offer with its original identity until Ended', () => {
    const text = readFileSync(new URL('./fixtures/save-v7-awaiting-choice.json', import.meta.url), 'utf8'); const parsed = parseSave(text);
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    const migrated = migrateWorldV7ToV8(parsed.world); const originalRun = migrated.expedition.run;
    expect(migrated.expedition.contentIdentity).toEqual(contentIdentity(LEGACY_V7_CONTENT));
    const restored = restore(migrated); expect(restored.expedition.run).toEqual(originalRun);
    const played = playToEnd(restored).world;
    expect(played.expedition.protocol).toBe('legacy-v2'); expect(played.expedition.contentIdentity).toEqual(contentIdentity(LEGACY_V7_CONTENT));
    expect(played.expedition.run?.commandLog.slice(0, originalRun!.commandLog.length)).toEqual(originalRun!.commandLog);
    expect(readFileSync(new URL('./fixtures/save-v7-awaiting-choice.json', import.meta.url), 'utf8')).toBe(text);
    expect(restore(played)).toEqual(played);
  }, 120_000);

  it('confirms an emergency retreat against the actual controller and cannot replay its losses', () => {
    let world = createWorldV8('v8-emergency'); const ids = world.disciples.slice(0, 2).map(actor => actor.id);
    world = expedition(world, { kind: 'expedition.depart', request: { squadIds: ids, routeId: 'route.qingfeng-trial' } }).world;
    world = step(world, 1200); world = expedition(world, { kind: 'expedition.continue' }).world; world = step(world, 17);
    const preview = previewWorldEmergencyRetreatV8(world)!; expect(preview.blockers).toEqual([]);
    const retreated = expedition(world, { kind: 'expedition.emergency-retreat', acknowledgeLoss: true, expectedBasisStamp: preview.basisStamp });
    expect(retreated.world.expedition.run?.settlement?.reason).toBe('emergencyRetreat');
    expect(retreated.world.expedition.run?.encounterResults[0]?.validation.battleSnapshotHash).toBe(stableHash(world.expedition.battle!.controller));
    expect(dispatchCommandV8(restore(retreated.world), retreated.command).result).toEqual(retreated.result);
    const ended = playToEnd(retreated.world).world;
    expect(ended.expedition.history).toHaveLength(1); expect(ended.campaign.progress.clears).toEqual([]); expect(restore(ended)).toEqual(ended);
  }, 30_000);
});
