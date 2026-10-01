import type { CombatContentCatalog } from '../combat/definitions/types';
import { RESOURCE_IDS } from '../economy/types';
import { restoreExpedition, serializeExpedition } from '../expeditions/snapshot';
import type { ExpeditionState } from '../expeditions/types';
import { canonicalStringify, compareStable, stableHash } from '../kernel/serialization';
import { CAMPAIGN_RECRUITS, CAMPAIGN_ROUTES, RECRUIT_COSTS, RECOVERY_RESOURCES, campaignKnowledge, campaignRoute } from './catalog';
import { CampaignFault, MAX_CAMPAIGN_CLAIMS, assertJson, copy, exact, freeze, hash, integer, unique, validId } from './shared';
import type { CampaignClaimAcknowledgement, CampaignClear, CampaignContext,
  CampaignMode, CampaignRouteId, Immutable } from './types';
import { STANDARD_RELIEF_POLICY, type CampaignClaimPlanV2 as CampaignClaimPlan, type CampaignClaimReceiptV2 as CampaignClaimReceipt,
  type CampaignClaimRequestV2 as CampaignClaimRequest, type CampaignDataV2 as CampaignData, type CampaignErrorV2 as CampaignError,
  type CampaignPlanResultV2 as CampaignPlanResult, type CampaignStateV2 as CampaignState, type CampaignTransitionV2 as CampaignTransition, type CampaignReliefBasis } from './v2-types';

class CampaignV2Fault extends Error { constructor(readonly code: CampaignError) { super(code); } }
function fail(code: CampaignError): never { throw new CampaignV2Fault(code); }
const schools = ['sword', 'body', 'alchemy', 'talisman'];
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const trusted = new WeakSet<object>();
function sealed(state: CampaignData): CampaignState { const result = freeze(state); trusted.add(result); return result; }
function errorCode(error: unknown): CampaignError { return (error instanceof CampaignV2Fault || error instanceof CampaignFault) ? error.code : error instanceof RangeError ? 'OVERFLOW' : 'INVALID_INPUT'; }
function nextRevision(state: CampaignState): number { if (!integer(state.revision + 1)) fail('OVERFLOW'); return state.revision + 1; }
export function createCampaignStateV2(mode: CampaignMode = 'standard'): CampaignState {
  if (!['standard', 'hardcore'].includes(mode)) throw new TypeError('Invalid campaign mode');
  return sealed({ schemaVersion: 2, rulesVersion: 2, reliefProtocol: 'standard-relief-v1', mode, revision: 0, clears: [], claims: [] });
}
function unlocked(state: CampaignState, routeId: string): boolean {
  const route = campaignRoute(routeId) ?? fail('UNKNOWN_ROUTE');
  return route.prerequisites.every(id => state.clears.some(clear => clear.routeId === id));
}
function archive(state: CampaignState): string[] {
  return [...new Set(state.clears.flatMap(clear => campaignRoute(clear.routeId)!.firstClear.knowledgeIds))].sort(compareStable);
}
export function campaignProgressV2(state: CampaignState) {
  assertState(state);
  return freeze({ completed: state.clears.some(clear => campaignRoute(clear.routeId)!.final),
    clearedRouteIds: state.clears.map(clear => clear.routeId),
    availableRouteIds: CAMPAIGN_ROUTES.filter(route => unlocked(state, route.id)).map(route => route.id),
    archiveKnowledgeIds: archive(state), recoveryGeneration: state.claims.filter(claim => claim.plan.recovery !== null).length,
    reliefCount: state.claims.filter(claim => claim.plan.relief !== null).length,
    lastReliefMonth: state.claims.filter(claim => claim.plan.relief !== null).at(-1)?.plan.relief?.month ?? null,
    unclaimedEquipmentRouteIds: state.clears.filter(clear => campaignRoute(clear.routeId)!.firstClear.equipmentId
      && !state.claims.some(claim => claim.plan.claimId === equipmentClaimId(clear.routeId))).map(clear => clear.routeId),
    unclaimedRecruitRouteIds: state.clears.filter(clear => campaignRoute(clear.routeId)!.firstClear.recruitInvitation
      && !state.claims.some(claim => claim.plan.claimId === recruitClaimId(clear.routeId))).map(clear => clear.routeId) });
}

/** Only the authoritative settled-run adapter may call this. Restores/replays domain history before accepting evidence.
 * Combat snapshot hashes are provenance links, not cryptographic proof; World must bind them to its actual battles. */
