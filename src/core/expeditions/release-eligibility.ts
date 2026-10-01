/** Experimental, opt-in admission only. Never imported by the v1/v2 offer or replay path. */
import type { ActionAdjustment, CombatDefinition, CombatEventKind, CombatTag, Condition, EffectPrimitive,
  Mechanics, School, SkillDefinition, TalentDefinition, TargetSelector, TriggerDefinition } from '../combat/definitions/types';
import { catalogFingerprint } from '../combat/runtime/catalog';
import { adjustedActionCost } from '../combat/runtime/castReadiness';
import { combatDefinitionSupport } from '../combat/runtime/engine';
import { compareStable, stableHash } from '../kernel/serialization';
import { FALLBACK_SUPPLIES, freeze } from './shared';
import type { Candidate, ExpeditionCatalog, ExpeditionState, Immutable } from './types';

export const RELEASE_ELIGIBILITY_RULES_ID = 'release-eligibility-candidate.1';
/** These are potential opportunities in the next encounter, not the initial HP/status snapshot.
 * Only the authoritative adapter may construct them, from its catalog, arena and locked loadout.
 * Distances are achievable pair distances; an omitted pair is unreachable, not distance zero.
 * A pair must describe a mutually achievable encounter opportunity, not disconnected arenas. */
export interface ReleaseEligibilityContext {
  readonly identity: { readonly rulesId: typeof RELEASE_ELIGIBILITY_RULES_ID; readonly catalogHash: string;
    readonly inputHash: string; readonly encounterId: string; readonly encounterRulesId: string; readonly arenaId: string };
  readonly horizonTicks: number;
  readonly enemies: readonly { readonly id: string; readonly controlResistanceBps: number }[];
  readonly members: readonly { readonly discipleId: string; readonly guardAllowed: boolean;
    readonly defeatRule: 'downed' | 'immediate'; readonly directDamageEnemyIds: readonly string[];
    readonly controlEnemyIds: readonly string[]; readonly decoyPlacementPossible: boolean }[];
  readonly reachablePairs: readonly { readonly firstId: string; readonly secondId: string; readonly distanceUnits: number }[];
  readonly focusEnemyIds: readonly string[];
  /** Runtime highest-value/shared-budget source holder, including effective stats and install-order ties.
   * Required for every team definition that can be installed. selectedTalisman has no
   * anchor when no living equipped talisman-skill recipient exists; only that card fails. */
  readonly teamSourceHolders: readonly { readonly definitionId: string; readonly discipleId: string }[];
}
export type ReleaseEligibilityReason = 'MISSING_CONTEXT' | 'CONTEXT_IDENTITY_MISMATCH' | 'INVALID_CONTEXT'
  | 'MISSING_MEMBER_FACTS' | 'INVALID_LOADOUT' | 'UNSUPPORTED_SOURCE' | 'INACTIVE_BOUND_RECIPIENT'
  | 'UNSUPPORTED_DEFINITION' | 'UNSUPPORTED_EXTRA_TARGET_STAGGER' | 'UNRECOGNIZED_RULE'
  | 'MAXIMUM_RANK' | 'MISSING_PREREQUISITE' | 'EXCLUDED' | 'NO_LIVING_RECIPIENT'
  | 'MISSING_PAID_SWORD_ACTIVE' | 'MISSING_OWN_MARK_APPLICATION' | 'MISSING_PAID_SHIELD_CASTER'
  | 'MISSING_REACHABLE_MARK_SPEND' | 'MISSING_REACHABLE_MARK' | 'MISSING_REACHABLE_STAGGER'
  | 'MISSING_REACHABLE_SHOCK' | 'MISSING_OWN_POISON' | 'MISSING_OTHER_POISON_CONSUMER'
  | 'MISSING_PAID_CLEANSE' | 'MISSING_PAID_HEAL' | 'MISSING_DIRECT_HEAL' | 'MISSING_MEDICINE'
  | 'MISSING_REACHABLE_POISON_SPEND' | 'MISSING_REACHABLE_POISON' | 'MISSING_REACHABLE_SHIELD'
  | 'MISSING_HOSTILE_DAMAGE' | 'GUARD_UNAVAILABLE' | 'FOCUS_UNAVAILABLE' | 'MISSING_DOWNED_ALLY'
  | 'MISSING_FORCE_PRODUCER' | 'MISSING_FORCE_RELEASE' | 'MISSING_OTHER_ALLY' | 'MISSING_CONTROL_OPPORTUNITY'
  | 'MISSING_PAID_TALISMAN_ACTIVE' | 'MISSING_RUNE_PRODUCER' | 'MISSING_RUNE_DIRECTION'
  | 'RESOURCE_PREEMPTED'
  | 'MISSING_DISTINCT_CASTERS' | 'MISSING_DISTINCT_SCHOOLS' | 'DECOY_PLACEMENT_UNAVAILABLE'
  | 'NO_REACHABLE_TRIGGER' | 'GRAPH_LIMIT_EXCEEDED' | 'FOLLOWUP_REQUIRED'
  | 'INSUFFICIENT_LEGAL_CARDS' | 'SUPPLY_FALLBACK_AVAILABLE';
export interface ReleaseEligibilityDiagnostic {
  readonly code: ReleaseEligibilityReason;
  readonly definitionId: string | null;
  readonly holderId: string | null;
  readonly detail: string;
}
export interface ReleaseEligibilityResult {
  readonly rulesId: typeof RELEASE_ELIGIBILITY_RULES_ID;
  readonly candidates: Immutable<Candidate[]>;
  readonly diagnostics: readonly ReleaseEligibilityDiagnostic[];
  readonly followupRequired: readonly { readonly definitionId: string; readonly holderId: string; readonly consumerDefinitionIds: readonly string[] }[];
  /** A descriptor only. Taking supplies still needs the authoritative reward transaction. */
  readonly supplyFallback: { readonly available: true; readonly supplies: typeof FALLBACK_SUPPLIES; readonly grantsReward: false };
  readonly missingChoiceCount: number;
}
/** Binds the context to current casualties, loadouts and explicit bindings, not just the origin. */
export function releaseEligibilityInputHash(state: ExpeditionState): string {
  // Installation order is meaningful for equal-value team-source ties and queued payments.
  return stableHash({ runId: state.runId, members: state.members, talents: state.talentInstances, contentMode: state.origin.contentMode });
}

type Active = Extract<SkillDefinition, { activation: 'active' }>;
type Member = ExpeditionState['members'][number];
interface Source { key: string; owner: string; bound: string; definition: CombatDefinition & { mechanics: Mechanics } }
interface Opportunity {
  key: string; kind: CombatEventKind; actor: string; target: string; school: School | null; tags: readonly CombatTag[];
  direct: boolean; family: string | null; sourceId: string; paid: number; interval: number; uses: number; ready: number;
  statusId: string | null; stacks: number; appliers: readonly string[];
  payment: Readonly<Record<string, number>>;
  depth: number;
}
interface StatusFact { key: string; producer: string; id: string; target: string; applier: string; stacks: number; perApplication: number;
  payment: Readonly<Record<string, number>>; interval: number; uses: number; ready: number }
interface ShieldFact { key: string; target: string; owner: string; interval: number; uses: number; ready: number }
interface AugmentFact { key: string; owner: string; tags: readonly CombatTag[]; adjustment: ActionAdjustment }
interface Graph {
  events: Map<string, Opportunity>; statuses: Map<string, StatusFact>; shields: Map<string, ShieldFact>;
  force: Set<string>; augments: Map<string, AugmentFact>; reached: Set<string>; limited: boolean;
}
const MARK = 'status.sword-mark', POISON = 'status.poison', RUNE = 'status.rune', MEDICINE = 'status.medicine';
const MAX_FACTS = 16_384, MAX_PASSES = 64;
const emptyGraph = (): Graph => ({ events: new Map(), statuses: new Map(), shields: new Map(), force: new Set(), augments: new Map(), reached: new Set(), limited: false });
const numeric = (value: number, min = 0, max = 100_000): boolean => Number.isSafeInteger(value) && value >= min && value <= max;
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
function compare(left: number, operator: Extract<Condition, { kind: 'compare' }>['operator'], right: number): boolean {
  switch (operator) { case 'eq': return left === right; case 'ne': return left !== right; case 'lt': return left < right;
    case 'lte': return left <= right; case 'gt': return left > right; case 'gte': return left >= right; }
}
function contains(condition: Condition, predicate: (part: Condition) => boolean): boolean {
  return predicate(condition) || ((condition.kind === 'all' || condition.kind === 'any') && condition.conditions.some(part => contains(part, predicate)))
    || (condition.kind === 'not' && contains(condition.condition, predicate));
}

