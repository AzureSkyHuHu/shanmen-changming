import type { School } from '../combat/definitions/types';
import type { SequenceState } from '../kernel/ids';
import type { BuildAuthorityCommand, BuildCatalog, BuildCommand, BuildDisciple, BuildError, BuildHistoryEntry,
  BuildReceipt, BuildSourceOperation, CreateBuildOptions, EquipmentDefinition, Immutable, LearnedSkill,
  MilestoneAward, SkillLearningRule, BuildCombatLoadout } from './types';

/** The registry resolves these values; saved data is never an executable catalog. */
export interface BuildContentIdentity {
  registryId: string; compositeFingerprint: string; combatFingerprint: string; buildRulesVersion: number;
}
/** Structurally shared with ContentBuildRules, without a runtime registry dependency. */
export interface BuildRulesDefinition {
  version: number; schools: readonly School[]; equipmentSlots: readonly string[];
  equipment: readonly EquipmentDefinition[]; lessons: readonly SkillLearningRule[];
  starterSkills: Readonly<Record<School, readonly string[]>>; milestones: readonly string[];
  maximumAllocatedPoints: number; maximumCommands: number; maximumDisciples: number; maximumEquipment: number;
  basics: readonly { id: string; definition: BuildCombatLoadout['basic'] }[];
}
export interface BuildContentContext {
  identity: Readonly<BuildContentIdentity>; catalog: BuildCatalog; rules: BuildRulesDefinition;
  legacy: { identity: Readonly<BuildContentIdentity>; catalog: BuildCatalog };
}
export type EquipmentOwner = { kind: 'disciple'; discipleId: string } | { kind: 'sect-estate' };
export interface EquipmentInstanceV2 { instanceId: string; definitionId: string; owner: EquipmentOwner; acquisitionId: string }
export type KnowledgeOrigin = { kind: 'archive'; knowledgeId: string }
  | { kind: 'teaching'; knowledgeId: string; teacherId: string; teachingId: string };
export type LearnedSkillV2 = LearnedSkill | { skillId: string; origin: 'archive' | 'teaching'; creditCost: 0;
  acquisitionId: string; provenance: KnowledgeOrigin };
export interface BuildDiscipleV2 extends Omit<BuildDisciple, 'learnedSkills'> { learnedSkills: LearnedSkillV2[] }
/** No loadout, active sources, allocation or simulation work survives retirement. */
export interface RetiredBuildDisciple { discipleId: string; school: School; treeId: string; deathId: string;
  learnedSkills: LearnedSkillV2[]; retiredRevision: number }
interface AuthorityBase { commandId: string; expectedRevision: number }
export type BuildAuthorityCommandV2 = BuildAuthorityCommand | (AuthorityBase & (
  | { kind: 'disciple.enroll'; acquisitionId: string; discipleId: string; school: School }
  | { kind: 'skill.grantKnowledge'; acquisitionId: string; discipleId: string; skillId: string; provenance: KnowledgeOrigin }
  | { kind: 'disciple.retire'; discipleId: string; deathId: string }
  | { kind: 'equipment.transfer'; transferId: string; itemInstanceId: string; fromOwner: EquipmentOwner; toOwner: EquipmentOwner;
      reason: { kind: 'death'; deathId: string } | { kind: 'estate-assignment'; assignmentId: string } }
));
export type AnyBuildCommandV2 = BuildCommand | BuildAuthorityCommandV2;
export interface BuildHistoryEntryV2 extends Omit<BuildHistoryEntry, 'command'> { command: AnyBuildCommandV2 }
export interface BuildMigrationBoundary {
  kind: 'legacy-v1'; identity: BuildContentIdentity; prefixLength: number;
  sourceStateHash: string; sequencesAtMigration: SequenceState;
}
export interface BuildDataV2 {
  schemaVersion: 2; simulationVersion: 'permanent-builds-2'; rulesVersion: 2;
  contentIdentity: BuildContentIdentity; rulesHash: string;
  origin: CreateBuildOptions; contentMode: CreateBuildOptions['contentMode']; revision: number;
  migration: BuildMigrationBoundary | null;
  disciples: BuildDiscipleV2[]; retiredDisciples: RetiredBuildDisciple[];
  equipment: EquipmentInstanceV2[]; awards: MilestoneAward[];
  receipts: BuildReceipt[]; history: BuildHistoryEntryV2[];
}
export interface BuildFrameV2 { builds: BuildDataV2; sequences: SequenceState }
export type BuildStateFrameV2 = Immutable<BuildFrameV2>;
export type BuildErrorV2 = BuildError | 'IDENTITY_REUSED' | 'INVALID_PROVENANCE' | 'ALREADY_RETIRED' | 'TRANSFER_CONFLICT';
export type BuildTransitionV2 =
  | { ok: true; frame: BuildStateFrameV2; receipt: Immutable<BuildReceipt>; operations: Immutable<BuildSourceOperation[]>; replayed: boolean }
  | { ok: false; frame: BuildStateFrameV2; code: BuildErrorV2; reasons: readonly string[] };
