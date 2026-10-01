import type { EffectPrimitive, Mechanics, StatusDefinition, SummonDefinition } from '../../core/combat/definitions/types.ts';
import { always, base, damage, infinite, mechanics, modifier, requiredCapabilities, self, ticks } from './helpers.ts';

function makeStatus(id: string, maximumStacks: number, durationTicks: number, m = mechanics(), periodicEffects: readonly EffectPrimitive[] = [], category: StatusDefinition['dispelCategory'] = 'buff'): StatusDefinition {
  return { ...base(`status.${id}`, 18, [...requiredCapabilities(m, periodicEffects), ...(category === 'control' ? ['control' as const] : [])]), kind: 'status', lifecycleScope: 'encounter', duration: ticks(durationTicks), identity: 'definitionAndCaster', stackPolicy: { kind: 'refresh', maximumStacks }, dispelCategory: category, actionLock: category === 'control' ? 'untilRemoved' : 'none', resistancePolicy: category === 'control' ? 'targetTenacity' : 'none', deathPolicy: 'remove', encounterEndPolicy: 'remove', expiryOrder: 'expireBeforePeriodic', periodicIntervalTicks: periodicEffects.length ? 20 : 0, periodicEffects, mechanics: m };
}
function statusModifier(id: string, stat: Parameters<typeof modifier>[1], value: number): Mechanics {
  const effect = modifier(id, stat, value, [], 'addFlat');
  return mechanics(effect.kind === 'installModifier' ? [{ ...effect, modifier: { ...effect.modifier, lifecycleScope: 'encounter', duration: infinite } }] : []);
}
const poison: EffectPrimitive = { ...damage(2000, 'poison', self, true), kind: 'damage', attackRead: 'applicationSnapshot' };
export const statuses: readonly StatusDefinition[] = [
  { ...makeStatus('sword-mark', 3, 160, mechanics(), [], 'debuff'), tags: ['swordMark'], identity: 'definition' },
  { ...makeStatus('poison', 3, 160, mechanics(), [poison], 'poison'), tags: ['poison', 'periodic'] },
  { ...makeStatus('shock', 1, 100, statusModifier('shockResistance', 'armor', -2), [], 'debuff'), tags: ['lightning'], identity: 'definition', stackPolicy: { kind: 'strongest', maximumStacks: 1, compareBy: 'magnitude', equalPolicy: 'refreshDuration' } },
  { ...makeStatus('stagger', 1, 24, mechanics(), [], 'control'), tags: ['control'], identity: 'definition' },
  { ...makeStatus('control-resistance', 3, 160, statusModifier('resolve', 'controlResistanceBps', 1000)), tags: ['control'] },
  { ...makeStatus('guarded', 1, 100, statusModifier('guardReduction', 'damageReductionBps', 2000)), tags: ['guard'], stackPolicy: { kind: 'strongest', maximumStacks: 1, compareBy: 'magnitude', equalPolicy: 'keepExisting' } },
  { ...makeStatus('medicine', 2, 200), tags: ['medicine'] },
  { ...makeStatus('rune', 3, 200), tags: ['rune'], stackPolicy: { kind: 'extend', maximumStacks: 3, maximumDurationTicks: 300 } },
  { ...makeStatus('crossed-edge', 1, 160), tags: ['sword', 'proc'] },
];
export const summons: readonly SummonDefinition[] = [{
  ...base('summon.paper-decoy', 10, ['summon']), kind: 'summon', lifecycleScope: 'encounter', tags: ['summon'], maximumPerCaster: 1, duration: ticks(160), healthCoefficientBps: 2500, role: 'threatDecoy', canCultivate: false, canEquip: false, canInherit: false,
}];
