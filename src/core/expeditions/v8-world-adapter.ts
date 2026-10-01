import { assessDepartureReturnInventory, assessRunReturnInventory } from '../world/expedition-return-capacity';
import { cloneWorldWithSharedHistory, worldEventCursor, worldEventsSince } from '../world/history-access';
import { applyBuildAuthorityCommandV2 as applyBuildAuthorityCommand, buildCombatLoadoutV2 as buildCombatLoadout } from '../builds/v2';
import { getWorldContent, getWorldRunCombatCatalog, getWorldRunEncounter, getWorldBuildContentContext } from '../world/content-access';
import { recordRegisteredCampaignVictoryV2, campaignProgressV2 } from '../campaign/v2';
import { CAMPAIGN_ROUTE_IDS } from '../campaign/types';
import type { CampaignRouteId } from '../campaign/types';
import { contentIdentity } from '../../content/registry';
import { createRegisteredExpedition, applyRegisteredExpeditionCommand, registeredTimeCheckpoint } from './versioned';
import type { RegisteredExpedition } from './versioned';
import { createCombatController, issueTacticalOrder, restoreCombatController, serializeCombatController, stepCombatController } from '../combat/ai';
import { createBattle, queryStat } from '../combat/runtime';
import type { BattleEntityInput } from '../combat/runtime';
import { availableResource, commitReservation, reserveResources } from '../economy/inventory';
import { cancelProduction } from '../economy/production';
import type { ResourceLine } from '../economy/types';
import { CALENDAR_TICKS_PER_MONTH, setClockMode, setPauseReason } from '../kernel/clock';
import { allocateId } from '../kernel/ids';
import { checkedAdd } from '../kernel/numeric';
import { canonicalStringify, compareStable, stableHash } from '../kernel/serialization';
import { dispatchWorldCultivationV8 as dispatchWorldCultivation, hasCultivationDecisionV8 as hasCultivationDecision } from '../world/cultivation-bridge-v8';
import type { WorldStateV8 as WorldState, WorldExpeditionStateV8 as WorldExpeditionState } from '../world/v8-types';
import { addLines, assertPlainJson, copy, freeze, integer, resourceLines, sortedLines, unique, validId } from './shared';
import type { ExpeditionAdapterEffect, ExpeditionCommand, ExpeditionMemberInput, Immutable, ValidatedEncounterOutcome } from './types';
import type { WorldEncounter, WorldExpeditionError, WorldExpeditionResult } from './world-types';
import type { ExpeditionDepartureRequestV8 as ExpeditionDepartureRequest, PlayerExpeditionCommandV8 as PlayerExpeditionCommand, WorldExpeditionPreviewV8 as WorldExpeditionPreview, WorldExpeditionProjectionV8 as WorldExpeditionProjection, WorldEmergencyRetreatPreview } from './v8-world-types';


function buildContext(world: WorldState) { return getWorldBuildContentContext(world) ?? reject('CONTENT_MISMATCH'); }
export function registeredWorldRun(world: WorldState): RegisteredExpedition {
  const state = world.expedition;
  if (!state.run || !state.contentIdentity || !state.routeId) return reject('INVALID_PHASE');
  if (state.protocol === 'legacy-v2' && state.run.schemaVersion === 2) return { schemaVersion: 1, identity: state.contentIdentity, routeId: state.routeId, protocol: 'legacy-v2', run: state.run };
  if (state.protocol === 'release-v3' && state.run.schemaVersion === 3) return { schemaVersion: 1, identity: state.contentIdentity, routeId: state.routeId, protocol: 'release-v3', run: state.run };
  return reject('CONTENT_MISMATCH');
}
const enemyArt: Readonly<Record<string, readonly WorldEncounter['enemies'][number]['archetypeId'][]>> = Object.freeze({
  'encounter.forest-patrol': ['ridge-raider','ridge-raider'], 'encounter.venom-hollow': ['venom-adept','ridge-raider'], 'encounter.stone-warden': ['ruin-guardian'],
  'encounter.miasma-garden': ['venom-adept','ridge-raider'], 'encounter.miasma-keeper': ['venom-adept','venom-adept'],
  'encounter.thunder-crossfire': ['venom-adept','venom-adept'], 'encounter.thunder-conductor': ['venom-adept','ridge-raider','ridge-raider'],
  'encounter.mountain-watch': ['ruin-guardian','ruin-guardian'], 'encounter.mountain-heart': ['ruin-guardian','venom-adept'],
  'encounter.everbright-vanguard': ['ruin-guardian','venom-adept','venom-adept'], 'encounter.everbright-heart': ['ruin-guardian','venom-adept','venom-adept'],
});
const enemyPresentation = (definitionId: string, index: number) => enemyArt[definitionId]?.[index] ?? reject('CONTENT_MISMATCH');

type DomainBody = ExpeditionCommand extends infer C ? C extends ExpeditionCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
export type WorldExpeditionDispatch = { ok: true; world: WorldState; result: WorldExpeditionResult; eventIds: string[] }
  | { ok: false; code: WorldExpeditionError };
