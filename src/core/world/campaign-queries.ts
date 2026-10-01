import { CAMPAIGN_ROUTE_IDS, type CampaignContext, type CampaignClaimRequest } from '../campaign/types';
import { campaignProgressV2, prepareCampaignClaimV2 } from '../campaign/v2';
import type { CampaignClaimRequestV2 } from '../campaign/v2-types';
import { CAMPAIGN_RECRUITS, RECOVERY_RESOURCES, RECRUIT_COSTS, campaignKnowledge } from '../campaign/catalog';
import { STANDARD_RELIEF_POLICY } from '../campaign/v2-types';
import { RESOURCE_IDS } from '../economy/types';
import { stableHash } from '../kernel/serialization';
import { copy, assertPlainJson } from '../expeditions/shared';
import { getWorldContent } from './content-access';
import type { CampaignPlayerRequest, PlayerCampaignCommand, WorldCampaignError, WorldCampaignPreview, WorldCampaignProjection } from './campaign-types';
import type { WorldStateV8 } from './v8-types';

export const WORLD_CAMPAIGN_ERROR_CODES: readonly WorldCampaignError[] = Object.freeze([
  'INVALID_STATE', 'INVALID_INPUT', 'UNKNOWN_ROUTE', 'ROUTE_LOCKED', 'INVALID_VICTORY', 'VICTORY_CONFLICT', 'UNKNOWN_REWARD', 'ALREADY_CLAIMED',
  'UNKNOWN_DISCIPLE', 'DISCIPLE_UNAVAILABLE', 'WRONG_SCHOOL', 'MISSING_PREREQUISITE', 'ALREADY_LEARNED', 'INSUFFICIENT_RESOURCES', 'ROSTER_FULL',
  'IDENTITY_REUSED', 'RECOVERY_UNAVAILABLE', 'LOSS_ACKNOWLEDGEMENT_REQUIRED', 'STALE_PLAN', 'INVALID_ACKNOWLEDGEMENT', 'CLAIM_CONFLICT',
  'HISTORY_LIMIT', 'OVERFLOW', 'RELIEF_UNAVAILABLE', 'RELIEF_COOLDOWN', 'INVALID_COMMAND', 'BLOCKED_BY_DECISION', 'ACTIVE_EXPEDITION',
  'BUILD_REJECTED', 'CULTIVATION_REJECTED', 'INVENTORY_FULL', 'ESTATE_UNAVAILABLE', 'ITEM_UNAVAILABLE', 'PREVIEW_STALE', 'SAVE_CAPACITY_EXCEEDED', 'SAVE_OBLIGATION_UNBOUNDED',
]);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export function isCampaignPlayerRequest(value: unknown): value is CampaignPlayerRequest {
  try {
    assertPlainJson(value); if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const request = value as CampaignPlayerRequest;
    if (request.kind === 'campaign.equipment.claim') return exact(value, ['kind', 'routeId', 'discipleId']) && CAMPAIGN_ROUTE_IDS.includes(request.routeId) && validId(request.discipleId);
    if (request.kind === 'campaign.lesson.learn') return exact(value, ['kind', 'knowledgeId', 'discipleId']) && validId(request.knowledgeId) && validId(request.discipleId);
    if (request.kind === 'campaign.recruit') return exact(value, ['kind', 'routeId', 'school']) && CAMPAIGN_ROUTE_IDS.includes(request.routeId)
      && ['sword', 'body', 'alchemy', 'talisman'].includes(request.school);
    if (request.kind === 'campaign.relief') return exact(value, ['kind', 'school']) && ['sword', 'body', 'alchemy', 'talisman'].includes(request.school);
    if (request.kind === 'campaign.recover') return exact(value, ['kind', 'acknowledgeLoss']) && request.acknowledgeLoss === true;
    return request.kind === 'estate.assign' && exact(value, ['kind', 'itemInstanceId', 'discipleId']) && validId(request.itemInstanceId) && validId(request.discipleId);
  } catch { return false; }
}
export function isPlayerCampaignCommand(value: unknown): value is PlayerCampaignCommand {
  try {
    assertPlainJson(value); if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const command = value as PlayerCampaignCommand;
    if (!validId(command.commandId) || typeof command.expectedBasisStamp !== 'string' || !/^[0-9a-f]{8}$/.test(command.expectedBasisStamp)) return false;
    const { commandId: _id, expectedBasisStamp: _stamp, ...request } = command;
    return isCampaignPlayerRequest(request);
  } catch { return false; }
}
export const hasActiveCampaignRun = (world: WorldStateV8): boolean => world.expedition.run !== null && world.expedition.run.phase !== 'Ended';
export const campaignManagementAvailable = (world: WorldStateV8): boolean => world.clock.mode === 'management'
  && !world.clock.pauseReasons.includes('error') && !world.cultivation.pendingDeaths.length && !world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady');
