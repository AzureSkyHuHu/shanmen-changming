/** Serializable combat protocol v1. Data only: no executor or combat state lives here. */
export const COMBAT_SCHEMA_VERSION = 1 as const;
export const COMBAT_TICKS_PER_SECOND = 20 as const;
export const BASIS_POINTS = 10_000 as const;
export const ROOT_PROC_LIMITS = { maxDepth: 8, maxDerivedEffects: 64 } as const;

/** All numbers are safe integers. Percentages use 10,000 basis points = 100%. */
export type TickCount = number;
export type Units = number;
export type BasisPoints = number;
export type DefinitionId = string;
export type School = 'sword' | 'body' | 'alchemy' | 'talisman';
export type LifecycleScope = 'character' | 'run' | 'encounter';
export type Duration =
  | { readonly kind: 'infinite' }
  | { readonly kind: 'ticks'; readonly ticks: TickCount }
  | { readonly kind: 'nodes'; readonly nodes: number };
export type Stat = 'attack' | 'maxHealth' | 'armor' | 'criticalChanceBps' | 'criticalMultiplierBps'
  | 'hasteBps' | 'damageReductionBps' | 'healingBps' | 'controlResistanceBps' | 'shieldBps';
export type CombatTag = School | 'active' | 'passive' | 'ultimate' | 'basic' | 'physical' | 'fire' | 'lightning'
  | 'poison' | 'melee' | 'ranged' | 'projectile' | 'beam' | 'area' | 'periodic' | 'damage' | 'shield'
  | 'heal' | 'cleanse' | 'control' | 'movement' | 'summon' | 'swordMark' | 'storedForce' | 'medicine'
  | 'rune' | 'proc' | 'guard' | 'interrupt' | 'penetration';
export type Comparison = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
/** Fields are closed; content cannot traverse arbitrary state or execute expressions. */
export type NumericField = 'actor.healthBps' | 'target.healthBps' | 'actor.shieldUnits' | 'event.actualHealthLoss'
  | 'event.actualShieldAbsorbed' | 'event.effectiveHealing' | 'event.overhealing' | 'event.consumedStacks'
  | 'event.paidSpirit' | 'event.idleTicks' | 'event.distinctCasterCount' | 'event.distinctSchoolCount';
export type BooleanField = 'event.enemyCaused' | 'event.isCritical' | 'event.isActive' | 'event.isBasic'
  | 'event.targetAlive' | 'event.differentCaster' | 'event.differentSchool' | 'event.ownedStatus';
export type Subject = 'actor' | 'target' | 'eventSource';
export type Condition =
  | { readonly kind: 'always' }
  | { readonly kind: 'all' | 'any'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'not'; readonly condition: Condition }
  | { readonly kind: 'compare'; readonly field: NumericField; readonly operator: Comparison; readonly value: number }
  | { readonly kind: 'flag'; readonly field: BooleanField; readonly value: boolean }
  | { readonly kind: 'hasStatus'; readonly subject: Subject; readonly statusId: DefinitionId; readonly minimumStacks: number }
  | { readonly kind: 'hasTag'; readonly subject: Subject; readonly tag: CombatTag }
  | { readonly kind: 'consumedStatus'; readonly statusId: DefinitionId };

/** All multi-target ties MUST resolve by stable entity ID, never collection insertion order. */
export type TargetSelector =
  | { readonly kind: 'self' | 'intent' | 'eventTarget' | 'eventActor' | 'statusSource' | 'focus' | 'boundHolder' }
  | { readonly kind: 'lowestHealth'; readonly team: 'ally' | 'enemy'; readonly excludeSelf: boolean; readonly maxRangeUnits: Units }
  | { readonly kind: 'area'; readonly team: 'ally' | 'enemy'; readonly center: 'self' | 'intent'; readonly radiusUnits: Units; readonly limit: number }
  | { readonly kind: 'chain'; readonly team: 'ally' | 'enemy'; readonly start: 'intent' | 'eventTarget'; readonly jumps: number; readonly maxRangeUnits: Units };
