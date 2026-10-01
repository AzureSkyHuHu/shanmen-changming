import { lookupProduction } from '../../src/core/world/history-access';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApplicationSession, type BuildRequest, type DepartureProposal, type ExpeditionRequest } from '../../src/application/session';
import { createWorld, canonicalStringify, CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel';
import { ExpeditionPanel, defaultExpeditionSquad, expeditionBattlePresentations, departureFormMatches, expeditionDepartureRequest } from '../../src/app/ExpeditionPanel';
import { commandFeedbackKey } from '../../src/application/status-messages';
import type { BuildLoadout } from '../../src/core/builds';

class Frames {
  private timestamp = 0;
  constructor(private readonly session: ApplicationSession) { session.frame(0); }
  step(): void { this.timestamp += 1000; this.session.frame(this.timestamp); }
  until(predicate: () => boolean, maximumFrames = 600): void {
    for (let count = 0; count < maximumFrames && !predicate(); count += 1) this.step();
    expect(predicate(), JSON.stringify(this.session.exportWorld().diagnostics)).toBe(true);
  }
}
function depart(session: ApplicationSession) {
  return session.confirmDeparture(session.prepareExpedition({ squadIds: defaultExpeditionSquad(session.getSnapshot()), routeId: 'route.qingfeng-trial' }));
}
function expeditionMarkup(session: ApplicationSession, locale: 'zh-CN' | 'en' = 'en') {
  return renderToStaticMarkup(createElement(ExpeditionPanel, { session, world: session.getSnapshot(), controller: session.getBattleController(), locale, readOnly: false, onReturnSect: () => undefined }));
}

describe('expedition preparation and shared command ports', () => {
  it('preselects two truly available adults and previews the actual eight-meal four-month route without mutation', () => {
    const session = new ApplicationSession();
    const selected = defaultExpeditionSquad(session.getSnapshot());
    expect(selected).toHaveLength(2);
    expect(selected.every((id) => session.getSnapshot().disciples.find((entry) => entry.id === id)!.ageMonths >= 192)).toBe(true);
    const before = canonicalStringify(session.exportWorld());
    const proposal = session.prepareExpedition({ squadIds: selected, routeId: 'route.qingfeng-trial' });
    expect(proposal.preview.expectedMonths).toBe(4);
    expect(proposal.preview.requestedSupplies).toEqual([{ resourceId: 'meal', quantity: 8 }]);
    expect(proposal.preview.blockers).toEqual([]);
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    expect(Object.isFrozen(proposal.preview.requestedSupplies)).toBe(true);
  });

  it('departing cancels real work, debits carried supplies and locks actual builds atomically', () => {
    const session = new ApplicationSession();
    const squad = defaultExpeditionSquad(session.getSnapshot());
    const job = session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: squad[0]! } });
    const outcome = depart(session);
    expect(outcome.status).toBe('accepted');
    const world = session.exportWorld();
    expect(world.commandReceipts[outcome.commandId]!.fingerprint).toContain(`"commandId":"${outcome.commandId}"`);
    expect(world.inventory.meal.owned).toBe(0);
    expect(world.inventory.wood.reserved).toBe(0);
    expect(lookupProduction(world, job.transactionId!)!.state).toBe('Cancelled');
    expect(world.expedition.run!.phase).toBe('Travelling');
    for (const id of squad) {
      expect(world.builds.disciples.find((entry) => entry.discipleId === id)!.lock?.runId).toBe(world.expedition.run!.runId);
      expect(world.cultivation.disciples.find((entry) => entry.discipleId === id)!.activityOwner?.runId).toBe(world.expedition.run!.runId);
    }
  });

  it('invalidates a departure proposal after resource changes, revision changes or loading an identical world', () => {
    const session = new ApplicationSession();
    const proposal = session.prepareExpedition({ squadIds: defaultExpeditionSquad(session.getSnapshot()), routeId: 'route.qingfeng-trial' });
    session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: proposal.preview.squadIds[0]! } });
    expect(session.isDepartureProposalCurrent(proposal)).toBe(false);
    expect(session.confirmDeparture(proposal).status).toBe('rejected');
    expect(session.exportWorld().expedition.run).toBeNull();
    const refreshed = session.prepareExpedition({ squadIds: [...proposal.preview.squadIds], routeId: 'route.qingfeng-trial' });
    session.replaceWorld(session.exportWorld());
    expect(session.confirmDeparture(refreshed).status).toBe('rejected');
    expect(session.exportWorld().inventory.meal.owned).toBe(8);
  });

  it('rechecks displayed costs and squad against copied proposals and live form edits', () => {
    const session = new ApplicationSession();
    const ids = defaultExpeditionSquad(session.getSnapshot());
    const proposal = session.prepareExpedition(expeditionDepartureRequest(ids, '')!);
    const before = canonicalStringify(session.exportWorld());
    const changedSupplies = JSON.parse(JSON.stringify(proposal)) as DepartureProposal;
    changedSupplies.request.supplies = [{ resourceId: 'meal', quantity: 9 }];
    expect(session.confirmDeparture(changedSupplies).status).toBe('rejected');
    const changedSquad = JSON.parse(JSON.stringify(proposal)) as DepartureProposal;
    changedSquad.request.squadIds = [ids[0]!];
    expect(session.confirmDeparture(changedSquad).status).toBe('rejected');
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    expect(departureFormMatches(proposal, ids, '')).toBe(true);
    expect(departureFormMatches(proposal, [ids[0]!], '')).toBe(false);
    expect(departureFormMatches(proposal, ids, '9')).toBe(false);
    const refreshed = session.prepareExpedition(expeditionDepartureRequest([ids[0]!], '')!);
    expect(departureFormMatches(refreshed, [ids[0]!], '')).toBe(true);
    expect(refreshed.preview.requestedSupplies).toEqual([{ resourceId: 'meal', quantity: 4 }]);
  });

  it('blocks storage-locked requests and never exposes outcome, month, death, loot or grant authority', () => {
    const session = new ApplicationSession();
    const before = canonicalStringify(session.exportWorld());
    for (const request of [
      { kind: 'encounter.resolve', result: { outcome: 'victory' } },
      { kind: 'time.commit', resultingCalendarMonth: 100 },
      { kind: 'members.died', discipleIds: ['entity:1'] },
      { kind: 'run.settle', loot: [{ resourceId: 'wood', quantity: 999 }] },
    ]) expect(session.dispatchExpedition(request as unknown as ExpeditionRequest).status).toBe('rejected');
    expect(session.dispatchBuild({ kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fake', ruleId: 'expedition.first-victory', expectedRevision: 0 } as unknown as BuildRequest).status).toBe('rejected');
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    session.setStorageReadOnly(true);
    session.setSpeed(3); session.togglePlayerPause();
    expect(session.exportWorld().clock.speed).toBe(1);
    expect(session.exportWorld().clock.pauseReasons).not.toContain('player');
    expect(depart(session).rejection?.code).toBe('CORE_PAUSED_ERROR');
    expect(session.exportWorld().inventory.meal.owned).toBe(8);
    expect(session.exportWorld().expedition.run).toBeNull();
  });

  it('queries a stable immutable build frame and commits only genuine player build commands', () => {
    const session = new ApplicationSession();
    const frame = session.getBuildFrame();
    expect(session.getBuildFrame()).toBe(frame);
    const disciple = frame.builds.disciples[1]!;
    expect(() => { (disciple.loadout.activeSkillIds as unknown as string[])[0] = 'fabricated'; }).toThrow();
    session.frame(0); session.frame(50);
    expect(session.getBuildFrame()).toBe(frame);
    const loadout: BuildLoadout = { ...disciple.loadout, activeSkillIds: [disciple.loadout.activeSkillIds[1], disciple.loadout.activeSkillIds[0]], equipment: { ...disciple.loadout.equipment } };
    const changed = session.dispatchBuild({ kind: 'loadout.set', discipleId: disciple.discipleId, loadout, expectedRevision: frame.builds.revision });
    expect(changed.status).toBe('accepted');
    expect(changed.buildResult?.commandId).toBe(changed.commandId);
    expect(session.getBuildFrame()).not.toBe(frame);
    expect(session.getBuildFrame().builds.disciples[1]!.loadout.activeSkillIds).toEqual(loadout.activeSkillIds);
  });
});

describe('actual checkpoint, battle and return UI integration', () => {
  it('advances true travel checkpoints, preserves pauses and releases locks only after real safe-return settlement', () => {
    const session = new ApplicationSession();
    expect(depart(session).status).toBe('accepted');
    const frames = new Frames(session);
    frames.step();
    expect(session.getSnapshot().expedition.travelProgressTicks).toBe(20);
    const savedTick = session.getSnapshot().clock.calendarTick;
    session.setPaused('player', true); frames.step();
    session.setForeground({ visible: false }); frames.step();
    session.setForeground({ visible: true }); frames.step();
    expect(session.getSnapshot().clock.calendarTick).toBe(savedTick);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    session.setPaused('player', false);
    frames.until(() => session.getSnapshot().expedition.phase === 'AtNode');
    expect(session.getSnapshot().clock.calendarTick).toBe(CALENDAR_TICKS_PER_MONTH);
    expect(session.getSnapshot().clock.pauseReasons).toContain('expedition');
    session.setPaused('player', true);
    expect(session.dispatchExpedition({ kind: 'expedition.retreat' }).status).toBe('accepted');
    expect(session.getSnapshot().expedition.phase).toBe('Ending');
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.dispatchExpedition({ kind: 'expedition.continue' }).status).toBe('accepted');
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    session.setPaused('player', false);
    frames.until(() => session.getSnapshot().expedition.phase === 'Ended');
    const final = session.exportWorld();
    expect(final.expedition.history.at(-1)!.reason).toBe('safeRetreat');
    expect(final.expedition.history.at(-1)!.endedCalendarTick).toBe(CALENDAR_TICKS_PER_MONTH * 2);
    expect(final.inventory.meal.owned).toBe(4);
    expect(final.builds.disciples.every((entry) => entry.lock === null)).toBe(true);
    const inventory = final.inventory;
    expect(session.dispatchExpedition({ kind: 'expedition.continue' }).status).toBe('rejected');
    expect(session.exportWorld().inventory).toEqual(inventory);
  });

  it('exposes a real immutable controller and explicit participant/enemy identities without advancing on render', () => {
    const session = new ApplicationSession(); depart(session);
    const frames = new Frames(session);
    frames.until(() => session.getSnapshot().expedition.phase === 'AtNode');
    session.dispatchExpedition({ kind: 'expedition.continue' });
    const controller = session.getBattleController()!;
    expect(controller.outcome.status).toBe('running');
    expect(controller.elapsedTicks).toBe(0);
    expect(Object.isFrozen(controller)).toBe(true);
    const actor = session.getSnapshot().expedition.participants[0]!;
    expect(() => { (controller.battle.entities[actor.battleEntityId]!.position as { x: number }).x = 999; }).toThrow();
    const presentations = expeditionBattlePresentations(session.getSnapshot(), 'en');
    expect(presentations[actor.battleEntityId]!.name).toBeTruthy();
    for (const enemy of session.getSnapshot().expedition.enemies) expect(presentations[enemy.battleEntityId]!.art).toBe(enemy.archetypeId);
    const before = canonicalStringify(session.exportWorld());
    const html = expeditionMarkup(session); const chinese = expeditionMarkup(session, 'zh-CN');
    expect(html).toContain('Combat continues automatically');
    expect(html).not.toContain('Text is temporarily unavailable');
    expect(chinese).not.toContain('文本暂不可用');
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    expect(session.getBattleController()).toBe(controller);
    expect('battle' in session.getSnapshot().expedition).toBe(false);
    expect('commandLog' in session.getSnapshot().expedition).toBe(false);
    expect('effectReceipts' in session.getSnapshot().expedition).toBe(false);
    const calendar = session.getSnapshot().clock.calendarTick;
    const enemy = session.getSnapshot().expedition.enemies[0]!;
    session.setPaused('player', true);
    const tactic = session.dispatchExpedition({ kind: 'expedition.tactic', order: { kind: 'focus', actorId: actor.battleEntityId, targetId: enemy.battleEntityId } });
    expect(tactic.status).toBe('accepted');
    expect(session.getBattleController()!.battle.tick).toBe(controller.battle.tick);
    session.setPaused('player', false); frames.step(); frames.step();
    expect(session.getBattleController()!.elapsedTicks).toBeGreaterThan(0);
    expect(session.getSnapshot().clock.calendarTick).toBe(calendar);
  });

  it('rejects unsafe retreat, stale offers and locked loadouts while real auto combat earns rewards', () => {
    const world = createWorld('ui-offer-integration'); world.inventory.meal.owned = 16;
    const session = new ApplicationSession(world);
    const squadIds = world.disciples.map((entry) => entry.id);
    session.confirmDeparture(session.prepareExpedition({ squadIds, routeId: 'route.qingfeng-trial' }));
    expect(session.dispatchExpedition({ kind: 'expedition.retreat' }).rejection?.expeditionCode).toBe('INVALID_PHASE');
    const locked = session.getBuildFrame().builds.disciples[0]!;
    const rejected = session.dispatchBuild({ kind: 'tree.respec', discipleId: locked.discipleId, nodeIds: [], expectedRevision: session.getBuildFrame().builds.revision });
    expect(rejected.rejection?.buildCode).toBe('EXPEDITION_LOCKED');
    expect(commandFeedbackKey(rejected)).toBe('buildView.locked');
    const frames = new Frames(session);
    frames.until(() => session.getSnapshot().expedition.phase === 'AtNode');
    session.dispatchExpedition({ kind: 'expedition.continue' });
    expect(session.dispatchExpedition({ kind: 'expedition.retreat' }).status).toBe('rejected');
    frames.until(() => session.getSnapshot().expedition.phase !== 'InEncounter');
    expect(session.getSnapshot().expedition.phase).toBe('RewardPending');
    const offer = session.getSnapshot().expedition.currentOffer!;
    expect(offer.candidateDefinitionIds.length).toBeGreaterThan(0);
    expect('rngBefore' in offer).toBe(false);
    const bad = session.dispatchExpedition({ kind: 'expedition.choose', offerId: offer.offerId, offerRevision: offer.revision + 1, definitionId: offer.candidateDefinitionIds[0]!, holderId: offer.eligibleHolderIdsByCard[offer.candidateDefinitionIds[0]!]![0] ?? null });
    expect(bad.status).toBe('rejected');
    const chosen = session.dispatchExpedition({ kind: 'expedition.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId: offer.candidateDefinitionIds[0]!, holderId: offer.eligibleHolderIdsByCard[offer.candidateDefinitionIds[0]!]![0] ?? null });
    expect(chosen.status).toBe('accepted');
    expect(session.getSnapshot().expedition.talentInstances).toHaveLength(1);
    const duplicate = session.dispatchExpedition({ kind: 'expedition.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId: offer.candidateDefinitionIds[0]!, holderId: offer.eligibleHolderIdsByCard[offer.candidateDefinitionIds[0]!]![0] ?? null });
    expect(duplicate.status).toBe('rejected');
    expect(session.getSnapshot().expedition.talentInstances).toHaveLength(1);
  });
});