/** UI-only player/hidden pauses are intentionally excluded. */
export function worldCampaignStateStamp(world: WorldStateV8): string {
  return stableHash({ identity: world.contentIdentity, campaign: world.campaign.progress.revision,
    cultivation: world.cultivation.revision, builds: world.builds.revision, month: world.cultivation.calendarMonth,
    mode: world.clock.mode, error: world.clock.pauseReasons.includes('error'),
    inventory: RESOURCE_IDS.map(id => world.inventory[id]), sequences: world.sequences, navVersion: world.map.navVersion,
    roster: world.disciples.map(member => [member.id, member.presentationId, member.lifeState]),
    archived: world.legacy.archivedIdentities.map(member => member.discipleId), estates: world.legacy.estates,
    run: world.expedition.run ? { id: world.expedition.run.runId, phase: world.expedition.run.phase, identity: world.expedition.contentIdentity } : null });
}
/** Built exclusively from authoritative state; the player never supplies this context. */
export function worldCampaignContext(world: WorldStateV8): CampaignContext {
  const disciples: CampaignContext['disciples'] = world.disciples.map(member => {
    const profile = world.cultivation.disciples.find(entry => entry.discipleId === member.id);
    const build = world.builds.disciples.find(entry => entry.discipleId === member.id);
    if (!profile || !build) throw new TypeError('Missing campaign disciple authority');
    return { discipleId: member.id, school: build.school, lifeState: profile.lifeState, deathId: profile.deathId,
      available: profile.lifeState === 'alive' && !profile.activityOwner && !profile.activeAttemptId && !profile.teaching
        && !world.cultivation.disciples.some(teacher => teacher.teaching?.studentId === member.id),
      learnedSkillIds: build.learnedSkills.map(skill => skill.skillId) };
  });
  const allFinal = disciples.every(member => member.lifeState === 'dead') && !world.cultivation.pendingDeaths.length && !hasActiveCampaignRun(world);
  const lastDeath = [...world.cultivation.events].reverse().find(event => event.kind === 'cultivation.died')?.relatedId
    ?? world.cultivation.deaths.at(-1)?.deathId ?? null;
  return { revision: world.cultivation.revision, calendarMonth: world.cultivation.calendarMonth, activeExpedition: hasActiveCampaignRun(world), disciples,
    archivedDiscipleIds: world.legacy.archivedIdentities.map(member => member.discipleId),
    availableResources: RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: world.inventory[resourceId].owned - world.inventory[resourceId].reserved })),
    terminalLossId: allFinal && (disciples.length + world.legacy.archivedIdentities.length > 0) ? lastDeath : null };
}
/** Read-only prospective IDs. Their counter is not advanced; the committing adapter allocates independently. */
export function campaignDomainRequest(world: WorldStateV8, request: Exclude<CampaignPlayerRequest, { kind: 'estate.assign' }>): CampaignClaimRequestV2 {
  const needed = request.kind === 'campaign.recover' ? 2 : request.kind === 'campaign.recruit' || request.kind === 'campaign.relief' ? 1 : 0;
  if (!Number.isSafeInteger(world.sequences.nextEntity + needed)) throw new RangeError('Entity sequence overflow');
  const discipleId = `entity:${world.sequences.nextEntity}`;
  switch (request.kind) {
    case 'campaign.equipment.claim': return { kind: 'equipment', routeId: request.routeId, discipleId: request.discipleId };
    case 'campaign.lesson.learn': return { kind: 'lesson', knowledgeId: request.knowledgeId, discipleId: request.discipleId };
    case 'campaign.recruit': return { kind: 'recruit', routeId: request.routeId, school: request.school, discipleId };
    case 'campaign.relief': return { kind: 'relief', school: request.school, discipleId };
    case 'campaign.recover': return { kind: 'recovery', discipleIds: [discipleId, `entity:${world.sequences.nextEntity + 1}`], acknowledgeLoss: true };
  }
}
export function previewWorldCampaign(world: WorldStateV8, request: CampaignPlayerRequest): WorldCampaignPreview {
  const basisStamp = stableHash({ stateStamp: worldCampaignStateStamp(world), request });
  const blockers: WorldCampaignError[] = []; let costs: WorldCampaignPreview['costs'] = []; let recruitProfiles: WorldCampaignPreview['recruitProfiles'] = [];
  if (!isCampaignPlayerRequest(request)) return { request: copy(request), basisStamp, costs, recruitProfiles, blockers: ['INVALID_COMMAND'] };
  if (!campaignManagementAvailable(world)) blockers.push('BLOCKED_BY_DECISION');
  try {
    if (request.kind === 'estate.assign') {
      const item = world.builds.equipment.find(entry => entry.instanceId === request.itemInstanceId);
      const estate = world.legacy.estates.find(entry => entry.itemInstanceIds.includes(request.itemInstanceId));
      if (!item || item.owner.kind !== 'sect-estate') blockers.push('ITEM_UNAVAILABLE');
      if (!estate || estate.settledMonth === null) blockers.push('ESTATE_UNAVAILABLE');
      if (!world.cultivation.disciples.some(member => member.discipleId === request.discipleId && member.lifeState === 'alive')
        || !world.builds.disciples.some(member => member.discipleId === request.discipleId)) blockers.push('DISCIPLE_UNAVAILABLE');
    } else {
      if ((request.kind === 'campaign.relief' || request.kind === 'campaign.recover') && hasActiveCampaignRun(world)) blockers.push('ACTIVE_EXPEDITION');
      const plan = prepareCampaignClaimV2(world.campaign.progress, campaignDomainRequest(world, request), worldCampaignContext(world));
      if (!plan.ok) blockers.push(plan.code);
      else { costs = copy(plan.plan.costs); recruitProfiles = plan.plan.grants.flatMap(grant => grant.kind === 'recruit' ? [copy(grant.profile)] : []); }
      // Costs remain visible when a target/resource check prevents preparing a plan.
      if (!costs.length) {
        if (request.kind === 'campaign.recruit') costs = copy(RECRUIT_COSTS);
        if (request.kind === 'campaign.relief') costs = copy(STANDARD_RELIEF_POLICY.costs);
        if (request.kind === 'campaign.lesson.learn') costs = copy(campaignKnowledge(request.knowledgeId)?.costs ?? []);
      }
    }
  } catch (error) { blockers.push(error instanceof RangeError ? 'OVERFLOW' : 'INVALID_STATE'); }
  return { request: copy(request), basisStamp, costs, recruitProfiles, blockers: [...new Set(blockers)] };
}
export function projectWorldCampaign(world: WorldStateV8): WorldCampaignProjection {
  const content = getWorldContent(world); const catalog = content.campaign;
  if (!catalog) throw new TypeError('Current World has no campaign catalog');
  const progress = campaignProgressV2(world.campaign.progress); const context = worldCampaignContext(world);
  const relief = previewWorldCampaign(world, { kind: 'campaign.relief', school: 'sword' });
  const recovery = previewWorldCampaign(world, { kind: 'campaign.recover', acknowledgeLoss: true });
  return {
    mode: world.campaign.progress.mode, revision: world.campaign.progress.revision, completed: progress.completed,
    basisStamp: worldCampaignStateStamp(world), activeRun: context.activeExpedition, managementActionsAvailable: campaignManagementAvailable(world),
    routes: catalog.routes.map(route => ({ routeId: route.id, nameKey: route.nameKey, descriptionKey: route.descriptionKey,
      counterplayKey: route.counterplayKey, mechanism: route.mechanism, prerequisites: [...route.prerequisites],
      available: progress.availableRouteIds.includes(route.id), cleared: progress.clearedRouteIds.includes(route.id), final: route.final,
      expectedMonths: route.specification.encounterCount * route.specification.maximumTravelMonths + route.specification.returnMonths })),
    recipients: context.disciples.filter(member => member.lifeState === 'alive').map(member => {
      const identity = world.disciples.find(entry => entry.id === member.discipleId)!;
      return { discipleId: member.discipleId, nameKey: identity.nameKey, presentationId: identity.presentationId, school: member.school,
        available: member.available, away: world.cultivation.disciples.find(entry => entry.discipleId === member.discipleId)!.activityOwner !== null };
    }),
    equipmentClaims: progress.unclaimedEquipmentRouteIds.map(routeId => {
      const definitionId = catalog.routes.find(route => route.id === routeId)!.firstClear.equipmentId!;
      const definition = content.buildRules.equipment.find(item => item.id === definitionId);
      if (!definition || !('nameKey' in definition) || typeof definition.nameKey !== 'string'
        || !('descriptionKey' in definition) || typeof definition.descriptionKey !== 'string') throw new TypeError('Campaign equipment lacks registered presentation metadata');
      return { routeId, definitionId: definition.id, nameKey: definition.nameKey, descriptionKey: definition.descriptionKey };
    }),
    lessons: progress.archiveKnowledgeIds.map(knowledgeId => {
      const definition = catalog.knowledge.find(entry => entry.id === knowledgeId)!;
      return { knowledgeId, nameKey: definition.nameKey, descriptionKey: definition.descriptionKey, school: definition.school,
        skillId: definition.skillId, costs: copy(definition.costs), learnedDiscipleIds: context.disciples.filter(member => member.learnedSkillIds.includes(definition.skillId)).map(member => member.discipleId) };
    }),
    recruitInvitations: progress.unclaimedRecruitRouteIds.map(routeId => ({ routeId, costs: copy(catalog.recruitCosts) })),
    recruitProfiles: copy(CAMPAIGN_RECRUITS),
    relief: { available: relief.blockers.length === 0, costs: copy(STANDARD_RELIEF_POLICY.costs), blockers: relief.blockers,
      nextEligibleMonth: progress.lastReliefMonth === null ? null : progress.lastReliefMonth + STANDARD_RELIEF_POLICY.cooldownMonths },
    recovery: { available: recovery.blockers.length === 0, nextGeneration: progress.recoveryGeneration + 1, resources: copy(RECOVERY_RESOURCES), blockers: recovery.blockers },
    estateItems: world.legacy.estates.flatMap(estate => estate.itemInstanceIds.flatMap(itemInstanceId => {
      const item = world.builds.equipment.find(entry => entry.instanceId === itemInstanceId);
      return !item ? [] : [{ itemInstanceId, definitionId: item.definitionId, acquisitionId: item.acquisitionId, owner: copy(item.owner),
        deceasedDiscipleId: estate.discipleId, deathId: estate.deathId, pendingRelease: estate.settledMonth === null }];
    })),
  };
}