export function recordCampaignVictoryV2(state: CampaignState, routeId: CampaignRouteId, run: ExpeditionState, catalog: CombatContentCatalog): CampaignTransition {
  try {
    assertState(state); assertJson(run);
    const route = campaignRoute(routeId) ?? fail('UNKNOWN_ROUTE');
    let validated: ExpeditionState;
    try { validated = restoreExpedition(serializeExpedition(run), catalog); } catch { fail('INVALID_VICTORY'); }
    const settlement = validated.settlement;
    const specification = copy(route.specification); specification.regularEncounterIds.sort(compareStable);
    if (!same(validated.origin.route, specification) || validated.phase !== 'Ended' || validated.locked || validated.currentEncounter
      || !settlement?.committed || settlement.reason !== 'victory' || !validId(settlement.commitId)
      || settlement.returnProgress !== settlement.returnMonths || validated.route.length !== route.specification.encounterCount
      || validated.encounterResults.length !== validated.route.length || !validated.members.some(member => member.alive)) fail('INVALID_VICTORY');
    for (const node of validated.route) {
      const result = validated.encounterResults.find(entry => entry.encounterId === `${node.nodeVisitId}/encounter`);
      if (!result || result.outcome !== 'victory' || result.validation.kind !== 'validatedCombatOutcome' || !hash(result.validation.battleSnapshotHash)) fail('INVALID_VICTORY');
    }
    const evidenceHash = stableHash({ routeId, origin: validated.origin, route: validated.route,
      encounterResults: validated.encounterResults, settlement });
    const identityConflict = state.clears.find(clear => clear.runId === validated.runId || clear.settlementId === settlement.settlementId);
    if (identityConflict) {
      if (identityConflict.routeId !== routeId || identityConflict.evidenceHash !== evidenceHash) fail('VICTORY_CONFLICT');
      return { ok: true, state, replayed: true };
    }
    if (!unlocked(state, routeId)) fail('ROUTE_LOCKED');
    // Repeatable routes still produce the expedition's ordinary loot, never another first-clear entitlement.
    if (state.clears.some(clear => clear.routeId === routeId)) return { ok: true, state, replayed: true };
    const next = copy(state); next.revision = nextRevision(state);
    next.clears.push({ revision: next.revision, routeId, runId: validated.runId, settlementId: settlement.settlementId,
      endedMonth: validated.calendarMonth, evidenceHash });
    return { ok: true, state: sealed(next), replayed: false };
  } catch (error) { return { ok: false, state, code: errorCode(error) }; }
}

