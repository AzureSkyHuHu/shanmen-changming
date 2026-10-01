import { iterateArchivedEvents, iterateArchivedCommandReceipts } from '../history';
import { normalizeResourceLines } from '../economy/inventory';
import type { ResourceLine } from '../economy/types';
import type { CampaignClaimRequestV2, CampaignClaimReceiptV2 } from '../campaign/v2-types';
import type { CampaignGrant } from '../campaign/types';
import type { BuildAuthorityCommandV2 } from '../builds/v2-types';
import type { CultivationAuthorityCommandV3 } from '../cultivation/v3';
import { canonicalStringify } from '../kernel/serialization';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { getWorldContent } from './content-access';
import { canonicalUtf8ByteLength } from '../save-budget';
import { assertCampaignHistoricalAdmission } from './campaign-admission-proof';
import { isPlayerCampaignCommand, WORLD_CAMPAIGN_ERROR_CODES } from './campaign-queries';
import type { CampaignPlayerRequest, WorldCampaignResult } from './campaign-types';
import type { WorldStateV8 } from './v8-types';

/** Collect these from the actual live+archived World event/receipt pass. They are
 * filtered by kind only; this function checks the complete exact new protocol. */
export interface WorldCampaignProofFacts { events: readonly unknown[]; receipts: readonly unknown[] }
export function collectWorldCampaignProofFacts(world: WorldStateV8): WorldCampaignProofFacts {
  const events: unknown[] = [];
  for (const event of iterateArchivedEvents(world.history)) if (event.kind === 'campaign.committed') events.push(event);
  for (const event of world.events) if (event.kind === 'campaign.committed') events.push(event);
  const receipts: unknown[] = [];
  const collect = (receipt: { fingerprint: string }): void => {
    try { const source: unknown = JSON.parse(receipt.fingerprint); if (object(source) && source.kind === 'campaign.command') receipts.push(receipt); }
    catch { /* The generic World receipt pass rejects malformed fingerprints. */ }
  };
  for (const receipt of iterateArchivedCommandReceipts(world.history)) collect(receipt);
  for (const receipt of Object.values(world.commandReceipts)) collect(receipt);
  return { events, receipts };
}
export type WorldCampaignProofValidation =
  | { ok: true; claimIds: string[]; paymentInstanceIds: string[]; actionRootIds: string[]; buildCommandIds: string[]; cultivationCommandIds: string[] }
  | { ok: false; errors: string[] };
type ObjectValue = Record<string, unknown>;
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: readonly string[]): value is ObjectValue => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length;
const eventNumber = (id: string): number => Number(id.slice(6));
function idNumber(value: unknown, kind: string, next: number): number {
  if (typeof value !== 'string' || !new RegExp(`^${kind}:[1-9][0-9]*$`).test(value)) throw new Error(`Invalid campaign ${kind} identity`);
  const numeric = Number(value.slice(kind.length + 1));
  if (!Number.isSafeInteger(numeric) || numeric >= next) throw new Error(`Invalid campaign ${kind} sequence`);
  return numeric;
}
function requestMatches(player: CampaignPlayerRequest, domain: CampaignClaimRequestV2): boolean {
  switch (player.kind) {
    case 'campaign.equipment.claim': return domain.kind === 'equipment' && player.routeId === domain.routeId && player.discipleId === domain.discipleId;
    case 'campaign.lesson.learn': return domain.kind === 'lesson' && player.knowledgeId === domain.knowledgeId && player.discipleId === domain.discipleId;
    case 'campaign.recruit': return domain.kind === 'recruit' && player.routeId === domain.routeId && player.school === domain.school;
    case 'campaign.relief': return domain.kind === 'relief' && player.school === domain.school;
    case 'campaign.recover': return domain.kind === 'recovery' && player.acknowledgeLoss === domain.acknowledgeLoss;
    case 'estate.assign': return false;
  }
}

/** Cross-domain consistency only. The caller separately validates each domain's
 * immutable replay and the global World event/ID/receipt structure. No submitted
 * domain acknowledgement is accepted as proof that its World effects occurred. */