class Analysis {
  readonly members: Member[];
  readonly sources: Source[] = [];
  readonly skills = new Map<string, Active[]>();
  readonly sourceIds = new Map<string, Set<string>>();
  readonly diagnostics: ReleaseEligibilityDiagnostic[] = [];
  readonly facts: ReleaseEligibilityContext['members'];
  readonly distances = new Map<string, number>();
  readonly graph: Graph;
  constructor(readonly state: ExpeditionState, readonly catalog: ExpeditionCatalog, readonly context: ReleaseEligibilityContext) {
    this.members = state.members.filter(member => member.alive && member.permanentDeathId === null).sort((a, b) => compareStable(a.discipleId, b.discipleId));
    this.facts = context.members;
    for (const pair of context.reachablePairs) {
      this.distances.set(`${pair.firstId}|${pair.secondId}`, pair.distanceUnits);
      this.distances.set(`${pair.secondId}|${pair.firstId}`, pair.distanceUnits);
    }
    this.collectSources(); this.graph = this.buildGraph(this.sources);
  }
  note(code: ReleaseEligibilityReason, detail: string, definitionId: string | null = null, holderId: string | null = null): void {
    this.diagnostics.push({ code, detail, definitionId, holderId });
  }
  member(id: string): Member | undefined { return this.members.find(member => member.discipleId === id); }
  fact(id: string) { return this.facts.find(fact => fact.discipleId === id)!; }
  near(first: string, second: string, range: number): boolean { return first === second || (this.distances.get(`${first}|${second}`) ?? Infinity) <= range; }
  enemy(id: string): boolean { return this.context.enemies.some(enemy => enemy.id === id); }
  supported(id: string): boolean { return combatDefinitionSupport(this.catalog, id, this.state.origin.contentMode).supported; }
  teamOwner(id: string): string | undefined { return this.context.teamSourceHolders.find(source => source.definitionId === id)?.discipleId; }
  collectSources(): void {
    const definitions = new Map([...this.catalog.skills, ...this.catalog.treeNodes, ...this.catalog.talents].map(definition => [definition.id, definition]));
    for (const member of this.members) {
      const ids = new Set<string>(); this.sourceIds.set(member.discipleId, ids);
      const active = member.loadout.activeSkillIds.map(id => definitions.get(id));
      const passive = definitions.get(member.loadout.passiveSkillId);
      const nodes = member.loadout.characterSourceIds.map(id => definitions.get(id));
      const school = member.loadout.basic.school;
      if (active.length !== 2 || !unique(member.loadout.activeSkillIds) || active.some(definition => definition?.kind !== 'skill' || definition.activation !== 'active' || definition.school !== school)
        || passive?.kind !== 'skill' || passive.activation !== 'passive' || passive.school !== school
        || nodes.length > 5 || !unique(member.loadout.characterSourceIds)
        || nodes.some(node => node?.kind !== 'treeNode' || node.school !== school || node.prerequisites.some(id => !member.loadout.characterSourceIds.includes(id))
          || node.excludes.some(id => member.loadout.characterSourceIds.includes(id)))) {
        this.note('INVALID_LOADOUT', 'Expected two distinct equipped actives, one same-school passive, and a valid five-point tree', null, member.discipleId);
        this.skills.set(member.discipleId, []); continue;
      }
      const add = (definition: Source['definition'], key = definition.id, bound = member.discipleId): void => {
        if (!this.supported(definition.id)) { this.note('UNSUPPORTED_SOURCE', 'Source cannot execute in the selected combat mode', definition.id, member.discipleId); return; }
        ids.add(definition.id); this.sources.push({ key: `${member.discipleId}/${key}`, owner: member.discipleId, bound, definition });
      };
      for (const definition of [...active, passive]) if (definition && 'mechanics' in definition) add(definition);
      // A forged cyclic tree cannot establish its own prerequisites.
      for (let pass = 0; pass < 5; pass += 1) for (const node of nodes) {
        if (node?.kind === 'treeNode' && !ids.has(node.id) && node.prerequisites.every(id => ids.has(id))) add(node);
      }
      this.skills.set(member.discipleId, active.filter((definition): definition is Active => definition?.kind === 'skill' && definition.activation === 'active' && ids.has(definition.id)).sort((a, b) => compareStable(a.id, b.id)));
    }
    const living = new Set(this.members.map(member => member.discipleId));
    const pending = [...this.state.talentInstances].sort((a, b) => a.acquiredRewardOrdinal - b.acquiredRewardOrdinal || compareStable(a.instanceId, b.instanceId));
    const visited = new Set<string>();
    for (let pass = 0; pass <= this.catalog.talents.length; pass += 1) for (const instance of pending) {
      if (visited.has(instance.instanceId)) continue;
      const definition = definitions.get(instance.definitionId);
      if (definition?.kind !== 'talent' || !this.supported(definition.id) || instance.holderScope !== definition.holderScope || instance.rank < 1 || instance.rank > definition.maximumRank) { visited.add(instance.instanceId); continue; }
      if (definition.recipientBinding === 'selectedTalisman' && (!instance.boundHolderId || !living.has(instance.boundHolderId)
        || !this.skills.get(instance.boundHolderId)?.some(skill => skill.school === 'talisman'))) {
        this.note('INACTIVE_BOUND_RECIPIENT', `Retained ${instance.instanceId}; an explicit legal rebind is required`, definition.id, instance.boundHolderId); visited.add(instance.instanceId); continue;
      }
      const prerequisites = instance.holderScope === 'team' ? new Set([...this.sourceIds.values()].flatMap(ids => [...ids])) : this.sourceIds.get(instance.holderId ?? '') ?? new Set<string>();
      if (!definition.prerequisites.every(id => prerequisites.has(id))) continue;
      visited.add(instance.instanceId);
      for (const member of this.members) {
        if (instance.holderScope === 'personal' && instance.holderId !== member.discipleId) continue;
        const owner = member.discipleId;
        this.sourceIds.get(owner)!.add(definition.id);
        if (instance.holderScope === 'team' && this.teamOwner(definition.id) !== owner) continue;
        this.sources.push({ key: `${owner}/${instance.instanceId}`, owner, bound: instance.boundHolderId ?? owner, definition });
      }
    }
    for (const instance of pending) if (!visited.has(instance.instanceId)) this.note('MISSING_PREREQUISITE', 'Owned source has no rooted effective prerequisite chain', instance.definitionId, instance.holderId);
  }
  targets(selector: TargetSelector, owner: string, event: Opportunity | null, bound: string): string[] {
    const allies = this.members.map(member => member.discipleId), enemies = this.context.enemies.map(enemy => enemy.id).sort(compareStable);
    switch (selector.kind) {
      case 'self': return [owner]; case 'boundHolder': return this.member(bound) ? [bound] : [];
      case 'intent': case 'eventTarget': return event ? [event.target] : [];
      case 'eventActor': return event ? [event.actor] : [];
      case 'statusSource': return event ? [...event.appliers] : [];
      case 'focus': return [...this.context.focusEnemyIds].sort(compareStable);
      case 'lowestHealth': return (selector.team === 'ally' ? allies : enemies).filter(id => (!selector.excludeSelf || id !== owner) && this.near(owner, id, selector.maxRangeUnits));
      case 'area': { const center = selector.center === 'self' ? owner : event?.target;
        return center ? (selector.team === 'ally' ? allies : enemies).filter(id => this.near(center, id, selector.radiusUnits)).slice(0, selector.limit) : []; }
      case 'chain': { const first = event?.target; if (!first || (selector.team === 'enemy') !== this.enemy(first)) return [];
        // The primary recipient is sufficient for capability proof; no unimplemented extra-target control is inferred.
        return [first]; }
    }
  }
  status(graph: Graph, id: string, target: string, applier?: string): number {
    const rows = [...graph.statuses.values()].filter(fact => fact.id === id && fact.target === target && (applier === undefined || fact.applier === applier));
    const byProducer = new Map<string, number>();
    for (const row of rows) byProducer.set(row.producer, Math.max(byProducer.get(row.producer) ?? 0, row.stacks));
    const definition = this.catalog.statuses.find(status => status.id === id);
    const byApplier = new Map<string, number>();
    for (const [producer, stacks] of byProducer) {
      const applierId = rows.find(row => row.producer === producer)!.applier;
      byApplier.set(applierId, (byApplier.get(applierId) ?? 0) + stacks);
    }
    const maximum = definition?.stackPolicy.maximumStacks ?? 0;
    const total = [...byApplier.values()].reduce((sum, value) => sum + Math.min(maximum, value), 0);
    return definition?.identity === 'definition' ? Math.min(maximum, total) : total;
  }
  plus(...payments: readonly Readonly<Record<string, number>>[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const payment of payments) for (const [owner, amount] of Object.entries(payment)) result[owner] = (result[owner] ?? 0) + amount;
    return result;
  }
  affordable(payment: Readonly<Record<string, number>>): boolean {
    return Object.entries(payment).every(([owner, amount]) => amount <= (this.member(owner)?.spirit ?? 0));
  }
  statusPayment(graph: Graph, id: string, target: string, count: number, applier?: string): Record<string, number> | null {
    const providers = [...graph.statuses.values()].filter(fact => fact.id === id && fact.target === target && fact.stacks > 0 && (applier === undefined || fact.applier === applier))
      .sort((a, b) => Object.values(a.payment).reduce((sum, value) => sum + value, 0) / a.perApplication - Object.values(b.payment).reduce((sum, value) => sum + value, 0) / b.perApplication || compareStable(a.key, b.key));
    let remaining = count; const used = new Set<string>(), result: Record<string, number> = {};
    for (const provider of providers) {
      if (used.has(provider.producer)) continue; used.add(provider.producer);
      const take = Math.min(remaining, provider.stacks), repeats = Math.ceil(take / provider.perApplication);
      for (const [owner, units] of Object.entries(provider.payment)) result[owner] = (result[owner] ?? 0) + units * repeats;
      remaining -= take; if (!remaining) return this.affordable(result) ? result : null;
    }
    return null;
  }
  conditionPayment(condition: Condition, owner: string, event: Opportunity, graph: Graph): Record<string, number> | null {
    if (condition.kind === 'hasStatus') return this.statusPayment(graph, condition.statusId, condition.subject === 'actor' ? owner : event.target, condition.minimumStacks);
    if (condition.kind === 'all') {
      const payments = condition.conditions.map(part => this.conditionPayment(part, owner, event, graph));
      return payments.some(payment => payment === null) ? null : this.plus(...payments as Record<string, number>[]);
    }
    if (condition.kind === 'any') {
      for (const part of condition.conditions) if (this.test(part, owner, event, graph)) {
        const payment = this.conditionPayment(part, owner, event, graph); if (payment && this.affordable(this.plus(event.payment, payment))) return payment;
      }
      return null;
    }
    return {};
  }
  paid(graph: Graph, owner?: string): Opportunity[] {
    return [...graph.events.values()].filter(event => event.kind === 'action.committed' && event.direct && event.paid > 0 && (owner === undefined || event.actor === owner));
  }
  test(condition: Condition, owner: string, event: Opportunity | null, graph: Graph): boolean {
    switch (condition.kind) {
      case 'always': return true;
      case 'all': return condition.conditions.every(part => this.test(part, owner, event, graph));
      case 'any': return condition.conditions.some(part => this.test(part, owner, event, graph));
      case 'not': return condition.condition.kind === 'hasStatus' || condition.condition.kind === 'flag'
        ? condition.condition.kind === 'hasStatus' || !this.test(condition.condition, owner, event, graph) : false;
      case 'hasStatus': return this.status(graph, condition.statusId, condition.subject === 'actor' ? owner : event?.target ?? '') >= condition.minimumStacks;
      case 'consumedStatus': return event?.statusId === condition.statusId && event.stacks > 0;
      case 'hasTag': return condition.subject === 'eventSource' ? !!event?.tags.includes(condition.tag)
        : condition.subject === 'actor' ? condition.tag === this.member(owner)?.loadout.basic.school : false;
      case 'flag': {
        let value = false;
        switch (condition.field) {
          case 'event.isBasic': value = !!event?.tags.includes('basic'); break;
          case 'event.isActive': value = !!event?.tags.includes('active'); break;
          case 'event.targetAlive': value = !!event; break;
          case 'event.ownedStatus': value = !!event?.appliers.includes(owner); break;
          case 'event.enemyCaused': value = !!event && this.enemy(event.actor); break;
          case 'event.differentCaster': value = !!event && (event.kind === 'status.consumed' ? event.actor !== owner : this.paid(graph).some(other => other.actor !== event.actor)); break;
          case 'event.differentSchool': value = !!event && this.paid(graph).some(other => other.school !== event.school); break;
          case 'event.isCritical': value = false; break;
        }
        return value === condition.value;
      }
      case 'compare': {
        let values: number[] = [];
        switch (condition.field) {
          case 'actor.healthBps': case 'target.healthBps': values = [1, 5000, 5001, 10000, condition.value].filter(value => value > 0 && value <= 10000); break;
          case 'actor.shieldUnits': values = [...graph.shields.values()].some(shield => shield.target === owner) ? [1, 10000] : [0]; break;
          case 'event.paidSpirit': values = [event?.paid ?? 0]; break;
          case 'event.consumedStacks': values = [event?.stacks ?? 0]; break;
          case 'event.distinctCasterCount': values = [new Set(this.paid(graph).map(cast => cast.actor)).size]; break;
          case 'event.distinctSchoolCount': values = [new Set(this.paid(graph).map(cast => cast.school)).size]; break;
          case 'event.idleTicks': values = [this.context.horizonTicks]; break;
          case 'event.actualShieldAbsorbed': values = event?.kind === 'shield.absorbed' || event?.kind === 'shield.broken' ? [1, 10000] : [0]; break;
          case 'event.actualHealthLoss': values = event?.kind === 'damage.healthLost' ? [1, 10000] : [0]; break;
          case 'event.effectiveHealing': case 'event.overhealing': values = event?.kind === 'healing.resolved' ? [0, 1, 10000] : [0]; break;
        }
        return values.some(value => compare(value, condition.operator, condition.value));
      }
    }
  }
  scope(trigger: TriggerDefinition, source: Source, event: Opportunity): boolean {
    if (event.kind !== trigger.event || event.depth + 1 > Math.min(8, trigger.proc.maxDepth) || trigger.proc.maximumActivations < 1
      || (!event.direct && (!trigger.proc.allowIndirectFamilies.includes(event.family ?? '') || trigger.proc.family === event.family))) return false;
    const defensive = ['shield.absorbed', 'shield.broken', 'control.ended', 'life.beforeDowned', 'life.downed'].includes(event.kind);
    const relevant = defensive ? event.target : event.actor;
    return trigger.eventScope === 'owner' ? relevant === source.owner : !!this.member(relevant);
  }
  adjustments(owner: string, tags: readonly CombatTag[], event: Opportunity, graph: Graph): ActionAdjustment[] {
    const result: ActionAdjustment[] = [];
    for (const source of this.sources.filter(source => source.owner === owner)) for (const rule of source.definition.mechanics.actionRules) {
      if (rule.tags.every(tag => tags.includes(tag)) && this.test(rule.condition, owner, event, graph)) result.push(rule.adjustment);
    }
    for (const augment of graph.augments.values()) if (augment.owner === owner && augment.tags.every(tag => tags.includes(tag))) result.push(augment.adjustment);
    return result;
  }
  putEvent(graph: Graph, event: Opportunity): void {
    const prior = graph.events.get(event.key);
    if (!prior || event.stacks > prior.stacks || event.uses > prior.uses || event.interval < prior.interval || event.ready < prior.ready) graph.events.set(event.key, event);
  }
  apply(effects: readonly EffectPrimitive[], source: Source, event: Opportunity | null, graph: Graph,
    family: string | null, direct: boolean, interval: number, uses: number, ready: number, prefix: string): void {
    if (ready > this.context.horizonTicks || uses < 1) return;
    effects.forEach((effect, index) => {
      if (!this.test(effect.condition, source.owner, event, graph)) return;
      const targets = this.targets(effect.target, source.owner, event, source.bound);
      for (const target of targets) {
        // Same target-team floor as runtime targetAllowed; labels cannot turn an enemy heal into an allied producer.
        if (['heal', 'shield', 'rescue', 'restoreResource', 'preventDowned', 'augmentNextAction', 'storeForce'].includes(effect.kind) && !this.member(target)) continue;
        if (['releaseForce', 'interrupt'].includes(effect.kind) && !this.enemy(target)) continue;
        const key = `${source.key}/${prefix}/${index}/${target}`;
        const parent: Opportunity = { key, kind: 'action.committed', actor: source.owner, target, school: event?.school ?? null,
          tags: event?.tags ?? [], direct, family, sourceId: source.definition.id, paid: event?.paid ?? 0, interval, uses, ready, statusId: null, stacks: 0, appliers: [], payment: event?.payment ?? {}, depth: direct ? 0 : (event?.depth ?? 0) + 1 };
        const adjustments = direct && event ? this.adjustments(source.owner, event.tags, event, graph) : [];
        switch (effect.kind) {
          case 'applyStatus': {
            const definition = this.catalog.statuses.find(status => status.id === effect.statusId); if (!definition || effect.stacks <= 0) break;
            const resistance = this.context.enemies.find(enemy => enemy.id === target)?.controlResistanceBps ?? this.member(target)?.loadout.stats.controlResistanceBps ?? 0;
            let duration = effect.duration.kind === 'ticks' ? effect.duration.ticks : this.context.horizonTicks;
            duration += adjustments.reduce((sum, adjustment) => sum + (adjustment.kind === 'statusDurationTicks' ? adjustment.value : 0), 0);
            if (definition.resistancePolicy === 'targetTenacity') duration = Math.floor(duration * (10000 - resistance) / 10000);
            if (duration <= 0) break;
            const stacks = effect.stacks + adjustments.reduce((sum, adjustment) => sum + (adjustment.kind === 'statusStacks' && adjustment.statusId === effect.statusId ? adjustment.value : 0), 0);
            // A producer conditional on absence cannot repeatedly stack its own output.
            const absentGate = event && source.definition.mechanics.triggers.some(trigger => trigger.proc.family === family
              && contains(trigger.condition, part => part.kind === 'not' && part.condition.kind === 'hasStatus' && part.condition.statusId === effect.statusId));
            const repetitions = !absentGate && interval < duration ? Math.min(uses, 1 + Math.floor(Math.max(0, this.context.horizonTicks - ready) / Math.max(1, interval))) : 1;
            const budgetRepeats = Math.min(repetitions, ...Object.entries(parent.payment).map(([owner, cost]) => cost > 0 ? Math.floor((this.member(owner)?.spirit ?? 0) / cost) : repetitions));
            const capacity = Math.min(definition.stackPolicy.maximumStacks, Math.max(0, stacks) * budgetRepeats);
            const prior = graph.statuses.get(key);
            const producer = `${source.key}/${prefix.startsWith('trigger/') ? prefix.split('/').slice(0, 2).join('/') : prefix}/${index}/${target}`;
            if (!prior || capacity > prior.stacks || ready < prior.ready) graph.statuses.set(key, { key, producer, id: effect.statusId, target, applier: source.owner, stacks: capacity, perApplication: Math.max(1, stacks), payment: parent.payment, interval, uses, ready });
            if (definition.dispelCategory === 'control' && this.member(target)) this.putEvent(graph, { ...parent, key: `${key}/ended`, kind: 'control.ended', actor: source.owner, direct: false, family: 'status-expiry', ready: ready + duration });
            break;
          }
          case 'consumeStatus': {
            const available = this.status(graph, effect.statusId, target, effect.sourceFilter === 'self' ? source.owner : undefined);
            if (available < effect.minimumStacks || available === 0) break;
            let count = Math.min(available, effect.maximumStacks), payment: Record<string, number> | null = null;
            for (; count >= Math.max(1, effect.minimumStacks); count -= 1) {
              const resource = this.statusPayment(graph, effect.statusId, target, count, effect.sourceFilter === 'self' ? source.owner : undefined);
              if (resource && this.affordable(this.plus(parent.payment, resource))) { payment = this.plus(parent.payment, resource); break; }
            }
            if (!payment) break;
            const providers = [...graph.statuses.values()].filter(fact => fact.id === effect.statusId && fact.target === target && (effect.sourceFilter !== 'self' || fact.applier === source.owner));
            this.putEvent(graph, { ...parent, kind: 'status.consumed', statusId: effect.statusId, stacks: count, payment, appliers: [...new Set(providers.map(fact => fact.applier))].sort(compareStable), ready: Math.max(ready, ...providers.map(fact => fact.ready)) }); break;
          }
          case 'shield': {
            if (!this.positiveAmount(effect, source.owner) || (effect.duration.kind === 'ticks' && effect.duration.ticks <= 0)) break;
            graph.shields.set(key, { key, target, owner: source.owner, interval, uses, ready }); break;
          }
          case 'heal': if (this.positiveAmount(effect, source.owner)) this.putEvent(graph, { ...parent, kind: 'healing.resolved' }); break;
          case 'storeForce': if (effect.coefficientBps > 0 && effect.maximumHealthBps > 0) graph.force.add(target); break;
          case 'releaseForce': if (graph.force.has(source.owner)) this.putEvent(graph, { ...parent, kind: 'force.released' }); break;
          case 'augmentNextAction': graph.augments.set(key, { key, owner: target, tags: effect.tags, adjustment: effect.adjustment }); break;
          case 'recordCast': if (event && event.paid > 0) this.putEvent(graph, { ...parent, kind: 'castHistory.recorded', actor: source.owner }); break;
          case 'zone': this.apply(effect.effects, source, event, graph, family ?? 'zone', false, effect.intervalTicks,
            effect.duration.kind === 'ticks' ? Math.floor((effect.duration.ticks - 1) / effect.intervalTicks) : 1, ready + effect.intervalTicks, `${prefix}/${index}/zone`); break;
          default: break;
        }
      }
    });
  }
  positiveAmount(effect: Extract<EffectPrimitive, { kind: 'heal' | 'shield' }>, owner: string): boolean {
    const amount = effect.amount, stats = this.member(owner)?.loadout.stats;
    if (amount.kind === 'flat') return amount.units > 0;
    if (amount.kind === 'stat') return Math.floor((stats?.[amount.stat] ?? 0) * amount.coefficientBps / 10000) + amount.flatUnits > 0;
    // These effects are reached only after their event/resource conditions have been established.
    return amount.kind === 'event' ? amount.coefficientBps > 0 && amount.capBps > 0 : amount.coefficientPerStackBps > 0 || amount.flatPerStackUnits > 0;
  }
  buildGraph(sources: readonly Source[], seed?: { owner: string; stacks: number }): Graph {
    const graph = emptyGraph();
    if (seed) graph.statuses.set('hypothetical-rune', { key: 'hypothetical-rune', producer: 'hypothetical-rune', id: RUNE, target: seed.owner, applier: seed.owner, stacks: seed.stacks, perApplication: seed.stacks, payment: {}, interval: 100000, uses: 1, ready: 0 });
    for (const member of this.members) {
      const owner = member.discipleId, facts = this.fact(owner), basic = member.loadout.basic;
      const template: Opportunity = { key: '', kind: 'action.committed', actor: owner, target: owner, school: basic.school, tags: [], direct: true, family: null,
        sourceId: 'runtime.basic', paid: 0, interval: Math.max(1, basic.cooldownTicks + basic.castTicks), uses: 100000, ready: basic.castTicks, statusId: null, stacks: 0, appliers: [], payment: {}, depth: 0 };
      if ((this.skills.get(owner)?.length ?? 0) !== 2) continue;
      for (const enemy of this.context.enemies) if (this.near(owner, enemy.id, basic.rangeUnits) && basic.castTicks <= this.context.horizonTicks) this.putEvent(graph, { ...template, key: `${owner}/basic/${enemy.id}`, target: enemy.id, tags: [basic.school, 'basic', 'physical', 'damage'] });
      if (facts.guardAllowed) this.putEvent(graph, { ...template, key: `${owner}/guard`, kind: 'command.guard', tags: ['guard'] });
      for (const enemy of facts.directDamageEnemyIds) {
        this.putEvent(graph, { ...template, key: `${owner}/damage/${enemy}`, kind: 'damage.healthLost', actor: enemy, sourceId: 'encounter.direct-damage', target: owner });
        this.putEvent(graph, { ...template, key: `${owner}/beforeDowned/${enemy}`, kind: 'life.beforeDowned', actor: enemy, sourceId: 'encounter.direct-damage', target: owner, uses: 1 });
        if (facts.defeatRule === 'downed') this.putEvent(graph, { ...template, key: `${owner}/downed/${enemy}`, kind: 'life.downed', actor: enemy, sourceId: 'encounter.direct-damage', target: owner, uses: 1 });
      }
      if ((member.loadout.stats.controlResistanceBps ?? 0) < 10000) for (const enemy of facts.controlEnemyIds) this.putEvent(graph, { ...template, key: `${owner}/control/${enemy}`, kind: 'control.ended', actor: enemy, sourceId: 'encounter.control', target: owner, direct: false, family: 'status-expiry' });
    }
    let previous = '';
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      for (const member of this.members) for (const skill of this.skills.get(member.discipleId) ?? []) {
        const owner = member.discipleId, source = sources.find(source => source.owner === owner && source.definition.id === skill.id)!;
        const targetIds = skill.action.targetTeam === 'self' ? [owner] : skill.action.targetTeam === 'ally' ? this.members.map(member => member.discipleId) : this.context.enemies.map(enemy => enemy.id);
        for (const target of targetIds) {
          const event: Opportunity = { key: `${owner}/${skill.id}/${target}`, kind: 'action.committed', actor: owner, target, school: skill.school,
            tags: skill.tags, direct: true, family: null, sourceId: skill.id, paid: skill.action.spiritCostUnits, interval: skill.action.cooldownTicks + skill.action.castTicks,
            uses: Math.floor(member.spirit / Math.max(1, skill.action.spiritCostUnits)), ready: skill.action.castTicks, statusId: null, stacks: 0, appliers: [], payment: { [owner]: skill.action.spiritCostUnits }, depth: 0 };
          const adjustments = this.adjustments(owner, skill.tags, event, graph);
          event.paid = adjustedActionCost(skill.action.spiritCostUnits, adjustments);
          event.payment = { [owner]: event.paid };
          event.uses = Math.floor(member.spirit / Math.max(1, event.paid));
          const range = skill.action.rangeUnits + adjustments.reduce((sum, adjustment) => sum + (adjustment.kind === 'rangeUnits' ? adjustment.value : 0), 0);
          const cast = Math.max(0, skill.action.castTicks + adjustments.reduce((sum, adjustment) => sum + (adjustment.kind === 'castTimeTicks' ? adjustment.value : 0), 0));
          event.ready = Math.floor(cast * 10000 / Math.max(1, 10000 + (member.loadout.stats.hasteBps ?? 0)));
          event.interval = Math.max(1, skill.action.cooldownTicks + event.ready);
          if (event.uses < 1 || event.ready > this.context.horizonTicks || !this.near(owner, target, range) || !this.test(skill.action.condition, owner, event, graph)) continue;
          this.putEvent(graph, event); this.apply(skill.action.effects, source, event, graph, null, true, event.interval, event.uses, event.ready, 'active');
        }
      }
      for (const source of sources) {
        this.apply(source.definition.mechanics.onInstall, source, null, graph, null, false, 100000, 1, 0, 'install');
        for (const trigger of source.definition.mechanics.triggers) for (const event of [...graph.events.values()]) {
          if (!this.scope(trigger, source, event) || !this.test(trigger.condition, source.owner, event, graph)) continue;
          const payment = this.conditionPayment(trigger.condition, source.owner, event, graph);
          if (!payment || !this.affordable(this.plus(event.payment, payment))) continue;
          graph.reached.add(`${source.key}/${trigger.triggerId}`);
          this.apply(trigger.effects, source, { ...event, payment: this.plus(event.payment, payment) }, graph, trigger.proc.family, false,
            Math.max(event.interval, trigger.proc.internalCooldownTicks, 1), Math.min(event.uses, trigger.proc.maximumActivations), event.ready, `trigger/${trigger.triggerId}/${event.actor}/${event.target}`);
        }
      }
      for (const shield of graph.shields.values()) if (this.member(shield.target)) for (const enemy of this.fact(shield.target).directDamageEnemyIds) {
        const damage = graph.events.get(`${shield.target}/damage/${enemy}`); if (!damage) continue;
        for (const kind of ['shield.absorbed', 'shield.broken'] as const) this.putEvent(graph, { ...damage, key: `${shield.key}/${kind}/${enemy}`, kind, interval: Math.max(damage.interval, shield.interval), uses: shield.uses });
      }
      const size = graph.events.size + graph.statuses.size + graph.shields.size + graph.augments.size + graph.reached.size;
      if (size > MAX_FACTS) { graph.limited = true; break; }
      const summary = `${size}/${[...graph.statuses.values()].reduce((sum, status) => sum + status.stacks, 0)}/${[...graph.events.values()].reduce((sum, event) => sum + event.stacks, 0)}/${graph.force.size}`;
      if (summary === previous) return graph; previous = summary;
    }
    graph.limited = true; return graph;
  }
  basics(graph: Graph, owner?: string): Opportunity[] { return [...graph.events.values()].filter(event => event.kind === 'action.committed' && event.direct && event.tags.includes('basic') && (owner === undefined || event.actor === owner)); }
  consumes(graph: Graph, statusId: string, count: number, owner?: string, paid = true): Opportunity[] {
    return [...graph.events.values()].filter(event => event.kind === 'status.consumed' && event.statusId === statusId && event.stacks >= count
      && (!paid || event.direct && event.paid > 0) && (owner === undefined || event.actor === owner));
  }
  healed(graph: Graph, owner?: string): boolean { return [...graph.events.values()].some(event => event.kind === 'healing.resolved' && event.direct && (owner === undefined || event.actor === owner)); }
  shielded(graph: Graph, owner: string): boolean { return [...graph.shields.values()].some(shield => shield.target === owner); }
  activeKind(graph: Graph, owner: string | undefined, kind: 'heal' | 'dispel' | 'shield', school?: School): boolean {
    return this.paid(graph, owner).some(event => {
      const skill = this.catalog.skills.find(skill => skill.id === event.sourceId);
      const requiredTag = kind === 'dispel' ? 'cleanse' : kind;
      const hasEffect = (effects: readonly EffectPrimitive[]): boolean => effects.some(effect => this.test(effect.condition, event.actor, event, graph)
        && this.targets(effect.target, event.actor, event, event.actor).some(target => (kind !== 'heal' && kind !== 'shield') || !!this.member(target))
        && (effect.kind === kind || effect.kind === 'zone' && hasEffect(effect.effects)));
      return skill?.activation === 'active' && event.tags.includes(requiredTag) && (!school || skill.school === school) && hasEffect(skill.action.effects);
    });
  }
  paidConsumerTargets(graph: Graph, statusId: string): string[] {
    return this.paid(graph).flatMap(event => {
      const skill = this.catalog.skills.find(skill => skill.id === event.sourceId);
      return skill?.activation === 'active' ? skill.action.effects.filter(effect => effect.kind === 'consumeStatus' && effect.statusId === statusId
        && this.test(effect.condition, event.actor, event, graph)).flatMap(effect => this.targets(effect.target, event.actor, event, event.actor)) : [];
    });
  }
  baseReasons(entry: TalentDefinition, owner: string): ReleaseEligibilityReason[] {
    const ids = entry.holderScope === 'team' ? new Set([...this.sourceIds.values()].flatMap(ids => [...ids])) : this.sourceIds.get(owner) ?? new Set<string>();
    const owned = new Set([...ids, ...this.state.talentInstances.filter(instance => instance.holderScope === 'team' || entry.holderScope === 'team' || instance.holderId === owner).map(instance => instance.definitionId)]);
    const rank = this.state.talentInstances.filter(instance => instance.definitionId === entry.id && (entry.holderScope === 'team' || instance.holderId === owner)).reduce((rank, instance) => Math.max(rank, instance.rank), 0);
    const reasons: ReleaseEligibilityReason[] = [];
    if (rank >= entry.maximumRank) reasons.push('MAXIMUM_RANK');
    if (!entry.prerequisites.every(id => ids.has(id))) reasons.push('MISSING_PREREQUISITE');
    if (entry.excludes.some(id => owned.has(id)) || this.catalog.talents.some(other => owned.has(other.id) && other.excludes.includes(entry.id))) reasons.push('EXCLUDED');
    return reasons;
  }
  triggerReachable(entry: TalentDefinition, recipient: string, graph: Graph): boolean {
    const owner = entry.holderScope === 'team' ? this.teamOwner(entry.id) : recipient;
    if (!owner) return false;
    const source: Source = { key: `candidate/${entry.id}/${owner}`, owner, bound: recipient, definition: entry };
    const events = [...graph.events.values()];
    // A recorder's own exact family may feed its payoff, but no unowned card/resource is added.
    for (const trigger of entry.mechanics.triggers) for (const event of [...events]) {
      if (!this.scope(trigger, source, event) || !this.test(trigger.condition, owner, event, graph)) continue;
      const payment = this.conditionPayment(trigger.condition, owner, event, graph);
      if (!payment || !this.affordable(this.plus(event.payment, payment))) continue;
      if (trigger.effects.some(effect => effect.kind === 'recordCast')) events.push({ ...event, key: `${event.key}/record`, kind: 'castHistory.recorded', actor: owner, direct: false, family: trigger.proc.family, depth: event.depth + 1 });
      if (trigger.effects.some(effect => effect.kind !== 'recordCast' && this.test(effect.condition, owner, event, graph)
        && this.targets(effect.target, owner, event, recipient).length > 0)) return true;
    }
    return false;
  }
  /** Existing automatic spenders execute before a newly acquired same-holder source.
   * Try each attainable opening stack count: an optional 2-stack spender must not block
   * a 1-stack payoff that can deliberately be used before the second stack exists. */
  resourceWindow(entry: TalentDefinition, owner: string, resource: string, required: number, graph: Graph): boolean {
    const candidates = this.paid(graph, owner).filter(event => entry.mechanics.triggers.some(trigger => trigger.event === event.kind && this.test(trigger.condition, owner, event, graph)));
    for (const event of candidates) for (let initial = required; initial <= this.status(graph, resource, owner); initial += 1) {
      let remaining = initial;
      const guaranteed = (condition: Condition, sourceOwner: string): boolean => {
        switch (condition.kind) {
          case 'always': return true;
          case 'all': return condition.conditions.every(part => guaranteed(part, sourceOwner));
          case 'any': return condition.conditions.some(part => guaranteed(part, sourceOwner));
          case 'hasStatus': return condition.subject === 'actor' && sourceOwner === owner && condition.statusId === resource && remaining >= condition.minimumStacks;
          case 'flag': return ['event.isActive', 'event.isBasic', 'event.targetAlive'].includes(condition.field) && this.test(condition, sourceOwner, event, graph);
          case 'hasTag': return condition.subject === 'eventSource' && this.test(condition, sourceOwner, event, graph);
          case 'compare': return condition.field === 'event.paidSpirit' && this.test(condition, sourceOwner, event, graph);
          default: return false;
        }
      };
      for (const source of this.sources) for (const trigger of source.definition.mechanics.triggers) {
        if (source.owner !== owner || trigger.priority > 0 || !this.scope(trigger, source, event) || !guaranteed(trigger.condition, source.owner)) continue;
        for (const effect of trigger.effects) if (effect.kind === 'consumeStatus' && effect.statusId === resource && guaranteed(effect.condition, source.owner)
          && this.targets(effect.target, source.owner, event, source.bound).includes(owner) && remaining >= effect.minimumStacks) remaining -= Math.min(remaining, effect.maximumStacks);
      }
      if (remaining >= required) return true;
    }
    return false;
  }
  runeDirection(owner: string, stacks: number, graph: Graph): { ok: boolean; followups: string[] } {
    if (this.consumes(graph, RUNE, 1, owner, false).length) return { ok: true, followups: [] };
    const hypothetical = this.buildGraph(this.sources, { owner, stacks });
    if (this.consumes(hypothetical, RUNE, 1, owner, false).length) return { ok: true, followups: [] };
    const followups = this.catalog.talents.filter(entry => ['talent.duanwen-jiezhou', 'talent.zhanwen-yuanshu', 'talent.sanzhuan-zhishen'].includes(entry.id)
      && this.supported(entry.id) && !this.baseReasons(entry, owner).length && !this.reasons(entry, owner, hypothetical).length).map(entry => entry.id).sort(compareStable);
    return { ok: followups.length > 0, followups };
  }
  reasons(entry: TalentDefinition, owner: string, graph: Graph): ReleaseEligibilityReason[] {
    const reasons: ReleaseEligibilityReason[] = [], requireCapability = (ok: boolean, code: ReleaseEligibilityReason): void => { if (!ok) reasons.push(code); };
    const paid = this.paid(graph, owner), allPaid = this.paid(graph), basic = this.basics(graph, owner);
    const basicStatus = (statusId: string, count = 1): boolean => basic.some(event => this.status(graph, statusId, event.target) >= count);
    const markSpend = (count: number, holder: string | undefined = owner): boolean => this.consumes(graph, MARK, count, holder).length > 0;
    const ownedPoison = (): boolean => [...graph.statuses.values()].some(fact => fact.id === POISON && fact.applier === owner && this.enemy(fact.target));
    const otherPoison = (): boolean => this.consumes(graph, POISON, 1).some(event => event.actor !== owner && event.appliers.includes(owner));
    const rune = (count: number): boolean => this.status(graph, RUNE, owner) >= count;
    const talisman = (): boolean => paid.some(event => event.school === 'talisman');
    const guard = (): boolean => [...graph.events.values()].some(event => event.kind === 'command.guard' && (entry.holderScope === 'team' || event.actor === owner));
    const focusSpend = (): boolean => this.paidConsumerTargets(graph, MARK).some(target => this.context.focusEnemyIds.includes(target));
    const force = (): void => { requireCapability(graph.force.has(owner), 'MISSING_FORCE_PRODUCER'); requireCapability(this.shielded(graph, owner), 'MISSING_REACHABLE_SHIELD');
      requireCapability(this.fact(owner).directDamageEnemyIds.length > 0, 'MISSING_HOSTILE_DAMAGE'); requireCapability([...graph.events.values()].some(event => event.kind === 'force.released' && event.actor === owner), 'MISSING_FORCE_RELEASE'); };
    switch (entry.id) {
      case 'talent.kairen-liuhen': requireCapability(paid.some(event => event.school === 'sword' && this.enemy(event.target)), 'MISSING_PAID_SWORD_ACTIVE'); break;
      case 'talent.dingfeng-shuanghen': requireCapability(this.basics(graph).some(event => this.status(graph, 'status.stagger', event.target) > 0), 'MISSING_REACHABLE_STAGGER'); break;
      case 'talent.hujian-jieli': requireCapability(paid.some(event => event.school === 'sword' && [...graph.statuses.values()].some(fact => fact.id === MARK && fact.applier === owner && fact.target === event.target && fact.key.includes(`/${event.sourceId}/active/`))), 'MISSING_OWN_MARK_APPLICATION'); requireCapability(this.activeKind(graph, undefined, 'shield'), 'MISSING_PAID_SHIELD_CASTER'); break;
      case 'talent.xigui-jianmai': case 'talent.pochen-duanliu': case 'talent.jianhuo-tonglu': requireCapability(markSpend(3), 'MISSING_REACHABLE_MARK_SPEND'); break;
      case 'talent.zhechao-hushen': requireCapability(markSpend(2), 'MISSING_REACHABLE_MARK_SPEND'); break;
      case 'talent.cuofeng': requireCapability(markSpend(1), 'MISSING_REACHABLE_MARK_SPEND'); requireCapability(basic.length > 0, 'MISSING_REACHABLE_MARK'); break;
      case 'talent.jiehen-xuming': requireCapability(basicStatus(MARK), 'MISSING_REACHABLE_MARK'); break;
      case 'talent.jianwen-huiliu': requireCapability(talisman(), 'MISSING_PAID_TALISMAN_ACTIVE'); requireCapability(this.consumes(graph, MARK, 3).length > 0, 'MISSING_REACHABLE_MARK_SPEND'); break;
      case 'talent.guanfeng-yinlei': requireCapability(basicStatus('status.shock'), 'MISSING_REACHABLE_SHOCK'); break;
      case 'talent.wenyao-yuxing': case 'talent.duhou-huigen': requireCapability(ownedPoison(), 'MISSING_OWN_POISON'); requireCapability(otherPoison(), 'MISSING_OTHER_POISON_CONSUMER'); break;
      case 'talent.yiyao-xudu': requireCapability(ownedPoison(), 'MISSING_OWN_POISON'); requireCapability(otherPoison(), 'MISSING_OTHER_POISON_CONSUMER'); requireCapability(basic.length > 0 && this.status(graph, MEDICINE, owner) >= 1, 'MISSING_MEDICINE'); break;
      case 'talent.jingdan-shenghua': requireCapability(this.activeKind(graph, owner, 'dispel') && paid.some(event => event.tags.includes('cleanse')), 'MISSING_PAID_CLEANSE'); break;
      case 'talent.yaohua-jingmai': case 'talent.juyao-chengquan': { const count = entry.id === 'talent.juyao-chengquan' ? 2 : 1;
        requireCapability(this.activeKind(graph, owner, 'dispel') && paid.some(event => event.tags.includes('cleanse')), 'MISSING_PAID_CLEANSE'); requireCapability(this.activeKind(graph, owner, 'heal') && paid.some(event => event.tags.includes('heal')), 'MISSING_PAID_HEAL');
        requireCapability(this.status(graph, MEDICINE, owner) >= count, 'MISSING_MEDICINE');
        if (this.status(graph, MEDICINE, owner) >= count) requireCapability(this.resourceWindow(entry, owner, MEDICINE, count, graph), 'RESOURCE_PREEMPTED'); break; }
      case 'talent.yaoyan-yanmian': requireCapability(this.consumes(graph, POISON, 1, owner).length > 0, 'MISSING_REACHABLE_POISON_SPEND'); break;
      case 'talent.yuhuo-zhaolu': requireCapability(this.consumes(graph, POISON, 1).length > 0, 'MISSING_REACHABLE_POISON_SPEND'); break;
      case 'talent.jinhuo-liuzhan': case 'talent.dudu-chengwen': requireCapability(this.consumes(graph, POISON, entry.id === 'talent.jinhuo-liuzhan' ? 3 : 2, owner).length > 0, 'MISSING_REACHABLE_POISON_SPEND'); break;
      case 'talent.yuying-hudeng': requireCapability(this.healed(graph, owner), 'MISSING_DIRECT_HEAL'); break;
      case 'talent.huomai-shujian': requireCapability(this.healed(graph), 'MISSING_DIRECT_HEAL'); requireCapability(focusSpend(), 'MISSING_REACHABLE_MARK_SPEND'); break;
      case 'talent.suijia-huixi': case 'talent.dunjia-runsheng': requireCapability(this.shielded(graph, owner), 'MISSING_REACHABLE_SHIELD'); requireCapability(this.fact(owner).directDamageEnemyIds.length > 0, 'MISSING_HOSTILE_DAMAGE'); break;
      case 'talent.dingbu-ningshi': case 'talent.jiefeng-qingwen': requireCapability([...graph.events.values()].some(event => event.kind === 'control.ended' && event.target === owner), 'MISSING_CONTROL_OPPORTUNITY'); break;
      case 'talent.shouyu-liuzhen': case 'talent.bingjian-shouyu': requireCapability(guard(), 'GUARD_UNAVAILABLE'); break;
      case 'talent.huzhen-dianfeng': requireCapability(guard(), 'GUARD_UNAVAILABLE'); requireCapability(this.context.focusEnemyIds.length > 0, 'FOCUS_UNAVAILABLE'); requireCapability(focusSpend(), 'MISSING_REACHABLE_MARK_SPEND'); break;
      case 'talent.fanzhen': requireCapability(graph.force.has(owner), 'MISSING_FORCE_PRODUCER'); requireCapability(this.shielded(graph, owner), 'MISSING_REACHABLE_SHIELD'); requireCapability(basic.length > 0, 'MISSING_FORCE_RELEASE'); break;
      case 'talent.cangjin-duanhe': case 'talent.cangjin-yangmai': case 'talent.humai': force(); if (entry.id !== 'talent.cangjin-duanhe') requireCapability(this.members.some(member => member.discipleId !== owner && this.near(owner, member.discipleId, 800)), 'MISSING_OTHER_ALLY'); break;
      case 'talent.pofu-shouyuan': break;
      case 'talent.tongjia-jiuyuan': requireCapability(this.members.some(member => member.discipleId !== owner && this.fact(member.discipleId).defeatRule === 'downed' && this.fact(member.discipleId).directDamageEnemyIds.length > 0), 'MISSING_DOWNED_ALLY'); break;
      case 'talent.shouzhong-shengfeng': requireCapability([...graph.shields.values()].some(shield => this.member(shield.target) && this.fact(shield.target).directDamageEnemyIds.length > 0), 'MISSING_REACHABLE_SHIELD'); requireCapability(this.context.focusEnemyIds.length > 0, 'FOCUS_UNAVAILABLE'); break;
      case 'talent.hufu-yangwen': requireCapability(talisman(), 'MISSING_PAID_TALISMAN_ACTIVE'); requireCapability(this.shielded(graph, owner), 'MISSING_REACHABLE_SHIELD'); break;
      case 'talent.liangyi-jiewen': requireCapability(new Set(allPaid.map(event => event.school)).size >= 2, 'MISSING_DISTINCT_SCHOOLS'); break;
      case 'talent.duanwen-jiezhou': requireCapability(rune(1) && basic.length > 0, 'MISSING_RUNE_PRODUCER'); break;
      case 'talent.zhanwen-yuanshu': case 'talent.sanzhuan-zhishen': { const count = entry.id === 'talent.sanzhuan-zhishen' ? 3 : 2;
        requireCapability(talisman(), 'MISSING_PAID_TALISMAN_ACTIVE'); requireCapability(rune(count), 'MISSING_RUNE_PRODUCER');
        if (rune(count)) requireCapability(this.resourceWindow(entry, owner, RUNE, count, graph), 'RESOURCE_PREEMPTED');
        if (entry.id === 'talent.sanzhuan-zhishen') requireCapability(this.fact(owner).decoyPlacementPossible, 'DECOY_PLACEMENT_UNAVAILABLE'); break; }
      case 'talent.yifa-hudeng': requireCapability(this.activeKind(graph, undefined, 'heal'), 'MISSING_PAID_HEAL'); requireCapability(new Set(allPaid.map(event => event.actor)).size >= 2, 'MISSING_DISTINCT_CASTERS'); break;
      case 'talent.sanyao-jingzhen': requireCapability(new Set(allPaid.map(event => event.school)).size >= 3, 'MISSING_DISTINCT_SCHOOLS'); break;
      case 'talent.sanyao-hepai': requireCapability(new Set(allPaid.map(event => event.actor)).size >= 3, 'MISSING_DISTINCT_CASTERS'); break;
      case 'talent.yifa-tongming': requireCapability(talisman(), 'MISSING_PAID_TALISMAN_ACTIVE'); requireCapability(new Set(allPaid.map(event => event.actor)).size >= 2, 'MISSING_DISTINCT_CASTERS'); break;
      case 'talent.shidu-qiwen': requireCapability(basicStatus(POISON), 'MISSING_REACHABLE_POISON'); break;
      case 'talent.zoumai-chengfu': requireCapability(false, 'UNSUPPORTED_EXTRA_TARGET_STAGGER'); break;
      default: requireCapability(false, 'UNRECOGNIZED_RULE');
    }
    return reasons;
  }
}