class AdapterFault extends Error { constructor(readonly code: WorldExpeditionError) { super(code); } }
function reject(code: WorldExpeditionError): never { throw new AdapterFault(code); }
function bundle(world: WorldState): WorldExpeditionState { return world.expedition; }
function active(world: WorldState): RegisteredExpedition['run'] { return bundle(world).run ?? reject('INVALID_PHASE'); }
function id(world: WorldState, kind: 'action' | 'instance'): string {
  const allocated = allocateId(world.sequences, kind); world.sequences = allocated.sequences; return allocated.id;
}
function setBundle(world: WorldState, fields: Partial<WorldExpeditionState>): WorldState {
  return { ...world, expedition: { ...bundle(world), ...fields } };
}
export function initializeWorldExpeditionV8(): WorldExpeditionState {
  return { schemaVersion: 2, contentIdentity: null, protocol: null, routeId: null, run: null, travel: null, battle: null, effectReceipts: [], deathMappings: [], history: [], forcedWithdrawal: false, blockedReason: null };
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function departureShape(value: unknown): value is ExpeditionDepartureRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as ExpeditionDepartureRequest;
  return (exact(value, ['squadIds', 'routeId']) || exact(value, ['squadIds', 'routeId', 'supplies'])) && CAMPAIGN_ROUTE_IDS.includes(request.routeId)
    && Array.isArray(request.squadIds) && request.squadIds.length >= 1 && request.squadIds.length <= 6
    && request.squadIds.every(validId) && unique(request.squadIds) && (request.supplies === undefined || resourceLines(request.supplies));
}
function tacticalShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const order = value as Record<string, unknown>;
  if (!validId(order.actorId)) return false;
  if (order.kind === 'clearFocus') return exact(value, ['kind', 'actorId']);
  if (order.kind === 'cast') return exact(value, ['kind', 'actorId', 'skillId', 'targetId']) && validId(order.skillId) && validId(order.targetId);
  const keys = order.kind === 'hold' ? ['kind', 'actorId'] : ['kind', 'actorId', 'targetId'];
  return ['hold', 'focus', 'guard'].includes(String(order.kind)) && (order.kind === 'hold' || validId(order.targetId))
    && (exact(value, keys) || (exact(value, [...keys, 'durationTicks']) && integer(order.durationTicks, 1, 10_000)));
}
export function isWorldExpeditionCommandV8(value: unknown): value is PlayerExpeditionCommand {
  try {
    assertPlainJson(value);
    if (!value || typeof value !== 'object') return false;
    const cmd = value as Record<string, unknown>;
    if (!validId(cmd.commandId)) return false;
    if (cmd.kind === 'expedition.depart') return exact(value, ['commandId', 'kind', 'request']) && departureShape(cmd.request);
    if (cmd.kind === 'expedition.emergency-retreat') return exact(value, ['commandId', 'kind', 'expectedBasisStamp', 'acknowledgeLoss']) && typeof cmd.expectedBasisStamp === 'string' && /^[0-9a-f]{8}$/.test(cmd.expectedBasisStamp) && cmd.acknowledgeLoss === true;
    if (['expedition.continue', 'expedition.retreat'].includes(String(cmd.kind))) return exact(value, ['commandId', 'kind']);
    if (cmd.kind === 'expedition.tactic') return exact(value, ['commandId', 'kind', 'order']) && tacticalShape(cmd.order);
    if (!validId(cmd.offerId) || !integer(cmd.offerRevision)) return false;
    if (cmd.kind === 'expedition.choose') return exact(value, ['commandId', 'kind', 'offerId', 'offerRevision', 'definitionId', 'holderId'])
      && validId(cmd.definitionId) && (cmd.holderId === null || validId(cmd.holderId));
    return ['expedition.reroll', 'expedition.supplies'].includes(String(cmd.kind)) && exact(value, ['commandId', 'kind', 'offerId', 'offerRevision']);
  } catch { return false; }
}
export function previewWorldExpeditionV8(world: WorldState, request: ExpeditionDepartureRequest): Immutable<WorldExpeditionPreview> {
  if (!departureShape(request)) throw new TypeError('Invalid departure request');
  const blockers = new Set<WorldExpeditionError>();
  const warnings: WorldExpeditionPreview['warnings'] = [];
  if (!world.expedition || !world.builds) blockers.add('INVALID_STATE');
  if (world.expedition?.run && world.expedition.run.phase !== 'Ended') blockers.add('BUSY');
  if (world.clock.mode !== 'management' || hasCultivationDecision(world)) blockers.add('BLOCKED_BY_DECISION');
  const route = getWorldContent(world).routes.find(route => route.id === request.routeId);
  if (!route || !campaignProgressV2(world.campaign.progress).availableRouteIds.includes(request.routeId)) blockers.add('CONTENT_MISMATCH');
  const specification = route?.specification;
  const expectedMonths = specification ? specification.encounterCount * specification.maximumTravelMonths + specification.returnMonths : 0;
  const minimumSupplies: ResourceLine[] = [{ resourceId: 'meal', quantity: expectedMonths * request.squadIds.length }];
  const supplies = sortedLines(request.supplies ?? minimumSupplies);
  if ((supplies.find(line => line.resourceId === 'meal')?.quantity ?? 0) < minimumSupplies[0]!.quantity
    || supplies.some(line => availableResource(world.inventory[line.resourceId]) < line.quantity)) blockers.add('INSUFFICIENT_SUPPLIES');
  if (route && !assessDepartureReturnInventory(world, { ...request, supplies }).fits) blockers.add('INVENTORY_FULL');
  for (const discipleId of request.squadIds) {
    const profile = world.cultivation.disciples.find(member => member.discipleId === discipleId);
    const disciple = world.disciples.find(member => member.id === discipleId);
    if (!profile || !disciple || profile.lifeState !== 'alive' || profile.activityOwner || profile.activeAttemptId || profile.teaching
      || world.cultivation.disciples.some(teacher => teacher.teaching?.studentId === discipleId)) blockers.add('MEMBER_UNAVAILABLE');
    if (profile && profile.lifespanMonths - profile.ageMonths <= expectedMonths) warnings.push({ code: 'LIFESPAN_BEFORE_RETURN', discipleId });
    if (profile && profile.injury > 0) warnings.push({ code: 'INJURED_MEMBER', discipleId });
    try {
      const build = world.builds.disciples.find(member => member.discipleId === discipleId);
      if (!build || build.lock) blockers.add('BUILD_UNAVAILABLE');
      else buildCombatLoadout({ builds: world.builds, sequences: world.sequences }, discipleId, buildContext(world));
    } catch { blockers.add('BUILD_UNAVAILABLE'); }
  }
  return freeze({ routeId: request.routeId, squadIds: [...request.squadIds].sort(compareStable), expectedMonths,
    minimumSupplies, requestedSupplies: supplies, blockers: [...blockers], warnings });
}
function buildAuthority(world: WorldState, body: Parameters<typeof applyBuildAuthorityCommand>[1]): WorldState {
  const result = applyBuildAuthorityCommand({ builds: world.builds, sequences: world.sequences }, body, buildContext(world));
  if (!result.ok) reject(result.code === 'EXPEDITION_LOCKED' ? 'BUSY' : 'BUILD_UNAVAILABLE');
  return { ...world, builds: copy(result.frame.builds), sequences: copy(result.frame.sequences) };
}
function startBattle(world: WorldState): WorldState {
  const run = active(world); const boundary = run.currentEncounter ?? reject('INVALID_PHASE');
  const definition = getWorldRunEncounter(world, boundary.encounterDefinitionId); const catalog = getWorldRunCombatCatalog(world);
  const participants = boundary.squad.map((member, index) => ({ discipleId: member.discipleId, battleEntityId: `entity:${index + 1}` }));
  const enemies: WorldEncounter['enemies'] = definition.enemies.map((enemy, index) => ({ battleEntityId: `entity:${participants.length + index + 1}`,
    nameKey: enemy.nameKey, archetypeId: enemyPresentation(definition.id, index) }));
  const entities: BattleEntityInput[] = boundary.squad.map((member, index) => ({
    id: participants[index]!.battleEntityId, team: 'sect', position: { x: 80, y: 80 * (index + 1) },
    stats: copy(member.loadout.stats), healthRatioBps: Math.max(1, Math.min(10_000, Math.floor(member.health * 10_000 / member.loadout.stats.maxHealth))),
    spirit: member.spirit, maximumSpirit: member.loadout.maximumSpirit,
    skills: [...member.loadout.activeSkillIds, member.loadout.passiveSkillId], sources: [...member.loadout.characterSourceIds],
    basic: copy(member.loadout.basic), deathRule: 'downed',
  }));
  for (const [index, enemy] of definition.enemies.entries()) {
    const { nameKey: _label, ...data } = enemy;
    entities.push({ ...copy(data), id: `entity:${participants.length + index + 1}`, team: 'foe' });
  }
  // Admit all sources in the one real createBattle call, then let the runtime initialize derived HP.
  const talentAnchors: { instanceId: string; definitionId: string; battleEntityId: string }[] = [];
  for (const talent of boundary.talentSources) {
    const bound = talent.boundHolderId ? participants.find(entry => entry.discipleId === talent.boundHolderId)?.battleEntityId : undefined;
    if (talent.boundHolderId && !bound) reject('INVALID_STATE');
    const anchors = talent.holderScope === 'personal' ? participants.filter(entry => entry.discipleId === talent.holderId) : participants;
    for (const anchor of anchors) {
      const index = entities.findIndex(entity => entity.id === anchor.battleEntityId);
      const entity = entities[index]!;
      entities[index] = { ...entity, sources: [...(entity.sources ?? []), { definitionId: talent.definitionId, ...(bound ? { options: { boundHolderId: bound } } : {}) }] };
      talentAnchors.push({ instanceId: talent.instanceId, definitionId: talent.definitionId, battleEntityId: anchor.battleEntityId });
    }
  }
  const battle = createBattle(catalog, { seed: boundary.seed, entities, contentMode: 'experimental', logCapacity: 160, ...(world.expedition.protocol === 'release-v3' ? { arena: copy(definition.arena) } : {}) });
  const characterSourceBindings: WorldEncounter['characterSourceBindings'] = [];
  for (const participant of participants) {
    const build = world.builds.disciples.find(entry => entry.discipleId === participant.discipleId)!;
    for (const source of build.sources) {
      const installed = Object.values(battle.sources).find(entry => entry.holderId === participant.battleEntityId && entry.sourceDefinitionId === source.sourceDefinitionId);
      if (source.kind !== 'equipment' && !installed) reject('INVALID_STATE');
      characterSourceBindings.push({ worldSourceInstanceId: source.sourceInstanceId, discipleId: participant.discipleId,
        battleEntityId: participant.battleEntityId, definitionId: source.sourceDefinitionId,
        kind: source.kind === 'equipment' ? 'bakedEquipment' : 'installed', battleSourceInstanceId: source.kind === 'equipment' ? null : installed?.sourceInstanceId ?? null });
    }
  }
  const sourceBindings: WorldEncounter['sourceBindings'] = [];
  for (const anchor of talentAnchors) {
    const installed = Object.values(battle.sources).find(source => source.holderId === anchor.battleEntityId && source.sourceDefinitionId === anchor.definitionId);
    if (!installed) reject('INVALID_STATE');
    sourceBindings.push({ runTalentInstanceId: anchor.instanceId, battleSourceInstanceId: installed.sourceInstanceId });
  }
  const controller = createCombatController(catalog, battle, { playerTeam: 'sect', arena: copy(definition.arena), maximumTicks: definition.maximumTicks,
    policies: Object.fromEntries(participants.map((participant) => [participant.battleEntityId, { allowUltimates: true }])) });
  const encounter: WorldEncounter = { encounterId: boundary.encounterId, definitionId: definition.id, configHash: controller.configHash, controller,
    participants, enemies, sourceBindings, characterSourceBindings, admittedSimulationTick: world.clock.simulationTick, lastAdvancedSimulationTick: world.clock.simulationTick };
  return { ...setBundle(world, { battle: encounter }), clock: setClockMode(world.clock, 'combat') };
}
function recordEffect(world: WorldState, effect: Immutable<ExpeditionAdapterEffect>): WorldState {
  return setBundle(world, { effectReceipts: [...bundle(world).effectReceipts, { effectId: effect.effectId, runId: effect.runId, kind: effect.kind, simulationTick: world.clock.simulationTick }] });
}
function applyEffect(world: WorldState, effect: Immutable<ExpeditionAdapterEffect>): WorldState {
  if (bundle(world).effectReceipts.some(receipt => receipt.effectId === effect.effectId)) return world;
  let next = world;
  const run = active(next);
  switch (effect.kind) {
    case 'departure': {
      const reserved = reserveResources(next.inventory, effect.debitSupplies, `${run.runId}/departure-reservation`, run.runId);
      if (!reserved.ok) reject('INSUFFICIENT_SUPPLIES');
      const debit = commitReservation(reserved.inventory, reserved.reservation, []);
      if (!debit.ok) reject('INSUFFICIENT_SUPPLIES');
      next = { ...next, inventory: debit.inventory };
      next = buildAuthority(next, { kind: 'expedition.lock', commandId: `${run.runId}/build-lock`, expectedRevision: next.builds.revision,
        runId: run.runId, locks: run.members.map(member => ({ discipleId: member.discipleId, lockId: member.lockId })) });
      next = { ...next, cultivation: { ...next.cultivation, revision: checkedAdd(next.cultivation.revision, 1), disciples: next.cultivation.disciples.map(profile => {
        const member = run.members.find(entry => entry.discipleId === profile.discipleId);
        return member ? { ...profile, activityOwner: { kind: 'expedition' as const, runId: run.runId, lockId: member.lockId } } : profile;
      }) } };
      break;
    }
    case 'monthAdmitted':
      next = setBundle(next, { travel: { checkpointId: effect.checkpoint.checkpointId, startCalendarTick: next.clock.calendarTick,
        targetCalendarTick: checkedAdd(next.clock.calendarTick, CALENDAR_TICKS_PER_MONTH) } });
      break;
    case 'monthCheckpoint': next = setBundle(next, { travel: null }); break;
    case 'encounterBegin': next = startBattle(next); break;
    case 'encounterResult': {
      for (const result of effect.members) {
        const profile = next.cultivation.disciples.find(entry => entry.discipleId === result.discipleId) ?? reject('INVALID_STATE');
        if (result.permanentDeathId) {
          const death = dispatchWorldCultivation(next, { kind: 'death.finalize', commandId: `${run.runId}/death/${result.permanentDeathId}`,
            expectedRevision: next.cultivation.revision, discipleId: result.discipleId, deathId: result.permanentDeathId, cause: 'combat', acknowledgeDeath: true });
          if (!death.ok) reject('INVALID_STATE');
          next = death.world;
        } else if (profile.injury !== result.injury) {
          next = { ...next, cultivation: { ...next.cultivation, revision: checkedAdd(next.cultivation.revision, 1),
            disciples: next.cultivation.disciples.map(entry => entry.discipleId === result.discipleId ? { ...entry, injury: result.injury } : entry) } };
        }
      }
      next = { ...setBundle(next, { battle: null }), clock: setClockMode(next.clock, 'management') };
      break;
    }
    case 'membersDied': if (!run.admittedCheckpoint) next = setBundle(next, { travel: null }); break;
    case 'talentCommit': break;
    case 'runSettled': {
      const credits = addLines(effect.settlement.loot, effect.settlement.unusedSupplies);
      if (credits.some(line => checkedAdd(next.inventory[line.resourceId].owned, line.quantity) > next.inventory[line.resourceId].capacity)) reject('INVENTORY_FULL');
      next = { ...next, inventory: { ...next.inventory } };
      for (const line of credits) next.inventory[line.resourceId] = { ...next.inventory[line.resourceId], owned: checkedAdd(next.inventory[line.resourceId].owned, line.quantity) };
      next = buildAuthority(next, { kind: 'expedition.unlock', commandId: `${run.runId}/build-unlock`, expectedRevision: next.builds.revision,
        runId: run.runId, locks: run.members.map(member => ({ discipleId: member.discipleId, lockId: member.lockId })) });
      next = { ...next, cultivation: { ...next.cultivation, revision: checkedAdd(next.cultivation.revision, 1),
        disciples: next.cultivation.disciples.map(profile => profile.activityOwner?.runId === run.runId ? { ...profile, activityOwner: null } : profile) },
        unlocks: [...new Set([...next.unlocks, ...effect.settlement.unlockIds])].sort(compareStable) };
      // A won battle stays won if the last traveler dies on the return leg.
      // Settle its sealed terms and deaths, but campaign/personal victory needs a living returner.
      const returnedVictory = effect.settlement.reason === 'victory' && effect.survivingDiscipleIds.length > 0;
      const needsPersonalProof = returnedVictory && effect.survivingDiscipleIds.some(discipleId => !next.builds.awards.some(award => award.discipleId === discipleId && award.ruleId === 'expedition.first-victory'));
      if (returnedVictory) for (const discipleId of effect.survivingDiscipleIds) {
        if (next.builds.awards.some(award => award.discipleId === discipleId && award.ruleId === 'expedition.first-victory')) continue;
        next = buildAuthority(next, { kind: 'milestone.award', commandId: `${run.runId}/award/${discipleId}`, expectedRevision: next.builds.revision,
          milestoneId: `milestone.first-expedition.${discipleId.replace(':', '-')}`, discipleId, ruleId: 'expedition.first-victory' });
      }
      const registered = registeredWorldRun(next);
      const history = { routeId: next.expedition.routeId!, contentIdentity: copy(registered.identity), protocol: registered.protocol, runId: run.runId, settlementId: effect.settlement.settlementId, reason: effect.settlement.reason,
        result: effect.settlement.reason === 'victory' ? 'completed' as const : effect.settlement.reason === 'defeat' ? 'defeated' as const : 'withdrawn' as const,
        forcedWithdrawal: bundle(next).forcedWithdrawal, endedCalendarTick: next.clock.calendarTick,
        loot: copy(effect.settlement.loot), returnedSupplies: copy(effect.settlement.unusedSupplies), lostLoot: copy(effect.settlement.lostLoot),
        survivingDiscipleIds: [...effect.survivingDiscipleIds], deadDiscipleIds: [...effect.deadDiscipleIds], deathMappings: copy(bundle(next).deathMappings) };
      next = setBundle(next, { history: [...bundle(next).history, history], battle: null, travel: null });
      const firstClear = returnedVictory && !next.campaign.progress.clears.some(clear => clear.routeId === next.expedition.routeId);
      if (returnedVictory) {
        const recorded = recordRegisteredCampaignVictoryV2(next.campaign.progress, next.expedition.routeId!, registered);
        if (!recorded.ok) reject('INVALID_STATE');
        next = { ...next, campaign: { ...next.campaign, progress: copy(recorded.state), clearEvidence: firstClear
          ? [...next.campaign.clearEvidence, { routeId: next.expedition.routeId!, runId: run.runId }] : next.campaign.clearEvidence } };
      }
      if (firstClear || needsPersonalProof || effect.deadDiscipleIds.length > 0) next = { ...next, campaign: { ...next.campaign,
        settledRunEvidence: [...next.campaign.settledRunEvidence, copy(registered)] } };
      next = { ...next, clock: setClockMode(next.clock, 'management') };
      break;
    }
  }
  return recordEffect(next, effect);
}
function domain(world: WorldState, body: DomainBody, commandId: string): WorldState {
  const run = active(world);
  const result = applyRegisteredExpeditionCommand(registeredWorldRun(world), { ...body, commandId, expectedRevision: run.revision } as ExpeditionCommand);
  if (!result.ok) {
    const code: WorldExpeditionError = ['STALE_OFFER', 'ILLEGAL_CHOICE', 'REROLLS_EXHAUSTED', 'NO_NEW_CANDIDATE', 'INSUFFICIENT_SUPPLIES', 'CONTENT_MISMATCH', 'CHECKPOINT_MISMATCH'].includes(result.code)
      ? result.code as WorldExpeditionError : 'INVALID_PHASE';
    reject(code);
  }
  let next = setBundle(world, { run: result.expedition.run, blockedReason: null });
  for (const effect of result.effects) next = applyEffect(next, effect);
  return next;
}
function ownPause(world: WorldState): WorldState {
  if (!world.expedition) return world;
  const run = bundle(world).run;
  const hold = !!run && run.phase !== 'Ended' && (run.phase === 'AtNode' || run.phase === 'RewardPending' || run.phase === 'Preparing'
    || ((run.phase === 'Travelling' || run.phase === 'Ending') && bundle(world).travel === null) || bundle(world).blockedReason !== null);
  return world.clock.pauseReasons.includes('expedition') === hold ? world : { ...world, clock: setPauseReason(world.clock, 'expedition', hold) };
}
function admitTravel(world: WorldState, commandId: string): WorldState {
  const checkpoint = registeredTimeCheckpoint(registeredWorldRun(world));
  if (!checkpoint) reject('INVALID_PHASE');
  return domain(world, { kind: 'time.admit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth }, commandId);
}
function settleReady(world: WorldState): WorldState {
  const run = bundle(world).run;
  if (!run || run.phase !== 'Ending' || hasCultivationDecision(world) || registeredTimeCheckpoint(registeredWorldRun(world))) return world;
  try { return domain(world, { kind: 'run.settle', settlementId: run.settlement!.settlementId }, `${run.runId}/settle`); }
  catch (error) { if (error instanceof AdapterFault && error.code === 'INVENTORY_FULL') return setBundle(world, { blockedReason: error.code }); throw error; }
}
function startDeparture(world: WorldState, request: ExpeditionDepartureRequest, commandId: string): WorldState {
  const preview = previewWorldExpeditionV8(world, request);
  if (preview.blockers.length) reject(preview.blockers[0]!);
  let next = world;
  for (const discipleId of preview.squadIds) {
    const disciple = next.disciples.find(entry => entry.id === discipleId)!;
    if (disciple.assignmentTransactionId) {
      const cancelled = cancelProduction(next, disciple.assignmentTransactionId, { commandId });
      if (!cancelled.ok) reject('MEMBER_UNAVAILABLE');
      next = cancelled.world;
    }
  }
  const runId = id(next, 'action').replace('action:', 'run:');
  const members: ExpeditionMemberInput[] = preview.squadIds.map(discipleId => {
    const profile = next.cultivation.disciples.find(entry => entry.discipleId === discipleId)!;
    const loadout = buildCombatLoadout({ builds: next.builds, sequences: next.sequences }, discipleId, buildContext(next));
    return { discipleId, available: true, alive: true, loadout: copy(loadout), health: Math.max(1, Math.floor(loadout.stats.maxHealth * (100 - profile.injury) / 100)),
      spirit: loadout.maximumSpirit, injury: profile.injury, durability: 100 };
  });
  const selected = getWorldContent(next); const route = selected.routes.find(entry => entry.id === request.routeId) ?? reject('CONTENT_MISMATCH');
  const admitted = createRegisteredExpedition({ runId, seed: stableHash({ seed: next.seed, runId }), calendarMonth: Math.floor(next.clock.calendarTick / CALENDAR_TICKS_PER_MONTH),
    members, supplies: copy(preview.requestedSupplies), route: copy(route.specification), contentMode: 'experimental', monthlyMealPerMember: 1 }, request.routeId, contentIdentity(selected));
  const run = admitted.run;
  next = setBundle(next, { run, contentIdentity: copy(admitted.identity), protocol: admitted.protocol, routeId: request.routeId, travel: null, battle: null, effectReceipts: [], deathMappings: [], forcedWithdrawal: false, blockedReason: null });
  next = domain(next, { kind: 'depart' }, commandId);
  return admitTravel(next, `${runId}/first-travel`);
}
export function dispatchWorldExpeditionV8(world: WorldState, command: PlayerExpeditionCommand): WorldExpeditionDispatch {
  if (!isWorldExpeditionCommandV8(command)) return { ok: false, code: 'INVALID_COMMAND' };
  if (!world.expedition || !world.builds) return { ok: false, code: 'INVALID_STATE' };
  try {
    let next = cloneWorldWithSharedHistory(world);
    if (command.kind === 'expedition.depart') next = startDeparture(next, command.request, command.commandId);
    else {
      const run = active(next);
      if (hasCultivationDecision(next)) reject('BLOCKED_BY_DECISION');
      switch (command.kind) {
        case 'expedition.continue':
          if (run.phase === 'AtNode') next = domain(next, { kind: 'encounter.begin' }, command.commandId);
          else if ((run.phase === 'Travelling' || run.phase === 'Ending') && registeredTimeCheckpoint(registeredWorldRun(world))) {
            if (next.expedition.travel || run.admittedCheckpoint) reject('INVALID_PHASE');
            next = admitTravel(next, command.commandId);
          }
          else if (run.phase === 'Ending') next = settleReady(next);
          else reject('INVALID_PHASE');
          break;
        case 'expedition.choose': next = domain(next, { kind: 'offer.choose', offerId: command.offerId, offerRevision: command.offerRevision, definitionId: command.definitionId, holderId: command.holderId }, command.commandId); break;
        case 'expedition.reroll': next = domain(next, { kind: 'offer.reroll', offerId: command.offerId, offerRevision: command.offerRevision }, command.commandId); break;
        case 'expedition.supplies':
          next = domain(next, { kind: 'offer.supplies', offerId: command.offerId, offerRevision: command.offerRevision }, command.commandId);
          if (!assessRunReturnInventory(next).fits) reject('INVENTORY_FULL');
          break;
        case 'expedition.retreat': next = domain(next, { kind: 'run.end', reason: 'safeRetreat' }, command.commandId); break;
        case 'expedition.emergency-retreat': {
          const preview = previewWorldEmergencyRetreatV8(next);
          if (!preview || preview.blockers.length || preview.basisStamp !== command.expectedBasisStamp) reject('INVALID_PHASE');
          next = settleBattle(next, true, command.commandId); break;
        }
        case 'expedition.tactic': {
          const encounter = bundle(next).battle;
          if (!encounter || run.phase !== 'InEncounter' || !encounter.participants.some(entry => entry.battleEntityId === command.order.actorId)) reject('INVALID_PHASE');
          next = setBundle(next, { battle: { ...encounter, controller: issueTacticalOrder(encounter.controller, getWorldRunCombatCatalog(next), command.order) } });
          break;
        }
      }
    }
    next = ownPause(settleReady(next));
    return { ok: true, world: next, result: { kind: command.kind, runId: bundle(next).run?.runId ?? null,
      phase: bundle(next).run?.phase ?? null, relatedId: bundle(next).run?.currentOfferId ?? bundle(next).battle?.encounterId ?? null }, eventIds: worldEventsSince(next, worldEventCursor(world)).map((event) => event.eventId) };
  } catch (error) { return { ok: false, code: error instanceof AdapterFault ? error.code : 'INVALID_STATE' }; }
}

/** Called by the outer command/tick coordinator; never calls the kernel simulation loop. */
export function reconcileWorldExpeditionDeathsV8(world: WorldState): WorldState {
  if (!world.expedition?.run || world.expedition.run.phase === 'Ended') return world;
  const run = active(world);
  const deaths = run.members.filter(member => member.alive).flatMap(member => {
    const profile = world.cultivation.disciples.find(entry => entry.discipleId === member.discipleId);
    return profile?.lifeState === 'dead' && profile.deathId ? [{ discipleId: member.discipleId, deathId: profile.deathId }] : [];
  });
  if (!deaths.length) return world;
  if (run.phase === 'InEncounter') throw new Error('Natural death cannot be reconciled during a frozen-calendar encounter');
  return ownPause(domain(world, { kind: 'members.died', discipleIds: deaths.map(entry => entry.discipleId), deathRecordIds: deaths.map(entry => entry.deathId) }, `${run.runId}/world-deaths/${run.revision}`));
}
function finishReachedCheckpoint(world: WorldState): WorldState {
  const travel = world.expedition?.travel;
  if (!travel) return world;
  if (world.clock.calendarTick > travel.targetCalendarTick) throw new Error('Expedition advanced beyond its exact month checkpoint');
  if (world.clock.calendarTick < travel.targetCalendarTick || hasCultivationDecision(world)) return world;
  const checkpoint = active(world).admittedCheckpoint;
  if (!checkpoint || checkpoint.checkpointId !== travel.checkpointId) throw new Error('Expedition checkpoint ownership mismatch');
  const next = domain(world, { kind: 'time.commit', checkpointId: checkpoint.checkpointId,
    expectedCalendarMonth: checkpoint.expectedCalendarMonth, resultingCalendarMonth: checkpoint.resultingCalendarMonth }, `${active(world).runId}/month/${active(world).travelLedger.length + 1}`);
  return settleReady(next);
}
export function beforeWorldExpeditionTickV8(world: WorldState): WorldState {
  if (!world.expedition) return world;
  return ownPause(settleReady(finishReachedCheckpoint(reconcileWorldExpeditionDeathsV8(world))));
}
function settleBattle(world: WorldState, emergency = false, commandId?: string): WorldState {
  const encounter = bundle(world).battle ?? reject('INVALID_PHASE');
  const controller = encounter.controller;
  if (controller.outcome.status === 'running' && !emergency) return world;
  let next = { ...world, sequences: { ...world.sequences } };
  const run = active(next); const definition = getWorldRunEncounter(next, encounter.definitionId); const catalog = getWorldRunCombatCatalog(next);
  const victory = !emergency && controller.outcome.status === 'victory';
  const result: ValidatedEncounterOutcome = {
    encounterId: encounter.encounterId, resultId: `${run.runId}/result/${run.nodeIndex + 1}`,
    validation: { kind: 'validatedCombatOutcome', battleId: `${run.runId}/battle/${run.nodeIndex + 1}`, battleSnapshotHash: stableHash(controller) },
    outcome: emergency ? 'emergencyRetreat' : victory ? 'victory' : 'defeat', retreatConfirmed: emergency, consumedSupplies: [],
    securedLoot: victory ? copy(definition.securedLoot) : [], unsecuredLoot: victory ? copy(definition.unsecuredLoot) : [], unlockIds: victory ? [...definition.unlockIds] : [],
    members: encounter.participants.map(participant => {
      const entity = controller.battle.entities[participant.battleEntityId] ?? reject('INVALID_STATE');
      const member = run.members.find(entry => entry.discipleId === participant.discipleId) ?? reject('INVALID_STATE');
      const dead = entity.life === 'Dead' && entity.deathId !== null;
      const downed = entity.life === 'Downed' || entity.health <= 0;
      // Prototype recovery is explicit: downed survivors return at 25% health with +25 injury.
      const ratio = downed ? 2500 : Math.floor(entity.health * 10_000 / Math.max(1, queryStat(controller.battle, catalog, entity.id, 'maxHealth')));
      let permanentDeathId: string | null = null;
      if (dead) {
        let mapping = bundle(next).deathMappings.find(entry => entry.encounterId === encounter.encounterId && entry.battleEntityId === entity.id && entry.battleDeathId === entity.deathId);
        if (!mapping) {
          mapping = { encounterId: encounter.encounterId, battleEntityId: entity.id, battleDeathId: entity.deathId!, discipleId: member.discipleId, worldDeathId: id(next, 'instance') };
          next = setBundle(next, { deathMappings: [...bundle(next).deathMappings, mapping] });
        }
        permanentDeathId = mapping.worldDeathId;
      }
      return { discipleId: member.discipleId, alive: !dead, permanentDeathId,
        health: dead ? 0 : Math.max(1, Math.min(member.loadout.stats.maxHealth, Math.floor(member.loadout.stats.maxHealth * ratio / 10_000))),
        spirit: Math.min(member.loadout.maximumSpirit, entity.spirit), injury: Math.min(100, member.injury + (downed ? 25 : 0) + (!victory && !dead ? 10 : 0)), durability: member.durability };
    }),
  };
  next = setBundle(next, { forcedWithdrawal: controller.outcome.status === 'draw' });
  return domain(next, { kind: 'encounter.resolve', result }, commandId ?? `${run.runId}/resolve/${run.nodeIndex + 1}`);
}
/** Clock/cultivation/production have already processed exactly one kernel tick. */
export function afterWorldExpeditionTickV8(world: WorldState): WorldState {
  if (!world.expedition) return world;
  let next = world;
  const encounter = bundle(next).battle;
  if (encounter) {
    const elapsed = next.clock.simulationTick - encounter.lastAdvancedSimulationTick;
    if (elapsed < 0 || elapsed > 1 || next.clock.mode !== 'combat') throw new Error('Combat/world tick ownership mismatch');
    if (elapsed === 1) {
      next = setBundle(next, { battle: { ...encounter, controller: stepCombatController(encounter.controller, getWorldRunCombatCatalog(next), 1), lastAdvancedSimulationTick: next.clock.simulationTick } });
      next = settleBattle(next);
    }
  }
  return ownPause(settleReady(finishReachedCheckpoint(next)));
}

export function projectWorldExpeditionV8(world: WorldState): Immutable<WorldExpeditionProjection> {
  const state = world.expedition ?? initializeWorldExpeditionV8(); const run = state.run;
  return freeze({ routeId: state.routeId, runId: run?.runId ?? null, phase: run?.phase ?? 'none', nodeIndex: run?.nodeIndex ?? 0, nodeCount: run?.route.length ?? 0,
    nextEncounterDefinitionId: run?.route[run.nodeIndex]?.encounterDefinitionId ?? null, currentMonth: Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH),
    travelProgressTicks: state.travel ? world.clock.calendarTick - state.travel.startCalendarTick : 0,
    travelTotalTicks: state.travel ? state.travel.targetCalendarTick - state.travel.startCalendarTick : 0, availableSupplies: copy(run?.supplies ?? []),
    blockedReason: state.blockedReason, forcedWithdrawal: state.forcedWithdrawal, currentOffer: run?.offers.find(offer => offer.offerId === run.currentOfferId) ?? null,
    talentInstances: run?.talentInstances ?? [], battle: state.battle?.controller ?? null, participants: state.battle?.participants ?? [], enemies: state.battle?.enemies ?? [], latestHistory: state.history.at(-1) ?? null });
}

/** A real controller snapshot is the sole outcome input. UI review pauses are excluded. */
export function previewWorldEmergencyRetreatV8(world: WorldState): Immutable<WorldEmergencyRetreatPreview> | null {
  const encounter = world.expedition.battle; const run = world.expedition.run;
  if (!encounter || !run || run.phase !== 'InEncounter' || world.expedition.protocol !== 'release-v3') return null;
  const blockers: string[] = []; if (hasCultivationDecision(world) || encounter.controller.outcome.status !== 'running') blockers.push('BLOCKED_BY_DECISION');
  const retainedLoot = run.unsecuredLoot.map(line => ({ ...line, quantity: Math.floor(line.quantity / 2) })).filter(line => line.quantity > 0);
  const unsecuredLoot = run.unsecuredLoot.map(line => ({ ...line, quantity: line.quantity - Math.floor(line.quantity / 2) })).filter(line => line.quantity > 0);
  const deadDiscipleIds: string[] = []; const injuryByDisciple = encounter.participants.map(participant => {
    const entity = encounter.controller.battle.entities[participant.battleEntityId]!;
    if (entity.life === 'Dead') deadDiscipleIds.push(participant.discipleId);
    const downed = entity.life === 'Downed' || entity.health <= 0;
    return { discipleId: participant.discipleId, addedInjury: entity.life === 'Dead' ? 0 : (downed ? 25 : 0) + 10 };
  });
  const living = run.members.filter(member => member.alive && !deadDiscipleIds.includes(member.discipleId)).length;
  const returnMonths = living ? run.origin.route.returnMonths : 0;
  const returnCost = returnMonths ? [{ resourceId: 'meal' as const, quantity: returnMonths * living * (run.origin.monthlyMealPerMember ?? 1) }] : [];
  return freeze({ basisStamp: stableHash({ run, encounter, inventory: world.inventory, pendingDeaths: world.cultivation.pendingDeaths }), runId: run.runId,
    encounterId: encounter.encounterId, blockers, losses: { unsecuredLoot, injuryByDisciple, deadDiscipleIds }, retainedLoot: addLines(run.securedLoot, retainedLoot), returnMonths, returnCost });
}