export type Amount =
  | { readonly kind: 'flat'; readonly units: Units }
  | { readonly kind: 'stat'; readonly stat: 'attack' | 'maxHealth'; readonly coefficientBps: BasisPoints; readonly flatUnits: Units }
  | { readonly kind: 'event'; readonly field: 'actualShieldAbsorbed' | 'effectiveHealing' | 'overhealing'; readonly coefficientBps: BasisPoints; readonly capStat: 'attack' | 'maxHealth'; readonly capBps: BasisPoints }
  | { readonly kind: 'consumed'; readonly resultKey: string; readonly stat: 'attack' | 'maxHealth'; readonly coefficientPerStackBps: BasisPoints; readonly flatPerStackUnits: Units };

/** Executor binds this identity to EVERY installed modifier/status/trigger contribution. */
export interface SourceOwner {
  readonly sourceEntityId: string;
  readonly sourceDefinitionId: DefinitionId;
  readonly sourceInstanceId: string;
  readonly lifecycleScope: LifecycleScope;
  readonly duration: Duration;
  readonly createdSequence: number;
}
export interface ModifierSpec {
  /** Stable within the definition; runtime identity is sourceInstanceId + modifierId. */
  readonly modifierId: string;
  readonly stat: Stat;
  readonly operation: 'addFlat' | 'addPercentBps' | 'multiplyBps' | 'minimum' | 'maximum';
  readonly value: number;
  readonly tags: readonly CombatTag[];
  readonly condition: Condition;
  readonly priority: number;
  readonly lifecycleScope: LifecycleScope;
  readonly duration: Duration;
}
export interface OwnedModifier extends SourceOwner { readonly modifier: ModifierSpec }
interface EffectBase { readonly target: TargetSelector; readonly condition: Condition }
/** Only these primitives may be interpreted by a separately registered, tested executor. */
export type EffectPrimitive = EffectBase & (
  | { readonly kind: 'damage'; readonly amount: Amount; readonly damageType: 'physical' | 'fire' | 'lightning' | 'poison'; readonly tags: readonly CombatTag[]; readonly armorPenetrationBps: BasisPoints; readonly attackRead: 'castSnapshot' | 'applicationSnapshot'; readonly defenseRead: 'hitLive'; readonly rounding: 'floor'; readonly canCritical: boolean }
  | { readonly kind: 'heal'; readonly amount: Amount; readonly rounding: 'floor' }
  | { readonly kind: 'shield'; readonly amount: Amount; readonly lifecycleScope: LifecycleScope; readonly duration: Duration; readonly stackPolicy: 'independent' | 'refreshSource' | 'strongest'; readonly rounding: 'floor' }
  | { readonly kind: 'applyStatus'; readonly statusId: DefinitionId; readonly stacks: number; readonly duration: Duration }
  | { readonly kind: 'consumeStatus'; readonly statusId: DefinitionId; readonly maximumStacks: number; readonly minimumStacks: number; readonly resultKey: string; readonly sourceFilter: 'any' | 'self' }
  | { readonly kind: 'restoreResource'; readonly resource: 'spirit'; readonly units: Units }
  | { readonly kind: 'installModifier'; readonly modifier: ModifierSpec }
  | { readonly kind: 'dispel'; readonly category: 'poison' | 'control' | 'debuff'; readonly count: number }
  | { readonly kind: 'interrupt'; readonly strength: number }
  | { readonly kind: 'move'; readonly mode: 'toAlly'; readonly maximumDistanceUnits: Units }
  | { readonly kind: 'summon'; readonly summonId: DefinitionId; readonly maximumPerCaster: 1; readonly duration: Duration }
  | { readonly kind: 'zone'; readonly radiusUnits: Units; readonly intervalTicks: TickCount; readonly duration: Duration; readonly effects: readonly EffectPrimitive[] }
  | { readonly kind: 'preventDowned'; readonly healthFloorBps: BasisPoints }
  | { readonly kind: 'rescue'; readonly healthBps: BasisPoints; readonly recoveryLockTicks: TickCount }
  | { readonly kind: 'storeForce'; readonly coefficientBps: BasisPoints; readonly maximumHealthBps: BasisPoints }
  | { readonly kind: 'releaseForce'; readonly coefficientBps: BasisPoints; readonly maximumHealthBps: BasisPoints; readonly damageType: 'physical'; readonly tags: readonly CombatTag[] }
  | { readonly kind: 'recordCast'; readonly windowTicks: TickCount; readonly maximumRecords: number; readonly distinctBy: 'caster' | 'school' }
  | { readonly kind: 'augmentNextAction'; readonly tags: readonly CombatTag[]; readonly uses: number; readonly duration: Duration; readonly adjustment: ActionAdjustment }
);
/** Effect variants rather than callbacks. Values modify one authoritative action phase. */
export type ActionAdjustment =
  | { readonly kind: 'costReductionBps'; readonly value: BasisPoints; readonly minimumCostUnits: Units }
  | { readonly kind: 'bonusDamageBps'; readonly value: BasisPoints }
  | { readonly kind: 'additionalChainTargets'; readonly value: number; readonly staggerTicks: TickCount }
  | { readonly kind: 'rangeUnits' | 'castTimeTicks' | 'statusDurationTicks' | 'areaRadiusUnits' | 'dispelCount' | 'interruptStrength'; readonly value: number }
  | { readonly kind: 'statusStacks'; readonly statusId: DefinitionId; readonly value: number };
