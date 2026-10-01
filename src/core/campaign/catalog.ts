import type { BattleArena, BattleEntityInput } from '../combat/runtime/types';
import type { ExpeditionEncounterDefinition } from '../expeditions/encounter-catalog';
import type { CampaignEquipmentDefinition, CampaignKnowledgeDefinition, CampaignRecruitDefinition, CampaignRouteDefinition, CampaignRouteId } from './types';
import { freeze } from './shared';

/** IDs/specification intentionally match the existing starter catalog. Its enemies stay owned there. */
export const CAMPAIGN_ROUTES = freeze<CampaignRouteDefinition[]>([
  { id: 'route.qingfeng-trial', nameKey: 'campaign.route.qingfeng.name', descriptionKey: 'campaign.route.qingfeng.description', counterplayKey: 'campaign.route.qingfeng.counterplay',
    mechanism: 'fundamentals', prerequisites: [], specification: {
      regionId: 'region.qingfeng', regularEncounterIds: ['encounter.forest-patrol', 'encounter.venom-hollow'], bossEncounterId: 'encounter.stone-warden',
      encounterCount: 3, minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1 },
    firstClear: { equipmentId: 'equipment.trail-robe', knowledgeIds: ['knowledge.clear-heart', 'knowledge.sun-piercing'], recruitInvitation: true }, final: false },
  { id: 'route.miasma-seal', nameKey: 'campaign.route.miasma.name', descriptionKey: 'campaign.route.miasma.description', counterplayKey: 'campaign.route.miasma.counterplay',
    mechanism: 'poison-attrition', prerequisites: ['route.qingfeng-trial'], specification: {
      regionId: 'region.miasma', regularEncounterIds: ['encounter.miasma-garden'], bossEncounterId: 'encounter.miasma-keeper',
      encounterCount: 3, minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1 },
    firstClear: { equipmentId: 'equipment.apothecary-vessel', knowledgeIds: [], recruitInvitation: false }, final: false },
  { id: 'route.thunder-seal', nameKey: 'campaign.route.thunder.name', descriptionKey: 'campaign.route.thunder.description', counterplayKey: 'campaign.route.thunder.counterplay',
    mechanism: 'split-ranged', prerequisites: ['route.qingfeng-trial'], specification: {
      regionId: 'region.thunder', regularEncounterIds: ['encounter.thunder-crossfire'], bossEncounterId: 'encounter.thunder-conductor',
      encounterCount: 3, minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1 },
    firstClear: { equipmentId: 'equipment.storm-focus', knowledgeIds: ['knowledge.guard-step'], recruitInvitation: true }, final: false },
  { id: 'route.mountain-seal', nameKey: 'campaign.route.mountain.name', descriptionKey: 'campaign.route.mountain.description', counterplayKey: 'campaign.route.mountain.counterplay',
    mechanism: 'shield-counterattack', prerequisites: ['route.miasma-seal', 'route.thunder-seal'], specification: {
      regionId: 'region.mountain', regularEncounterIds: ['encounter.mountain-watch'], bossEncounterId: 'encounter.mountain-heart',
      encounterCount: 3, minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1 },
    firstClear: { equipmentId: 'equipment.guardian-robe', knowledgeIds: [], recruitInvitation: false }, final: false },
  { id: 'route.everbright-finale', nameKey: 'campaign.route.finale.name', descriptionKey: 'campaign.route.finale.description', counterplayKey: 'campaign.route.finale.counterplay',
    mechanism: 'combined-arms', prerequisites: ['route.mountain-seal'], specification: {
      regionId: 'region.everbright', regularEncounterIds: ['encounter.everbright-vanguard'], bossEncounterId: 'encounter.everbright-heart',
      encounterCount: 3, minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1 },
    firstClear: { equipmentId: null, knowledgeIds: [], recruitInvitation: true }, final: true },
]);

