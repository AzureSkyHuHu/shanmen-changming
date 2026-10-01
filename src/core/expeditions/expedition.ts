import { combatDefinitionSupport } from '../combat/runtime/engine';
import { checkedAdd } from '../kernel/numeric';
import { createRandomStreams, drawInteger } from '../kernel/random';
import { canonicalStringify, compareStable, stableHash } from '../kernel/serialization';
import { generateOffer, legalTalentCandidates } from './offers';
import { ExpeditionFault, MAX_COMMANDS, MAX_ENCOUNTERS, MAX_MONTHS_PER_NODE, MAX_SQUAD, addLines, assertPlainJson,
  copy, fail, freeze, instanceId, integer, resourceLines, sortedLines, subtractLines, unique, validId } from './shared';
import type { CreateExpeditionOptions, EncounterBoundary, EndReason, ExpeditionAdapterEffect, ExpeditionCatalog,
  ExpeditionCommand, ExpeditionData, ExpeditionMemberInput, ExpeditionReceipt, ExpeditionState, ExpeditionTransition,
  Immutable, OfferState, TimeCheckpoint, ValidatedEncounterOutcome } from './types';

const schools = ['sword', 'body', 'alchemy', 'talisman'];
const statNames = ['attack', 'maxHealth', 'armor', 'criticalChanceBps', 'criticalMultiplierBps', 'hasteBps', 'damageReductionBps', 'healingBps', 'controlResistanceBps', 'shieldBps'];
function validateMember(member: ExpeditionMemberInput, catalog: ExpeditionCatalog, mode: CreateExpeditionOptions['contentMode']): void {
  if (!member || !validId(member.discipleId) || member.available !== true || member.alive !== true || !member.loadout) fail('INVALID_INPUT');
  const loadout = member.loadout;
  if (!loadout.basic || !schools.includes(loadout.basic.school) || !integer(loadout.basic.coefficientBps, 1, 100_000)
    || !integer(loadout.basic.cooldownTicks, 1, 72_000) || !integer(loadout.basic.castTicks, 0, 1200)
    || !integer(loadout.basic.rangeUnits, 1, 10_000) || !Array.isArray(loadout.activeSkillIds)
    || loadout.activeSkillIds.length !== 2 || !unique(loadout.activeSkillIds) || !validId(loadout.passiveSkillId)
    || !Array.isArray(loadout.characterSourceIds) || loadout.characterSourceIds.length > 5 || !unique(loadout.characterSourceIds)
    || !loadout.equipment || Object.values(loadout.equipment).length !== 3 || !Object.values(loadout.equipment).every(validId)
    || !['weaponId', 'robeId', 'artifactId'].every(key => key in loadout.equipment)
    || !loadout.stats || !integer(loadout.stats.attack, 1, 1_000_000) || !integer(loadout.stats.maxHealth, 1, 10_000_000)
    || Object.entries(loadout.stats).some(([key, value]) => !statNames.includes(key) || !integer(value, 0, 10_000_000))
    || !integer(loadout.maximumSpirit, 1, 1_000_000) || !integer(member.health, 1, loadout.stats.maxHealth)
    || !integer(member.spirit, 0, loadout.maximumSpirit) || !integer(member.injury, 0, 100) || !integer(member.durability, 0, 100)) fail('INVALID_INPUT');
  for (const [slot, id] of [...loadout.activeSkillIds, loadout.passiveSkillId].entries()) {
    const skill = catalog.skills.find(entry => entry.id === id);
    if (!skill || skill.school !== loadout.basic.school || skill.activation !== (slot === 2 ? 'passive' : 'active')) fail('INVALID_INPUT');
    if (!combatDefinitionSupport(catalog, id, mode).supported) fail('UNSUPPORTED_LOADOUT');
  }
  const nodes = loadout.characterSourceIds.map(id => catalog.treeNodes.find(node => node.id === id));
  if (nodes.some(node => !node || node.school !== loadout.basic.school || node.prerequisites.some(id => !loadout.characterSourceIds.includes(id))
    || node.excludes.some(id => loadout.characterSourceIds.includes(id)))) fail('INVALID_INPUT');
  for (const id of loadout.characterSourceIds) if (!combatDefinitionSupport(catalog, id, mode).supported) fail('UNSUPPORTED_LOADOUT');
}
function validateOptions(options: CreateExpeditionOptions, catalog: ExpeditionCatalog): void {
  assertPlainJson(options);
  if (!options || !validId(options.runId) || options.runId.length > 64 || typeof options.seed !== 'string' || options.seed.length < 1 || options.seed.length > 200
    || !integer(options.calendarMonth, 0, Number.MAX_SAFE_INTEGER - 1000) || !Array.isArray(options.members)
    || options.members.length < 1 || options.members.length > MAX_SQUAD || !unique(options.members.map(member => member.discipleId))
    || !resourceLines(options.supplies) || !['verified', 'experimental'].includes(options.contentMode)
    || (options.monthlyMealPerMember !== undefined && !integer(options.monthlyMealPerMember, 0, 100))) fail('INVALID_INPUT');
  const route = options.route;
  if (!route || !validId(route.regionId) || !validId(route.bossEncounterId) || !Array.isArray(route.regularEncounterIds)
    || route.regularEncounterIds.length < 1 || route.regularEncounterIds.length > 64 || !route.regularEncounterIds.every(validId)
    || !unique(route.regularEncounterIds) || !integer(route.encounterCount, 2, MAX_ENCOUNTERS)
    || !integer(route.minimumTravelMonths, 0, MAX_MONTHS_PER_NODE) || !integer(route.maximumTravelMonths, route.minimumTravelMonths, MAX_MONTHS_PER_NODE)
    || !integer(route.returnMonths, 0, MAX_MONTHS_PER_NODE)) fail('INVALID_INPUT');
  if (options.preferredTags && (!Array.isArray(options.preferredTags) || options.preferredTags.length > 2 || !unique(options.preferredTags)
    || options.preferredTags.some(tag => !catalog.talents.some(talent => talent.tags.includes(tag)) && !catalog.skills.some(skill => skill.tags.includes(tag))))) fail('INVALID_INPUT');
  for (const member of options.members) validateMember(member, catalog, options.contentMode);
}