export function validateWorldCampaignProofs(world: WorldStateV8, facts: WorldCampaignProofFacts): WorldCampaignProofValidation {
  try {
    canonicalUtf8ByteLength(facts); // Never invoke an accessor while rejecting hostile proof data.
    const events = new Map<string, ObjectValue>();
    const paymentIds = new Set<string>(); const roots = new Set<string>();
    const claimed = new Set<string>(); const provedBuilds = new Set<string>(); const provedCultivation = new Set<string>();
    const buildEntries = new Map(world.builds.history.map(entry => [entry.command.commandId, entry]));
    const cultivationEntries = new Map(world.cultivation.authorityReceipts.map(entry => [entry.command.commandId, entry]));
    const claims = new Map(world.campaign.progress.claims.map(receipt => [receipt.plan.claimId, receipt]));
    for (const event of facts.events) {
      if (!exact(event, ['eventId', 'kind', 'tick', 'rootActionId', 'parentEventId', 'payload']) || event.kind !== 'campaign.committed'
        || !integer(event.tick) || event.tick > world.clock.simulationTick || event.parentEventId !== null
        || !exact(event.payload, ['commandId', 'calendarTick', 'claimId', 'payment', 'creditedResources', 'acquisitionIds', 'buildCommandIds', 'cultivationCommandIds'])) throw new Error('Invalid campaign commit event');
      idNumber(event.eventId, 'event', world.sequences.nextEvent); idNumber(event.rootActionId, 'action', world.sequences.nextAction);
      const proof = event.payload; const payment = proof.payment;
      if (typeof proof.commandId !== 'string' || events.has(proof.commandId) || typeof event.rootActionId !== 'string' || roots.has(event.rootActionId)
        || !integer(proof.calendarTick) || proof.calendarTick > world.clock.calendarTick || proof.calendarTick > event.tick
        || !exact(payment, ['reservationId', 'ownerTransactionId', 'lines', 'state']) || payment.state !== 'committed'
        || payment.ownerTransactionId !== event.rootActionId || typeof payment.reservationId !== 'string' || paymentIds.has(payment.reservationId)
        || !Array.isArray(payment.lines) || !Array.isArray(proof.creditedResources) || !ids(proof.acquisitionIds)
        || !ids(proof.buildCommandIds) || !ids(proof.cultivationCommandIds)) throw new Error('Invalid campaign payment/ownership proof');
      idNumber(payment.reservationId, 'instance', world.sequences.nextInstance);
      roots.add(event.rootActionId); paymentIds.add(payment.reservationId); events.set(proof.commandId, event);
    }
    const chronological = [...events.values()].sort((left, right) => Number(String(left.eventId).slice(6)) - Number(String(right.eventId).slice(6)));
    for (let index = 1; index < chronological.length; index += 1) {
      const previous = chronological[index - 1]!; const current = chronological[index]!;
      if ((previous.tick as number) > (current.tick as number) || ((previous.payload as ObjectValue).calendarTick as number) > ((current.payload as ObjectValue).calendarTick as number)) throw new Error('Campaign transaction chronology moved backwards');
    }
    const consumedEvents = new Set<string>();
    for (const receipt of facts.receipts) {
      if (!exact(receipt, ['commandId', 'fingerprint', 'result']) || typeof receipt.commandId !== 'string' || typeof receipt.fingerprint !== 'string'
        || !object(receipt.result) || receipt.result.commandId !== receipt.commandId) throw new Error('Invalid campaign outer receipt');
      const origin: unknown = JSON.parse(receipt.fingerprint);
      if (!exact(origin, ['kind', 'payload']) || origin.kind !== 'campaign.command' || !exact(origin.payload, ['command'])
        || !isPlayerCampaignCommand(origin.payload.command) || origin.payload.command.commandId !== receipt.commandId
        || receipt.fingerprint !== canonicalStringify(origin)) throw new Error('Invalid campaign originating command');
      const { commandId: _id, expectedBasisStamp: _stamp, ...request } = origin.payload.command;
      const result = receipt.result;
      if (result.status === 'rejected') {
        if (!exact(result, ['commandId', 'status', 'transactionId', 'eventIds', 'rejection']) || result.transactionId !== null || !same(result.eventIds, [])
          || !exact(result.rejection, ['code', 'campaignCode']) || result.rejection.code !== 'CAMPAIGN_REJECTED'
          || !WORLD_CAMPAIGN_ERROR_CODES.includes(result.rejection.campaignCode as never) || events.has(receipt.commandId)) throw new Error('Invalid rejected campaign receipt');
        continue;
      }
      const event = events.get(receipt.commandId);
      if (!exact(result, ['commandId', 'status', 'transactionId', 'eventIds', 'rejection', 'campaignResult']) || result.status !== 'accepted'
        || result.transactionId !== null || result.rejection !== null || !event || consumedEvents.has(receipt.commandId)
        || !same(result.eventIds, [event.eventId])) throw new Error('Campaign receipt lacks its unique commit event');
      consumedEvents.add(receipt.commandId);
      const proof = event.payload as ObjectValue; const payment = proof.payment as ObjectValue; const root = event.rootActionId as string;
      const expectedBuilds: Body<BuildAuthorityCommandV2>[] = []; const expectedCultivation: Body<CultivationAuthorityCommandV3>[] = [];
      const expectedResult: WorldCampaignResult = { kind: request.kind, claimId: null, discipleIds: [], itemInstanceIds: [] };
      let claim: CampaignClaimReceiptV2 | undefined; const credits: ResourceLine[] = [];
      if (request.kind === 'estate.assign') {
        if (proof.claimId !== null || !same(proof.acquisitionIds, []) || !world.legacy.estates.some(estate => estate.settledMonth !== null && estate.itemInstanceIds.includes(request.itemInstanceId))) throw new Error('Estate assignment lacks a settled item');
        expectedBuilds.push({ kind: 'equipment.transfer', transferId: `${root}/estate`, itemInstanceId: request.itemInstanceId,
          fromOwner: { kind: 'sect-estate' }, toOwner: { kind: 'disciple', discipleId: request.discipleId }, reason: { kind: 'estate-assignment', assignmentId: root } });
        expectedResult.discipleIds.push(request.discipleId); expectedResult.itemInstanceIds.push(request.itemInstanceId);
      } else {
        if (typeof proof.claimId !== 'string' || claimed.has(proof.claimId)) throw new Error('Missing or duplicate campaign claim proof');
        claim = claims.get(proof.claimId);
        if (!claim || !requestMatches(request, claim.plan.request) || claim.acknowledgement.transactionId !== root
          || !same(proof.acquisitionIds, claim.acknowledgement.acquisitionIds)) throw new Error('Campaign claim differs from its World command acknowledgement');
        const month = Math.floor((proof.calendarTick as number) / CALENDAR_TICKS_PER_MONTH);
        if (claim.plan.relief && claim.plan.relief.month !== month) throw new Error('Relief commit month differs from its admitted basis');
        const domainRequest = claim.plan.request;
        const unlockRoutes = domainRequest.kind === 'equipment' || domainRequest.kind === 'recruit' ? [domainRequest.routeId]
          : domainRequest.kind === 'lesson' ? getWorldContent(world).campaign!.routes.filter(route => route.firstClear.knowledgeIds.includes(domainRequest.knowledgeId)).map(route => route.id) : [];
        if (unlockRoutes.length && !world.campaign.progress.clears.some(clear => unlockRoutes.includes(clear.routeId) && clear.endedMonth <= month)) throw new Error('Campaign transaction predates its clear entitlement');
        if (claim.plan.recovery && !world.cultivation.deaths.some(death => death.deathId === claim!.plan.recovery!.terminalLossId && death.month <= month)) throw new Error('Recovery transaction predates its finalized loss');
        claimed.add(proof.claimId); expectedResult.claimId = proof.claimId;
        for (const grant of claim.plan.grants) {
          if (grant.kind === 'resources') { credits.push(...grant.resources); continue; }
          if (!expectedResult.discipleIds.includes(grant.discipleId)) expectedResult.discipleIds.push(grant.discipleId);
          if (grant.kind === 'equipment') {
            expectedBuilds.push({ kind: 'equipment.grant', acquisitionId: grant.acquisitionId, discipleId: grant.discipleId, definitionId: grant.definitionId });
            const items = world.builds.equipment.filter(item => item.acquisitionId === grant.acquisitionId && item.definitionId === grant.definitionId);
            if (items.length !== 1) throw new Error('Campaign equipment claim has no unique acquired item');
            expectedResult.itemInstanceIds.push(items[0]!.instanceId);
          } else if (grant.kind === 'lesson') {
            expectedBuilds.push({ kind: 'skill.grantKnowledge', acquisitionId: grant.acquisitionId, discipleId: grant.discipleId, skillId: grant.skillId,
              provenance: { kind: 'archive', knowledgeId: grant.knowledgeId } });
            expectedCultivation.push({ kind: 'knowledge.grant', acquisitionId: grant.acquisitionId, claimId: claim.plan.claimId, discipleId: grant.discipleId, knowledgeId: grant.knowledgeId });
          } else {
            expectedBuilds.push({ kind: 'disciple.enroll', acquisitionId: grant.acquisitionId, discipleId: grant.discipleId, school: grant.profile.school });
            const { school: _school, nameKey: _name, ...profile } = grant.profile;
            expectedCultivation.push({ kind: 'disciple.enroll', acquisitionId: grant.acquisitionId, discipleId: grant.discipleId, profile });
            const items = world.builds.equipment.filter(item => item.acquisitionId.startsWith(`${grant.acquisitionId}/`));
            if (items.length !== 3) throw new Error('Campaign recruit lacks its exact starter equipment');
            expectedResult.itemInstanceIds.push(...items.map(item => item.instanceId));
            validateRecruitIdentity(world, grant, proof.calendarTick as number);
          }
        }
      }
      assertCampaignHistoricalAdmission(world, request, claim, root, event.eventId as string, proof.calendarTick as number);
      if (!same(payment.lines, claim?.plan.costs ?? []) || !same(proof.creditedResources, normalizeResourceLines(credits))) throw new Error('Campaign payment differs from registered costs/credits');
      if (!same(proof.buildCommandIds, expectedBuilds.map((_, index) => `${root}/build/${index}`))
        || !same(proof.cultivationCommandIds, expectedCultivation.map((_, index) => `${root}/cultivation/${index}`))) throw new Error('Campaign domain command ownership differs');
      for (const [index, body] of expectedBuilds.entries()) {
        const id = `${root}/build/${index}`; const entry = buildEntries.get(id);
        if (!entry?.authority || provedBuilds.has(id)) throw new Error('Campaign build effect is missing or reused');
        if (entry.sequencesBefore.nextAction !== Number(root.slice(7)) + 1 || entry.sequencesBefore.nextEvent !== eventNumber(event.eventId as string)) throw new Error('Campaign action allocation boundary differs');
        const { commandId: _command, expectedRevision: _revision, ...actual } = entry.command;
        if (!same(actual, body)) throw new Error('Campaign build effect differs from promised grant'); provedBuilds.add(id);
      }
      for (const [index, body] of expectedCultivation.entries()) {
        const id = `${root}/cultivation/${index}`; const entry = cultivationEntries.get(id);
        if (!entry || provedCultivation.has(id)) throw new Error('Campaign cultivation effect is missing or reused');
        const { commandId: _command, expectedRevision: _revision, ...actual } = entry.command;
        if (!same(actual, body)) throw new Error('Campaign cultivation effect differs from promised grant'); provedCultivation.add(id);
      }
      if (!same(result.campaignResult, expectedResult)) throw new Error('Campaign result identity differs from committed grants');
    }
    if (consumedEvents.size !== events.size) throw new Error('Orphan campaign commit event');
    if (claimed.size !== claims.size) throw new Error('Campaign claim lacks a defined World transaction proof');
    // Every new campaign-controlled authority effect must be claimed by exactly one
    // World transaction, even if an unrelated legitimate claim also exists.
    for (const entry of world.builds.history.slice(world.builds.migration?.prefixLength ?? 0)) if (entry.authority) {
      const command = entry.command;
      const campaignControlled = command.kind === 'equipment.grant' || command.kind === 'disciple.enroll'
        || command.kind === 'skill.grantKnowledge' && command.provenance.kind === 'archive'
        || command.kind === 'equipment.transfer' && command.reason.kind === 'estate-assignment';
      if (campaignControlled && !provedBuilds.has(command.commandId)) throw new Error('Unclaimed campaign build authority');
    }
    for (const entry of world.cultivation.authorityReceipts) if (entry.command.kind !== 'disciple.archive' && !provedCultivation.has(entry.command.commandId)) throw new Error('Unclaimed campaign cultivation authority');
    return { ok: true, claimIds: [...claimed], paymentInstanceIds: [...paymentIds], actionRootIds: [...roots], buildCommandIds: [...provedBuilds], cultivationCommandIds: [...provedCultivation] };
  } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : 'Invalid campaign transaction proof'] }; }
}
function validateRecruitIdentity(world: WorldStateV8, grant: Extract<CampaignGrant, { kind: 'recruit' }>, calendarTick: number): void {
  const actor = world.disciples.find(member => member.id === grant.discipleId) ?? world.legacy.archivedIdentities.find(member => member.discipleId === grant.discipleId);
  const presentation = { sword: 'disciple-0', body: 'disciple-1', alchemy: 'disciple-2', talisman: 'disciple-3' }[grant.profile.school];
  const birth = (Math.floor(calendarTick / CALENDAR_TICKS_PER_MONTH) - grant.profile.ageMonths) * CALENDAR_TICKS_PER_MONTH;
  if (!Number.isSafeInteger(birth) || !actor || actor.nameKey !== grant.profile.nameKey || actor.presentationId !== presentation
    || actor.birthCalendarTick !== birth || actor.aptitude !== grant.profile.aptitude) throw new Error('Campaign recruit identity differs from its committed profile/month');
  if ('archivedMonth' in actor) {
    const death = world.cultivation.deaths.find(entry => entry.discipleId === grant.discipleId && entry.deathId === actor.deathId);
    if (!death || actor.ageMonths !== grant.profile.ageMonths + death.month - Math.floor(calendarTick / CALENDAR_TICKS_PER_MONTH)) throw new Error('Recruit death chronology predates enrollment');
  }
}
