import type { ActionAdjustment, CombatEventKind, CombatTag, Duration, EffectPrimitive, LifecycleScope, ModifierSpec, School, SourceOwner, Stat } from '../definitions/types';
import type { RandomStreams } from '../../kernel/random';
import type { SequenceState } from '../../kernel/ids';

export const BATTLE_SNAPSHOT_VERSION = 2 as const;
export const BATTLE_SIMULATION_VERSION = 'combat-runtime-2' as const;
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type CombatStats = Readonly<Record<Stat, number>>;
export type LifeState = 'Alive' | 'Downed' | 'Recovered' | 'Dead';
export type BattleSourceInput = string | {
  readonly definitionId: string;
  readonly options?: SourceInstallOptions;
};
export interface BattleEntityInput {
  readonly id?: string;
  readonly team: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly stats: Partial<CombatStats> & { readonly attack: number; readonly maxHealth: number };
  readonly health?: number;
  /** Initial fraction of derived maxHealth after initial source installation. Integer 1..10000;
   * exclusive with health. Floors to integer HP, minimum 1. Never reapplied after admission. */
  readonly healthRatioBps?: number;
  readonly spirit?: number;
  readonly maximumSpirit?: number;
  readonly skills?: readonly string[];
  /** Installs in array order after skills. A structured entry matching a listed skill supplies
   * that skill's install options instead of installing it again; at most one options override. */
  readonly sources?: readonly BattleSourceInput[];
  readonly deathRule?: 'downed' | 'immediate';
  readonly basic?: { readonly coefficientBps: number; readonly cooldownTicks: number; readonly castTicks: number; readonly rangeUnits: number; readonly school: School };
}
export interface BattleOptions {
  readonly seed: string;
  /** Owned arena geometry. It may be bound once later by a controller. */
  readonly arena?: BattleArena;
  readonly entities: readonly BattleEntityInput[];
  /** Experimental explicitly executes supported, uncertified authored definitions for tests/previews. */
  readonly contentMode?: 'verified' | 'experimental';
  readonly logCapacity?: number;
}
export interface BattleEntity {
  id: string; kind: 'combatant' | 'summon'; team: string; position: { x: number; y: number }; baseStats: Record<Stat, number>;
  health: number; spirit: number; maximumSpirit: number; reservedSpirit: number; life: LifeState;
  recoveryUntilTick: number; deathRule: 'downed' | 'immediate'; deathId: string | null; downedCount: number;
  skills: string[]; cooldowns: Record<string, number>; currentActionId: string | null; lastCommittedTick: number;
  basic: { coefficientBps: number; cooldownTicks: number; castTicks: number; rangeUnits: number; school: School };
}
export interface InstalledSource extends SourceOwner {
  executionKind: 'installed' | 'committed';
  holderId: string; boundHolderId: string; installedTick: number; expiresAtTick: number | null;
  remainingNodes: number | null; parentSourceInstanceId: string | null; statusInstanceId: string | null;
  previousCast: { actorId: string; school: School } | null; sharedBudgetId: string | null;
}
export interface StatContribution { sourceInstanceId: string; holderId: string; modifier: ModifierSpec; expiresAtTick: number | null; installedTick: number }
export interface ShieldInstance extends SourceOwner {
  shieldInstanceId: string; holderId: string; remaining: number; initialAmount: number; expiresAtTick: number | null;
  stackPolicy: 'independent' | 'refreshSource' | 'strongest'; broken: boolean;
}
export interface StatusInstance {
  statusInstanceId: string; sourceInstanceId: string; definitionId: string; holderId: string; applierId: string;
  stacks: number; stackSources: { applierId: string; sourceInstanceId: string | null; stacks: number }[]; magnitude: number; appliedTick: number; expiresAtTick: number | null; nextPeriodicTick: number | null;
  attackSnapshot: CombatStats; provenance: Provenance;
}
export interface Provenance { rootActionId: string; parentId: string | null; depth: number; family: string | null; direct: boolean; originalTags: readonly CombatTag[]; originalActorId: string; school: School | null }
export interface BattleAction {
  actionId: string; actorId: string; skillId: string; targetId: string; requestTick: number; castEndTick: number;
  state: 'Casting' | 'Committed' | 'Complete' | 'Interrupted' | 'Invalidated'; reservedSpirit: number; paidSpirit: number;
  cooldownTicks: number; rangeUnits: number; targetTeam: 'self' | 'ally' | 'enemy'; attackSnapshot: CombatStats;
  tags: readonly CombatTag[]; school: School; adjustments: readonly ActionAdjustment[]; chargeIds: string[];
  effects: readonly EffectPrimitive[]; reason: string | null;
}
export interface AugmentCharge extends SourceOwner { chargeId: string; recipientIds: string[]; tags: readonly CombatTag[]; uses: number; expiresAtTick: number | null; adjustment: ActionAdjustment }
export interface ForceContribution { sourceInstanceId: string; holderId: string; units: number }
export interface CastRecord { actionId: string; actorId: string; school: School; tick: number; rootActionId: string; parentId: string | null }
export interface TriggerLedger { sourceInstanceId: string; triggerId: string; targetKey: string; activations: number; cooldownUntilTick: number; roots: string[] }
export interface RootBudget { rootActionId: string; derivedEffects: number; exhausted: boolean }
export type RuntimeEventKind = CombatEventKind | 'action.reserved' | 'action.interrupted' | 'action.invalidated' | 'action.complete' | 'status.applied' | 'status.removed' | 'life.recovered' | 'life.died' | 'command.rejected' | 'proc.truncated' | 'source.installed' | 'source.removed' | 'effect.rejected' | 'entity.moved' | 'zone.created' | 'zone.removed' | 'summon.created' | 'summon.removed';
export interface BattleEvent extends Provenance {
  eventId: string; sequence: number; tick: number; kind: RuntimeEventKind; actorId: string; targetId: string | null;
  sourceInstanceId: string | null; sourceDefinitionId: string | null;
  values: Readonly<Partial<Record<'requestedDamage' | 'afterDefense' | 'actualHealthLoss' | 'actualShieldAbsorbed' | 'requestedHealing' | 'effectiveHealing' | 'overhealing' | 'consumedStacks' | 'paidSpirit' | 'idleTicks' | 'distinctCasterCount' | 'distinctSchoolCount' | 'forceUnits', number>>>;
  flags: Readonly<Partial<Record<'enemyCaused' | 'isCritical' | 'isActive' | 'isBasic' | 'targetAlive' | 'differentCaster' | 'differentSchool' | 'ownedStatus', boolean>>>;
  statusId: string | null; consumedApplierIds: readonly string[]; shieldInstanceId: string | null; reason: string | null;
}
export interface BattleStatistics {
  eventCount: number; requestedDamage: number; shieldAbsorbed: number; healthLost: number;
  requestedHealing: number; effectiveHealing: number; overhealing: number; committedActions: number;
  downed: number; recovered: number; deaths: number; rejectedCommands: number; truncatedProcs: number;
  byEntity: Record<string, { damage: number; absorbed: number; healing: number; kills: number }>;
}
export interface QueuedProgram {
  sourceInstanceId: string; holderId: string; boundHolderId: string; statusApplierId: string | null;
  effects: readonly EffectPrimitive[]; event: BattleEvent; provenance: Provenance; attackSnapshot: CombatStats;
  intentId: string | null; adjustments: readonly ActionAdjustment[]; effectLimit: number;
}
export interface BattleData {
  snapshotVersion: typeof BATTLE_SNAPSHOT_VERSION; simulationVersion: typeof BATTLE_SIMULATION_VERSION;
  contentVersion: string; catalogHash: string; contentMode: 'verified' | 'experimental'; tick: number; ended: boolean;
  arena: BattleArena | null; zones: ZoneInstance[]; summons: SummonInstance[];
  sequences: SequenceState; random: RandomStreams; entities: Record<string, BattleEntity>;
  sources: Record<string, InstalledSource>; modifiers: StatContribution[]; shields: ShieldInstance[];
  statuses: StatusInstance[]; actions: Record<string, BattleAction>; augments: AugmentCharge[];
  force: ForceContribution[]; castHistory: Record<string, CastRecord[]>; triggerLedger: TriggerLedger[];
  teamBudgets: Record<string, { budgetId: string; definitionId: string; team: string }>; roots: Record<string, RootBudget>; queue: QueuedProgram[]; focusByTeam: Record<string, string>;
  logCapacity: number; log: BattleEvent[]; statistics: BattleStatistics;
}
export type BattleState = DeepReadonly<BattleData>;
export type BattleCommand =
  | { readonly kind: 'cast'; readonly actorId: string; readonly skillId: string; readonly targetId: string }
  | { readonly kind: 'basic'; readonly actorId: string; readonly targetId: string }
  | { readonly kind: 'guard'; readonly actorId: string; readonly targetId: string }
  | { readonly kind: 'focus'; readonly actorId: string; readonly targetId: string }
  | { readonly kind: 'clearFocus'; readonly actorId: string }
  | { readonly kind: 'cancel'; readonly actorId: string }
  | { readonly kind: 'interrupt'; readonly actorId: string; readonly targetId: string; readonly strength: number }
  | { readonly kind: 'finishDowned'; readonly actorId: string; readonly targetId: string };
