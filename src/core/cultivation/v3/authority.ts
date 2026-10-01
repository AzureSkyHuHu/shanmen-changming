import { checkedAdd } from '../../kernel/numeric';
import { canonicalStringify, cloneJson } from '../../kernel/serialization';
import { MAX_CULTIVATION_HISTORY, MAX_CULTIVATORS } from '../rules';
import { validateCultivationFrame } from '../validation';
import type { CultivationFrame as LegacyCultivationFrame } from '../types';
import { validateCultivationFrameV3 } from './validation';
import { deceasedSummary, enrolledCultivator, isCultivationAuthorityCommandV3 } from './provenance';
import type { CultivationAuthorityCommandV3, CultivationAuthorityErrorV3, CultivationAuthorityTransitionV3, CultivationFrame } from './types';

/** Schema conversion only; source bytes and all resources/RNG/sequences are preserved. */
export function upgradeCultivationFrameV2(value: unknown): CultivationFrame {
  const errors = validateCultivationFrame(value); if (errors.length) throw new TypeError(errors.join('; '));
  const source = cloneJson(value) as LegacyCultivationFrame;
  const { schemaVersion: _version, revision, calendarMonth, disciples, attempts, pendingDeaths, deaths, sectRelicIds, receipts, events, ...legacyStateExtras } = source.cultivation;
  return { ...source, cultivation: { revision, calendarMonth, disciples, attempts, pendingDeaths, deaths, sectRelicIds, receipts, events, schemaVersion: 3,
    legacyIdentities: source.cultivation.disciples.map(member => ({ discipleId: member.discipleId, knowledge: cloneJson(member.knowledge) })),
    legacyStateExtras, archivedDisciples: [], authorityReceipts: [] } };
}
/** Only World adapters call this after deriving an authoritative campaign/death fact. */
export function applyCultivationAuthorityCommandV3(frame: CultivationFrame, command: CultivationAuthorityCommandV3): CultivationAuthorityTransitionV3 {
  const fail = (code: CultivationAuthorityErrorV3): CultivationAuthorityTransitionV3 => ({ ok: false, frame, code });
  if (validateCultivationFrameV3(frame).length) return fail('INVALID_STATE');
  try {
    if (!isCultivationAuthorityCommandV3(command)) return fail('INVALID_COMMAND');
    const fingerprint = canonicalStringify(command);
    const prior = frame.cultivation.authorityReceipts.find(receipt => receipt.command.commandId === command.commandId);
    if (prior) return prior.fingerprint === fingerprint ? { ok: true, frame, receipt: cloneJson(prior), replayed: true } : fail('COMMAND_CONFLICT');
    if (frame.cultivation.receipts.some(receipt => receipt.commandId === command.commandId)) return fail('COMMAND_CONFLICT');
    if (command.expectedRevision !== frame.cultivation.revision) return fail('REVISION_CONFLICT');
    if (frame.cultivation.authorityReceipts.length >= MAX_CULTIVATION_HISTORY) return fail('HISTORY_LIMIT');
    const next = cloneJson(frame); let relatedId = command.discipleId;
    if (command.kind !== 'disciple.archive' && next.cultivation.authorityReceipts.some(receipt => receipt.command.kind !== 'disciple.archive'
      && receipt.command.acquisitionId === command.acquisitionId)) return fail('ACQUISITION_CONFLICT');
    if (command.kind === 'disciple.enroll') {
      if ([...next.cultivation.disciples, ...next.cultivation.archivedDisciples].some(member => member.discipleId === command.discipleId)) return fail('IDENTITY_REUSED');
      if (next.cultivation.disciples.length >= MAX_CULTIVATORS) return fail('HISTORY_LIMIT');
      next.cultivation.disciples.push(enrolledCultivator(command.discipleId, command.profile));
    } else {
      const member = next.cultivation.disciples.find(entry => entry.discipleId === command.discipleId);
      if (!member) return fail('UNKNOWN_DISCIPLE');
      if (member.activityOwner) return fail('ACTIVITY_LOCKED');
      if (command.kind === 'knowledge.grant') {
        if (member.lifeState !== 'alive' || member.activeAttemptId || member.teaching
          || next.cultivation.disciples.some(teacher => teacher.teaching?.studentId === member.discipleId)) return fail('DISCIPLE_UNAVAILABLE');
        if (member.knowledge.some(entry => entry.knowledgeId === command.knowledgeId)) return fail('ALREADY_LEARNED');
        member.knowledge.push({ knowledgeId: command.knowledgeId, teacherId: null, teachingId: null }); relatedId = command.knowledgeId;
      } else {
        if (member.lifeState !== 'dead' || member.deathId !== command.deathId
          || !next.cultivation.deaths.some(death => death.discipleId === member.discipleId && death.deathId === command.deathId)
          || next.cultivation.disciples.some(other => other.teaching?.studentId === member.discipleId || other.heirId === member.discipleId)) return fail('DEATH_CONFLICT');
        next.cultivation.archivedDisciples.push(deceasedSummary(member, checkedAdd(next.cultivation.revision, 1)));
        next.cultivation.disciples = next.cultivation.disciples.filter(entry => entry.discipleId !== member.discipleId);
      }
    }
    next.cultivation.revision = checkedAdd(next.cultivation.revision, 1);
    const receipt = { command: cloneJson(command), fingerprint, revision: next.cultivation.revision, relatedId };
    next.cultivation.authorityReceipts.push(receipt);
    if (validateCultivationFrameV3(next).length) return fail('INVALID_STATE');
    return { ok: true, frame: next, receipt: cloneJson(receipt), replayed: false };
  } catch (error) { return fail(error instanceof RangeError ? 'OVERFLOW' : 'INVALID_COMMAND'); }
}