const equipmentClaimId = (routeId: string) => `campaign/equipment/${routeId}`;
const recruitClaimId = (routeId: string) => `campaign/recruit/${routeId}`;
function validRequest(value: unknown): value is CampaignClaimRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as CampaignClaimRequest;
  if (request.kind === 'equipment') return exact(request, ['kind', 'routeId', 'discipleId']) && !!campaignRoute(request.routeId) && validId(request.discipleId);
  if (request.kind === 'lesson') return exact(request, ['kind', 'knowledgeId', 'discipleId']) && validId(request.knowledgeId) && validId(request.discipleId);
  if (request.kind === 'recruit') return exact(request, ['kind', 'routeId', 'school', 'discipleId']) && !!campaignRoute(request.routeId) && schools.includes(request.school) && validId(request.discipleId);
  if (request.kind === 'relief') return exact(request, ['kind', 'school', 'discipleId']) && schools.includes(request.school) && validId(request.discipleId);
  return request.kind === 'recovery' && exact(request, ['kind', 'discipleIds', 'acknowledgeLoss']) && request.acknowledgeLoss === true
    && Array.isArray(request.discipleIds) && request.discipleIds.length === 2 && request.discipleIds.every(validId) && unique(request.discipleIds);
}
function contextValid(context: CampaignContext): void {
  assertJson(context);
  if (!exact(context, ['revision', 'calendarMonth', 'activeExpedition', 'disciples', 'archivedDiscipleIds', 'availableResources', 'terminalLossId'])
    || !integer(context.revision) || !integer(context.calendarMonth) || typeof context.activeExpedition !== 'boolean'
    || !Array.isArray(context.disciples) || context.disciples.length > 36 || !Array.isArray(context.archivedDiscipleIds)
    || !context.archivedDiscipleIds.every(validId) || !unique(context.archivedDiscipleIds)
    || !Array.isArray(context.availableResources) || context.availableResources.length > RESOURCE_IDS.length
    || !unique(context.availableResources.map(line => line.resourceId))
    || context.availableResources.some(line => !exact(line, ['resourceId', 'quantity']) || !RESOURCE_IDS.includes(line.resourceId) || !integer(line.quantity, 0, 1_000_000_000))
    || (context.terminalLossId !== null && !validId(context.terminalLossId))) fail('INVALID_INPUT');
  if (!unique([...context.archivedDiscipleIds, ...context.disciples.map(disciple => disciple.discipleId)])) fail('INVALID_INPUT');
  for (const disciple of context.disciples) {
    if (!exact(disciple, ['discipleId', 'school', 'lifeState', 'deathId', 'available', 'learnedSkillIds'])
      || !validId(disciple.discipleId) || !schools.includes(disciple.school) || !['alive', 'pendingDeath', 'dead'].includes(disciple.lifeState)
      || typeof disciple.available !== 'boolean' || (disciple.lifeState !== 'alive' && disciple.available)
      || (disciple.lifeState === 'dead' ? !validId(disciple.deathId) : disciple.deathId !== null)
      || !Array.isArray(disciple.learnedSkillIds) || disciple.learnedSkillIds.length > 24 || !disciple.learnedSkillIds.every(validId)
      || !unique(disciple.learnedSkillIds)) fail('INVALID_INPUT');
  }
  const deathIds = context.disciples.flatMap(disciple => disciple.deathId ? [disciple.deathId] : []);
  if (!unique(deathIds)) fail('INVALID_INPUT');
}
function requireRecipient(context: CampaignContext, discipleId: string) {
  const disciple = context.disciples.find(entry => entry.discipleId === discipleId) ?? fail('UNKNOWN_DISCIPLE');
  if (disciple.lifeState !== 'alive' || !disciple.available) fail('DISCIPLE_UNAVAILABLE');
  return disciple;
}
function requireNewIdentities(state: CampaignState, context: CampaignContext, ids: readonly string[]): void {
  if (context.disciples.length + ids.length > 36) fail('ROSTER_FULL');
  const grantedIds = state.claims.flatMap(receipt => receipt.plan.grants.flatMap(grant => grant.kind === 'recruit' ? [grant.discipleId] : []));
  if (ids.some(id => context.archivedDiscipleIds.includes(id) || context.disciples.some(disciple => disciple.discipleId === id) || grantedIds.includes(id))) fail('IDENTITY_REUSED');
}
/** Construct all resource/effect terms from versioned catalogs. No client-supplied quantities or profiles survive. */
function constructPlan(state: CampaignState, request: CampaignClaimRequest, contextRevision: number, contextHash: string,
  recovery: CampaignClaimPlan['recovery'], relief: CampaignReliefBasis | null): CampaignClaimPlan {
  const base: Omit<CampaignClaimPlan, 'planHash'> = { claimId: '', expectedRevision: state.revision, contextRevision, contextHash,
    request: copy(request), costs: [], grants: [], recovery: copy(recovery), relief: copy(relief) };
  if (request.kind === 'equipment' || request.kind === 'recruit') {
    const route = campaignRoute(request.routeId) ?? fail('UNKNOWN_ROUTE');
    if (!state.clears.some(clear => clear.routeId === route.id)) fail('UNKNOWN_REWARD');
    if (request.kind === 'equipment') {
      if (!route.firstClear.equipmentId) fail('UNKNOWN_REWARD');
      base.claimId = equipmentClaimId(route.id);
      base.grants = [{ kind: 'equipment', acquisitionId: base.claimId, discipleId: request.discipleId, definitionId: route.firstClear.equipmentId }];
    } else {
      if (!route.firstClear.recruitInvitation) fail('UNKNOWN_REWARD');
      base.claimId = recruitClaimId(route.id); base.costs = copy(RECRUIT_COSTS);
      base.grants = [{ kind: 'recruit', acquisitionId: base.claimId, discipleId: request.discipleId,
        candidateId: `${base.claimId}/${request.school}`, profile: copy(CAMPAIGN_RECRUITS.find(profile => profile.school === request.school)!) }];
    }
  } else if (request.kind === 'lesson') {
    const knowledge = campaignKnowledge(request.knowledgeId);
    if (!knowledge || !archive(state).includes(request.knowledgeId)) fail('UNKNOWN_REWARD');
    base.claimId = `campaign/lesson/${request.knowledgeId}/${request.discipleId}`; base.costs = copy(knowledge.costs);
    base.grants = [{ kind: 'lesson', acquisitionId: base.claimId, discipleId: request.discipleId, knowledgeId: knowledge.id, skillId: knowledge.skillId }];
  } else if (request.kind === 'relief') {
    const previous = state.claims.filter(receipt => receipt.plan.relief !== null);
    if (state.mode !== 'standard' || !relief || !integer(relief.ordinal, 1) || relief.ordinal !== previous.length + 1
      || !integer(relief.month) || !validId(relief.survivorId) || relief.survivorId === request.discipleId
      || state.clears.some(clear => campaignRoute(clear.routeId)!.firstClear.recruitInvitation
        && !state.claims.some(receipt => receipt.plan.claimId === recruitClaimId(clear.routeId)))) fail('RELIEF_UNAVAILABLE');
    const last = previous.at(-1)?.plan.relief;
    if (last && relief.month - last.month < STANDARD_RELIEF_POLICY.cooldownMonths) fail('RELIEF_COOLDOWN');
    if (state.clears.some(clear => clear.endedMonth > relief.month)) fail('RELIEF_UNAVAILABLE');
    base.claimId = `campaign/relief/${relief.ordinal}`; base.costs = copy(STANDARD_RELIEF_POLICY.costs);
    base.grants = [{ kind: 'recruit', acquisitionId: base.claimId, discipleId: request.discipleId,
      candidateId: `${base.claimId}/${request.school}`, profile: copy(CAMPAIGN_RECRUITS.find(profile => profile.school === request.school)!) }];
  } else {
    if (state.mode !== 'standard' || !recovery || recovery.generation !== state.claims.filter(receipt => receipt.plan.recovery).length + 1
      || !validId(recovery.terminalLossId) || state.claims.some(receipt => receipt.plan.recovery?.terminalLossId === recovery.terminalLossId)) fail('RECOVERY_UNAVAILABLE');
    base.claimId = `campaign/recovery/${recovery.generation}`;
    base.grants = request.discipleIds.map((discipleId, index) => ({ kind: 'recruit' as const, acquisitionId: `${base.claimId}/disciple/${index + 1}`,
      discipleId, candidateId: `${base.claimId}/candidate/${index + 1}`, profile: copy(CAMPAIGN_RECRUITS.find(profile => profile.school === (index === 0 ? 'sword' : 'alchemy'))!) }));
    base.grants.push({ kind: 'resources', acquisitionId: `${base.claimId}/supplies`, resources: copy(RECOVERY_RESOURCES) });
  }
  if ((request.kind === 'recovery') !== (recovery !== null) || (request.kind === 'relief') !== (relief !== null) || !validId(base.claimId)
    || base.grants.some(grant => !validId(grant.acquisitionId) || (grant.kind === 'recruit' && !validId(grant.candidateId)))) fail('INVALID_INPUT');
  if (state.claims.some(receipt => receipt.plan.claimId === base.claimId)) fail('ALREADY_CLAIMED');
  return { ...base, planHash: stableHash(base) };
}
function prepare(state: CampaignState, request: CampaignClaimRequest, context: CampaignContext): CampaignClaimPlan {
  assertJson(request);
  const rawRequest: unknown = request;
  if (exact(rawRequest, ['kind', 'discipleIds', 'acknowledgeLoss']) && rawRequest.kind === 'recovery' && rawRequest.acknowledgeLoss !== true) fail('LOSS_ACKNOWLEDGEMENT_REQUIRED');
  if (!validRequest(request)) {
    fail('INVALID_INPUT');
  }
  contextValid(context);
  if (state.claims.length >= MAX_CAMPAIGN_CLAIMS) fail('HISTORY_LIMIT');
  let recovery: CampaignClaimPlan['recovery'] = null;
  let relief: CampaignReliefBasis | null = null;
  if (request.kind === 'equipment') requireRecipient(context, request.discipleId);
  if (request.kind === 'lesson') {
    const disciple = requireRecipient(context, request.discipleId);
    const knowledge = campaignKnowledge(request.knowledgeId) ?? fail('UNKNOWN_REWARD');
    if (disciple.school !== knowledge.school) fail('WRONG_SCHOOL');
    if (disciple.learnedSkillIds.includes(knowledge.skillId)) fail('ALREADY_LEARNED');
    if (knowledge.requiredSkillIds.some(id => !disciple.learnedSkillIds.includes(id))) fail('MISSING_PREREQUISITE');
  }
  if (request.kind === 'recruit') requireNewIdentities(state, context, [request.discipleId]);
  if (request.kind === 'relief') {
    const living = context.disciples.filter(disciple => disciple.lifeState !== 'dead');
    if (state.mode !== 'standard' || context.activeExpedition || living.length !== 1 || living[0]!.lifeState !== 'alive'
      || context.terminalLossId !== null) fail('RELIEF_UNAVAILABLE');
    requireNewIdentities(state, context, [request.discipleId]);
    relief = { ordinal: state.claims.filter(receipt => receipt.plan.relief !== null).length + 1,
      month: context.calendarMonth, survivorId: living[0]!.discipleId };
  }
  if (request.kind === 'recovery') {
    if (state.mode !== 'standard' || context.activeExpedition || context.disciples.some(disciple => disciple.lifeState !== 'dead')
      || context.terminalLossId === null || (!context.disciples.length && !context.archivedDiscipleIds.length)) fail('RECOVERY_UNAVAILABLE');
    // A nonempty live roster must actually include the final death; archived-only contexts are adapter-verified.
    if (context.disciples.length && !context.disciples.some(disciple => disciple.deathId === context.terminalLossId)) fail('RECOVERY_UNAVAILABLE');
    requireNewIdentities(state, context, request.discipleIds);
    recovery = { generation: state.claims.filter(receipt => receipt.plan.recovery).length + 1, terminalLossId: context.terminalLossId };
  }
  const plan = constructPlan(state, request, context.revision, stableHash(context), recovery, relief);
  if (plan.costs.some(cost => (context.availableResources.find(line => line.resourceId === cost.resourceId)?.quantity ?? 0) < cost.quantity)) fail('INSUFFICIENT_RESOURCES');
  return plan;
}
export function prepareCampaignClaimV2(state: CampaignState, request: CampaignClaimRequest, context: CampaignContext): CampaignPlanResult {
  try { assertState(state); return { ok: true, plan: freeze(prepare(state, request, context)) }; }
  catch (error) { return { ok: false, code: errorCode(error) }; }
}
function acknowledgementValid(plan: Immutable<CampaignClaimPlan>, acknowledgement: CampaignClaimAcknowledgement): boolean {
  return exact(acknowledgement, ['kind', 'claimId', 'planHash', 'transactionId', 'acquisitionIds'])
    && acknowledgement.kind === 'campaignEffectsCommitted' && acknowledgement.claimId === plan.claimId && acknowledgement.planHash === plan.planHash
    && validId(acknowledgement.transactionId) && Array.isArray(acknowledgement.acquisitionIds) && unique(acknowledgement.acquisitionIds)
    && same([...acknowledgement.acquisitionIds].sort(compareStable), plan.grants.map(grant => grant.acquisitionId).sort(compareStable));
}
/** Call with the PRE-transaction context after all effects have succeeded in a candidate World. Commit both together.
 * No acknowledgement on failure means no campaign mutation, so an identical plan can safely retry. */
