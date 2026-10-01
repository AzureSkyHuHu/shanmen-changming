import { canonicalStringify, cloneJson } from '../../kernel/serialization';
import { createCultivator } from '../cultivation';
import { isCultivationCommand, validIdentity } from '../validation';
import { validId } from '../../expeditions/shared';
import type { Cultivator, CultivationFrame, CultivationAuthorityCommandV3, CultivationEnrollmentProfile, DeceasedCultivator } from './types';

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const same = (left: unknown, right: unknown) => canonicalStringify(left) === canonicalStringify(right);
export function expandDeceasedCultivator(value: DeceasedCultivator): Cultivator {
  const { archivedRevision: _revision, ...retained } = value;
  return { ...retained, lifeState: 'dead', trainingMode: 'duty', activeAttemptId: null, pendingDeathId: null,
    heirId: null, relicIds: [], teaching: null, activityOwner: null };
}
export function enrolledCultivator(discipleId: string, profile: CultivationEnrollmentProfile): Cultivator {
  if (!exact(profile, ['ageMonths', 'realm', 'lifespanMonths', 'cultivation', 'understanding', 'foundation', 'mindset', 'injury', 'aptitude'])
    || profile.realm !== 'mortal' || profile.cultivation !== 0 || profile.injury !== 0) throw new TypeError('Invalid enrollment profile');
  const member = createCultivator(discipleId, profile);
  if (member.lifespanMonths !== profile.lifespanMonths) throw new TypeError('Invalid enrollment lifespan');
  return member;
}
export function isCultivationAuthorityCommandV3(value: unknown): value is CultivationAuthorityCommandV3 {
  try {
    canonicalStringify(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const command = value as CultivationAuthorityCommandV3;
    if (!validId(command.commandId) || !integer(command.expectedRevision) || !validIdentity(command.discipleId)) return false;
    const common = ['commandId', 'expectedRevision', 'kind', 'discipleId'];
    if (command.kind === 'disciple.enroll') {
      if (!exact(command, [...common, 'acquisitionId', 'profile']) || !validId(command.acquisitionId)) return false;
      enrolledCultivator(command.discipleId, command.profile); return true;
    }
    if (command.kind === 'knowledge.grant') return exact(command, [...common, 'acquisitionId', 'claimId', 'knowledgeId'])
      && validId(command.acquisitionId) && validId(command.claimId) && command.acquisitionId === command.claimId && validIdentity(command.knowledgeId);
    return command.kind === 'disciple.archive' && exact(command, [...common, 'deathId']) && validIdentity(command.deathId);
  } catch { return false; }
}
/** Domain provenance only. World must additionally prove campaign payment/enrollment and finalized death. */
export function validateCultivationAuthorityFacts(frame: CultivationFrame): string[] {
  try {
    const state = frame.cultivation;
    if (!exact(state, ['schemaVersion', 'revision', 'calendarMonth', 'disciples', 'attempts', 'pendingDeaths', 'deaths', 'sectRelicIds',
      'receipts', 'events', 'legacyIdentities', 'legacyStateExtras', 'archivedDisciples', 'authorityReceipts'])
      || state.legacyStateExtras === null || typeof state.legacyStateExtras !== 'object' || Array.isArray(state.legacyStateExtras)) return ['Invalid cultivation v3 fields'];
    const all = [...state.disciples, ...state.archivedDisciples.map(expandDeceasedCultivator)];
    const byId = new Map(all.map(member => [member.discipleId, member]));
    const seenLegacy = new Set<string>(); const acquired = new Set<string>(); const commandIds = new Set(state.receipts.map(receipt => receipt.commandId));
    for (const origin of state.legacyIdentities) {
      if (!exact(origin, ['discipleId', 'knowledge']) || !validIdentity(origin.discipleId) || seenLegacy.has(origin.discipleId)
        || !byId.has(origin.discipleId) || !Array.isArray(origin.knowledge)) return ['Invalid legacy cultivation identity'];
      seenLegacy.add(origin.discipleId);
      if (origin.knowledge.some(entry => !byId.get(origin.discipleId)!.knowledge.some(knowledge => same(knowledge, entry)))) return ['Legacy knowledge was removed'];
    }
    let previousRevision = 0;
    const enrolled = new Set<string>(); const archived = new Set<string>();
    for (const receipt of state.authorityReceipts) {
      if (!exact(receipt, ['command', 'fingerprint', 'revision', 'relatedId']) || !isCultivationAuthorityCommandV3(receipt.command)
        || receipt.fingerprint !== canonicalStringify(receipt.command) || !integer(receipt.revision) || receipt.revision <= previousRevision
        || receipt.revision !== receipt.command.expectedRevision + 1 || receipt.revision > state.revision || commandIds.has(receipt.command.commandId)) return ['Invalid cultivation authority receipt'];
      previousRevision = receipt.revision; commandIds.add(receipt.command.commandId);
      const command = receipt.command; const member = byId.get(command.discipleId);
      if (!member) return ['Unknown cultivation authority identity'];
      if (command.kind !== 'disciple.archive') {
        if (acquired.has(command.acquisitionId)) return ['Duplicate cultivation acquisition']; acquired.add(command.acquisitionId);
      }
      if (command.kind === 'disciple.enroll') {
        if (seenLegacy.has(command.discipleId) || enrolled.has(command.discipleId) || receipt.relatedId !== command.discipleId) return ['Cultivation identity was reused'];
        enrolled.add(command.discipleId);
      } else if (command.kind === 'knowledge.grant') {
        if (receipt.relatedId !== command.knowledgeId || !member.knowledge.some(entry => entry.knowledgeId === command.knowledgeId
          && entry.teacherId === null && entry.teachingId === null)) return ['Cultivation grant lacks knowledge'];
      } else {
        const summary = state.archivedDisciples.find(entry => entry.discipleId === command.discipleId);
        if (!summary || summary.deathId !== command.deathId || summary.archivedRevision !== receipt.revision
          || receipt.relatedId !== command.discipleId || archived.has(command.discipleId)) return ['Invalid cultivation retirement receipt'];
        archived.add(command.discipleId);
      }
    }
    if (all.some(member => !seenLegacy.has(member.discipleId) && !enrolled.has(member.discipleId))) return ['Unadmitted cultivation identity'];
    for (const summary of state.archivedDisciples) {
      if (!exact(summary, ['discipleId', 'ageMonths', 'realm', 'lifespanMonths', 'cultivation', 'understanding', 'foundation', 'mindset',
        'injury', 'aptitude', 'knowledge', 'talents', 'deathId', 'archivedRevision']) || !archived.has(summary.discipleId)
        || !state.deaths.some(death => death.discipleId === summary.discipleId && death.deathId === summary.deathId)) return ['Unproven deceased cultivation identity'];
    }
    for (const member of all) for (const knowledge of member.knowledge) {
      if (state.legacyIdentities.some(origin => origin.discipleId === member.discipleId && origin.knowledge.some(entry => same(entry, knowledge)))) continue;
      if (knowledge.teacherId === null) {
        if (!state.authorityReceipts.some(receipt => receipt.command.kind === 'knowledge.grant'
          && receipt.command.discipleId === member.discipleId && receipt.command.knowledgeId === knowledge.knowledgeId)) return ['Knowledge lacks grant provenance'];
      } else {
        const taught = state.events.filter(event => event.kind === 'cultivation.taught' && event.discipleId === member.discipleId && event.relatedId === knowledge.teachingId);
        const started = state.events.filter(event => event.kind === 'cultivation.teachingStarted' && event.discipleId === knowledge.teacherId && event.relatedId === knowledge.teachingId);
        const receipts = state.receipts.filter(receipt => receipt.result.kind === 'teaching.begin' && receipt.result.relatedId === knowledge.teachingId);
        if (taught.length !== 1 || started.length !== 1 || receipts.length !== 1 || taught[0]!.month < started[0]!.month + 2) return ['Knowledge lacks completed teaching'];
        const command: unknown = JSON.parse(receipts[0]!.fingerprint);
        if (!isCultivationCommand(command) || command.kind !== 'teaching.begin' || command.discipleId !== knowledge.teacherId
          || command.studentId !== member.discipleId || command.knowledgeId !== knowledge.knowledgeId
          || !byId.get(knowledge.teacherId)?.knowledge.some(entry => entry.knowledgeId === knowledge.knowledgeId)) return ['Teaching knowledge provenance differs'];
      }
    }
    return [];
  } catch { return ['Malformed cultivation authority facts']; }
}
export function deceasedSummary(member: Cultivator, archivedRevision: number): DeceasedCultivator {
  if (member.lifeState !== 'dead' || member.deathId === null || member.activityOwner || member.activeAttemptId || member.teaching || member.relicIds.length) throw new TypeError('Cultivator is not ready for archive');
  return cloneJson({ discipleId: member.discipleId, ageMonths: member.ageMonths, realm: member.realm, lifespanMonths: member.lifespanMonths,
    cultivation: member.cultivation, understanding: member.understanding, foundation: member.foundation, mindset: member.mindset,
    injury: member.injury, aptitude: member.aptitude, knowledge: member.knowledge, talents: member.talents,
    deathId: member.deathId, archivedRevision });
}
