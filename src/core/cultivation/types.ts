import type { InventoryLedger, Reservation, ResourceLine } from '../economy/types';
import type { SequenceState } from '../kernel/ids';
import type { RandomStream, RandomStreams } from '../kernel/random';
import type { ExpeditionActivityOwner } from '../expeditions/world-types';
import type { SourceOwner } from '../combat/definitions/types';

export const REALMS = ['mortal', 'qi', 'foundation', 'golden-core', 'nascent-soul'] as const;
export type Realm = (typeof REALMS)[number];
export type TrainingMode = 'duty' | 'training' | 'rest';
export type DeathCause = 'lifespan' | 'breakthrough' | 'combat' | 'legacy-unknown';
export type PermanentTalentId = 'cultivation.steady-breath' | 'cultivation.patient-scholar' | 'cultivation.resilient-body';
export interface PermanentTalent extends SourceOwner {
  sourceDefinitionId: PermanentTalentId;
  lifecycleScope: 'character';
  duration: { kind: 'infinite' };
  active: boolean;
}
export interface LearnedKnowledge { knowledgeId: string; teacherId: string | null; teachingId: string | null }
export interface TeachingPlan { teachingId: string; studentId: string; knowledgeId: string; completedMonths: number; requiredMonths: number }
export interface Cultivator {
  discipleId: string;
  ageMonths: number;
  realm: Realm;
  lifespanMonths: number;
  cultivation: number;
  understanding: number;
  foundation: number;
  mindset: number;
  injury: number;
  aptitude: number;
  lifeState: 'alive' | 'pendingDeath' | 'dead';
  trainingMode: TrainingMode;
  activeAttemptId: string | null;
  pendingDeathId: string | null;
  deathId: string | null;
  heirId: string | null;
  relicIds: string[];
  knowledge: LearnedKnowledge[];
  teaching: TeachingPlan | null;
  activityOwner: ExpeditionActivityOwner | null;
  talents: PermanentTalent[];
}
export interface BreakthroughPreparation { method: 'standard' | 'forced'; arraySupport: 0 | 1 | 2 }
export interface RiskFactor { key: 'base' | 'understanding' | 'foundation' | 'mindset' | 'array' | 'injury' | 'tribulation' | 'forced'; contributionBps: number }
export type PreviewBlocker = 'NOT_ALIVE' | 'BUSY' | 'FINAL_REALM' | 'CULTIVATION_REQUIRED' | 'INJURY_TOO_HIGH' | 'MATERIALS_REQUIRED';
export type RiskWarning = 'LIFESPAN_BEFORE_COMPLETION' | 'FAILURE_CAN_KILL' | 'FORCED_ATTEMPT' | 'MONTHLY_SUPPLY_REQUIRED' | 'AVAILABLE_MEALS_BELOW_PLAN';
export interface BreakthroughPreview {
  phase: 'Prepared';
  rulesVersion: 1;
  stateRevision: number;
  basisHash: string;
  discipleId: string;
  targetRealm: Realm | null;
  preparation: BreakthroughPreparation;
  costs: ResourceLine[];
  seclusionMonths: number;
  monthlyMealCost: number;
  remainingLifespanMonths: number;
  successBps: number;
  /** Conditional probability GIVEN failure; never label this as total death probability. */
  failureDeathBps: number;
  overallDeathBps: number;
  factors: RiskFactor[];
  blockers: PreviewBlocker[];
  warnings: RiskWarning[];
}
export interface BreakthroughSample {
  sampleId: string;
  successRoll: number;
  deathRoll: number | null;
  randomBefore: RandomStream;
  randomAfter: RandomStream;
}
export interface BreakthroughAttempt {
  attemptId: string;
  discipleId: string;
  rootActionId: string;
  phase: 'Reserved' | 'InSeclusion' | 'DecisionReady' | 'Resolved' | 'Cancelled';
  preview: BreakthroughPreview;
  reservation: Reservation;
  completedMonths: number;
  blockedMonths: number;
  blockedReason: 'SUPPLY_SHORTAGE' | null;
  sample: BreakthroughSample | null;
  outcome: 'success' | 'injury' | 'death' | 'cancelled' | null;
}
export interface PendingDeath { deathId: string; discipleId: string; cause: DeathCause; month: number }
export interface DeathRecord extends PendingDeath {
  beneficiaryId: string | null;
  transferredRelicIds: string[];
  revokedSourceInstanceIds: string[];
  cancelledAttemptId: string | null;
  /** Integration must stop jobs/repair external relationships for this disciple exactly once. */
  cleanupDiscipleId: string;
}
export const CULTIVATION_EVENT_KINDS = ['cultivation.confirmed', 'cultivation.started', 'cultivation.ready', 'cultivation.resolved', 'cultivation.cancelled',
  'cultivation.expiryPending', 'cultivation.died', 'cultivation.talentGranted', 'cultivation.teachingStarted', 'cultivation.taught'] as const;
