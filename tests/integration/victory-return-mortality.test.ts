import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExpeditionPanel } from '../../src/app/ExpeditionPanel';
import { ApplicationSession } from '../../src/application/session';
import { contentIdentity, LEGACY_V7_CONTENT } from '../../src/content/registry';
import { recordRegisteredCampaignVictoryV2 } from '../../src/core/campaign/v2';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { registeredWorldRun } from '../../src/core/expeditions/v8-world-adapter';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { parseSave } from '../../src/core/kernel/save';
import { cloneJson } from '../../src/core/kernel/serialization';
import { advanceTicksWithStatusV8, createWorldV8, dispatchCommandV8, createSaveEnvelopeV8, serializeSaveV8, parseSaveV8,
  migrateWorldV7ToV8, previewWorldExpeditionV8, projectWorldCampaign, validateWorldStateV8,
  type CommandV8, type PlayerExpeditionCommandV8, type WorldStateV8 } from '../../src/core/kernel/v8';
import { translate } from '../../src/i18n';
import provenance from './fixtures/save-v7-campaign-provenance.json';

type Body<T> = T extends T ? Omit<T, 'commandId'> : never;
const metadata = { buildId: 'victory-return-mortality', savedAt: '2026-10-01T19:00:00Z' };
const routeId = 'route.qingfeng-trial' as const;
const month = CALENDAR_TICKS_PER_MONTH;

function reload(world: WorldStateV8): WorldStateV8 {
  const parsed = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.world).toEqual(world);
  return parsed.world;
}
function advance(world: WorldStateV8, ticks: number): WorldStateV8 {
  const result = advanceTicksWithStatusV8(world, ticks);
  expect(result.invariantStop, JSON.stringify(result.invariantStop)).toBeNull();
  expect(result.capacityStop).toBeNull();
  expect(validateWorldStateV8(result.world)).toEqual([]);
  return result.world;
}
function act(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>) {
  const commandId = `return-mortality:${world.clock.simulationTick}:${world.expedition.run?.revision ?? 0}`;
  const command: CommandV8 = { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'expedition.command', payload: { command: { ...body, commandId } as PlayerExpeditionCommandV8 } };
  const result = dispatchCommandV8(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
  expect(validateWorldStateV8(result.world)).toEqual([]);
  return result.world;
}

/** Explicit boundary fixture, not a claim of having simulated a full lifetime.
 * Only birth ticks and their matching current ages change, before any action.
 * Combat, month advancement, expiry events, death IDs and finalization are real.
 */
function nearLifespanBoundary(deadCount: number, returnTicks: number) {
  const world = createWorldV8('expedition-world');
  const squadIds = world.disciples.slice(0, 2).map(member => member.id);
  const dyingIds = squadIds.slice(0, deadCount);
  for (const discipleId of dyingIds) {
    const actor = world.disciples.find(member => member.id === discipleId)!;
    const profile = world.cultivation.disciples.find(member => member.discipleId === discipleId)!;
    actor.birthCalendarTick = 3 * month + returnTicks - profile.lifespanMonths * month;
    actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / month);
    profile.ageMonths = actor.ageMonths;
  }
  expect(validateWorldStateV8(world)).toEqual([]);
  expect(world.cultivation.pendingDeaths).toEqual([]);
  expect(world.cultivation.deaths).toEqual([]);
  const preview = previewWorldExpeditionV8(world, { routeId, squadIds });
  expect(preview.blockers).toEqual([]);
  expect(preview.warnings.filter(warning => warning.code === 'LIFESPAN_BEFORE_RETURN').map(warning => warning.discipleId)).toEqual(dyingIds);
  return { world: reload(world), squadIds, dyingIds };
}

function winActualBattles(world: WorldStateV8, squadIds: string[]): WorldStateV8 {
  let next = act(world, { kind: 'expedition.depart', request: { routeId, squadIds } });
  let battles = 0;
  for (let guard = 0; guard < 30 && next.expedition.run?.phase !== 'Ending'; guard++) {
    const run = next.expedition.run!;
    if (run.phase === 'InEncounter') {
      const calendar = next.clock.calendarTick;
      next = advance(next, 5000);
      expect(next.clock.calendarTick).toBe(calendar);
      expect(next.expedition.run?.encounterResults.at(-1)?.outcome).toBe('victory');
      battles++;
    } else if (run.phase === 'RewardPending') {
      const offer = run.offers.find(entry => entry.offerId === run.currentOfferId)!;
      next = act(next, { kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision });
    } else if (next.expedition.travel) next = advance(next, month);
    else next = act(next, { kind: 'expedition.continue' });
  }
  expect(battles).toBe(3);
  expect(next.clock.calendarTick).toBe(3 * month);
  expect(next.expedition.run?.phase).toBe('Ending');
  expect(next.expedition.run?.settlement).toMatchObject({ reason: 'victory', committed: false, returnMonths: 1, returnProgress: 0 });
  expect(next.expedition.run?.members.every(member => member.alive)).toBe(true);
  expect(next.campaign.progress.clears).toEqual([]);
  return reload(next);
}