export function acknowledgeCampaignClaimV2(state: CampaignState, plan: Immutable<CampaignClaimPlan>, context: CampaignContext,
  acknowledgement: CampaignClaimAcknowledgement): CampaignTransition {
  try {
    assertState(state); assertJson(plan); assertJson(acknowledgement);
    const prior = state.claims.find(receipt => receipt.plan.claimId === plan.claimId);
    if (prior) {
      if (!same(prior.plan, plan) || !same(prior.acknowledgement, acknowledgement)) fail('CLAIM_CONFLICT');
      return { ok: true, state, replayed: true };
    }
    if (plan.expectedRevision !== state.revision) fail('STALE_PLAN');
    const recalculated = prepare(state, copy(plan.request), context);
    if (!same(plan, recalculated)) fail('STALE_PLAN');
    if (!acknowledgementValid(plan, acknowledgement) || state.claims.some(receipt => receipt.acknowledgement.transactionId === acknowledgement.transactionId)) fail('INVALID_ACKNOWLEDGEMENT');
    const next = copy(state); next.revision = nextRevision(state); next.claims.push({ plan: copy(plan), acknowledgement: copy(acknowledgement) });
    return { ok: true, state: sealed(next), replayed: false };
  } catch (error) { return { ok: false, state, code: errorCode(error) }; }
}

