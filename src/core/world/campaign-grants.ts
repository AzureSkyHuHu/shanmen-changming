import { isMapCell, cardinalDistance } from '../agents/navigation';
import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { BuildAuthorityCommandV2, BuildContentContext } from '../builds/v2-types';
import { acknowledgeCampaignClaimV2, prepareCampaignClaimV2 } from '../campaign/v2';
import type { CampaignGrant } from '../campaign/types';
import { applyCultivationAuthorityCommandV3 } from '../cultivation/v3/authority';
import type { CultivationAuthorityCommandV3 } from '../cultivation/v3/types';
import { commitReservation, normalizeResourceLines, reserveResources } from '../economy/inventory';
import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { copy } from '../expeditions/shared';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { allocateId, type SequenceKind } from '../kernel/ids';
import { checkedAdd } from '../kernel/numeric';
import { canonicalUtf8ByteLength } from '../save-budget/canonical-bytes';
import { campaignDomainRequest, isPlayerCampaignCommand, previewWorldCampaign, worldCampaignContext } from './campaign-queries';
import type { CampaignPlayerRequest, PlayerCampaignCommand, WorldCampaignError, WorldCampaignResult } from './campaign-types';
import type { WorldCampaignCommitCandidate, WorldCampaignTransactionProof } from './campaign-transaction-types';
import { getWorldBuildContentContext } from './content-access';
import { cloneWorldWithSharedHistory } from './history-access';
import type { GridPosition } from './types';
import type { PersistentPresentationId, WorldStateV8 } from './v8-types';

class GrantFault extends Error {
  constructor(readonly code: WorldCampaignError) { super(code); }
}
function fail(code: WorldCampaignError): never { throw new GrantFault(code); }
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
const PRESENTATIONS: Record<Extract<CampaignGrant, { kind: 'recruit' }>['profile']['school'], PersistentPresentationId> = {
  sword: 'disciple-0', body: 'disciple-1', alchemy: 'disciple-2', talisman: 'disciple-3',
};
function allocate(world: WorldStateV8, kind: SequenceKind): string {
  const result = allocateId(world.sequences, kind); world.sequences = result.sequences; return result.id;
}
function assertInventory(world: WorldStateV8): void {
  for (const id of RESOURCE_IDS) {
    const entry = world.inventory[id];
    if (!entry || entry.resourceId !== id || ![entry.owned, entry.reserved, entry.capacity].every(value => Number.isSafeInteger(value) && value >= 0)
      || entry.reserved > entry.owned || entry.owned > entry.capacity) fail('INVALID_STATE');
  }
}
/** Stable nearest-cell order is independent of tile-array order and never draws RNG.
 * Prefer an unoccupied cell, but a crowded map may share a walkable spawn tile. */