/** Slot opportunity costs create tradeoffs; no new executable effect primitive is introduced. */
export const CAMPAIGN_EQUIPMENT = freeze<CampaignEquipmentDefinition[]>([
  { id: 'equipment.trail-robe', nameKey: 'campaign.equipment.trailRobe.name', descriptionKey: 'campaign.equipment.trailRobe.description',
    slot: 'robe', school: null, tags: [], flatStats: { maxHealth: 35, controlResistanceBps: 600 }, maximumSpiritBonus: 0 },
  { id: 'equipment.apothecary-vessel', nameKey: 'campaign.equipment.apothecaryVessel.name', descriptionKey: 'campaign.equipment.apothecaryVessel.description',
    slot: 'artifact', school: null, tags: ['heal'], flatStats: { healingBps: 1800 }, maximumSpiritBonus: 5 },
  { id: 'equipment.storm-focus', nameKey: 'campaign.equipment.stormFocus.name', descriptionKey: 'campaign.equipment.stormFocus.description',
    slot: 'artifact', school: null, tags: ['damage'], flatStats: { attack: 4 }, maximumSpiritBonus: 0 },
  { id: 'equipment.guardian-robe', nameKey: 'campaign.equipment.guardianRobe.name', descriptionKey: 'campaign.equipment.guardianRobe.description',
    slot: 'robe', school: null, tags: ['shield'], flatStats: { maxHealth: 12, armor: 3, shieldBps: 1000 }, maximumSpiritBonus: 0 },
]);
/** Each book teaches a real existing skill and survives in the sect archive for later generations. */
export const CAMPAIGN_KNOWLEDGE = freeze<CampaignKnowledgeDefinition[]>([
  { id: 'knowledge.clear-heart', nameKey: 'campaign.knowledge.clearHeart.name', descriptionKey: 'campaign.knowledge.clearHeart.description',
    school: 'alchemy', skillId: 'skill.qingxin', requiredSkillIds: ['skill.qingwu'], costs: [{ resourceId: 'herbs', quantity: 2 }] },
  { id: 'knowledge.sun-piercing', nameKey: 'campaign.knowledge.sunPiercing.name', descriptionKey: 'campaign.knowledge.sunPiercing.description',
    school: 'sword', skillId: 'skill.guanri-jianjue', requiredSkillIds: ['skill.liuhen-jian'], costs: [{ resourceId: 'stone', quantity: 2 }] },
  { id: 'knowledge.guard-step', nameKey: 'campaign.knowledge.guardStep.name', descriptionKey: 'campaign.knowledge.guardStep.description',
    school: 'body', skillId: 'skill.yuanhu', requiredSkillIds: ['skill.baoyue'], costs: [{ resourceId: 'herbs', quantity: 2 }] },
]);
export const CAMPAIGN_RECRUITS = freeze<CampaignRecruitDefinition[]>([
  { school: 'sword', nameKey: 'campaign.recruit.sword', ageMonths: 216, lifespanMonths: 960, realm: 'mortal', aptitude: 48, cultivation: 0, understanding: 28, foundation: 24, mindset: 55, injury: 0 },
  { school: 'body', nameKey: 'campaign.recruit.body', ageMonths: 252, lifespanMonths: 960, realm: 'mortal', aptitude: 44, cultivation: 0, understanding: 22, foundation: 34, mindset: 55, injury: 0 },
  { school: 'alchemy', nameKey: 'campaign.recruit.alchemy', ageMonths: 240, lifespanMonths: 960, realm: 'mortal', aptitude: 46, cultivation: 0, understanding: 34, foundation: 22, mindset: 55, injury: 0 },
  { school: 'talisman', nameKey: 'campaign.recruit.talisman', ageMonths: 228, lifespanMonths: 960, realm: 'mortal', aptitude: 50, cultivation: 0, understanding: 30, foundation: 22, mindset: 50, injury: 0 },
]);
export const RECRUIT_COSTS = freeze([{ resourceId: 'meal' as const, quantity: 4 }]);
export const RECOVERY_RESOURCES = freeze([{ resourceId: 'grain' as const, quantity: 8 }, { resourceId: 'meal' as const, quantity: 4 }]);

