import { combatCatalog } from '../../content/definitions';
import { prepareCombatCatalog } from '../combat/runtime';
import type { BattleArena, BattleEntityInput } from '../combat/runtime';
import type { ResourceLine } from '../economy/types';
import { freeze } from './shared';
import type { Immutable, RouteSpecification } from './types';

/** One detached, deeply frozen authored catalog shared by builds, runs, controllers and validation. */
export const EXPEDITION_COMBAT_CATALOG = prepareCombatCatalog(combatCatalog);
export interface ExpeditionEncounterDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  enemies: (Omit<BattleEntityInput, 'id' | 'team'> & { nameKey: string })[];
  arena: BattleArena;
  maximumTicks: number;
  securedLoot: ResourceLine[];
  unsecuredLoot: ResourceLine[];
  unlockIds: string[];
}
export const STARTER_ROUTE_ID = 'route.qingfeng-trial' as const;
export const STARTER_ROUTE: Immutable<RouteSpecification> = freeze({
  regionId: 'region.qingfeng', regularEncounterIds: ['encounter.forest-patrol', 'encounter.venom-hollow'],
  bossEncounterId: 'encounter.stone-warden', encounterCount: 3,
  minimumTravelMonths: 1, maximumTravelMonths: 1, returnMonths: 1,
});
const arena: BattleArena = { origin: { x: 0, y: 0 }, widthCells: 14, heightCells: 10, cellSizeUnits: 80,
  blockedCells: [{ x: 6, y: 3 }, { x: 6, y: 4 }, { x: 7, y: 5 }] };
const basic = { coefficientBps: 10_000, cooldownTicks: 40, castTicks: 8, rangeUnits: 160, school: 'body' as const };
/** Explicit unbalanced first-playable encounter tuning, using only existing supported effects. */
export const EXPEDITION_ENCOUNTERS: Immutable<ExpeditionEncounterDefinition[]> = freeze([
  { id: 'encounter.forest-patrol', nameKey: 'expedition.encounter.forestPatrol.name', descriptionKey: 'expedition.encounter.forestPatrol.description',
    arena, maximumTicks: 2400,
    enemies: [
      { nameKey: 'expedition.enemy.raider', position: { x: 880, y: 240 }, stats: { attack: 5, maxHealth: 48, armor: 0 }, maximumSpirit: 40, basic, deathRule: 'immediate' },
      { nameKey: 'expedition.enemy.raider', position: { x: 880, y: 400 }, stats: { attack: 5, maxHealth: 48, armor: 0 }, maximumSpirit: 40, basic, deathRule: 'immediate' },
    ], securedLoot: [{ resourceId: 'herbs', quantity: 2 }], unsecuredLoot: [{ resourceId: 'wood', quantity: 5 }], unlockIds: [] },
  { id: 'encounter.venom-hollow', nameKey: 'expedition.encounter.venomHollow.name', descriptionKey: 'expedition.encounter.venomHollow.description',
    arena, maximumTicks: 2400,
    enemies: [
      { nameKey: 'expedition.enemy.venomAdept', position: { x: 880, y: 320 }, stats: { attack: 5, maxHealth: 78, armor: 1 }, skills: ['skill.qingwu'], maximumSpirit: 90,
        basic: { ...basic, school: 'alchemy', rangeUnits: 400, cooldownTicks: 50 }, deathRule: 'immediate' },
      { nameKey: 'expedition.enemy.raider', position: { x: 800, y: 480 }, stats: { attack: 4, maxHealth: 36, armor: 0 }, maximumSpirit: 40, basic, deathRule: 'immediate' },
    ], securedLoot: [{ resourceId: 'herbs', quantity: 3 }], unsecuredLoot: [{ resourceId: 'grain', quantity: 6 }], unlockIds: [] },
  { id: 'encounter.stone-warden', nameKey: 'expedition.encounter.stoneWarden.name', descriptionKey: 'expedition.encounter.stoneWarden.description',
    arena, maximumTicks: 3600,
    enemies: [
      { nameKey: 'expedition.enemy.stoneWarden', position: { x: 880, y: 320 }, stats: { attack: 10, maxHealth: 240, armor: 3 }, skills: ['skill.baoyue', 'skill.zhenbu'], maximumSpirit: 130,
        basic: { ...basic, coefficientBps: 12_000, castTicks: 20, cooldownTicks: 50 }, deathRule: 'immediate' },
    ], securedLoot: [{ resourceId: 'stone', quantity: 12 }], unsecuredLoot: [{ resourceId: 'herbs', quantity: 5 }, { resourceId: 'wood', quantity: 10 }], unlockIds: ['region.qingfeng.cleared'] },
]);
export function expeditionEncounter(id: string): Immutable<ExpeditionEncounterDefinition> {
  const encounter = EXPEDITION_ENCOUNTERS.find(entry => entry.id === id);
  if (!encounter) throw new Error('Unknown expedition encounter');
  return encounter;
}