function spawnPosition(world: WorldStateV8): GridPosition {
  const center = world.buildings.find(building => building.operational && building.blueprintId === 'housing')
    ?? world.buildings.find(building => building.operational && building.blueprintId === 'storage')
    ?? { x: Math.floor(world.map.width / 2), y: Math.floor(world.map.height / 2) };
  const tiles = world.map.tiles.filter(tile => tile.walkable && isMapCell(world.map, tile))
    .sort((left, right) => cardinalDistance(left, center) - cardinalDistance(right, center) || left.y - right.y || left.x - right.x);
  const tile = tiles.find(entry => !world.disciples.some(member => member.position.x === entry.x && member.position.y === entry.y)) ?? tiles[0];
  if (!tile) fail('INVALID_STATE');
  return { x: tile.x, y: tile.y };
}
function applyBuild(world: WorldStateV8, context: BuildContentContext, rootActionId: string,
  proof: WorldCampaignTransactionProof, command: Body<BuildAuthorityCommandV2>): void {
  const commandId = `${rootActionId}/build/${proof.buildCommandIds.length}`;
  const transition = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences },
    { ...command, commandId, expectedRevision: world.builds.revision } as BuildAuthorityCommandV2, context);
  if (!transition.ok) fail(transition.code === 'OVERFLOW' ? 'OVERFLOW' : 'BUILD_REJECTED');
  if (transition.replayed) fail('BUILD_REJECTED');
  world.builds = copy(transition.frame.builds); world.sequences = copy(transition.frame.sequences);
  proof.buildCommandIds.push(commandId);
}
function applyCultivation(world: WorldStateV8, rootActionId: string, proof: WorldCampaignTransactionProof,
  command: Body<CultivationAuthorityCommandV3>): void {
  const commandId = `${rootActionId}/cultivation/${proof.cultivationCommandIds.length}`;
  const transition = applyCultivationAuthorityCommandV3({ cultivation: world.cultivation, inventory: world.inventory,
    randomStreams: world.randomStreams, sequences: world.sequences },
  { ...command, commandId, expectedRevision: world.cultivation.revision } as CultivationAuthorityCommandV3);
  if (!transition.ok) fail(transition.code === 'OVERFLOW' ? 'OVERFLOW' : 'CULTIVATION_REJECTED');
  if (transition.replayed) fail('CULTIVATION_REJECTED');
  world.cultivation = copy(transition.frame.cultivation); world.inventory = copy(transition.frame.inventory);
  world.sequences = copy(transition.frame.sequences); world.randomStreams = copy(transition.frame.randomStreams);
  proof.cultivationCommandIds.push(commandId);
}
function applyGrant(world: WorldStateV8, context: BuildContentContext, rootActionId: string,
  proof: WorldCampaignTransactionProof, result: WorldCampaignResult, grant: CampaignGrant): void {
  proof.acquisitionIds.push(grant.acquisitionId);
  if (grant.kind === 'resources') {
    proof.creditedResources.push(...copy(grant.resources)); return;
  }
  result.discipleIds.push(grant.discipleId);
  if (grant.kind === 'equipment') {
    applyBuild(world, context, rootActionId, proof, { kind: 'equipment.grant', acquisitionId: grant.acquisitionId,
      discipleId: grant.discipleId, definitionId: grant.definitionId });
    const item = world.builds.equipment.find(entry => entry.acquisitionId === grant.acquisitionId);
    if (!item) fail('BUILD_REJECTED'); result.itemInstanceIds.push(item.instanceId);
  } else if (grant.kind === 'lesson') {
    applyBuild(world, context, rootActionId, proof, { kind: 'skill.grantKnowledge', acquisitionId: grant.acquisitionId,
      discipleId: grant.discipleId, skillId: grant.skillId, provenance: { kind: 'archive', knowledgeId: grant.knowledgeId } });
    applyCultivation(world, rootActionId, proof, { kind: 'knowledge.grant', acquisitionId: grant.acquisitionId,
      claimId: proof.claimId!, discipleId: grant.discipleId, knowledgeId: grant.knowledgeId });
  } else {
    const discipleId = allocate(world, 'entity');
    if (discipleId !== grant.discipleId) fail('IDENTITY_REUSED');
    const { school, nameKey, ...profile } = grant.profile;
    // Cultivation ages advance at global month boundaries. New profiles therefore
    // inherit this month's start, rather than a new birthday at the intra-month tick.
    const birthMonth = checkedAdd(world.cultivation.calendarMonth, -profile.ageMonths);
    const birthCalendarTick = checkedAdd(0, birthMonth * CALENDAR_TICKS_PER_MONTH);
    const position = spawnPosition(world);
    applyBuild(world, context, rootActionId, proof, { kind: 'disciple.enroll', acquisitionId: grant.acquisitionId, discipleId, school });
    applyCultivation(world, rootActionId, proof, { kind: 'disciple.enroll', acquisitionId: grant.acquisitionId, discipleId, profile });
    world.disciples.push({ id: discipleId, nameKey, presentationId: PRESENTATIONS[school], ageMonths: profile.ageMonths,
      birthCalendarTick, position, lifeState: 'alive', canWork: profile.ageMonths >= 16 * 12,
      traveling: false, assignmentTransactionId: null, aptitude: profile.aptitude });
    result.itemInstanceIds.push(...world.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === discipleId).map(item => item.instanceId));
  }
}

/** Builds an isolated prospective boundary only: no World event, outer receipt,
 * admission, budget gate or publication occurs here. The gateway owns all of them.
 * Domain effects, payment and acknowledgement are returned together or discarded.
 * In particular recovery never retires or archives anybody on the caller's behalf. */