export type CombatEventKind = 'action.committed' | 'damage.healthLost' | 'shield.absorbed' | 'shield.broken'
  | 'status.consumed' | 'control.ended' | 'life.beforeDowned' | 'life.downed' | 'healing.resolved'
  | 'command.guard' | 'force.released' | 'castHistory.recorded';
export interface ProcPolicy {
  readonly family: string;
  /** Indirect events opt in by exact family; empty means direct actions only. */
  readonly allowIndirectFamilies: readonly string[];
  readonly oncePerRoot: boolean;
  readonly perTarget: boolean;
  readonly internalCooldownTicks: TickCount;
  readonly maximumActivations: number;
  readonly activationScope: 'encounter' | 'run';
  readonly maxDepth: number;
  readonly maxDerivedEffects: number;
}
export interface TriggerDefinition {
  readonly triggerId: string;
  readonly event: CombatEventKind;
  readonly eventScope: 'owner' | 'allies' | 'team';
  readonly condition: Condition;
  readonly priority: number;
  readonly proc: ProcPolicy;
  readonly effects: readonly EffectPrimitive[];
}
export interface Mechanics {
  readonly onInstall: readonly EffectPrimitive[];
  readonly triggers: readonly TriggerDefinition[];
  /** Persistent alterations still bind to a sourceInstanceId and the owner's lifetime. */
  readonly actionRules: readonly { readonly ruleId: string; readonly tags: readonly CombatTag[]; readonly condition: Condition; readonly adjustment: ActionAdjustment }[];
}
export type Capability = EffectPrimitive['kind'] | 'actionRules' | 'control';
export interface DefinitionBase {
  readonly id: DefinitionId;
  readonly schemaVersion: 1;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly descriptionParameters: Readonly<Record<string, number | string>>;
  readonly tags: readonly CombatTag[];
  readonly presentationKey: string;
  readonly source: { readonly designRef: string; readonly section: number };
  readonly testScenarioIds: readonly string[];
  readonly tuning: 'unbalanced-baseline';
  readonly implementation: 'definition-only' | 'blocked' | 'verified';
  readonly blockedReasons: readonly string[];
  readonly requiredCapabilities: readonly Capability[];
}
export interface ActiveAction {
  readonly spiritCostUnits: Units;
  readonly cooldownTicks: TickCount;
  readonly castTicks: TickCount;
  readonly rangeUnits: Units;
  readonly targetTeam: 'self' | 'ally' | 'enemy';
  readonly target: TargetSelector;
  readonly condition: Condition;
  readonly effects: readonly EffectPrimitive[];
  readonly commitPolicy: 'castEndRevalidate';
  readonly missRefundPolicy: 'none';
  readonly launchedSourceDeathPolicy: 'resolveCommitted';
}
export type SkillDefinition = DefinitionBase & {
  readonly kind: 'skill'; readonly school: School; readonly lifecycleScope: 'character'; readonly mechanics: Mechanics;
} & (
  | { readonly activation: 'active'; readonly action: ActiveAction; readonly ultimate: boolean }
  | { readonly activation: 'passive' }
);
export interface TalentDefinition extends DefinitionBase {
  readonly kind: 'talent';
  readonly lifecycleScope: 'run';
  readonly holderScope: 'personal' | 'team';
  readonly category: 'general' | 'school' | 'crossSchool' | 'route';
  readonly buildId: DefinitionId;
  readonly offerRole: 'core' | 'support' | 'bridge';
  readonly maximumRank: number;
  readonly prerequisites: readonly DefinitionId[];
  readonly excludes: readonly DefinitionId[];
  readonly requiredSourceTags: readonly CombatTag[];
  readonly providesSourceTags: readonly CombatTag[];
  readonly teamStackPolicy: 'notApplicable' | 'highestValueSharedBudget';
  readonly recipientBinding: 'holder' | 'team' | 'selectedTalisman';
  readonly mechanics: Mechanics;
}
export interface TreeNodeDefinition extends DefinitionBase {
  readonly kind: 'treeNode'; readonly lifecycleScope: 'character'; readonly treeId: DefinitionId;
  readonly school: School; readonly branch: 'a' | 'b' | 'c'; readonly tier: 1 | 2 | 3;
  readonly pointCost: 1; readonly prerequisites: readonly DefinitionId[]; readonly excludes: readonly DefinitionId[];
  readonly mechanics: Mechanics;
}
export interface TreeDefinition extends DefinitionBase {
  readonly kind: 'tree'; readonly school: School; readonly lifecycleScope: 'character';
  readonly maximumPoints: 5; readonly nodeIds: readonly DefinitionId[];
}
export type StackPolicy =
  | { readonly kind: 'refresh'; readonly maximumStacks: number }
  | { readonly kind: 'extend'; readonly maximumStacks: number; readonly maximumDurationTicks: TickCount }
  | { readonly kind: 'independent'; readonly maximumStacks: number }
  | { readonly kind: 'strongest'; readonly maximumStacks: 1; readonly compareBy: 'magnitude'; readonly equalPolicy: 'keepExisting' | 'refreshDuration' };