function validateContext(state: ExpeditionState, catalog: ExpeditionCatalog, context: ReleaseEligibilityContext | null | undefined): ReleaseEligibilityDiagnostic[] {
  const note = (code: ReleaseEligibilityReason, detail: string, holderId: string | null = null): ReleaseEligibilityDiagnostic => ({ code, detail, holderId, definitionId: null });
  if (!context) return [note('MISSING_CONTEXT', 'Authoritative upcoming-encounter opportunities are required')];
  if (!Array.isArray(context.members) || !Array.isArray(context.enemies) || !Array.isArray(context.reachablePairs)
    || !Array.isArray(context.focusEnemyIds) || !Array.isArray(context.teamSourceHolders)
    || context.members.some(fact => !fact || !Array.isArray(fact.directDamageEnemyIds) || !Array.isArray(fact.controlEnemyIds))) return [note('INVALID_CONTEXT', 'All bounded encounter fact collections must be explicit')];
  if (!context.identity || context.identity.rulesId !== RELEASE_ELIGIBILITY_RULES_ID || context.identity.catalogHash !== catalogFingerprint(catalog)
    || context.identity.inputHash !== releaseEligibilityInputHash(state)) return [note('CONTEXT_IDENTITY_MISMATCH', 'Rebuild encounter context after catalog, casualty, loadout or binding changes')];
  const hasTalismanRecipient = state.members.some(member => member.alive && member.permanentDeathId === null
    && [...member.loadout.activeSkillIds, member.loadout.passiveSkillId].some(id => catalog.skills.some(skill => skill.id === id && skill.school === 'talisman')));
  const ids = [...state.members.map(member => member.discipleId), ...context.enemies.map(enemy => enemy.id)];
  if (!context.identity.encounterId || !context.identity.encounterRulesId || !context.identity.arenaId || !numeric(context.horizonTicks, 1)
    || state.members.length > 36 || context.enemies.length > 36 || !unique(ids) || !unique(context.members.map(member => member.discipleId))
    || context.members.length > 36 || context.reachablePairs.length > 2556 || !unique(context.focusEnemyIds)
    || !unique(context.teamSourceHolders.map(source => source.definitionId))
    || context.teamSourceHolders.some(source => !catalog.talents.some(entry => entry.id === source.definitionId && entry.holderScope === 'team')
      || !state.members.some(member => member.discipleId === source.discipleId && member.alive && member.permanentDeathId === null))
    || (state.members.some(member => member.alive && member.permanentDeathId === null) && catalog.talents.some(entry => entry.holderScope === 'team'
      && (entry.recipientBinding !== 'selectedTalisman' || hasTalismanRecipient)
      && !context.teamSourceHolders.some(source => source.definitionId === entry.id)))
    || context.enemies.some(enemy => !numeric(enemy.controlResistanceBps, 0, 10000))
    || context.focusEnemyIds.some(id => !context.enemies.some(enemy => enemy.id === id))
    || context.reachablePairs.some(pair => !ids.includes(pair.firstId) || !ids.includes(pair.secondId) || !numeric(pair.distanceUnits, 0, 1_000_000))
    || !unique(context.reachablePairs.map(pair => [pair.firstId, pair.secondId].sort(compareStable).join('|')))
    || context.members.some(fact => !state.members.some(member => member.discipleId === fact.discipleId)
      || typeof fact.guardAllowed !== 'boolean' || typeof fact.decoyPlacementPossible !== 'boolean' || !['downed', 'immediate'].includes(fact.defeatRule)
      || !unique(fact.directDamageEnemyIds) || !unique(fact.controlEnemyIds)
      || [...fact.directDamageEnemyIds, ...fact.controlEnemyIds].some(id => !context.enemies.some(enemy => enemy.id === id)))) return [note('INVALID_CONTEXT', 'Encounter facts exceed bounds or contain invalid/ambiguous references')];
  return state.members.filter(member => member.alive && member.permanentDeathId === null && !context.members.some(fact => fact.discipleId === member.discipleId))
    .map(member => note('MISSING_MEMBER_FACTS', 'Guard, damage/control, defeat and placement facts must be explicit', member.discipleId));
}

