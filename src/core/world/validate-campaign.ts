import { contentIdentity, LEGACY_V7_CONTENT, resolveContentIdentity } from '../../content/registry';
import { campaignRoute, campaignKnowledge } from '../campaign/catalog';
import { validateCampaignStateV2 } from '../campaign/v2';
import { restoreRegisteredExpedition } from '../expeditions/versioned';
import { canonicalStringify, stableHash } from '../kernel/serialization';
import { REALMS } from '../cultivation/types';
import type { WorldStateV8 } from './v8-types';

const same = (left: unknown, right: unknown) => canonicalStringify(left) === canonicalStringify(right);
const exact = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Authoritative cross-domain links. A syntactically valid standalone grant is never enough. */
export function validateWorldCampaign(world: WorldStateV8): string[] {
  try {
    if (!exact(world.campaign, ['schemaVersion', 'progress', 'clearEvidence']) || world.campaign.schemaVersion !== 1
      || !Array.isArray(world.campaign.clearEvidence) || world.campaign.clearEvidence.length > 5
      || validateCampaignStateV2(world.campaign.progress).length) throw new Error('Invalid campaign authority');
    const progress = world.campaign.progress; const proofs = world.campaign.clearEvidence;
    // This additive migration checkpoint has no committing World transaction/cost
    // fact schema yet. A standalone domain acknowledgement cannot certify payment
    // or applied grants. The committing bridge must replace this fail-closed gate
    // with bidirectional World receipt/event/domain-effect verification.
    if (progress.claims.length > 0) throw new Error('Campaign claim lacks a defined World transaction proof');
    if (proofs.length !== progress.clears.length || new Set(proofs.map(proof => proof.routeId)).size !== proofs.length) throw new Error('Campaign clear proof count differs');
    for (const proof of proofs) {
      if (!exact(proof, ['routeId', 'expedition'])) throw new Error('Invalid campaign proof shape');
      const registered = restoreRegisteredExpedition(proof.expedition); const run = registered.run;
      const route = campaignRoute(proof.routeId); const clear = progress.clears.find(entry => entry.routeId === proof.routeId);
      const settlement = run.settlement;
      if (!route || !clear || registered.routeId !== proof.routeId || run.phase !== 'Ended' || run.locked || run.currentEncounter
        || !settlement?.committed || settlement.reason !== 'victory' || settlement.returnProgress !== settlement.returnMonths
        || run.route.length !== route.specification.encounterCount || run.encounterResults.length !== run.route.length
        || !run.members.some(member => member.alive) || run.route.some(node => !run.encounterResults.some(result => result.encounterId === `${node.nodeVisitId}/encounter` && result.outcome === 'victory'))
        || clear.runId !== run.runId || clear.settlementId !== settlement.settlementId || clear.endedMonth !== run.calendarMonth
        || clear.evidenceHash !== stableHash({ routeId: proof.routeId, origin: run.origin, route: run.route, encounterResults: run.encounterResults, settlement })) throw new Error('Campaign clear has no matching settled proof');
      if (!world.expedition.history.some(history => history.runId === run.runId && history.settlementId === settlement.settlementId
        && history.routeId === proof.routeId && same(history.contentIdentity, registered.identity) && history.protocol === registered.protocol
        && history.reason === 'victory')) throw new Error('Campaign proof lacks World return settlement');
    }
    if (!exact(world.legacy, ['schemaVersion', 'archivedIdentities', 'estates']) || world.legacy.schemaVersion !== 1
      || !Array.isArray(world.legacy.archivedIdentities) || !Array.isArray(world.legacy.estates)) throw new Error('Invalid deceased/estate authority');
    const archived = world.legacy.archivedIdentities;
    if (archived.length !== world.builds.retiredDisciples.length || archived.length !== world.cultivation.archivedDisciples.length
      || new Set(archived.map(entry => entry.discipleId)).size !== archived.length) throw new Error('Archived domain identity counts differ');
    for (const identity of archived) {
      const build = world.builds.retiredDisciples.find(entry => entry.discipleId === identity.discipleId);
      const profile = world.cultivation.archivedDisciples.find(entry => entry.discipleId === identity.discipleId);
      if (!exact(identity, ['discipleId', 'nameKey', 'presentationId', 'birthCalendarTick', 'ageMonths', 'aptitude', 'school', 'realm', 'deathId', 'archivedMonth'])
        || !build || !profile || build.school !== identity.school || build.deathId !== identity.deathId || profile.deathId !== identity.deathId
        || profile.realm !== identity.realm || profile.ageMonths !== identity.ageMonths || profile.aptitude !== identity.aptitude
        || typeof identity.nameKey !== 'string' || !/^disciple-[0-3]$/.test(identity.presentationId)
        || !Number.isSafeInteger(identity.birthCalendarTick) || !integer(identity.archivedMonth)
        || identity.archivedMonth > world.cultivation.calendarMonth || world.disciples.some(member => member.id === identity.discipleId)) throw new Error('Invalid deceased identity projection');
    }
    const allIds = new Set([...world.disciples.map(member => member.id), ...archived.map(member => member.discipleId)]);
    const grants = progress.claims.flatMap(receipt => receipt.plan.grants.map(grant => ({ grant, receipt })));
    const prefix = world.builds.migration?.prefixLength ?? 0;
    for (const entry of world.builds.history.slice(prefix)) {
      if (!entry.authority) continue;
      const command = entry.command;
      if (command.kind === 'equipment.grant') {
        if (!grants.some(({ grant }) => grant.kind === 'equipment' && grant.acquisitionId === command.acquisitionId
          && grant.discipleId === command.discipleId && grant.definitionId === command.definitionId)) throw new Error('Build equipment grant lacks campaign acquisition');
      } else if (command.kind === 'disciple.enroll') {
        const grant = grants.find(({ grant }) => grant.kind === 'recruit' && grant.acquisitionId === command.acquisitionId)?.grant;
        if (!grant || grant.kind !== 'recruit' || grant.discipleId !== command.discipleId || grant.profile.school !== command.school) throw new Error('Build enrollment lacks campaign acquisition');
      } else if (command.kind === 'skill.grantKnowledge') {
        const definition = campaignKnowledge(command.provenance.knowledgeId);
        if (!definition || definition.skillId !== command.skillId) throw new Error('Knowledge/skill mapping differs from registered lesson');
        if (command.provenance.kind === 'archive') {
          if (!grants.some(({ grant }) => grant.kind === 'lesson' && grant.acquisitionId === command.acquisitionId
            && grant.discipleId === command.discipleId && grant.knowledgeId === command.provenance.knowledgeId && grant.skillId === command.skillId)) throw new Error('Build knowledge grant lacks paid campaign lesson');
        } else {
          const provenance = command.provenance;
          const student = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(member => member.discipleId === command.discipleId);
          if (!student?.knowledge.some(knowledge => knowledge.knowledgeId === provenance.knowledgeId && knowledge.teacherId === provenance.teacherId && knowledge.teachingId === provenance.teachingId)
            || command.acquisitionId !== `teaching/${provenance.teachingId}/${command.discipleId}`
            || !world.cultivation.events.some(event => event.kind === 'cultivation.taught' && event.discipleId === command.discipleId && event.relatedId === provenance.teachingId)) throw new Error('Build knowledge grant lacks completed teaching');
        }
      } else if (command.kind === 'disciple.retire') {
        if (!world.cultivation.deaths.some(death => death.deathId === command.deathId && death.discipleId === command.discipleId)
          || !world.legacy.estates.some(estate => estate.deathId === command.deathId && estate.discipleId === command.discipleId && estate.settledMonth !== null)) throw new Error('Build retirement lacks finalized estate');
      } else if (command.kind === 'equipment.transfer' && command.reason.kind === 'death') {
        const deathId = command.reason.deathId;
        if (!world.legacy.estates.some(estate => estate.deathId === deathId && estate.transferCommandIds.includes(command.commandId)
          && estate.itemInstanceIds.includes(command.itemInstanceId) && command.fromOwner.kind === 'disciple'
          && command.fromOwner.discipleId === estate.discipleId && same(command.toOwner, estate.settledOwner))) throw new Error('Equipment transfer lacks estate ownership proof');
      } else if (command.kind === 'equipment.transfer') {
        throw new Error('Estate assignment lacks a defined World transaction proof');
      } else if (command.kind === 'milestone.award') {
        if (command.ruleId === 'expedition.first-victory') {
          // Route-first-clear proof cannot justify a recruit's first victory on
          // a later repeat run. New awards stay closed until the World bridge
          // records the exact settled run/survivor evidence for every such award.
          throw new Error('First-victory award lacks a defined World settlement proof');
        } else {
          const profile = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(member => member.discipleId === command.discipleId);
          if (!profile || REALMS.indexOf(profile.realm) < REALMS.indexOf(command.ruleId.slice(6) as typeof REALMS[number])) throw new Error('Realm award lacks attained realm');
        }
      }
    }
    for (const receipt of world.cultivation.authorityReceipts) {
      const command = receipt.command;
      if (command.kind === 'disciple.enroll') {
        const grant = grants.find(({ grant }) => grant.kind === 'recruit' && grant.acquisitionId === command.acquisitionId)?.grant;
        if (!grant || grant.kind !== 'recruit' || grant.discipleId !== command.discipleId) throw new Error('Cultivation enrollment lacks campaign acquisition');
        const { school: _school, nameKey: _name, ...profile } = grant.profile;
        if (!same(profile, command.profile)) throw new Error('Recruit cultivation profile differs from fixed catalog');
      } else if (command.kind === 'knowledge.grant') {
        if (!grants.some(({ grant, receipt }) => grant.kind === 'lesson' && grant.acquisitionId === command.acquisitionId
          && receipt.plan.claimId === command.claimId && grant.discipleId === command.discipleId && grant.knowledgeId === command.knowledgeId)) throw new Error('Cultivation knowledge lacks paid lesson');
      } else if (!archived.some(identity => identity.discipleId === command.discipleId && identity.deathId === command.deathId)) throw new Error('Cultivation archive lacks World identity');
    }
    const estateDeaths = new Set<string>();
    if (world.builds.equipment.some(item => item.owner.kind === 'disciple'
      && !world.builds.disciples.some(member => member.discipleId === (item.owner as { discipleId: string }).discipleId))) throw new Error('Equipment remains owned by a retired identity');
    for (const estate of world.legacy.estates) {
      if (!exact(estate, ['estateId', 'deathId', 'discipleId', 'beneficiaryId', 'itemInstanceIds', 'pendingRunId', 'transferCommandIds', 'recordedMonth', 'settledMonth', 'settledOwner'])
        || estate.estateId !== `estate/${estate.deathId}` || estateDeaths.has(estate.deathId) || !allIds.has(estate.discipleId)
        || (estate.beneficiaryId !== null && !allIds.has(estate.beneficiaryId)) || !integer(estate.recordedMonth)
        || estate.recordedMonth > world.cultivation.calendarMonth || !world.cultivation.deaths.some(death => death.deathId === estate.deathId
          && death.discipleId === estate.discipleId && death.beneficiaryId === estate.beneficiaryId)
        || new Set(estate.itemInstanceIds).size !== estate.itemInstanceIds.length) throw new Error('Invalid estate fact');
      estateDeaths.add(estate.deathId);
      if (estate.settledMonth === null) {
        const member = world.builds.disciples.find(entry => entry.discipleId === estate.discipleId);
        if (!member || estate.settledOwner !== null || estate.transferCommandIds.length
          || (member.lock?.runId ?? null) !== estate.pendingRunId || !same(estate.itemInstanceIds,
            world.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === estate.discipleId).map(item => item.instanceId))) throw new Error('Pending estate changed locked ownership');
      } else {
        if (!integer(estate.settledMonth) || estate.settledMonth < estate.recordedMonth || estate.settledMonth > world.cultivation.calendarMonth
          || estate.pendingRunId !== null || estate.settledOwner === null || estate.transferCommandIds.length !== estate.itemInstanceIds.length
          || !archived.some(identity => identity.discipleId === estate.discipleId && identity.deathId === estate.deathId)) throw new Error('Incomplete settled estate');
        const transfers = world.builds.history.filter(entry => entry.authority && entry.command.kind === 'equipment.transfer'
          && entry.command.reason.kind === 'death' && entry.command.reason.deathId === estate.deathId);
        const commands = transfers.map(entry => entry.command);
        if (new Set(estate.transferCommandIds).size !== estate.transferCommandIds.length || transfers.length !== estate.itemInstanceIds.length
          || !same([...estate.transferCommandIds].sort(), commands.map(command => command.commandId).sort())
          || !same([...estate.itemInstanceIds].sort(), commands.map(command => command.kind === 'equipment.transfer' ? command.itemInstanceId : '').sort())
          || commands.some(command => command.kind !== 'equipment.transfer' || command.fromOwner.kind !== 'disciple'
            || command.fromOwner.discipleId !== estate.discipleId || !same(command.toOwner, estate.settledOwner))) throw new Error('Estate item/transfer proof is incomplete');
        // Existing equipment can leave a disciple only through this death transfer.
        // The earliest transfer's global event counter locates beneficiary life in
        // the same immutable chronology; a later death must not undo an old inheritance.
        const beforeEvent = Math.min(...transfers.map(entry => entry.sequencesBefore.nextEvent));
        const beneficiary = estate.beneficiaryId;
        let eligible = beneficiary !== null;
        if (beneficiary !== null) {
          const profile = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(member => member.discipleId === beneficiary);
          const lifeEvents = world.cultivation.events.filter(event => event.discipleId === beneficiary
            && (event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.died'));
          const firstUnavailableEvent = Math.min(...lifeEvents.map(event => Number(event.eventId.slice(6))));
          const currentAlive = world.cultivation.disciples.some(member => member.discipleId === beneficiary && member.lifeState === 'alive');
          eligible = !!profile && (currentAlive || (lifeEvents.length > 0 && firstUnavailableEvent >= beforeEvent));
        }
        const expectedOwner = eligible ? { kind: 'disciple', discipleId: beneficiary } : { kind: 'sect-estate' };
        if (!same(estate.settledOwner, expectedOwner)) throw new Error('Estate recipient differs from committed eligible heir');
      }
    }
    if (world.cultivation.deaths.some(death => !estateDeaths.has(death.deathId))) throw new Error('Finalized death lacks estate responsibility');
    if (!resolveContentIdentity(world.contentIdentity, { allowCandidate: true }) || same(world.contentIdentity, contentIdentity(LEGACY_V7_CONTENT))) throw new Error('World has no current growth content');
    return [];
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid campaign provenance']; }
}
