import { LEGACY_V7_CONTENT } from '../../content/registry';
import { campaignProgressV2 } from '../campaign/v2';
import type { CampaignClaimReceiptV2 } from '../campaign/v2-types';
import type { School } from '../combat/definitions/types';
import { isCultivationCommand } from '../cultivation/validation';
import { REALM_RULES } from '../cultivation/rules';
import { REALMS } from '../cultivation/types';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import type { CampaignPlayerRequest } from './campaign-types';
import { getWorldContent } from './content-access';
import type { WorldStateV8 } from './v8-types';

interface AtCommit { discipleId: string; school: School; skills: Set<string>; locked: boolean; life: 'alive' | 'pendingDeath' | 'dead'; busy: boolean }
const eventNumber = (id: string): number => Number(id.slice(6));
/** Reconstruct prerequisites from immutable authority history, not an opaque
 * context hash or present-day life/ownership. Equal simulation ticks are ordered
 * by global action/event allocation; later retirement cannot erase eligibility. */
export function assertCampaignHistoricalAdmission(world: WorldStateV8, request: CampaignPlayerRequest,
  claim: CampaignClaimReceiptV2 | undefined, rootActionId: string, committedEventId: string, calendarTick: number): void {
  const action = Number(rootActionId.slice(7)); const event = eventNumber(committedEventId);
  const content = getWorldContent(world);
  const starter = world.builds.migration ? LEGACY_V7_CONTENT.buildRules.starterSkills : content.buildRules.starterSkills;
  const roster = new Map<string, AtCommit>(); const known = new Set<string>(); const realmRanks = new Map<string, number>();
  for (const original of world.builds.origin.disciples) {
    known.add(original.discipleId); realmRanks.set(original.discipleId, 0);
    roster.set(original.discipleId, { discipleId: original.discipleId, school: original.school,
      skills: new Set(starter[original.school]), locked: false, life: 'alive', busy: false });
  }
  for (const entry of world.builds.history) {
    // The campaign builder allocates its root before domain grants. Its own
    // commands have nextAction=root+1, so they cannot enlarge its admitted roster.
    if (entry.sequencesBefore.nextAction > action) continue;
    const command = entry.command;
    if (entry.authority && command.kind === 'disciple.enroll') {
      known.add(command.discipleId); realmRanks.set(command.discipleId, 0);
      roster.set(command.discipleId, { discipleId: command.discipleId, school: command.school,
        skills: new Set(content.buildRules.starterSkills[command.school]), locked: false, life: 'alive', busy: false });
    } else if (entry.authority && command.kind === 'disciple.retire') roster.delete(command.discipleId);
    else if (entry.authority && (command.kind === 'expedition.lock' || command.kind === 'expedition.unlock')) {
      for (const lock of command.locks) { const member = roster.get(lock.discipleId); if (member) member.locked = command.kind === 'expedition.lock'; }
    } else if (command.kind === 'skill.learn' || entry.authority && command.kind === 'skill.grantKnowledge') roster.get(command.discipleId)?.skills.add(command.skillId);
    else if (entry.authority && command.kind === 'milestone.award' && command.ruleId.startsWith('realm.')) {
      const rank = REALMS.findIndex(realm => `realm.${realm}` === command.ruleId);
      realmRanks.set(command.discipleId, Math.max(realmRanks.get(command.discipleId) ?? 0, rank));
    }
  }
  const allProfiles = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples];
  const identities = new Map<string, { birthCalendarTick: number }>([...world.disciples.map(actor => [actor.id, actor] as const), ...world.legacy.archivedIdentities.map(actor => [actor.discipleId, actor] as const)]);
  const before = (id: string): boolean => eventNumber(id) < event;
  const deadBefore = new Set<string>();
  for (const id of known) {
    const death = world.cultivation.deaths.find(record => record.discipleId === id);
    const died = world.cultivation.events.filter(record => record.kind === 'cultivation.died' && record.discipleId === id && record.relatedId === death?.deathId);
    if (died.length > 1) throw new Error('Ambiguous historical death source');
    // The World validator binds this explicit exception to the retained v7 prefix.
    if (death && !died.length) {
      const old = world.legacy.migrationLifecycle?.finalizedDeaths.find(record => record.deathId === death.deathId && record.discipleId === id);
      if (!old || !world.builds.migration || event < world.builds.migration.sequencesAtMigration.nextEvent) throw new Error('Campaign eligibility lacks legacy lifecycle evidence');
      deadBefore.add(id);
    }
    if (died[0] && before(died[0].eventId)) deadBefore.add(id);
    const member = roster.get(id); if (!member) continue;
    const profile = allProfiles.find(value => value.discipleId === id); const identity = identities.get(id);
    if (!profile || !identity) throw new Error('Campaign historical identity is missing');
    if (deadBefore.has(id)) member.life = 'dead';
    else {
      const expiry = world.cultivation.events.find(record => record.kind === 'cultivation.expiryPending' && record.discipleId === id && before(record.eventId));
      const realm = REALMS[realmRanks.get(id) ?? 0]!;
      const age = Math.floor((calendarTick - identity.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
      if (age < 0) throw new Error('Campaign transaction predates a recipient birth');
      if (expiry || age >= REALM_RULES[realm].lifespanMonths) member.life = 'pendingDeath';
    }
  }
  let decisionReady = false;
  for (const attempt of world.cultivation.attempts) {
    const terminal = world.cultivation.events.find(record => ['cultivation.resolved', 'cultivation.cancelled'].includes(record.kind)
      && record.relatedId === attempt.attemptId && before(record.eventId));
    if (terminal) continue;
    const confirmed = world.cultivation.events.find(record => record.kind === 'cultivation.confirmed' && record.relatedId === attempt.attemptId);
    if (!confirmed) throw new Error('Campaign eligibility lacks attempt admission history');
    if (!before(confirmed.eventId)) continue;
    const member = roster.get(attempt.discipleId); if (member) member.busy = true;
    if (world.cultivation.events.some(record => record.kind === 'cultivation.ready' && record.relatedId === attempt.attemptId && before(record.eventId))) decisionReady = true;
  }
  for (const started of world.cultivation.events.filter(record => record.kind === 'cultivation.teachingStarted' && before(record.eventId))) {
    if (world.cultivation.events.some(record => record.kind === 'cultivation.taught' && record.relatedId === started.relatedId && before(record.eventId))) continue;
    const receipt = world.cultivation.receipts.find(record => record.result.kind === 'teaching.begin' && record.result.relatedId === started.relatedId);
    if (!receipt) throw new Error('Campaign eligibility lacks teaching admission history');
    const command: unknown = JSON.parse(receipt.fingerprint);
    if (!isCultivationCommand(command) || command.kind !== 'teaching.begin' || command.discipleId !== started.discipleId || !known.has(command.studentId)) throw new Error('Campaign teaching history differs');
    if ([command.discipleId, command.studentId].some(id => !roster.has(id) || roster.get(id)!.life !== 'alive')) continue;
    roster.get(command.discipleId)!.busy = true; roster.get(command.studentId)!.busy = true;
  }
  const members = [...roster.values()];
  if (decisionReady || members.some(member => member.life === 'pendingDeath')) throw new Error('Campaign transaction bypassed an unresolved historical decision');
  const activeRun = members.some(member => member.locked);
  if (request.kind === 'estate.assign' || request.kind === 'campaign.equipment.claim' || request.kind === 'campaign.lesson.learn') {
    const member = roster.get(request.discipleId);
    if (!member || member.life !== 'alive' || request.kind !== 'estate.assign' && (member.locked || member.busy)) throw new Error('Campaign recipient was unavailable at commit');
    if (request.kind === 'campaign.lesson.learn') {
      const lesson = content.campaign!.knowledge.find(definition => definition.id === request.knowledgeId);
      if (!lesson || member.school !== lesson.school || member.skills.has(lesson.skillId) || lesson.requiredSkillIds.some(id => !member.skills.has(id))) throw new Error('Campaign lesson prerequisites were not met at commit');
    }
  }
  const incoming = claim?.plan.grants.filter(grant => grant.kind === 'recruit').length ?? 0;
  if (members.length + incoming > content.buildRules.maximumDisciples) throw new Error('Campaign enrollment exceeded its historical roster');
  if (request.kind === 'campaign.relief') {
    const survivors = members.filter(member => member.life === 'alive');
    if (!claim?.plan.relief || activeRun || world.campaign.progress.mode !== 'standard' || survivors.length !== 1
      || survivors[0]!.discipleId !== claim.plan.relief.survivorId) throw new Error('Relief lacked its actual single-survivor basis');
    const prior = { ...world.campaign.progress, revision: claim.plan.expectedRevision,
      clears: world.campaign.progress.clears.filter(clear => clear.revision <= claim!.plan.expectedRevision),
      claims: world.campaign.progress.claims.filter(receipt => receipt.plan.expectedRevision < claim!.plan.expectedRevision) };
    if (campaignProgressV2(prior).unclaimedRecruitRouteIds.length) throw new Error('Relief had an unspent historical invitation');
  }
  if (request.kind === 'campaign.recover') {
    if (!claim?.plan.recovery || activeRun || world.campaign.progress.mode !== 'standard' || !known.size
      || members.some(member => member.life !== 'dead') || [...known].some(id => !deadBefore.has(id))) throw new Error('Recovery lacked an actual finalized total loss');
    const latest = world.cultivation.events.filter(record => record.kind === 'cultivation.died' && known.has(record.discipleId) && before(record.eventId)).at(-1)?.relatedId
      ?? world.cultivation.deaths.filter(death => known.has(death.discipleId) && deadBefore.has(death.discipleId)).at(-1)?.deathId;
    if (latest !== claim.plan.recovery.terminalLossId) throw new Error('Recovery did not reference the latest finalized loss');
  }
}
