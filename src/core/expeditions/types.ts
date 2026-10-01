import type { CombatContentCatalog, CombatTag, School } from '../combat/definitions/types';
import type { BattleEntityInput } from '../combat/runtime/types';
import type { ResourceLine } from '../economy/types';
import type { RandomStream, RandomStreams } from '../kernel/random';

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type ExpeditionPhase = 'Preparing' | 'Travelling' | 'AtNode' | 'InEncounter' | 'RewardPending' | 'Ending' | 'Ended';
export type EndReason = 'victory' | 'safeRetreat' | 'emergencyRetreat' | 'defeat';
export interface ExpeditionLoadout {
  basic: NonNullable<BattleEntityInput['basic']>;
  activeSkillIds: [string, string];
  passiveSkillId: string;
  characterSourceIds: string[];
  equipment: { weaponId: string; robeId: string; artifactId: string };
  stats: BattleEntityInput['stats'];
  maximumSpirit: number;
}
export interface ExpeditionMemberInput {
  discipleId: string;
  available: boolean;
  alive: boolean;
  loadout: ExpeditionLoadout;
  health: number;
  spirit: number;
  injury: number;
  durability: number;
}
export interface ExpeditionMember extends ExpeditionMemberInput { lockId: string; permanentDeathId: string | null; }
/** Encounter IDs refer to adapter-owned definitions; no enemy statistics or AI are invented here. */
export interface RouteSpecification {
  regionId: string;
  regularEncounterIds: string[];
  bossEncounterId: string;
  encounterCount: number;
  minimumTravelMonths: number;
  maximumTravelMonths: number;
  returnMonths: number;
}
export interface RouteNode {
  nodeId: string;
  nodeVisitId: string;
  ordinal: number;
  encounterDefinitionId: string;
  kind: 'encounter' | 'boss';
  travelMonths: number;
  reward: boolean;
}
export interface CreateExpeditionOptions {
  runId: string;
  seed: string;
  calendarMonth: number;
  members: ExpeditionMemberInput[];
  supplies: ResourceLine[];
  route: RouteSpecification;
  preferredTags?: CombatTag[];
  /** Must be explicit while authored combat definitions remain experimental. */
  contentMode: 'verified' | 'experimental';
  /** Provisional first-pass travel food rule; defaults to one meal per living member per month. */
  monthlyMealPerMember?: number;
}
export interface TimeCheckpoint {
  checkpointId: string;
  timeSettlementId: string;
  runId: string;
  kind: 'travel' | 'return';
  nodeVisitId: string | null;
  monthOrdinal: number;
  expectedCalendarMonth: number;
  resultingCalendarMonth: number;
  absentDiscipleIds: string[];
  supplyCost: ResourceLine[];
}
export interface TravelLedgerEntry extends TimeCheckpoint { committedBy: string; }
export interface AbandonedCheckpoint { checkpoint: TimeCheckpoint; reason: 'allMembersDead' | 'runEnded'; abandonedAtCalendarMonth: number; }
export interface RunTalent {
  instanceId: string;
  definitionId: string;
  holderScope: 'personal' | 'team';
  holderId: string | null;
  boundHolderId: string | null;
  rank: number;
  acquiredRewardOrdinal: number;
}
export interface GuaranteeCounters {
  coreShown: boolean;
  supportDue: { buildId: string; dueOrdinal: number; fulfilled: boolean }[];
}
export type OfferDiagnostic = 'INCOMPLETE_CATALOG' | 'INSUFFICIENT_LEGAL_CARDS' | 'NO_GENERAL_CARD'
  | 'CORE_GUARANTEE_UNAVAILABLE' | 'SUPPORT_GUARANTEE_UNAVAILABLE' | 'REROLL_HAS_NO_NEW_CARD';
