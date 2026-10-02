import { inspectEstateIdentityRecords, inspectEstateSettlementRecords } from './estate-records';
import { permanentTeachingLesson } from './teaching-provenance';
import { contentIdentity, LEGACY_V7_CONTENT, resolveContentIdentity } from '../../content/registry';
import { campaignRoute, campaignKnowledge } from '../campaign/catalog';
import { validateCampaignStateV2 } from '../campaign/v2';
import { restoreRegisteredExpedition } from '../expeditions/versioned';
import { canonicalStringify, stableHash } from '../kernel/serialization';
import { REALMS } from '../cultivation/types';
import { collectWorldCampaignProofFacts, validateWorldCampaignProofs } from './campaign-proof';
import type { WorldStateV8 } from './v8-types';

const same = (left: unknown, right: unknown) => canonicalStringify(left) === canonicalStringify(right);
const exact = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
/** Authoritative cross-domain links. A syntactically valid standalone grant is never enough. */
export interface WorldCampaignInspection { errors: string[]; paymentInstanceIds: string[]; actionRootIds: string[] }
export function validateWorldCampaign(world: WorldStateV8): string[] { return inspectWorldCampaign(world).errors; }
export function inspectWorldCampaign(world: WorldStateV8): WorldCampaignInspection {
  try {
    if (!exact(world.campaign, ['schemaVersion', 'progress', 'clearEvidence', 'settledRunEvidence']) || world.campaign.schemaVersion !== 2
      || !Array.isArray(world.campaign.clearEvidence) || world.campaign.clearEvidence.length > 5 || !Array.isArray(world.campaign.settledRunEvidence)
      || validateCampaignStateV2(world.campaign.progress).length) throw new Error('Invalid campaign authority');
    const progress = world.campaign.progress; const proofs = world.campaign.clearEvidence;
    const transactions = validateWorldCampaignProofs(world, collectWorldCampaignProofFacts(world));
    if (!transactions.ok) throw new Error(transactions.errors[0]);
    if (proofs.length !== progress.clears.length || new Set(proofs.map(proof => proof.routeId)).size !== proofs.length) throw new Error('Campaign clear proof count differs');
    const runProofs = world.campaign.settledRunEvidence.map(proof => restoreRegisteredExpedition(proof));
    if (new Set(runProofs.map(proof => proof.run.runId)).size !== runProofs.length) throw new Error('Duplicate settled run evidence');
    for (const registered of runProofs) {
      const run = registered.run; const settlement = run.settlement;
      const history = world.expedition.history.find(entry => entry.runId === run.runId);
      if (run.phase !== 'Ended' || run.locked || !settlement?.committed || !history || history.settlementId !== settlement.settlementId
        || history.routeId !== registered.routeId || !same(history.contentIdentity, registered.identity) || history.protocol !== registered.protocol
        || history.reason !== settlement.reason || !same(history.loot, settlement.loot) || !same(history.returnedSupplies, settlement.unusedSupplies)
        || !same(history.lostLoot, settlement.lostLoot) || !same([...history.survivingDiscipleIds].sort(), run.members.filter(member => member.alive).map(member => member.discipleId).sort())
        || !same([...history.deadDiscipleIds].sort(), run.members.filter(member => !member.alive).map(member => member.discipleId).sort())) throw new Error('Settled evidence differs from its World settlement');
      const permanent = proofs.some(proof => proof.runId === run.runId) || world.builds.history.slice(world.builds.migration?.prefixLength ?? 0).some(entry => entry.authority
        && entry.command.kind === 'milestone.award' && entry.command.ruleId === 'expedition.first-victory' && entry.command.commandId === `${run.runId}/award/${entry.command.discipleId}`)
        || run.members.some(member => !member.alive && world.cultivation.deaths.some(death => death.deathId === member.permanentDeathId && death.discipleId === member.discipleId));
      if (!permanent) throw new Error('Orphan settled run evidence');
    }
    for (const proof of proofs) {
      if (!exact(proof, ['routeId', 'runId'])) throw new Error('Invalid campaign proof shape');
      const registered = runProofs.find(entry => entry.run.runId === proof.runId); if (!registered) throw new Error('Campaign clear has no settled run reference');
      const run = registered.run;
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
    inspectEstateIdentityRecords(world);
    const archived = world.legacy.archivedIdentities;
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
          const lesson = permanentTeachingLesson(world, provenance.teachingId);
          if (!lesson || lesson.teacherId !== provenance.teacherId || lesson.studentId !== command.discipleId || lesson.definition.skillId !== command.skillId) throw new Error('Teaching lacked its permanent source at admission');
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
        if (!transactions.buildCommandIds.includes(command.commandId)) throw new Error('Estate assignment lacks a defined World transaction proof');
      } else if (command.kind === 'milestone.award') {
        if (command.ruleId === 'expedition.first-victory') {
          if (!runProofs.some(proof => proof.run.settlement?.reason === 'victory' && proof.run.members.some(member => member.discipleId === command.discipleId && member.alive)
            && command.commandId === `${proof.run.runId}/award/${command.discipleId}`
            && command.milestoneId === `milestone.first-expedition.${command.discipleId.replace(':', '-')}`)) throw new Error('First-victory award lacks a defined World settlement proof');
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
    inspectEstateSettlementRecords(world);
    if (!resolveContentIdentity(world.contentIdentity, { allowCandidate: true }) || same(world.contentIdentity, contentIdentity(LEGACY_V7_CONTENT))) throw new Error('World has no current growth content');
    return { errors: [], paymentInstanceIds: transactions.paymentInstanceIds, actionRootIds: transactions.actionRootIds };
  } catch (error) { return { errors: [error instanceof Error ? error.message : 'Invalid campaign provenance'], paymentInstanceIds: [], actionRootIds: [] }; }
}