export interface SourceInstallOptions { readonly boundHolderId?: string; readonly duration?: Duration; readonly lifecycleScope?: LifecycleScope }

/** Grid locomotion is a simulation input, separate from the content `move` primitive. */
export interface BattleArena {
  readonly origin: { readonly x: number; readonly y: number };
  readonly widthCells: number;
  readonly heightCells: number;
  readonly cellSizeUnits: number;
  readonly blockedCells: readonly { readonly x: number; readonly y: number }[];
}
export interface BattleMovementIntent { readonly actorId: string; readonly to: { readonly x: number; readonly y: number } }
export interface BattleStepOptions { readonly movement?: { readonly arena: BattleArena; readonly intents: readonly BattleMovementIntent[] } }

/** A fixed spatial field. The creation intent is historical; it never follows that entity. */
export interface ZoneInstance {
  zoneInstanceId: string; sourceInstanceId: string; casterId: string; anchor: { x: number; y: number };
  radiusUnits: number; createdTick: number; expiresAtTick: number | null; nextPeriodicTick: number;
  effect: Extract<EffectPrimitive, { kind: 'zone' }>; adjustments: readonly ActionAdjustment[];
  attackSnapshot: CombatStats; provenance: Provenance; intentId: string;
}
/** Battle-only, disposable identity. It must never be mapped to a campaign disciple. */
export interface SummonInstance {
  entityId: string; sourceInstanceId: string; casterId: string; definitionId: string;
  createdTick: number; expiresAtTick: number; casterMaxHealth: number; role: 'threatDecoy';
}