function assertState(value: CampaignState): void {
  if (value && typeof value === 'object' && trusted.has(value)) return;
  assertJson(value);
  if (!exact(value, ['schemaVersion', 'rulesVersion', 'reliefProtocol', 'mode', 'revision', 'clears', 'claims']) || value.schemaVersion !== 2 || value.rulesVersion !== 2 || value.reliefProtocol !== 'standard-relief-v1'
    || !['standard', 'hardcore'].includes(value.mode) || !Array.isArray(value.clears) || value.clears.length > CAMPAIGN_ROUTES.length
    || !Array.isArray(value.claims) || value.claims.length > MAX_CAMPAIGN_CLAIMS || value.revision !== value.clears.length + value.claims.length) fail('INVALID_STATE');
  const replay: CampaignData = { schemaVersion: 2, rulesVersion: 2, reliefProtocol: 'standard-relief-v1', mode: value.mode, revision: 0, clears: [], claims: [] };
  const entries: { revision: number; clear: Immutable<CampaignClear> | null; receipt: Immutable<CampaignClaimReceipt> | null }[] = [
    ...value.clears.map((clear: Immutable<CampaignClear>) => ({ revision: clear.revision, clear, receipt: null })),
    ...value.claims.map((receipt: Immutable<CampaignClaimReceipt>) => ({ revision: receipt.plan?.expectedRevision + 1, clear: null, receipt })),
  ].sort((left, right) => left.revision - right.revision);
  for (const entry of entries) {
    if (entry.revision !== replay.revision + 1) fail('INVALID_STATE');
    if (entry.clear) {
      const clear = entry.clear;
      if (!exact(clear, ['revision', 'routeId', 'runId', 'settlementId', 'endedMonth', 'evidenceHash']) || !campaignRoute(clear.routeId)
        || !validId(clear.runId) || clear.runId.length > 64 || clear.settlementId !== `${clear.runId}/settlement`
        || !integer(clear.endedMonth) || !hash(clear.evidenceHash) || !unlocked(replay, clear.routeId)
        || replay.clears.some(previous => previous.routeId === clear.routeId || previous.runId === clear.runId || previous.settlementId === clear.settlementId)) fail('INVALID_STATE');
      replay.clears.push(copy(clear));
    } else if (entry.receipt) {
      const receipt = entry.receipt; const plan = receipt.plan;
      if (!exact(receipt, ['plan', 'acknowledgement']) || !exact(plan, ['claimId', 'expectedRevision', 'contextRevision', 'contextHash', 'request', 'costs', 'grants', 'recovery', 'relief', 'planHash'])
        || !validRequest(plan.request) || !integer(plan.contextRevision) || !hash(plan.contextHash)
        || (plan.recovery !== null && !exact(plan.recovery, ['generation', 'terminalLossId']))
        || (plan.relief !== null && !exact(plan.relief, ['ordinal', 'month', 'survivorId']))) fail('INVALID_STATE');
      const expected = constructPlan(replay, copy(plan.request), plan.contextRevision, plan.contextHash, copy(plan.recovery), copy(plan.relief));
      if (!same(plan, expected) || !acknowledgementValid(plan, copy(receipt.acknowledgement))
        || replay.claims.some(previous => previous.acknowledgement.transactionId === receipt.acknowledgement.transactionId)) fail('INVALID_STATE');
      const newIds = plan.grants.flatMap(grant => grant.kind === 'recruit' ? [grant.discipleId] : []);
      if (!unique(newIds) || replay.claims.some(previous => previous.plan.grants.some(grant => grant.kind === 'recruit' && newIds.includes(grant.discipleId)))) fail('INVALID_STATE');
      replay.claims.push(copy(receipt));
    } else fail('INVALID_STATE');
    replay.revision = entry.revision;
  }
  if (!same(replay, value)) fail('INVALID_STATE');
}
export function validateCampaignStateV2(value: unknown): readonly string[] {
  try { assertState(value as CampaignState); return []; } catch (error) { return [errorCode(error)]; }
}

export function serializeCampaignV2(state: CampaignState): string {
  assertState(state);
  const text = canonicalStringify({ format: 'shanmen-campaign', version: 2, state, checksum: stableHash(state) });
  if (text.length > 2_000_000) throw new RangeError('Campaign snapshot exceeds limit'); return text;
}
export function restoreCampaignV2(text: string): CampaignState {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new TypeError('Invalid campaign snapshot size');
  const parsed: unknown = JSON.parse(text); assertJson(parsed);
  if (!exact(parsed, ['format', 'version', 'state', 'checksum']) || parsed.format !== 'shanmen-campaign' || parsed.version !== 2
    || parsed.checksum !== stableHash(parsed.state)) throw new TypeError('Invalid campaign snapshot');
  assertState(parsed.state as CampaignState); return sealed(copy(parsed.state as CampaignState));
}
