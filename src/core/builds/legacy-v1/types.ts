// Frozen v7 build-v1 protocol from commit 98e7026. Change only with an explicit legacy compatibility fix.
import type { CombatContentCatalog, CombatTag, School, SourceOwner, Stat } from '../../combat/definitions/types';
import type { BattleEntityInput } from '../../combat/runtime/types';
import type { SequenceState } from '../../kernel/ids';

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type EquipmentSlot = 'weapon' | 'robe' | 'artifact';
export type MilestoneRuleId = 'realm.qi' | 'realm.foundation' | 'realm.golden-core' | 'realm.nascent-soul' | 'expedition.first-victory';
export interface EquipmentDefinition {
  readonly id: string;
  readonly slot: EquipmentSlot;
  readonly school: School | null;
  readonly tags: readonly CombatTag[];
  readonly flatStats: Readonly<Partial<Record<Stat, number>>>;
  readonly maximumSpiritBonus: number;
}
export interface SkillLearningRule {
  readonly skillId: string;
  readonly creditCost: number;
  readonly requiredSkillIds: readonly string[];
  /** These remain equip requirements after learning; knowledge itself survives a respec. */
  readonly requiredNodeIds: readonly string[];
}
export interface BuildLoadout {
  basicId: string;
  activeSkillIds: [string, string];
  passiveSkillId: string;
  equipment: { weaponId: string; robeId: string; artifactId: string };
}
export interface LearnedSkill { skillId: string; origin: 'starter' | 'study'; creditCost: number; acquisitionId: string; }
export interface BuildSource extends SourceOwner {
  lifecycleScope: 'character';
  duration: { kind: 'infinite' };
  kind: 'treeNode' | 'skill' | 'equipment';
  itemInstanceId: string | null;
}
export interface BuildDisciple {
  discipleId: string;
  school: School;
  treeId: string;
  allocatedNodeIds: string[];
  learnedSkills: LearnedSkill[];
  loadout: BuildLoadout;
  sources: BuildSource[];
  lock: { runId: string; lockId: string; loadoutHash: string } | null;
}
export interface EquipmentInstance { instanceId: string; definitionId: string; ownerDiscipleId: string; acquisitionId: string; }
export interface MilestoneAward { milestoneId: string; discipleId: string; ruleId: MilestoneRuleId; treePoints: 1; learningCredits: 2; }
export interface CreateBuildOptions {
  disciples: { discipleId: string; school: School }[];
  /** Explicitly required: current authored catalog is not certified in verified mode. */
  contentMode: 'verified' | 'experimental';
  sequences?: SequenceState;
}
interface CommandBase { commandId: string; expectedRevision: number; }
export type BuildCommand = CommandBase & (
  | { kind: 'tree.respec'; discipleId: string; nodeIds: readonly string[] }
  | { kind: 'skill.learn'; discipleId: string; skillId: string }
  | { kind: 'loadout.set'; discipleId: string; loadout: Immutable<BuildLoadout> }
);
/** Never expose this union through the player command dispatcher. IDs refer to adapter-validated facts. */
export type BuildAuthorityCommand = CommandBase & (
  | { kind: 'milestone.award'; milestoneId: string; discipleId: string; ruleId: MilestoneRuleId }
  | { kind: 'equipment.grant'; acquisitionId: string; discipleId: string; definitionId: string }
  | { kind: 'expedition.lock'; runId: string; locks: { discipleId: string; lockId: string }[] }
  | { kind: 'expedition.unlock'; runId: string; locks: { discipleId: string; lockId: string }[] }
);
export type AnyBuildCommand = BuildCommand | BuildAuthorityCommand;
export type BuildSourceOperation = { kind: 'source.remove' | 'source.install'; source: BuildSource };
export interface BuildReceipt {
  commandId: string;
  fingerprint: string;
  authority: boolean;
  revision: number;
  operations: BuildSourceOperation[];
  resultId: string | null;
}
export interface BuildHistoryEntry { authority: boolean; command: AnyBuildCommand; sequencesBefore: SequenceState; }
export interface BuildData {
  schemaVersion: 1;
  simulationVersion: 'permanent-builds-1';
  rulesVersion: 1;
  contentHash: string;
  origin: CreateBuildOptions;
  contentMode: CreateBuildOptions['contentMode'];
  revision: number;
  disciples: BuildDisciple[];
  equipment: EquipmentInstance[];
  awards: MilestoneAward[];
  receipts: BuildReceipt[];
  history: BuildHistoryEntry[];
}
/** Commit both fields, and corresponding source operations, as one world transaction. */
export interface BuildFrame { builds: BuildData; sequences: SequenceState; }
export type BuildStateFrame = Immutable<BuildFrame>;
export type BuildError = 'INVALID_INPUT' | 'INVALID_STATE' | 'INVALID_COMMAND' | 'CONTENT_MISMATCH' | 'UNKNOWN_DISCIPLE'
  | 'UNKNOWN_DEFINITION' | 'UNSUPPORTED_CONTENT' | 'REVISION_CONFLICT' | 'COMMAND_CONFLICT' | 'MILESTONE_CONFLICT'
  | 'MILESTONE_ALREADY_AWARDED' | 'ACQUISITION_CONFLICT' | 'INSUFFICIENT_POINTS' | 'POINT_LIMIT' | 'INVALID_ALLOCATION'
  | 'MISSING_PREREQUISITE' | 'ALREADY_LEARNED' | 'INSUFFICIENT_LEARNING_CREDITS' | 'INVALID_LOADOUT'
  | 'ITEM_NOT_OWNED' | 'ITEM_ALREADY_EQUIPPED' | 'EXPEDITION_LOCKED' | 'LOCK_MISMATCH' | 'COMMAND_LIMIT' | 'OVERFLOW';
export type BuildTransition =
  | { ok: true; frame: BuildStateFrame; receipt: Immutable<BuildReceipt>; operations: Immutable<BuildSourceOperation[]>; replayed: boolean }
  | { ok: false; frame: BuildStateFrame; code: BuildError; reasons: readonly string[] };
export interface BuildCombatLoadout {
  basic: NonNullable<BattleEntityInput['basic']>;
  activeSkillIds: [string, string];
  passiveSkillId: string;
  characterSourceIds: string[];
  equipment: { weaponId: string; robeId: string; artifactId: string };
  stats: BattleEntityInput['stats'];
  maximumSpirit: number;
}
export interface BuildProgress { earnedPoints: number; allocatedPoints: number; availablePoints: number; earnedLearningCredits: number; spentLearningCredits: number; availableLearningCredits: number; }
export interface BuildChoice { definitionId: string; available: boolean; reasons: readonly string[]; }
export type BuildCatalog = CombatContentCatalog;