const arena: BattleArena = { origin: { x: 0, y: 0 }, widthCells: 14, heightCells: 10, cellSizeUnits: 80, blockedCells: [] };
const divided: BattleArena = { ...arena, blockedCells: [{ x: 6, y: 3 }, { x: 6, y: 4 }, { x: 6, y: 5 }] };
const basic: NonNullable<BattleEntityInput['basic']> = { school: 'body', coefficientBps: 10_000, cooldownTicks: 44, castTicks: 12, rangeUnits: 160 };
type Enemy = ExpeditionEncounterDefinition['enemies'][number];
function enemy(nameKey: string, x: number, y: number, attack: number, maxHealth: number, skills: string[] = [], ranged = false): Enemy {
  return { nameKey, position: { x, y }, stats: { attack, maxHealth, armor: 1 }, skills, maximumSpirit: 140,
    sources: skills.includes('skill.xujin') ? ['talent.fanzhen'] : [],
    basic: { ...basic, rangeUnits: ranged ? 520 : 160 }, deathRule: 'immediate' };
}
function encounter(id: string, key: string, enemies: Enemy[], boss: boolean, field = arena): ExpeditionEncounterDefinition {
  return { id, nameKey: `campaign.encounter.${key}.name`, descriptionKey: `campaign.encounter.${key}.description`, enemies,
    arena: field, maximumTicks: boss ? 4800 : 3000, securedLoot: [{ resourceId: 'herbs', quantity: boss ? 5 : 2 }],
    unsecuredLoot: [{ resourceId: 'stone', quantity: boss ? 8 : 3 }], unlockIds: [] };
}
/** Additional encounters only. Existing Qingfeng definitions remain the single starter source. */
export const CAMPAIGN_ENCOUNTERS = freeze<ExpeditionEncounterDefinition[]>([
  encounter('encounter.miasma-garden', 'miasmaGarden', [
    enemy('expedition.enemy.venomAdept', 800, 240, 7, 95, ['skill.qingwu'], true), enemy('expedition.enemy.raider', 880, 480, 7, 70),
  ], false),
  encounter('encounter.miasma-keeper', 'miasmaKeeper', [
    enemy('expedition.enemy.venomAdept', 880, 320, 9, 230, ['skill.qingwu', 'skill.huichun'], true),
    enemy('expedition.enemy.venomAdept', 720, 480, 6, 80, ['skill.qingwu'], true),
  ], true),
  encounter('encounter.thunder-crossfire', 'thunderCrossfire', [
    enemy('campaign.enemy.stormAdept', 880, 160, 7, 85, ['skill.yinlei'], true), enemy('campaign.enemy.stormAdept', 880, 560, 7, 85, ['skill.yinlei'], true),
  ], false, divided),
  encounter('encounter.thunder-conductor', 'thunderConductor', [
    enemy('campaign.enemy.stormAdept', 880, 320, 10, 230, ['skill.yinlei', 'skill.fenzhang'], true),
    enemy('expedition.enemy.raider', 640, 160, 6, 100), enemy('expedition.enemy.raider', 640, 560, 6, 100),
  ], true, divided),
  encounter('encounter.mountain-watch', 'mountainWatch', [
    enemy('expedition.enemy.stoneWarden', 720, 240, 8, 140, ['skill.baoyue', 'skill.xujin']),
    enemy('expedition.enemy.stoneWarden', 880, 480, 8, 140, ['skill.baoyue', 'skill.zhenbu']),
  ], false),
  encounter('encounter.mountain-heart', 'mountainHeart', [
    enemy('expedition.enemy.stoneWarden', 880, 320, 13, 390, ['skill.baoyue', 'skill.zhenbu', 'skill.xujin']),
    enemy('campaign.enemy.stormAdept', 880, 560, 7, 95, ['skill.yinlei'], true),
  ], true),
  encounter('encounter.everbright-vanguard', 'everbrightVanguard', [
    enemy('expedition.enemy.stoneWarden', 720, 320, 9, 150, ['skill.baoyue']),
    enemy('expedition.enemy.venomAdept', 880, 160, 8, 105, ['skill.qingwu'], true),
    enemy('campaign.enemy.stormAdept', 880, 560, 8, 105, ['skill.yinlei'], true),
  ], false, divided),
  encounter('encounter.everbright-heart', 'everbrightHeart', [
    enemy('expedition.enemy.stoneWarden', 720, 320, 14, 420, ['skill.baoyue', 'skill.zhenbu', 'skill.xujin']),
    enemy('expedition.enemy.venomAdept', 880, 160, 9, 120, ['skill.qingwu', 'skill.huichun'], true),
    enemy('campaign.enemy.stormAdept', 880, 560, 9, 120, ['skill.yinlei'], true),
  ], true, divided),
]);
export const campaignRoute = (id: CampaignRouteId | string) => CAMPAIGN_ROUTES.find(route => route.id === id);
export const campaignKnowledge = (id: string) => CAMPAIGN_KNOWLEDGE.find(knowledge => knowledge.id === id);
