import type { ActionAdjustment, Amount, Capability, CombatEventKind, Condition, DefinitionBase, Duration, EffectPrimitive, Mechanics, ModifierSpec, ProcPolicy, TargetSelector, TriggerDefinition } from '../../core/combat/definitions/types.ts';

/** Authoring helpers only. Their output is ordinary serializable data, never callbacks. */
export const always: Condition = { kind: 'always' };
export const self: TargetSelector = { kind: 'self' };
export const intent: TargetSelector = { kind: 'intent' };
export const eventTarget: TargetSelector = { kind: 'eventTarget' };
export const lowestAlly: TargetSelector = { kind: 'lowestHealth', team: 'ally', excludeSelf: false, maxRangeUnits: 800 };
export const otherAlly: TargetSelector = { ...lowestAlly, excludeSelf: true };
export const ticks = (count: number): Duration => ({ kind: 'ticks', ticks: count });
export const infinite: Duration = { kind: 'infinite' };
export const all = (...conditions: Condition[]): Condition => ({ kind: 'all', conditions });
export const flag = (field: Extract<Condition, { kind: 'flag' }>['field'], value = true): Condition => ({ kind: 'flag', field, value });
export const compare = (field: Extract<Condition, { kind: 'compare' }>['field'], operator: Extract<Condition, { kind: 'compare' }>['operator'], value: number): Condition => ({ kind: 'compare', field, operator, value });
export const status = (statusId: string, minimumStacks = 1, subject: 'actor' | 'target' = 'actor'): Condition => ({ kind: 'hasStatus', subject, statusId, minimumStacks });
export const consumed = (statusId: string): Condition => ({ kind: 'consumedStatus', statusId });
export const scale = (coefficientBps: number, stat: 'attack' | 'maxHealth' = 'attack'): Amount => ({ kind: 'stat', stat, coefficientBps, flatUnits: 0 });
export const damage = (coefficientBps: number, damageType: 'physical' | 'fire' | 'lightning' | 'poison' = 'physical', target: TargetSelector = intent, proc = false): Extract<EffectPrimitive, { kind: 'damage' }> => ({ kind: 'damage', target, condition: always, amount: scale(coefficientBps), damageType, tags: [damageType, ...(proc ? ['proc' as const] : [])], armorPenetrationBps: 0, attackRead: 'castSnapshot', defenseRead: 'hitLive', rounding: 'floor', canCritical: !proc });
export const apply = (statusId: string, count: number, durationTicks: number, target: TargetSelector = intent): EffectPrimitive => ({ kind: 'applyStatus', statusId, stacks: count, duration: ticks(durationTicks), target, condition: always });
export const consume = (statusId: string, maximumStacks: number, resultKey: string, target: TargetSelector = intent, minimumStacks = 1): EffectPrimitive => ({ kind: 'consumeStatus', statusId, maximumStacks, minimumStacks, resultKey, target, condition: always, sourceFilter: 'any' });
export const shield = (coefficientBps: number, durationTicks: number, target: TargetSelector = self): EffectPrimitive => ({ kind: 'shield', target, condition: always, amount: scale(coefficientBps, 'maxHealth'), lifecycleScope: 'encounter', duration: ticks(durationTicks), stackPolicy: 'independent', rounding: 'floor' });
export const heal = (coefficientBps: number, target: TargetSelector = intent): EffectPrimitive => ({ kind: 'heal', target, condition: always, amount: scale(coefficientBps), rounding: 'floor' });
export const restore = (units: number): EffectPrimitive => ({ kind: 'restoreResource', target: self, condition: always, resource: 'spirit', units });
export const augment = (tags: Extract<EffectPrimitive, { kind: 'augmentNextAction' }>['tags'], adjustment: ActionAdjustment, durationTicks = 160, uses = 1, target: TargetSelector = self): EffectPrimitive => ({ kind: 'augmentNextAction', target, condition: always, tags, adjustment, duration: ticks(durationTicks), uses });
export const modifier = (modifierId: string, stat: ModifierSpec['stat'], value: number, tags: ModifierSpec['tags'] = [], operation: ModifierSpec['operation'] = 'addPercentBps'): Extract<EffectPrimitive, { kind: 'installModifier' }> => ({ kind: 'installModifier', target: self, condition: always, modifier: { modifierId, stat, operation, value, tags, condition: always, priority: 0, lifecycleScope: 'character', duration: infinite } });
export const mechanics = (onInstall: readonly EffectPrimitive[] = [], triggers: readonly TriggerDefinition[] = [], actionRules: Mechanics['actionRules'] = []): Mechanics => ({ onInstall, triggers, actionRules });
export const rule = (ruleId: string, tags: Mechanics['actionRules'][number]['tags'], adjustment: ActionAdjustment, condition: Condition = always): Mechanics['actionRules'][number] => ({ ruleId, tags, adjustment, condition });
export const procPolicy = (family: string, internalCooldownTicks = 0, maximumActivations = 999): ProcPolicy => ({ family, allowIndirectFamilies: [], oncePerRoot: true, perTarget: false, internalCooldownTicks, maximumActivations, activationScope: 'encounter', maxDepth: 8, maxDerivedEffects: 64 });
export const trigger = (triggerId: string, event: CombatEventKind, condition: Condition, effects: readonly EffectPrimitive[], internalCooldownTicks = 0, maximumActivations = 999, eventScope: TriggerDefinition['eventScope'] = 'owner'): TriggerDefinition => ({ triggerId, event, eventScope, condition, effects, priority: 0, proc: procPolicy(triggerId, internalCooldownTicks, maximumActivations) });
export const enemyShield = all(flag('event.enemyCaused'), compare('event.actualShieldAbsorbed', 'gt', 0));
export const paidActive = all(flag('event.isActive'), compare('event.paidSpirit', 'gt', 0));
export const area = (team: 'ally' | 'enemy', radiusUnits: number, center: 'self' | 'intent' = 'self'): TargetSelector => ({ kind: 'area', team, center, radiusUnits, limit: 6 });
export function requiredCapabilities(m: Mechanics, effects: readonly EffectPrimitive[] = []): Capability[] {
  const found = new Set<Capability>();
  const visit = (items: readonly EffectPrimitive[]) => { for (const effect of items) { found.add(effect.kind); if (effect.kind === 'zone') visit(effect.effects); } };
  visit(effects); visit(m.onInstall); for (const t of m.triggers) visit(t.effects);
  if (m.actionRules.length) found.add('actionRules');
  return [...found].sort();
}
export function base(id: string, section: number, capabilities: readonly Capability[], parameters: DefinitionBase['descriptionParameters'] = {}): DefinitionBase {
  const advanced = capabilities.filter((capability) => ['move', 'zone', 'summon'].includes(capability));
  return {
    id, schemaVersion: 1, nameKey: `combat.${id}.name`, descriptionKey: `combat.${id}.description`, descriptionParameters: parameters,
    tags: [], presentationKey: `combat.${id}.presentation`, source: { designRef: `docs/engineering-plan/source/game-design.md#s${section}`, section },
    testScenarioIds: [`${id}.positive`, `${id}.invalidPrerequisite`, `${id}.cleanupRestore`], tuning: 'unbalanced-baseline',
    implementation: advanced.length ? 'blocked' : 'definition-only', blockedReasons: advanced.map((capability) => `${capability} executor conformance is not implemented or tested.`), requiredCapabilities: capabilities,
  };
}