export function prepareWorldCampaignCommit(world: WorldStateV8, command: PlayerCampaignCommand): WorldCampaignCommitCandidate {
  if (!isPlayerCampaignCommand(command)) return { ok: false, code: 'INVALID_COMMAND' };
  try {
    // Data-only guard, not save-budget admission. This reuses authenticated frozen
    // JSON sizes and does not impose the expedition input's smaller array limit.
    canonicalUtf8ByteLength(world); assertInventory(world);
    const { commandId, expectedBasisStamp, ...body } = command;
    const request: CampaignPlayerRequest = body;
    const preview = previewWorldCampaign(world, request);
    if (preview.basisStamp !== expectedBasisStamp) fail('PREVIEW_STALE');
    if (preview.blockers.length) fail(preview.blockers[0]!);
    const context = getWorldBuildContentContext(world); if (!context) fail('INVALID_STATE');
    // A personal reward is not a passive ownership transfer to an away heir.
    if ((request.kind === 'campaign.equipment.claim' || request.kind === 'campaign.lesson.learn')
      && world.builds.disciples.some(member => member.discipleId === request.discipleId && member.lock !== null)) fail('DISCIPLE_UNAVAILABLE');
    const beforeContext = worldCampaignContext(world);
    const prepared = request.kind === 'estate.assign' ? null
      : prepareCampaignClaimV2(world.campaign.progress, campaignDomainRequest(world, request), beforeContext);
    if (prepared && !prepared.ok) fail(prepared.code);
    const plan = prepared?.ok ? prepared.plan : null;
    const candidate: WorldStateV8 = cloneWorldWithSharedHistory(world);
    const rootActionId = allocate(candidate, 'action');
    const reservationId = allocate(candidate, 'instance');
    if (Object.hasOwn(candidate.reservations, reservationId)) fail('INVALID_STATE');
    const reserved = reserveResources(candidate.inventory, plan?.costs ?? [], reservationId, rootActionId);
    if (!reserved.ok) fail(reserved.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_RESOURCES' : 'INVALID_STATE');
    const proof: WorldCampaignTransactionProof = { commandId, calendarTick: world.clock.calendarTick, claimId: plan?.claimId ?? null, payment: copy(reserved.reservation),
      creditedResources: [], acquisitionIds: [], buildCommandIds: [], cultivationCommandIds: [] };
    const result: WorldCampaignResult = { kind: request.kind, claimId: proof.claimId, discipleIds: [], itemInstanceIds: [] };
    candidate.inventory = copy(reserved.inventory);
    if (request.kind === 'estate.assign') {
      // Destination may be away/locked: transfer ownership alone, never equip it.
      applyBuild(candidate, context, rootActionId, proof, { kind: 'equipment.transfer', transferId: `${rootActionId}/estate`,
        itemInstanceId: request.itemInstanceId, fromOwner: { kind: 'sect-estate' }, toOwner: { kind: 'disciple', discipleId: request.discipleId },
        reason: { kind: 'estate-assignment', assignmentId: rootActionId } });
      result.discipleIds.push(request.discipleId); result.itemInstanceIds.push(request.itemInstanceId);
    } else {
      if (!plan) fail('INVALID_STATE');
      for (const grant of plan.grants) applyGrant(candidate, context, rootActionId, proof, result, copy(grant));
    }
    const credits: ResourceLine[] | null = normalizeResourceLines(proof.creditedResources);
    if (!credits) fail('INVALID_STATE'); proof.creditedResources = credits;
    // A single existing inventory transaction conserves all debits and credits.
    // Delaying it permits a late grant/capacity failure to discard the entire candidate.
    const committed = commitReservation(candidate.inventory, reserved.reservation, credits);
    if (!committed.ok) fail(committed.rejection.code === 'CAPACITY_EXCEEDED' ? 'INVENTORY_FULL' : 'INVALID_STATE');
    candidate.inventory = copy(committed.inventory);
    // Production owns World.reservations; campaign retains this committed proof
    // only in its eventual World event rather than creating an orphan live row.
    proof.payment = copy(committed.reservation);
    if (plan) {
      const acknowledged = acknowledgeCampaignClaimV2(world.campaign.progress, plan, beforeContext, { kind: 'campaignEffectsCommitted',
        claimId: plan.claimId, planHash: plan.planHash, transactionId: rootActionId, acquisitionIds: [...proof.acquisitionIds] });
      if (!acknowledged.ok) fail(acknowledged.code);
      candidate.campaign.progress = copy(acknowledged.state);
    }
    return { ok: true, candidate, rootActionId, proof, result };
  } catch (error) {
    return { ok: false, code: error instanceof GrantFault ? error.code : error instanceof RangeError ? 'OVERFLOW' : 'INVALID_STATE' };
  }
}
