import type { CultivationState as LegacyState, CultivationFrame as LegacyFrame, CultivationError,
  CultivationCommandResult, Cultivator, LearnedKnowledge } from '../types';
export * from '../types';
export interface DeceasedCultivator extends Pick<Cultivator, 'discipleId' | 'ageMonths' | 'realm' | 'lifespanMonths'
  | 'cultivation' | 'understanding' | 'foundation' | 'mindset' | 'injury' | 'aptitude' | 'knowledge' | 'talents'> {
  deathId: string; archivedRevision: number;
}
export type CultivationEnrollmentProfile = Pick<Cultivator, 'ageMonths' | 'realm' | 'lifespanMonths' | 'cultivation'
  | 'understanding' | 'foundation' | 'mindset' | 'injury' | 'aptitude'>;
interface AuthorityBase { commandId: string; expectedRevision: number }
export type CultivationAuthorityCommandV3 = AuthorityBase & (
  | { kind: 'disciple.enroll'; acquisitionId: string; discipleId: string; profile: CultivationEnrollmentProfile }
  | { kind: 'knowledge.grant'; acquisitionId: string; claimId: string; discipleId: string; knowledgeId: string }
  | { kind: 'disciple.archive'; discipleId: string; deathId: string }
);
export interface CultivationAuthorityReceiptV3 {
  command: CultivationAuthorityCommandV3; fingerprint: string; revision: number; relatedId: string;
}
export interface CultivationState extends Omit<LegacyState, 'schemaVersion'> {
  schemaVersion: 3;
  /** Frozen admitted legacy identities/knowledge; new identities require enrollment receipts. */
  legacyIdentities: { discipleId: string; knowledge: LearnedKnowledge[] }[];
  legacyStateExtras: Record<string, unknown>;
  archivedDisciples: DeceasedCultivator[];
  authorityReceipts: CultivationAuthorityReceiptV3[];
}
export interface CultivationFrame extends Omit<LegacyFrame, 'cultivation'> { cultivation: CultivationState }
export type CultivationTransition = { ok: true; frame: CultivationFrame; result: CultivationCommandResult; replayed: boolean }
  | { ok: false; frame: CultivationFrame; code: CultivationError };
export interface MonthStepResult { frame: CultivationFrame; processedMonths: number; stopped: 'complete' | 'decision-required' | 'invalid-state' | 'invalid-month-count' | 'overflow' }
export type CultivationAgeSyncResult = { ok: true; frame: CultivationFrame } | { ok: false; frame: CultivationFrame; code: CultivationError };
export type CultivationAuthorityErrorV3 = CultivationError | 'IDENTITY_REUSED' | 'ACQUISITION_CONFLICT' | 'ALREADY_LEARNED' | 'HISTORY_LIMIT';
export type CultivationAuthorityTransitionV3 = { ok: true; frame: CultivationFrame; receipt: CultivationAuthorityReceiptV3; replayed: boolean }
  | { ok: false; frame: CultivationFrame; code: CultivationAuthorityErrorV3 };