describe('real victory followed by mortality on the return leg', () => {
  it.each([
    { label: 'no returners after a partial prepaid month', deadCount: 2, returnTicks: 17 },
    { label: 'no returners at the exact return checkpoint', deadCount: 2, returnTicks: month },
    { label: 'one living returner at the exact return checkpoint', deadCount: 1, returnTicks: month },
  ])('$label preserves settlement and survivor-only entitlements', ({ deadCount, returnTicks }) => {
    const fixture = nearLifespanBoundary(deadCount, returnTicks);
    let world = winActualBattles(fixture.world, fixture.squadIds);
    const sealed = cloneJson(world.expedition.run!.settlement!);
    const outcomes = cloneJson(world.expedition.run!.encounterResults);
    const runId = world.expedition.run!.runId;
    world = act(world, { kind: 'expedition.continue' });
    const prepaid = cloneJson(world.expedition.run!.admittedCheckpoint!);
    const remainingSupplies = cloneJson(world.expedition.run!.supplies);
    expect(prepaid.supplyCost).toEqual([{ resourceId: 'meal', quantity: 2 }]);
    world = reload(advance(world, returnTicks));
    expect(world.clock.calendarTick).toBe(3 * month + returnTicks);
    expect(world.clock.pauseReasons).toContain('cultivation');
    expect(world.cultivation.pendingDeaths.map(death => death.discipleId)).toEqual(fixture.dyingIds);
    expect(world.expedition.run?.settlement?.committed).toBe(false);

    const deathCommands: { command: CommandV8; result: ReturnType<typeof dispatchCommandV8>['result'] }[] = [];
    for (const discipleId of fixture.dyingIds) {
      const pending = world.cultivation.pendingDeaths.find(death => death.discipleId === discipleId)!;
      const commandId = `return-mortality:death:${discipleId}`;
      const command: CommandV8 = { kind: 'cultivation.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
        payload: { command: { kind: 'death.finalize', commandId, expectedRevision: world.cultivation.revision,
          discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true } } };
      const result = dispatchCommandV8(world, command);
      expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
      world = reload(result.world);
      deathCommands.push({ command, result: result.result });
      expect(world.legacy.estates.find(estate => estate.discipleId === discipleId)).toMatchObject({ pendingRunId: runId, settledMonth: null });
      expect(world.builds.disciples.find(build => build.discipleId === discipleId)?.lock?.runId).toBe(runId);
    }
    expect(world.cultivation.pendingDeaths).toEqual([]);
    const inventoryBeforeSettlement = cloneJson(world.inventory);
    const resumed = advance(reload(world), 1);
    expect(resumed).toEqual(advance(world, 1));
    world = reload(resumed);
    const run = world.expedition.run!;
    const history = world.expedition.history[0]!;
    const survivingIds = fixture.squadIds.filter(id => !fixture.dyingIds.includes(id));
    expect(run.phase).toBe('Ended');
    expect(run.settlement).toMatchObject({ settlementId: sealed.settlementId, reason: 'victory', committed: true,
      loot: sealed.loot, lostLoot: sealed.lostLoot, retainedUnsecuredBps: sealed.retainedUnsecuredBps, unlockIds: sealed.unlockIds,
      unusedSupplies: remainingSupplies });
    expect(run.encounterResults).toEqual(outcomes);
    expect(run.locked).toBe(false);
    expect(run.talentInstances).toEqual([]);
    expect(history).toMatchObject({ runId, reason: 'victory', result: 'completed', survivingDiscipleIds: survivingIds, deadDiscipleIds: fixture.dyingIds,
      endedCalendarTick: 3 * month + returnTicks, loot: sealed.loot, lostLoot: sealed.lostLoot, returnedSupplies: remainingSupplies });
    expect(world.expedition.history).toHaveLength(1);
    expect(world.expedition.effectReceipts.filter(receipt => receipt.kind === 'runSettled')).toHaveLength(1);
    expect(world.expedition.travel).toBeNull();
    expect(world.expedition.blockedReason).toBeNull();
    expect(world.clock.pauseReasons).not.toContain('expedition');
    expect(world.builds.disciples.every(build => build.lock === null)).toBe(true);
    expect(world.cultivation.disciples.every(profile => profile.activityOwner === null)).toBe(true);
    for (const resourceId of RESOURCE_IDS) {
      const credit = [...sealed.loot, ...remainingSupplies].filter(line => line.resourceId === resourceId).reduce((sum, line) => sum + line.quantity, 0);
      expect(world.inventory[resourceId].owned).toBe(inventoryBeforeSettlement[resourceId].owned + credit);
    }
    for (const unlockId of sealed.unlockIds) expect(world.unlocks.filter(id => id === unlockId)).toHaveLength(1);
    expect(run.travelLedger.filter(checkpoint => checkpoint.kind === 'return')).toHaveLength(survivingIds.length ? 1 : 0);
    expect(run.abandonedCheckpoints.filter(entry => entry.checkpoint.checkpointId === prepaid.checkpointId))
      .toEqual(survivingIds.length ? [] : [{ checkpoint: prepaid, reason: 'allMembersDead', abandonedAtCalendarMonth: 3 }]);

    expect(world.campaign.settledRunEvidence).toHaveLength(1);
    expect(world.campaign.settledRunEvidence[0]).toEqual(registeredWorldRun(world));
    expect(world.builds.awards.filter(award => award.ruleId === 'expedition.first-victory').map(award => award.discipleId)).toEqual(survivingIds);
    expect(world.campaign.progress.clears.map(clear => clear.routeId)).toEqual(survivingIds.length ? [routeId] : []);
    expect(world.campaign.clearEvidence).toEqual(survivingIds.length ? [{ routeId, runId }] : []);
    expect(projectWorldCampaign(world).routes.find(route => route.routeId === 'route.miasma-seal')?.available).toBe(survivingIds.length > 0);
    const registeredVictory = recordRegisteredCampaignVictoryV2(world.campaign.progress, routeId, registeredWorldRun(world));
    expect(registeredVictory).toMatchObject(survivingIds.length ? { ok: true, replayed: true } : { ok: false, code: 'INVALID_VICTORY' });

    for (const discipleId of fixture.dyingIds) {
      const deaths = world.cultivation.deaths.filter(death => death.discipleId === discipleId);
      expect(deaths).toHaveLength(1);
      expect(deaths[0]?.cause).toBe('lifespan');
      expect(run.members.find(member => member.discipleId === discipleId)?.permanentDeathId).toBe(deaths[0]!.deathId);
      const estate = world.legacy.estates.find(entry => entry.discipleId === discipleId)!;
      expect(estate).toMatchObject({ pendingRunId: null, settledMonth: Math.floor((3 * month + returnTicks) / month), settledOwner: { kind: 'sect-estate' } });
      expect(estate.transferCommandIds).toHaveLength(estate.itemInstanceIds.length);
      for (const itemId of estate.itemInstanceIds) expect(world.builds.equipment.find(item => item.instanceId === itemId)?.owner).toEqual({ kind: 'sect-estate' });
      expect(world.builds.retiredDisciples.filter(build => build.discipleId === discipleId)).toHaveLength(1);
      expect(world.cultivation.archivedDisciples.filter(profile => profile.discipleId === discipleId)).toHaveLength(1);
      expect(world.legacy.archivedIdentities.filter(identity => identity.discipleId === discipleId)).toHaveLength(1);
    }
    for (const { command, result } of deathCommands) {
      const replay = dispatchCommandV8(world, command);
      expect(replay.result).toEqual(result);
      expect(replay.world).toBe(world);
    }
    // Markup coverage only, not browser/visual acceptance. Reuse this genuinely
    // earned settlement through the real application projection in both locales.
    const session = new ApplicationSession(world);
    const beforeRender = session.exportWorld();
    expect(session.getEngineVersion()).toBe(8);
    expect(session.getSnapshot().expedition.phase).toBe('Ended');
    for (const locale of ['zh-CN', 'en'] as const) {
      const markup = renderToStaticMarkup(createElement(ExpeditionPanel, {
        session, world: session.getSnapshot(), controller: session.getBattleController(), locale,
        readOnly: false, onReturnSect: () => {},
      }));
      const notice = translate(locale, 'expedition.ui.noSurvivorClear');
      expect(notice).not.toBe('expedition.ui.noSurvivorClear');
      if (survivingIds.length === 0) expect(markup).toContain(`<p class="notice">${notice}</p>`);
      else expect(markup).not.toContain(notice);
      expect(markup).toContain(translate(locale, 'expedition.ui.settlementCommitted'));
      expect(markup).not.toContain('expedition.ui.noSurvivorClear');
    }
    expect(session.exportWorld()).toEqual(beforeRender);
    const later = advance(world, 1);
    expect(later.expedition).toEqual(world.expedition);
    expect(later.inventory).toEqual(world.inventory);
    expect(later.builds).toEqual(world.builds);
    expect(later.legacy).toEqual(world.legacy);
    expect(later.campaign).toEqual(world.campaign);
    expect(reload(later)).toEqual(later);
  }, 120_000);

  it('keeps an original v7 completed source and its migrated frozen run unchanged', () => {
    const fixture = provenance.fixtures.find(entry => entry.filename === 'save-v7-ended-clear.json')!;
    const sourceUrl = new URL(`./fixtures/${fixture.filename}`, import.meta.url);
    const text = readFileSync(sourceUrl, 'utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe(fixture.sha256);
    const parsed = parseSave(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const original = cloneJson(parsed.world);
    const migrated = reload(migrateWorldV7ToV8(parsed.world));
    expect(migrated.expedition.protocol).toBe('legacy-v2');
    expect(migrated.expedition.contentIdentity).toEqual(contentIdentity(LEGACY_V7_CONTENT));
    expect(migrated.expedition.run).toEqual(original.expedition.run);
    expect(advance(migrated, 1).expedition).toEqual(migrated.expedition);
    expect(parsed.world).toEqual(original);
    expect(readFileSync(sourceUrl, 'utf8')).toBe(text);
  });
});
