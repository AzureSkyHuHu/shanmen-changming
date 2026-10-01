import type { CombatControllerState, TacticalCommand } from '../combat/ai';
import type { ResourceLine } from '../economy/types';
import type { ExpeditionState, EndReason, Immutable } from './types';

export interface ExpeditionActivityOwner { kind: 'expedition'; runId: string; lockId: string; }
export interface WorldTravelCheckpoint {
  checkpointId: string;
  startCalendarTick: number;
  targetCalendarTick: number;
}
export interface EncounterParticipant { battleEntityId: string; discipleId: string; }
export interface EncounterEnemy { battleEntityId: string; nameKey: string; archetypeId: 'ridge-raider' | 'venom-adept' | 'ruin-guardian'; }
export interface EncounterSourceBinding { runTalentInstanceId: string; battleSourceInstanceId: string; }
export interface CharacterSourceBinding {
  worldSourceInstanceId: string;
  discipleId: string;
  battleEntityId: string;
  definitionId: string;
  kind: 'installed' | 'bakedEquipment';
  battleSourceInstanceId: string | null;
}
export interface EncounterDeathMapping { encounterId: string; battleEntityId: string; battleDeathId: string; discipleId: string; worldDeathId: string; }
export interface WorldEncounter {
  encounterId: string;
  definitionId: string;
  configHash: string;
  controller: CombatControllerState;
  participants: EncounterParticipant[];
  enemies: EncounterEnemy[];
  sourceBindings: EncounterSourceBinding[];
  characterSourceBindings: CharacterSourceBinding[];
  admittedSimulationTick: number;
  lastAdvancedSimulationTick: number;
}
export interface WorldExpeditionEffectReceipt {
  effectId: string;
  runId: string;
  kind: string;
  simulationTick: number;
}
export interface WorldRunHistory {
  runId: string;
  settlementId: string;
  reason: EndReason;
  result: 'completed' | 'withdrawn' | 'defeated';
  forcedWithdrawal: boolean;
  endedCalendarTick: number;
  loot: ResourceLine[];
  returnedSupplies: ResourceLine[];
  lostLoot: ResourceLine[];
  survivingDiscipleIds: string[];
  deadDiscipleIds: string[];
  deathMappings: EncounterDeathMapping[];
}
export interface WorldExpeditionState {
  schemaVersion: 1;
  run: ExpeditionState | null;
  travel: WorldTravelCheckpoint | null;
  battle: WorldEncounter | null;
  effectReceipts: WorldExpeditionEffectReceipt[];
  deathMappings: EncounterDeathMapping[];
  history: WorldRunHistory[];
  forcedWithdrawal: boolean;
  blockedReason: WorldExpeditionError | null;
}
export interface ExpeditionDepartureRequest {
  squadIds: string[];
  routeId: 'route.qingfeng-trial';
  /** Defaults to exactly enough prepaid travelling food; player may carry more. */
  supplies?: ResourceLine[];
}
interface PlayerCommandBase { commandId: string; }
/** Only this bounded union is accepted from the player. Outcome/month/death/settlement are trusted hooks. */
export type PlayerExpeditionCommand = PlayerCommandBase & (
  | { kind: 'expedition.depart'; request: ExpeditionDepartureRequest }
  | { kind: 'expedition.continue' }
  | { kind: 'expedition.choose'; offerId: string; offerRevision: number; definitionId: string; holderId: string | null }
  | { kind: 'expedition.reroll'; offerId: string; offerRevision: number }
  | { kind: 'expedition.supplies'; offerId: string; offerRevision: number }
  | { kind: 'expedition.retreat' }
  | { kind: 'expedition.tactic'; order: TacticalCommand }
);
export type WorldExpeditionCommand = PlayerExpeditionCommand;
export type WorldExpeditionError = 'INVALID_COMMAND' | 'INVALID_PHASE' | 'BUSY' | 'MEMBER_UNAVAILABLE' | 'BUILD_UNAVAILABLE'
  | 'INSUFFICIENT_SUPPLIES' | 'INVENTORY_FULL' | 'STALE_OFFER' | 'ILLEGAL_CHOICE' | 'NO_NEW_CANDIDATE'
  | 'REROLLS_EXHAUSTED' | 'CHECKPOINT_MISMATCH' | 'CONTENT_MISMATCH' | 'INVALID_STATE' | 'BLOCKED_BY_DECISION';
export interface WorldExpeditionResult { kind: PlayerExpeditionCommand['kind']; runId: string | null; phase: ExpeditionState['phase'] | null; relatedId: string | null; }
export interface WorldExpeditionPreview {
  routeId: 'route.qingfeng-trial';
  squadIds: string[];
  expectedMonths: number;
  minimumSupplies: ResourceLine[];
  requestedSupplies: ResourceLine[];
  blockers: WorldExpeditionError[];
  warnings: { code: 'LIFESPAN_BEFORE_RETURN' | 'INJURED_MEMBER'; discipleId: string }[];
}
export interface WorldExpeditionProjection {
  runId: string | null;
  phase: ExpeditionState['phase'] | 'none';
  nodeIndex: number;
  nodeCount: number;
  nextEncounterDefinitionId: string | null;
  currentMonth: number;
  travelProgressTicks: number;
  travelTotalTicks: number;
  availableSupplies: ResourceLine[];
  blockedReason: WorldExpeditionError | null;
  forcedWithdrawal: boolean;
  currentOffer: ExpeditionState['offers'][number] | null;
  talentInstances: ExpeditionState['talentInstances'];
  battle: CombatControllerState | null;
  participants: Immutable<EncounterParticipant[]>;
  enemies: Immutable<EncounterEnemy[]>;
  latestHistory: Immutable<WorldRunHistory> | null;
}