export interface CultivationEvent {
  eventId: string;
  kind: (typeof CULTIVATION_EVENT_KINDS)[number];
  month: number;
  rootActionId: string;
  discipleId: string;
  relatedId: string | null;
}
interface CommandBase { commandId: string; expectedRevision: number }
export type CultivationCommand = CommandBase & (
  | { kind: 'breakthrough.confirm'; preview: BreakthroughPreview }
  | { kind: 'breakthrough.begin' | 'breakthrough.cancel'; attemptId: string }
  | { kind: 'breakthrough.resolve'; attemptId: string; acknowledgeRisk: boolean }
  | { kind: 'death.finalize'; discipleId: string; deathId: string; cause: Exclude<DeathCause, 'legacy-unknown'>; acknowledgeDeath: boolean }
  | { kind: 'training.set'; discipleId: string; mode: TrainingMode }
  | { kind: 'legacy.setHeir'; discipleId: string; heirId: string | null }
  | { kind: 'talent.grant'; discipleId: string; talentId: PermanentTalentId }
  | { kind: 'teaching.begin'; discipleId: string; studentId: string; knowledgeId: string }
);
export interface CultivationCommandResult { commandId: string; kind: CultivationCommand['kind']; relatedId: string | null; outcome: 'accepted' | 'success' | 'injury' | 'death' | 'cancelled' }
export interface CultivationReceipt { commandId: string; fingerprint: string; result: CultivationCommandResult }
export interface CultivationState {
  schemaVersion: 2;
  revision: number;
  calendarMonth: number;
  disciples: Cultivator[];
  attempts: BreakthroughAttempt[];
  pendingDeaths: PendingDeath[];
  deaths: DeathRecord[];
  sectRelicIds: string[];
  receipts: CultivationReceipt[];
  events: CultivationEvent[];
}
/** Inventory/RNG/sequences must be committed together with cultivation by the integrating world. */
export interface CultivationFrame { cultivation: CultivationState; inventory: InventoryLedger; randomStreams: RandomStreams; sequences: SequenceState }
export type CultivationError = 'INVALID_STATE' | 'INVALID_COMMAND' | 'REVISION_CONFLICT' | 'COMMAND_CONFLICT' | 'UNKNOWN_DISCIPLE'
  | 'UNKNOWN_ATTEMPT' | 'PREVIEW_STALE' | 'PREPARATION_BLOCKED' | 'INSUFFICIENT_RESOURCES' | 'ATTEMPT_FINISHED'
  | 'INVALID_PHASE' | 'ACKNOWLEDGEMENT_REQUIRED' | 'DISCIPLE_UNAVAILABLE' | 'DEATH_CONFLICT' | 'INVALID_INHERITANCE'
  | 'UNKNOWN_TALENT' | 'INVALID_TEACHING' | 'ACTIVITY_LOCKED' | 'OVERFLOW';
export type CultivationTransition = { ok: true; frame: CultivationFrame; result: CultivationCommandResult; replayed: boolean }
  | { ok: false; frame: CultivationFrame; code: CultivationError };
export interface MonthStepResult { frame: CultivationFrame; processedMonths: number; stopped: 'complete' | 'decision-required' | 'invalid-state' | 'invalid-month-count' | 'overflow' }

export type CultivationAgeSyncResult = { ok: true; frame: CultivationFrame } | { ok: false; frame: CultivationFrame; code: CultivationError };