export function createExpedition(options: CreateExpeditionOptions, catalog: ExpeditionCatalog): ExpeditionState {
  validateOptions(options, catalog);
  const origin = copy(options);
  origin.members.sort((a, b) => compareStable(a.discipleId, b.discipleId));
  origin.route.regularEncounterIds.sort(compareStable);
  origin.supplies = sortedLines(origin.supplies);
  const state: ExpeditionData = {
    schemaVersion: 2, simulationVersion: 'expedition-2', contentHash: stableHash(catalog), origin,
    runId: origin.runId, phase: 'Preparing', revision: 0, calendarMonth: origin.calendarMonth,
    members: origin.members.map(member => ({ ...copy(member), lockId: `${origin.runId}/lock/${member.discipleId}`, permanentDeathId: null })),
    route: [], nodeIndex: 0, nodeTimeProgress: 0, travelLedger: [], admittedCheckpoint: null, abandonedCheckpoints: [], supplies: sortedLines(origin.supplies), locked: false,
    currentEncounter: null, encounterResults: [], offers: [], currentOfferId: null, talentInstances: [], securedLoot: [], unsecuredLoot: [], unlockIds: [],
    randomStreams: createRandomStreams(`${origin.seed}::${origin.runId}`), nextInstance: 1, remainingRerolls: 2,
    rewardCounters: { generated: 0, committed: 0, forfeited: 0 }, guarantees: { coreShown: false, supportDue: [] },
    settlement: null, receipts: [], commandLog: [],
  };
  for (let ordinal = 1; ordinal <= origin.route.encounterCount; ordinal += 1) {
    const boss = ordinal === origin.route.encounterCount;
    const index = drawInteger(state.randomStreams, 'generation', 0, origin.route.regularEncounterIds.length - 1);
    state.randomStreams = index.streams;
    const travel = drawInteger(state.randomStreams, 'generation', origin.route.minimumTravelMonths, origin.route.maximumTravelMonths);
    state.randomStreams = travel.streams;
    state.route.push({ nodeId: `${state.runId}/node/${ordinal}`, nodeVisitId: `${state.runId}/visit/${ordinal}`, ordinal,
      encounterDefinitionId: boss ? origin.route.bossEncounterId : origin.route.regularEncounterIds[index.value]!,
      kind: boss ? 'boss' : 'encounter', travelMonths: travel.value, reward: !boss });
  }
  return freeze(state);
}
export function expeditionDeparturePreview(state: ExpeditionState): Immutable<{
  runId: string; squadIds: string[]; debitSupplies: typeof state.origin.supplies; expectedTotalMonths: number; route: typeof state.route;
}> {
  return freeze({ runId: state.runId, squadIds: state.members.map(member => member.discipleId), debitSupplies: state.origin.supplies,
    expectedTotalMonths: state.route.reduce((months, node) => months + node.travelMonths, state.origin.route.returnMonths), route: state.route });
}
export function getNextTimeCheckpoint(state: ExpeditionState): Immutable<TimeCheckpoint> | null {
  if (state.admittedCheckpoint) return state.admittedCheckpoint;
  const ending = state.phase === 'Ending';
  if (state.phase !== 'Travelling' && !ending) return null;
  const node = state.route[state.nodeIndex];
  const total = ending ? state.settlement?.returnMonths ?? 0 : node?.travelMonths ?? 0;
  const progress = ending ? state.settlement?.returnProgress ?? 0 : state.nodeTimeProgress;
  if (progress >= total) return null;
  const timeSettlementId = ending ? `${state.settlement!.settlementId}/return` : `${node!.nodeVisitId}/travel`;
  const members = state.members.filter(member => member.alive).map(member => member.discipleId);
  const mealCost = members.length * (state.origin.monthlyMealPerMember ?? 1);
  return freeze({ checkpointId: `${timeSettlementId}/month/${progress + 1}`, timeSettlementId, runId: state.runId,
    kind: ending ? 'return' : 'travel', nodeVisitId: ending ? null : node!.nodeVisitId, monthOrdinal: progress + 1,
    expectedCalendarMonth: state.calendarMonth, resultingCalendarMonth: checkedAdd(state.calendarMonth, 1),
    absentDiscipleIds: members, supplyCost: mealCost ? [{ resourceId: 'meal', quantity: mealCost }] : [] });
}
const currentOffer = (state: ExpeditionData): OfferState => state.offers.find(offer => offer.offerId === state.currentOfferId) ?? fail('STALE_OFFER');
function checkOffer(state: ExpeditionData, offerId: string, revision: number): OfferState {
  if (state.phase !== 'RewardPending') fail('INVALID_PHASE');
  const offer = currentOffer(state);
  if (offer.offerId !== offerId || offer.revision !== revision || offer.resolution !== 'pending') fail('STALE_OFFER');
  return offer;
}
function advanceNode(state: ExpeditionData): void {
  state.currentOfferId = null;
  state.nodeIndex += 1;
  state.nodeTimeProgress = 0;
  const node = state.route[state.nodeIndex];
  if (!node) fail('INVALID_PHASE');
  state.phase = node.travelMonths === 0 ? 'AtNode' : 'Travelling';
}
function beginEnding(state: ExpeditionData, reason: EndReason): void {
  if (state.settlement) {
    if (state.settlement.reason !== reason) fail('INVALID_END_REASON');
    return;
  }
  const retainedBps = reason === 'defeat' ? 0 : reason === 'emergencyRetreat' ? 5000 : 10_000;
  if (state.admittedCheckpoint) abandonCheckpoint(state, state.members.some(member => member.alive) ? 'runEnded' : 'allMembersDead');
  const retained = state.unsecuredLoot.map(line => ({ ...line, quantity: Math.floor(line.quantity * retainedBps / 10_000) })).filter(line => line.quantity > 0);
  const lost = state.unsecuredLoot.map(line => ({ ...line, quantity: line.quantity - (retained.find(item => item.resourceId === line.resourceId)?.quantity ?? 0) })).filter(line => line.quantity > 0);
  state.settlement = {
    settlementId: `${state.runId}/settlement`, reason, createdMonth: state.calendarMonth,
    returnMonths: state.members.some(member => member.alive) ? state.origin.route.returnMonths : 0, retainedUnsecuredBps: retainedBps,
    loot: addLines(state.securedLoot, retained), lostLoot: lost, unusedSupplies: sortedLines(state.supplies),
    unlockIds: [...state.unlockIds], returnProgress: 0, committed: false, commitId: null,
  };
  const offer = state.offers.find(entry => entry.offerId === state.currentOfferId);
  if (offer && offer.resolution === 'pending') {
    offer.resolution = 'forfeited'; offer.commitId = `${state.settlement.settlementId}/forfeit/${offer.offerId}`;
    state.rewardCounters.forfeited += 1;
  }
  state.currentOfferId = null;
  state.phase = 'Ending';
}
function abandonCheckpoint(state: ExpeditionData, reason: 'allMembersDead' | 'runEnded'): void {
  if (!state.admittedCheckpoint) return;
  state.abandonedCheckpoints.push({ checkpoint: copy(state.admittedCheckpoint), reason, abandonedAtCalendarMonth: state.calendarMonth });
  state.admittedCheckpoint = null;
}
function makeBoundary(state: ExpeditionData): EncounterBoundary {
  const node = state.route[state.nodeIndex]!;
  const squad = state.members.filter(member => member.alive);
  const living = new Set(squad.map(member => member.discipleId));
  return { encounterId: `${node.nodeVisitId}/encounter`, nodeId: node.nodeId, encounterDefinitionId: node.encounterDefinitionId,
    seed: `${state.origin.seed}::${state.runId}::${node.nodeVisitId}`, memberIds: squad.map(member => member.discipleId), squad: copy(squad),
    talentSources: copy(state.talentInstances.filter(talent => (talent.holderScope === 'team' || (talent.holderId !== null && living.has(talent.holderId)))
      && (talent.boundHolderId === null || living.has(talent.boundHolderId)))), calendarMonth: state.calendarMonth };
}
function validateOutcome(state: ExpeditionData, result: ValidatedEncounterOutcome): void {
  const boundary = state.currentEncounter ?? fail('INVALID_PHASE');
  if (!result || result.encounterId !== boundary.encounterId || !validId(result.resultId) || !result.validation
    || result.validation.kind !== 'validatedCombatOutcome' || !validId(result.validation.battleId)
    || typeof result.validation.battleSnapshotHash !== 'string' || !/^[a-f0-9]{8,128}$/.test(result.validation.battleSnapshotHash)
    || !['victory', 'emergencyRetreat', 'defeat'].includes(result.outcome) || typeof result.retreatConfirmed !== 'boolean'
    || (result.outcome === 'emergencyRetreat' && !result.retreatConfirmed) || !Array.isArray(result.members)
    || result.members.length !== boundary.memberIds.length || !unique(result.members.map(member => member.discipleId))
    || !resourceLines(result.consumedSupplies) || !resourceLines(result.securedLoot) || !resourceLines(result.unsecuredLoot)
    || !Array.isArray(result.unlockIds) || result.unlockIds.length > 64 || !result.unlockIds.every(validId) || !unique(result.unlockIds)
    || state.encounterResults.some(previous => previous.resultId === result.resultId)) fail('INVALID_OUTCOME');
  for (const member of result.members) {
    const original = state.members.find(entry => entry.discipleId === member.discipleId);
    if (!original || !boundary.memberIds.includes(member.discipleId) || typeof member.alive !== 'boolean'
      || !integer(member.health, member.alive ? 1 : 0, member.alive ? original.loadout.stats.maxHealth : 0)
      || !integer(member.spirit, 0, original.loadout.maximumSpirit) || !integer(member.injury, 0, 100)
      || !integer(member.durability, 0, original.durability)
      || (member.alive ? member.permanentDeathId !== null : !validId(member.permanentDeathId))
      || Object.keys(member).sort().join(',') !== 'alive,discipleId,durability,health,injury,permanentDeathId,spirit') fail('INVALID_OUTCOME');
  }
  const deathIds = result.members.flatMap(member => member.permanentDeathId ? [member.permanentDeathId] : []);
  if (!unique(deathIds) || deathIds.some(id => state.members.some(member => member.permanentDeathId === id))
    || (result.outcome !== 'defeat' && !result.members.some(member => member.alive))) fail('INVALID_OUTCOME');
}
function removeDeadTalents(state: ExpeditionData): string[] {
  const dead = new Set(state.members.filter(member => !member.alive).map(member => member.discipleId));
  const removed = state.talentInstances.filter(talent => talent.holderScope === 'personal' && talent.holderId !== null && dead.has(talent.holderId));
  state.talentInstances = state.talentInstances.filter(talent => !removed.includes(talent));
  return removed.map(talent => talent.instanceId);
}
function execute(state: ExpeditionData, command: ExpeditionCommand, catalog: ExpeditionCatalog, effects: ExpeditionAdapterEffect[]): string | null {
  const effectBase = { effectId: `${state.runId}/command/${command.commandId}`, runId: state.runId };
  switch (command.kind) {
    case 'depart': {
      if (state.phase !== 'Preparing') fail('INVALID_PHASE');
      state.locked = true;
      state.phase = state.route[0]!.travelMonths ? 'Travelling' : 'AtNode';
      effects.push({ ...effectBase, kind: 'departure', lockIds: state.members.map(member => member.lockId), absentDiscipleIds: state.members.map(member => member.discipleId), debitSupplies: sortedLines(state.origin.supplies) });
      return state.runId;
    }
    case 'time.admit': {
      const checkpoint = getNextTimeCheckpoint(state);
      if (!checkpoint || command.checkpointId !== checkpoint.checkpointId || command.expectedCalendarMonth !== checkpoint.expectedCalendarMonth
        ) fail('CHECKPOINT_MISMATCH');
      if (state.admittedCheckpoint) return checkpoint.checkpointId;
      state.supplies = subtractLines(state.supplies, checkpoint.supplyCost);
      state.admittedCheckpoint = copy(checkpoint);
      if (state.phase === 'Ending') state.settlement!.unusedSupplies = sortedLines(state.supplies);
      effects.push({ ...effectBase, kind: 'monthAdmitted', checkpoint: copy(checkpoint) });
      return checkpoint.checkpointId;
    }
    case 'time.commit': {
      const checkpoint = state.admittedCheckpoint;
      if (!checkpoint || command.checkpointId !== checkpoint.checkpointId || command.expectedCalendarMonth !== checkpoint.expectedCalendarMonth
        || command.resultingCalendarMonth !== checkpoint.resultingCalendarMonth) fail('CHECKPOINT_MISMATCH');
      state.calendarMonth = checkpoint.resultingCalendarMonth;
      state.travelLedger.push({ ...copy(checkpoint), committedBy: command.commandId });
      state.admittedCheckpoint = null;
      if (state.phase === 'Ending') { state.settlement!.returnProgress += 1; state.settlement!.unusedSupplies = sortedLines(state.supplies); }
      else { state.nodeTimeProgress += 1; if (state.nodeTimeProgress === state.route[state.nodeIndex]!.travelMonths) state.phase = 'AtNode'; }
      effects.push({ ...effectBase, kind: 'monthCheckpoint', checkpoint: copy(checkpoint) });
      return checkpoint.checkpointId;
    }
    case 'encounter.begin': {
      if (state.phase !== 'AtNode' || !state.members.some(member => member.alive)) fail('INVALID_PHASE');
      state.currentEncounter = makeBoundary(state); state.phase = 'InEncounter';
      effects.push({ ...effectBase, kind: 'encounterBegin', boundary: copy(state.currentEncounter) });
      return state.currentEncounter.encounterId;
    }
    case 'encounter.resolve': {
      if (state.phase !== 'InEncounter') fail('INVALID_PHASE');
      validateOutcome(state, command.result);
      const result = copy(command.result);
      state.supplies = subtractLines(state.supplies, result.consumedSupplies);
      state.securedLoot = addLines(state.securedLoot, result.securedLoot);
      state.unsecuredLoot = addLines(state.unsecuredLoot, result.unsecuredLoot);
      state.unlockIds = [...new Set([...state.unlockIds, ...result.unlockIds])].sort(compareStable);
      for (const outcome of result.members) {
        const member = state.members.find(entry => entry.discipleId === outcome.discipleId)!;
        member.alive = outcome.alive; member.health = outcome.health; member.spirit = outcome.spirit;
        member.injury = outcome.injury; member.durability = outcome.durability; member.permanentDeathId = outcome.permanentDeathId;
      }
      const revoked = removeDeadTalents(state);
      state.encounterResults.push(result);
      effects.push({ ...effectBase, kind: 'encounterResult', resultId: result.resultId, members: copy(result.members), clearEncounterId: result.encounterId, revokedTalentInstanceIds: revoked });
      state.currentEncounter = null;
      if (result.outcome !== 'victory') beginEnding(state, result.outcome);
      else if (state.route[state.nodeIndex]!.kind === 'boss') beginEnding(state, 'victory');
      else {
        const offer = generateOffer(state, catalog, null, false);
        state.offers.push(offer); state.currentOfferId = offer.offerId; state.rewardCounters.generated += 1; state.phase = 'RewardPending';
      }
      return result.resultId;
    }
    case 'offer.reroll': {
      const prior = checkOffer(state, command.offerId, command.offerRevision);
      if (state.remainingRerolls === 0) fail('REROLLS_EXHAUSTED');
      const shown = new Set(state.offers.flatMap(offer => offer.shownHistory));
      if (!legalTalentCandidates(state, catalog).some(candidate => !shown.has(candidate.definitionId))) fail('NO_NEW_CANDIDATE');
      state.remainingRerolls -= 1;
      const refreshed = generateOffer(state, catalog, prior, true);
      if (!refreshed.candidateDefinitionIds.some(id => !shown.has(id))) fail('NO_NEW_CANDIDATE');
      state.offers[state.offers.indexOf(prior)] = refreshed;
      return refreshed.offerId;
    }
    case 'offer.choose': {
      const offer = checkOffer(state, command.offerId, command.offerRevision);
      if (!offer.candidateDefinitionIds.includes(command.definitionId)) fail('ILLEGAL_CHOICE');
      const candidate = legalTalentCandidates(state, catalog).find(entry => entry.definitionId === command.definitionId);
      const definition = catalog.talents.find(entry => entry.id === command.definitionId);
      if (!candidate || !definition || (candidate.holderIds.length > 0 ? !candidate.holderIds.includes(command.holderId ?? '') : command.holderId !== null)) fail('ILLEGAL_CHOICE');
      const holder = definition.holderScope === 'personal' ? command.holderId : null;
      let talent = state.talentInstances.find(entry => entry.definitionId === definition.id && entry.holderId === holder && entry.holderScope === definition.holderScope);
      if (talent) talent.rank += 1;
      else {
        talent = { instanceId: instanceId(state, 'talent'), definitionId: definition.id, holderScope: definition.holderScope, holderId: holder,
          boundHolderId: definition.recipientBinding === 'selectedTalisman' ? command.holderId : null, rank: 1, acquiredRewardOrdinal: offer.rewardOrdinal };
        state.talentInstances.push(talent);
      }
      offer.chosenCard = definition.id; offer.chosenHolder = command.holderId; offer.commitId = command.commandId; offer.resolution = 'talent';
      state.rewardCounters.committed += 1;
      if (definition.offerRole === 'core' && !state.guarantees.supportDue.some(due => due.buildId === definition.buildId)) {
        state.guarantees.supportDue.push({ buildId: definition.buildId, dueOrdinal: offer.rewardOrdinal + 2, fulfilled: false });
      }
      effects.push({ ...effectBase, kind: 'talentCommit', offerId: offer.offerId, talent: copy(talent) });
      advanceNode(state);
      return talent.instanceId;
    }
    case 'offer.supplies': {
      const offer = checkOffer(state, command.offerId, command.offerRevision);
      state.supplies = addLines(state.supplies, offer.supplyFallback);
      offer.commitId = command.commandId; offer.resolution = 'supplies'; state.rewardCounters.committed += 1;
      advanceNode(state);
      return offer.offerId;
    }
    case 'members.died': {
      if (!['Travelling', 'AtNode', 'RewardPending', 'Ending'].includes(state.phase)) fail('INVALID_PHASE');
      if (!Array.isArray(command.discipleIds) || !command.discipleIds.length || command.discipleIds.length !== command.deathRecordIds?.length
        || !unique(command.discipleIds) || !unique(command.deathRecordIds) || !command.deathRecordIds.every(validId)
        || state.commandLog.some(previous => previous.kind === 'members.died' && previous.deathRecordIds.some(id => command.deathRecordIds.includes(id)))
        || command.discipleIds.some(id => !state.members.some(member => member.discipleId === id && member.alive))) fail('INVALID_INPUT');
      for (let index = 0; index < command.discipleIds.length; index += 1) {
        const member = state.members.find(entry => entry.discipleId === command.discipleIds[index])!;
        member.alive = false; member.health = 0; member.permanentDeathId = command.deathRecordIds[index]!;
      }
      const revoked = removeDeadTalents(state);
      effects.push({ ...effectBase, kind: 'membersDied', discipleIds: [...command.discipleIds], deathRecordIds: [...command.deathRecordIds], revokedTalentInstanceIds: revoked });
      if (!state.members.some(member => member.alive)) {
        if (!state.settlement) beginEnding(state, 'defeat');
        else {
          // Preserve sealed loot terms but close unpaid future return legs; prepaid incomplete month remains spent.
          abandonCheckpoint(state, 'allMembersDead');
          state.settlement.returnMonths = state.settlement.returnProgress;
        }
      } else if (state.phase === 'RewardPending') {
        const prior = currentOffer(state);
        state.offers[state.offers.indexOf(prior)] = generateOffer(state, catalog, prior, false);
      }
      return command.deathRecordIds[0]!;
    }
    case 'talent.rebind': {
      if (!['AtNode', 'RewardPending', 'Travelling'].includes(state.phase)) fail('INVALID_PHASE');
      const talent = state.talentInstances.find(entry => entry.instanceId === command.instanceId);
      const definition = catalog.talents.find(entry => entry.id === talent?.definitionId);
      if (!talent || talent.holderScope !== 'team' || definition?.recipientBinding !== 'selectedTalisman'
        || !state.members.some(member => member.discipleId === command.holderId && member.alive && member.loadout.basic.school === 'talisman')) fail('ILLEGAL_CHOICE');
      talent.boundHolderId = command.holderId;
      return talent.instanceId;
    }
    case 'run.end': {
      if (state.settlement) { if (state.settlement.reason !== command.reason) fail('INVALID_END_REASON'); return state.settlement.settlementId; }
      if (command.reason !== 'safeRetreat' || !['AtNode', 'RewardPending'].includes(state.phase)) fail('INVALID_END_REASON');
      beginEnding(state, command.reason);
      return state.settlement!.settlementId;
    }
    case 'run.settle': {
      const settlement = state.settlement;
      if (!settlement || settlement.settlementId !== command.settlementId) fail('INVALID_PHASE');
      if (settlement.committed) return settlement.settlementId;
      if (state.phase !== 'Ending') fail('INVALID_PHASE');
      if (settlement.returnProgress !== settlement.returnMonths) fail('RETURN_INCOMPLETE');
      settlement.committed = true; settlement.commitId = command.commandId;
      effects.push({ ...effectBase, effectId: settlement.settlementId, kind: 'runSettled', settlement: copy(settlement),
        releaseLockIds: state.members.map(member => member.lockId), survivingDiscipleIds: state.members.filter(member => member.alive).map(member => member.discipleId),
        deadDiscipleIds: state.members.filter(member => !member.alive).map(member => member.discipleId), removeRunTalentInstanceIds: state.talentInstances.map(talent => talent.instanceId),
        clearEncounterIds: state.encounterResults.map(result => result.encounterId) });
      state.talentInstances = []; state.locked = false; state.currentEncounter = null; state.phase = 'Ended';
      return settlement.settlementId;
    }
  }
}
export function applyExpeditionCommand(state: ExpeditionState, command: ExpeditionCommand, catalog: ExpeditionCatalog): ExpeditionTransition {
  try {
    assertPlainJson(command);
    if (!command || !validId(command.commandId) || !integer(command.expectedRevision) || !['depart', 'time.admit', 'time.commit', 'encounter.begin', 'encounter.resolve',
      'offer.reroll', 'offer.choose', 'offer.supplies', 'members.died', 'talent.rebind', 'run.end', 'run.settle'].includes(command.kind)) fail('INVALID_COMMAND');
    if (state.contentHash !== stableHash(catalog)) fail('CONTENT_MISMATCH');
    const commandHash = stableHash(command);
    const prior = state.receipts.find(receipt => receipt.commandId === command.commandId);
    if (prior) {
      if (prior.commandHash !== commandHash || canonicalStringify(state.commandLog[state.receipts.indexOf(prior)]) !== canonicalStringify(command)) fail('COMMAND_CONFLICT');
      return { ok: true, state, receipt: prior, effects: [], replayed: true };
    }
    if (command.expectedRevision !== state.revision) fail('REVISION_CONFLICT');
    if (state.commandLog.length >= MAX_COMMANDS) fail('COMMAND_LIMIT');
    const draft = copy(state);
    const effects: ExpeditionAdapterEffect[] = [];
    const resultId = execute(draft, copy(command), catalog, effects);
    draft.revision = checkedAdd(draft.revision, 1);
    const receipt: ExpeditionReceipt = { commandId: command.commandId, commandHash, kind: command.kind, revision: draft.revision, effectIds: effects.map(effect => effect.effectId), resultId };
    draft.receipts.push(receipt); draft.commandLog.push(copy(command));
    return { ok: true, state: freeze(draft), receipt: freeze(receipt), effects: freeze(effects), replayed: false };
  } catch (error) {
    return { ok: false, state, code: error instanceof ExpeditionFault ? error.code : error instanceof RangeError ? 'OVERFLOW' : 'INVALID_INPUT' };
  }
}
