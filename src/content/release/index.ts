import type { CombatContentCatalog } from '../../core/combat/definitions/types';
import type { MessageSpecifications, ParameterSpec } from '../../i18n/types';
import { prepareCombatCatalog } from '../../core/combat/runtime/catalog';
import { stableHash } from '../../core/kernel/serialization';
import { combatCatalog, allCombatDefinitions } from '../definitions';
import { combatZhCN } from '../locales/zh-CN/combat';
import { combatEn } from '../locales/en/combat';
import { CAMPAIGN_ENCOUNTERS, CAMPAIGN_EQUIPMENT, CAMPAIGN_KNOWLEDGE, CAMPAIGN_RECRUITS, CAMPAIGN_ROUTES, RECRUIT_COSTS, RECOVERY_RESOURCES } from '../../core/campaign/catalog';
import { BUILD_RULES_VERSION, EQUIPMENT_DEFINITIONS, SKILL_LEARNING_RULES } from '../../core/builds/rules';
import { releaseTalents, releaseTalentRows } from './talents';
export { releaseTalents, releaseTalentRows };
export type { ReleaseTalentRow } from './helpers';

const recommendedSupportSkills: Readonly<Record<string, readonly string[]>> = {
  'build.huichao-jianzhen': ['skill.zhenbu', 'skill.fumai', 'skill.yinlei'],
  'build.yaohuo-gonglu': ['skill.qingxin', 'skill.liuhen-jian', 'skill.fumai'],
  'build.xuanjia-huixiang': ['skill.liuhen-jian'],
  'build.sanyao-liuzhuan': ['skill.qingwu'],
};

/** Opt-in candidate only: never change the live import graph before explicit v8 migration. */
export const releaseCombatCatalog: CombatContentCatalog = prepareCombatCatalog({
  ...combatCatalog,
  contentVersion: '0.2.0-release-candidate.2',
  talents: [...combatCatalog.talents, ...releaseTalents],
  builds: combatCatalog.builds.map(build => ({ ...build,
    starterSkillIds: [...build.starterSkillIds, ...(recommendedSupportSkills[build.id] ?? [])],
    talentIds: [...build.talentIds, ...releaseTalents.filter(talent => talent.buildId === build.id).map(talent => talent.id)],
  })),
});
const copy = (language: 'zh' | 'en'): Record<string, string> => Object.fromEntries(releaseTalentRows.flatMap(row => [
  [row.definition.nameKey, language === 'zh' ? row.zhName : row.enName],
  [row.definition.descriptionKey, language === 'zh' ? row.zhDescription : row.enDescription],
]));
export const releaseCombatZhCN = Object.freeze({ ...combatZhCN, ...copy('zh') });
export const releaseCombatEn = Object.freeze({ ...combatEn, ...copy('en') });
export const releaseCombatMessageSpecifications: MessageSpecifications = Object.fromEntries(allCombatDefinitions(releaseCombatCatalog).flatMap(definition => [
  [definition.nameKey, { parameters: {} }],
  [definition.descriptionKey, { parameters: Object.fromEntries(Object.entries(definition.descriptionParameters).map(([name, value]): [string, ParameterSpec] => [name, typeof value === 'number' ? { type: 'number', format: 'integer' } : { type: 'string', format: 'text' }])) }],
]));

/** One composition point for content + obtainable growth. No independent gear combat fork. */
export const releaseCatalogIdentity = Object.freeze({
  candidateId: 'shanmen-release-v8-candidate.2', proposedSaveVersion: 8,
  combatFingerprint: stableHash(releaseCombatCatalog),
  currentCombatFingerprint: stableHash(combatCatalog),
  currentBuildRulesVersion: BUILD_RULES_VERSION,
  compositeFingerprint: stableHash({ combat: releaseCombatCatalog, equipment: [...EQUIPMENT_DEFINITIONS, ...CAMPAIGN_EQUIPMENT],
    lessons: SKILL_LEARNING_RULES, knowledge: CAMPAIGN_KNOWLEDGE, routes: CAMPAIGN_ROUTES, encounters: CAMPAIGN_ENCOUNTERS,
    recruits: CAMPAIGN_RECRUITS, recruitCosts: RECRUIT_COSTS, recoveryResources: RECOVERY_RESOURCES }),
  admission: 'not-live-until-explicit-migration',
  blockers: ['talent.zoumai-chengfu: explicit extra-target Stagger protocol is pending', 'expedition authored-ID admission remains the frozen live registry'],
});

/** Proposal data only; deliberately not assignable to ActionAdjustment or installed anywhere. */
export const proposedExtraTargetStaggerOverride = Object.freeze({
  definitionId: 'talent.zoumai-chengfu', replacesAdjustment: 'additionalChainTargets', requiredProtocol: 'combat-protocol-2-proposed',
  additionalTargets: 1, linkRangeUnits: 600,
  extraTargetStatus: { statusId: 'status.stagger', durationTicks: 16, stacks: 1 },
  execution: 'synchronous-committed-extra-target-pairs', originalTargetReceivesBonusStatus: false,
  oldCatalogMutationAllowed: false, migrationRequired: true,
});