export interface OfferState {
  offerId: string;
  runId: string;
  rewardOrdinal: number;
  revision: number;
  candidateDefinitionIds: string[];
  eligibleHolderIdsByCard: Record<string, string[]>;
  shownHistory: string[];
  remainingRerolls: number;
  rngBefore: RandomStream;
  rngAfter: RandomStream;
  guaranteeCounters: GuaranteeCounters;
  diagnostics: OfferDiagnostic[];
  supplyFallback: ResourceLine[];
  chosenCard: string | null;
  chosenHolder: string | null;
  commitId: string | null;
  resolution: 'pending' | 'talent' | 'supplies' | 'forfeited';
}
export interface EncounterBoundary {
  encounterId: string;
  nodeId: string;
  encounterDefinitionId: string;
  seed: string;
  /** In-session engine IDs are mapped to disciple IDs by the adapter. */
  memberIds: string[];
  squad: ExpeditionMember[];
  talentSources: RunTalent[];
  calendarMonth: number;
}
export interface EncounterMemberResult {
  discipleId: string;
  alive: boolean;
  /** A Downed combat entity is not a permanent death; adapter must resolve that distinction explicitly. */
  permanentDeathId: string | null;
  health: number;
  spirit: number;
  injury: number;
  durability: number;
}
/** Authoritative adapter contract: this module validates identity/ranges/consistency, not combat truth. */
export interface ValidatedEncounterOutcome {
  encounterId: string;
  resultId: string;
  validation: { kind: 'validatedCombatOutcome'; battleId: string; battleSnapshotHash: string };
  outcome: 'victory' | 'emergencyRetreat' | 'defeat';
  retreatConfirmed: boolean;
  members: EncounterMemberResult[];
  consumedSupplies: ResourceLine[];
  securedLoot: ResourceLine[];
  unsecuredLoot: ResourceLine[];
  unlockIds: string[];
}
export interface EndRunSettlement {
  settlementId: string;
  reason: EndReason;
  createdMonth: number;
  returnMonths: number;
  retainedUnsecuredBps: number;
  loot: ResourceLine[];
  lostLoot: ResourceLine[];
  unusedSupplies: ResourceLine[];
  unlockIds: string[];
  returnProgress: number;
  committed: boolean;
  commitId: string | null;
}
interface EffectBase { effectId: string; runId: string; }
export type ExpeditionAdapterEffect = EffectBase & (
  | { kind: 'departure'; lockIds: string[]; absentDiscipleIds: string[]; debitSupplies: ResourceLine[] }
  | { kind: 'monthCheckpoint'; checkpoint: TimeCheckpoint }
  | { kind: 'monthAdmitted'; checkpoint: TimeCheckpoint }
  | { kind: 'encounterBegin'; boundary: EncounterBoundary }
  | { kind: 'encounterResult'; resultId: string; members: EncounterMemberResult[]; clearEncounterId: string; revokedTalentInstanceIds: string[] }
  | { kind: 'talentCommit'; offerId: string; talent: RunTalent }
  | { kind: 'membersDied'; discipleIds: string[]; deathRecordIds: string[]; revokedTalentInstanceIds: string[] }
  | { kind: 'runSettled'; settlement: EndRunSettlement; releaseLockIds: string[]; survivingDiscipleIds: string[];
      deadDiscipleIds: string[]; removeRunTalentInstanceIds: string[]; clearEncounterIds: string[] }
);
interface CommandBase { commandId: string; expectedRevision: number; }
export type ExpeditionCommand = CommandBase & (
  | { kind: 'depart' }
  | { kind: 'time.admit'; checkpointId: string; expectedCalendarMonth: number }
  | { kind: 'time.commit'; checkpointId: string; expectedCalendarMonth: number; resultingCalendarMonth: number }
  | { kind: 'encounter.begin' }
  | { kind: 'encounter.resolve'; result: ValidatedEncounterOutcome }
  | { kind: 'offer.reroll'; offerId: string; offerRevision: number }
  | { kind: 'offer.choose'; offerId: string; offerRevision: number; definitionId: string; holderId: string | null }
  | { kind: 'offer.supplies'; offerId: string; offerRevision: number }
  | { kind: 'members.died'; discipleIds: string[]; deathRecordIds: string[] }
  | { kind: 'talent.rebind'; instanceId: string; holderId: string }
  | { kind: 'run.end'; reason: EndReason }
  | { kind: 'run.settle'; settlementId: string }
);
export interface ExpeditionReceipt {
  commandId: string;
  commandHash: string;
  kind: ExpeditionCommand['kind'];
  revision: number;
  effectIds: string[];
  resultId: string | null;
}
export interface ExpeditionData {
  schemaVersion: 2;
  simulationVersion: 'expedition-2';
  contentHash: string;
  origin: CreateExpeditionOptions;
  runId: string;
  phase: ExpeditionPhase;
  revision: number;
  calendarMonth: number;
  members: ExpeditionMember[];
  route: RouteNode[];
  nodeIndex: number;
  nodeTimeProgress: number;
  travelLedger: TravelLedgerEntry[];
  admittedCheckpoint: TimeCheckpoint | null;
  abandonedCheckpoints: AbandonedCheckpoint[];
  supplies: ResourceLine[];
  locked: boolean;
  currentEncounter: EncounterBoundary | null;
  encounterResults: ValidatedEncounterOutcome[];
  offers: OfferState[];
  currentOfferId: string | null;
  talentInstances: RunTalent[];
  securedLoot: ResourceLine[];
  unsecuredLoot: ResourceLine[];
  unlockIds: string[];
  randomStreams: RandomStreams;
  nextInstance: number;
  remainingRerolls: number;
  rewardCounters: { generated: number; committed: number; forfeited: number };
  guarantees: GuaranteeCounters;
  settlement: EndRunSettlement | null;
  receipts: ExpeditionReceipt[];
  commandLog: ExpeditionCommand[];
}
export type ExpeditionState = Immutable<ExpeditionData>;
export type ExpeditionError = 'INVALID_INPUT' | 'INVALID_COMMAND' | 'CONTENT_MISMATCH' | 'UNSUPPORTED_LOADOUT' | 'COMMAND_CONFLICT'
  | 'REVISION_CONFLICT' | 'INVALID_PHASE' | 'CHECKPOINT_MISMATCH' | 'INVALID_OUTCOME' | 'INSUFFICIENT_SUPPLIES'
  | 'STALE_OFFER' | 'ILLEGAL_CHOICE' | 'REROLLS_EXHAUSTED' | 'NO_NEW_CANDIDATE' | 'INVALID_END_REASON'
  | 'RETURN_INCOMPLETE' | 'COMMAND_LIMIT' | 'OVERFLOW';
export type ExpeditionTransition =
  | { ok: true; state: ExpeditionState; receipt: Immutable<ExpeditionReceipt>; effects: Immutable<ExpeditionAdapterEffect[]>; replayed: boolean }
  | { ok: false; state: ExpeditionState; code: ExpeditionError };
export interface Candidate { definitionId: string; holderIds: string[]; tags: CombatTag[]; category: 'general' | 'school' | 'crossSchool' | 'route'; role: 'core' | 'support' | 'bridge'; buildId: string; }
export type ExpeditionCatalog = CombatContentCatalog;
export type { CombatTag, School };