export interface StatusDefinition extends DefinitionBase {
  readonly kind: 'status'; readonly lifecycleScope: 'encounter'; readonly duration: Duration;
  readonly identity: 'definition' | 'definitionAndCaster'; readonly stackPolicy: StackPolicy;
  readonly dispelCategory: 'poison' | 'control' | 'debuff' | 'buff' | 'none';
  readonly actionLock: 'none' | 'untilRemoved'; readonly resistancePolicy: 'none' | 'targetTenacity';
  readonly deathPolicy: 'remove'; readonly encounterEndPolicy: 'remove';
  readonly expiryOrder: 'expireBeforePeriodic'; readonly periodicIntervalTicks: TickCount;
  readonly periodicEffects: readonly EffectPrimitive[];
  readonly mechanics: Mechanics;
}
export interface SummonDefinition extends DefinitionBase {
  readonly kind: 'summon'; readonly lifecycleScope: 'encounter'; readonly maximumPerCaster: 1;
  readonly duration: Duration; readonly healthCoefficientBps: BasisPoints;
  readonly role: 'threatDecoy'; readonly canCultivate: false; readonly canEquip: false; readonly canInherit: false;
}
export interface BuildDefinition extends DefinitionBase {
  readonly kind: 'build'; readonly starterSkillIds: readonly DefinitionId[]; readonly talentIds: readonly DefinitionId[];
}
export type CombatDefinition = SkillDefinition | TalentDefinition | TreeNodeDefinition | TreeDefinition | StatusDefinition | SummonDefinition | BuildDefinition;
export interface CombatContentCatalog {
  readonly schemaVersion: 1;
  readonly contentVersion: string;
  readonly requiredSimulationVersion: string;
  readonly scope: 'combat-definition-foundation';
  readonly ticksPerSecond: 20;
  readonly targetTalentCount: 48;
  readonly skills: readonly SkillDefinition[];
  readonly trees: readonly TreeDefinition[];
  readonly treeNodes: readonly TreeNodeDefinition[];
  readonly talents: readonly TalentDefinition[];
  readonly statuses: readonly StatusDefinition[];
  readonly summons: readonly SummonDefinition[];
  readonly builds: readonly BuildDefinition[];
}