/** No RNG, mutation, choice, grant, rebind, source removal or old-catalog admission occurs here. */
export function evaluateReleaseEligibility(state: ExpeditionState, catalog: ExpeditionCatalog,
  context?: ReleaseEligibilityContext | null): Immutable<ReleaseEligibilityResult> {
  const diagnostics = validateContext(state, catalog, context), candidates: Candidate[] = [];
  const followupRequired: { definitionId: string; holderId: string; consumerDefinitionIds: string[] }[] = [];
  if (!diagnostics.length && context) {
    const analysis = new Analysis(state, catalog, context); diagnostics.push(...analysis.diagnostics);
    if (analysis.graph.limited) diagnostics.push({ code: 'GRAPH_LIMIT_EXCEEDED', definitionId: null, holderId: null, detail: 'Bounded capability analysis could not establish a fixed point' });
    if (!analysis.graph.limited && !analysis.diagnostics.some(note => note.code === 'INVALID_LOADOUT')) for (const entry of [...catalog.talents].sort((a, b) => compareStable(a.id, b.id))) {
      if (entry.id === 'talent.zoumai-chengfu' || !analysis.supported(entry.id)) {
        diagnostics.push({ code: entry.id === 'talent.zoumai-chengfu' ? 'UNSUPPORTED_EXTRA_TARGET_STAGGER' : 'UNSUPPORTED_DEFINITION', definitionId: entry.id, holderId: null, detail: 'Definition is not admitted by this opt-in protocol' }); continue;
      }
      if (entry.holderScope === 'team' && entry.recipientBinding === 'selectedTalisman' && !analysis.teamOwner(entry.id)) {
        diagnostics.push({ code: 'NO_LIVING_RECIPIENT', definitionId: entry.id, holderId: null,
          detail: 'No living equipped talisman-skill recipient; this card has no runtime source anchor' }); continue;
      }
      const holderIds: string[] = [];
      for (const member of analysis.members) {
        const owner = member.discipleId;
        if (entry.holderScope === 'team' && entry.recipientBinding === 'team' && analysis.teamOwner(entry.id) !== owner) continue;
        const reasons = [...analysis.baseReasons(entry, owner), ...analysis.reasons(entry, owner, analysis.graph)];
        if (!reasons.length && !analysis.triggerReachable(entry, owner, analysis.graph)) reasons.push('NO_REACHABLE_TRIGGER');
        if (!reasons.length && ['talent.hufu-yangwen', 'talent.jiefeng-qingwen', 'talent.shidu-qiwen'].includes(entry.id)) {
          const direction = analysis.runeDirection(owner, entry.id === 'talent.jiefeng-qingwen' ? 2 : 1, analysis.graph);
          if (!direction.ok) reasons.push('MISSING_RUNE_DIRECTION');
          else if (direction.followups.length) followupRequired.push({ definitionId: entry.id, holderId: owner, consumerDefinitionIds: direction.followups });
        }
        if (!reasons.length) holderIds.push(owner);
        else for (const code of [...new Set(reasons)]) diagnostics.push({ code, definitionId: entry.id, holderId: owner, detail: 'No valid existing-source witness for this recipient' });
      }
      if (holderIds.length) candidates.push({ definitionId: entry.id,
        holderIds: entry.holderScope === 'team' && entry.recipientBinding === 'team' ? [] : holderIds,
        tags: [...entry.tags], category: entry.category, role: entry.offerRole, buildId: entry.buildId });
      else if (!analysis.members.length) diagnostics.push({ code: 'NO_LIVING_RECIPIENT', definitionId: entry.id, holderId: null, detail: 'No surviving recipient' });
    }
  }
  for (const followup of followupRequired) diagnostics.push({ code: 'FOLLOWUP_REQUIRED', definitionId: followup.definitionId, holderId: followup.holderId, detail: followup.consumerDefinitionIds.join(',') });
  if (candidates.length < 3) diagnostics.push({ code: 'INSUFFICIENT_LEGAL_CARDS', definitionId: null, holderId: null, detail: `Only ${candidates.length} legal cards; do not fabricate a third card` });
  diagnostics.push({ code: 'SUPPLY_FALLBACK_AVAILABLE', definitionId: null, holderId: null, detail: 'The existing reward transaction may offer the explicit supply alternative' });
  diagnostics.sort((a, b) => compareStable(a.definitionId ?? '', b.definitionId ?? '') || compareStable(a.holderId ?? '', b.holderId ?? '') || compareStable(a.code, b.code) || compareStable(a.detail, b.detail));
  return freeze({ rulesId: RELEASE_ELIGIBILITY_RULES_ID, candidates, diagnostics, followupRequired,
    supplyFallback: { available: true, supplies: FALLBACK_SUPPLIES.map(line => ({ ...line })), grantsReward: false }, missingChoiceCount: Math.max(0, 3 - candidates.length) });
}
