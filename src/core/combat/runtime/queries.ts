import type { CombatContentCatalog, CombatDefinition, CombatTag, Condition, EffectPrimitive, Mechanics, Stat, TargetSelector } from '../definitions/types';
import { checkedAdd, multiplyDivideFloor } from '../../kernel/numeric';
import { compareStable } from '../../kernel/serialization';
import { catalogDefinitions, findCombatDefinition } from './catalog';
import type { BattleEvent, BattleState, CombatStats, InstalledSource, Provenance, StatusInstance } from './types';

export interface EvaluationContext {
  holderId: string; targetId: string | null; intentId: string | null; boundHolderId: string;
  statusApplierId: string | null; event: BattleEvent | null; provenance: Provenance;
  sourceInstanceId: string | null; sourceDefinitionId: string | null; spatialAnchor?: { readonly x: number; readonly y: number }; spatialRadiusUnits?: number; attackSnapshot: CombatStats; results: Record<string, number>; statQuery?: Stat; excludeTeamSources?: boolean;
}
export const STAT_DEFAULTS: Record<Stat, number> = { attack: 0, maxHealth: 1, armor: 0, criticalChanceBps: 0, criticalMultiplierBps: 15_000, hasteBps: 0, damageReductionBps: 0, healingBps: 0, controlResistanceBps: 0, shieldBps: 0 };
export const STAT_LIMITS: Readonly<Record<Stat, readonly [number, number]>> = {
  attack: [0, 1_000_000_000], maxHealth: [1, 1_000_000_000], armor: [0, 1_000_000],
  criticalChanceBps: [0, 10_000], criticalMultiplierBps: [10_000, 100_000], hasteBps: [-9000, 100_000],
  damageReductionBps: [0, 9500], healingBps: [-10_000, 100_000], controlResistanceBps: [0, 10_000], shieldBps: [-10_000, 100_000],
};
export const definitions = catalogDefinitions;
export function definition(catalog: CombatContentCatalog, id: string): CombatDefinition { const d = findCombatDefinition(catalog, id); if (!d) throw new Error(`Unknown combat definition: ${id}`); return d; }
export function mechanics(catalog: CombatContentCatalog, source: Pick<InstalledSource, 'sourceDefinitionId'>): Mechanics | null { const d = definition(catalog, source.sourceDefinitionId); return 'mechanics' in d ? d.mechanics : null; }
export const tagsMatch = (required: readonly CombatTag[], actual: readonly CombatTag[]): boolean => required.every(tag => actual.includes(tag));
export const alive = (state: BattleState, id: string): boolean => { const entity = state.entities[id]; return !!entity && (entity.life === 'Alive' || entity.life === 'Recovered'); };
export function distanceSquared(state: BattleState, a: string, b: string): number {
  const left = state.entities[a]; const right = state.entities[b]; if (!left || !right) return Number.MAX_SAFE_INTEGER;
  const dx = left.position.x - right.position.x; const dy = left.position.y - right.position.y;
  const value = dx * dx + dy * dy; if (!Number.isSafeInteger(value)) throw new RangeError('Distance overflow'); return value;
}
export function within(state: BattleState, a: string, b: string, range: number): boolean { const sq = range * range; if (!Number.isSafeInteger(sq)) throw new RangeError('Range overflow'); return distanceSquared(state, a, b) <= sq; }
export function statusActive(state: BattleState, catalog: CombatContentCatalog, status: StatusInstance | BattleState['statuses'][number]): boolean {
  const d = definition(catalog, status.definitionId); if (d.kind !== 'status') return false;
  if (d.stackPolicy.kind !== 'strongest') return true;
  const competitors = state.statuses.filter(other => other.definitionId === status.definitionId && other.holderId === status.holderId && (d.identity === 'definition' || other.applierId === status.applierId));
  competitors.sort((a, b) => b.magnitude - a.magnitude || a.appliedTick - b.appliedTick || (state.sources[a.sourceInstanceId]?.createdSequence ?? 0) - (state.sources[b.sourceInstanceId]?.createdSequence ?? 0));
  return competitors[0]?.statusInstanceId === status.statusInstanceId;
}
export function sourceActive(state: BattleState, catalog: CombatContentCatalog, sourceId: string): boolean {
  const source = state.sources[sourceId]; if (!source) return false;
  if (source.executionKind === 'committed') return true;
  const status = source.statusInstanceId ? state.statuses.find(item => item.statusInstanceId === source.statusInstanceId) : null;
  if (status && !statusActive(state, catalog, status)) return false;
  const d = definition(catalog, source.sourceDefinitionId);
  if (d.kind === 'talent' && d.recipientBinding === 'selectedTalisman' && !alive(state, source.boundHolderId)) return false;
  if (d.kind === 'talent' && d.holderScope === 'team') {
    const team = state.entities[source.holderId]?.team;
    const score = (candidate: BattleState['sources'][string]): number => {
      const effects: readonly EffectPrimitive[] = [...d.mechanics.onInstall, ...d.mechanics.triggers.flatMap(trigger => trigger.effects)];
      return effects.reduce((sum, effect) => {
        let magnitude = 0;
        if (effect.kind === 'installModifier') magnitude = Math.abs(effect.modifier.value);
        if ('amount' in effect) { const amount = effect.amount; if (amount.kind === 'flat') magnitude = amount.units; else if (amount.kind === 'stat') magnitude = checkedAdd(multiplyDivideFloor(queryStat(state, catalog, candidate.holderId, amount.stat, [], true), amount.coefficientBps, 10_000), amount.flatUnits); else if (amount.kind === 'event') magnitude = multiplyDivideFloor(queryStat(state, catalog, candidate.holderId, amount.capStat, [], true), amount.capBps, 10_000); else magnitude = multiplyDivideFloor(queryStat(state, catalog, candidate.holderId, amount.stat, [], true), amount.coefficientPerStackBps, 10_000); }
        return checkedAdd(sum, magnitude);
      }, 0);
    };
    const candidates = Object.values(state.sources).filter(other => other.sourceDefinitionId === source.sourceDefinitionId && state.entities[other.holderId]?.team === team && alive(state, other.holderId) && (d.recipientBinding !== 'selectedTalisman' || alive(state, other.boundHolderId))).sort((a, b) => score(b) - score(a) || a.createdSequence - b.createdSequence);
    return candidates[0]?.sourceInstanceId === sourceId;
  }
  return true;
}
export function statusStacks(state: BattleState, catalog: CombatContentCatalog, holderId: string, statusId: string): number { return state.statuses.filter(s => s.holderId === holderId && s.definitionId === statusId && statusActive(state, catalog, s)).reduce((total, s) => checkedAdd(total, s.stacks), 0); }
export function activeShields(state: BattleState, holderId: string): BattleState['shields'][number][] {
  const eligible = state.shields.filter(s => s.holderId === holderId && s.remaining > 0 && !s.broken && (s.expiresAtTick === null || s.expiresAtTick > state.tick));
  return eligible.filter(shield => shield.stackPolicy !== 'strongest' || !eligible.some(other => other.stackPolicy === 'strongest' && other.sourceDefinitionId === shield.sourceDefinitionId && (other.initialAmount > shield.initialAmount || (other.initialAmount === shield.initialAmount && other.createdSequence < shield.createdSequence)))).sort((a, b) => a.createdSequence - b.createdSequence || compareStable(a.shieldInstanceId, b.shieldInstanceId));
}
export function shieldUnits(state: BattleState, holderId: string): number { return activeShields(state, holderId).reduce((sum, item) => checkedAdd(sum, item.remaining), 0); }
function compare(a: number, operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', b: number): boolean { switch (operator) { case 'eq': return a === b; case 'ne': return a !== b; case 'lt': return a < b; case 'lte': return a <= b; case 'gt': return a > b; case 'gte': return a >= b; } }
export function conditionPasses(state: BattleState, catalog: CombatContentCatalog, condition: Condition, context: EvaluationContext): boolean {
  const actor = state.entities[context.holderId]; const target = context.targetId ? state.entities[context.targetId] : null;
  switch (condition.kind) {
    case 'always': return true;
    case 'all': return condition.conditions.every(c => conditionPasses(state, catalog, c, context));
    case 'any': return condition.conditions.some(c => conditionPasses(state, catalog, c, context));
    case 'not': return !conditionPasses(state, catalog, condition.condition, context);
    case 'compare': {
      let value: number | undefined;
      switch (condition.field) {
        // A maximum-health condition uses base health only for its own circular query.
        case 'actor.healthBps': value = actor ? multiplyDivideFloor(actor.health, 10_000, context.statQuery === 'maxHealth' ? actor.baseStats.maxHealth : queryStat(state, catalog, actor.id, 'maxHealth', [], context.excludeTeamSources)) : undefined; break;
        case 'target.healthBps': value = target ? multiplyDivideFloor(target.health, 10_000, context.statQuery === 'maxHealth' ? target.baseStats.maxHealth : queryStat(state, catalog, target.id, 'maxHealth', [], context.excludeTeamSources)) : undefined; break;
        case 'actor.shieldUnits': value = actor ? shieldUnits(state, actor.id) : undefined; break;
        default: value = context.event?.values[condition.field.slice(6) as keyof BattleEvent['values']];
      }
      return value !== undefined && compare(value, condition.operator, condition.value);
    }
    case 'flag': {
      const event = context.event; if (!event) return false;
      let value = event.flags[condition.field.slice(6) as keyof BattleEvent['flags']];
      if (condition.field === 'event.ownedStatus' && event.kind === 'status.consumed') value = event.consumedApplierIds.includes(context.holderId);
      if (condition.field === 'event.differentCaster' && event.kind === 'status.consumed') value = event.actorId !== context.holderId;
      return value !== undefined && value === condition.value;
    }
    case 'consumedStatus': return context.event?.kind === 'status.consumed' && context.event.statusId === condition.statusId && (context.event.values.consumedStacks ?? 0) > 0;
    case 'hasStatus': {
      const id = condition.subject === 'actor' ? context.holderId : condition.subject === 'target' ? context.targetId : context.provenance.originalActorId;
      return id !== null && statusStacks(state, catalog, id, condition.statusId) >= condition.minimumStacks;
    }
    case 'hasTag': {
      if (condition.subject === 'eventSource') return context.provenance.originalTags.includes(condition.tag);
      const id = condition.subject === 'actor' ? context.holderId : context.targetId;
      return id !== null && state.statuses.some(status => status.holderId === id && statusActive(state, catalog, status) && definition(catalog, status.definitionId).tags.includes(condition.tag));
    }
  }
}
export function emptyContext(state: BattleState, holderId: string, tags: readonly CombatTag[] = []): EvaluationContext {
  const entity = state.entities[holderId]; if (!entity) throw new Error(`Unknown entity: ${holderId}`);
  return { holderId, targetId: null, intentId: null, boundHolderId: holderId, statusApplierId: null, event: null, provenance: { rootActionId: 'query', parentId: null, depth: 0, family: null, direct: true, originalTags: tags, originalActorId: holderId, school: null }, sourceInstanceId: null, sourceDefinitionId: null, attackSnapshot: entity.baseStats, results: {} };
}
export function queryStat(state: BattleState, catalog: CombatContentCatalog, entityId: string, stat: Stat, tags: readonly CombatTag[] = [], excludeTeamSources = false): number {
  const entity = state.entities[entityId]; if (!entity) throw new Error(`Unknown entity: ${entityId}`);
  const contributions = state.modifiers.filter(entry => entry.holderId === entityId && entry.modifier.stat === stat && (!excludeTeamSources || (() => { const source = state.sources[entry.sourceInstanceId]; if (!source) return false; const d = definition(catalog, source.sourceDefinitionId); return d.kind !== 'talent' || d.holderScope !== 'team'; })()) && sourceActive(state, catalog, entry.sourceInstanceId) && (entry.expiresAtTick === null || entry.expiresAtTick > state.tick) && tagsMatch(entry.modifier.tags, tags) && conditionPasses(state, catalog, entry.modifier.condition, { ...emptyContext(state, entityId, tags), statQuery: stat, excludeTeamSources })).sort((a, b) => a.modifier.priority - b.modifier.priority || compareStable(a.sourceInstanceId, b.sourceInstanceId) || compareStable(a.modifier.modifierId, b.modifier.modifierId));
  let base = entity.baseStats[stat]; let percent = 10_000; let minimum = STAT_LIMITS[stat][0]; let maximum = STAT_LIMITS[stat][1];
  const multipliers: number[] = [];
  for (const entry of contributions) {
    const status = state.statuses.find(item => item.sourceInstanceId === entry.sourceInstanceId);
    const value = entry.modifier.value * (status?.stacks ?? 1); if (!Number.isSafeInteger(value)) throw new RangeError('Modifier overflow');
    switch (entry.modifier.operation) {
      case 'addFlat': base = checkedAdd(base, value); break;
      case 'addPercentBps': percent = checkedAdd(percent, value); break;
      case 'multiplyBps': multipliers.push(checkedAdd(10_000, (entry.modifier.value - 10_000) * (status?.stacks ?? 1))); break;
      case 'minimum': minimum = Math.max(minimum, value); break;
      case 'maximum': maximum = Math.min(maximum, value); break;
    }
  }
  let numerator = base * Math.max(0, percent); let denominator = 10_000;
  if (!Number.isSafeInteger(numerator)) throw new RangeError('Stat product overflow');
  for (const multiplier of multipliers) { numerator *= Math.max(0, multiplier); denominator *= 10_000; if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new RangeError('Stat product overflow'); }
  const result = Math.floor(numerator / denominator);
  return Math.max(STAT_LIMITS[stat][0], Math.min(STAT_LIMITS[stat][1], maximum, Math.max(minimum, result)));
}
export function snapshotStats(state: BattleState, catalog: CombatContentCatalog, entityId: string, tags: readonly CombatTag[]): CombatStats { return Object.fromEntries((Object.keys(STAT_DEFAULTS) as Stat[]).map(stat => [stat, queryStat(state, catalog, entityId, stat, tags)])) as Record<Stat, number>; }
export function selectTargets(state: BattleState, catalog: CombatContentCatalog, selector: TargetSelector, context: EvaluationContext, includeDowned = false): string[] {
  const holder = state.entities[context.holderId]; if (!holder) return [];
  const valid = (id: string | null | undefined): id is string => !!id && (alive(state, id) || (includeDowned && state.entities[id]?.life === 'Downed'));
  const teamMatches = (id: string, team: 'ally' | 'enemy') => (state.entities[id]?.team === holder.team) === (team === 'ally');
  const candidates = Object.keys(state.entities).filter(valid).sort(compareStable);
  const singleton = (id: string | null | undefined) => valid(id) ? [id] : [];
  switch (selector.kind) {
    case 'self': return singleton(context.holderId);
    case 'intent': return singleton(context.intentId);
    case 'eventTarget': return singleton(context.event?.targetId);
    case 'eventActor': return singleton(context.event?.actorId);
    case 'statusSource': return singleton(context.statusApplierId);
    case 'boundHolder': return singleton(context.boundHolderId);
    case 'focus': return singleton(state.focusByTeam[holder.team]);
    case 'lowestHealth': return candidates.filter(id => teamMatches(id, selector.team) && (!selector.excludeSelf || id !== holder.id) && within(state, holder.id, id, selector.maxRangeUnits)).sort((a, b) => {
      const left = state.entities[a]!; const right = state.entities[b]!;
      const delta = left.health * queryStat(state, catalog, b, 'maxHealth') - right.health * queryStat(state, catalog, a, 'maxHealth');
      if (!Number.isSafeInteger(delta)) throw new RangeError('Health ratio overflow'); return delta || compareStable(a, b);
    }).slice(0, 1);
    case 'area': { const center = context.spatialAnchor ?? state.entities[selector.center === 'self' ? holder.id : context.intentId ?? '']?.position; return center ? candidates.filter(id => { const p = state.entities[id]!.position; return teamMatches(id, selector.team) && (p.x - center.x) ** 2 + (p.y - center.y) ** 2 <= selector.radiusUnits ** 2; }).slice(0, selector.limit) : []; }
    case 'chain': {
      const start = selector.start === 'intent' ? context.intentId : context.event?.targetId;
      if (!valid(start) || !teamMatches(start, selector.team)) return [];
      const selected = [start];
      for (let count = 0; count < selector.jumps; count++) { const previous = selected[selected.length - 1]!; const next = candidates.filter(id => !selected.includes(id) && teamMatches(id, selector.team) && within(state, previous, id, selector.maxRangeUnits)).sort((a, b) => distanceSquared(state, previous, a) - distanceSquared(state, previous, b) || compareStable(a, b))[0]; if (!next) break; selected.push(next); }
      return selected;
    }
  }
}
