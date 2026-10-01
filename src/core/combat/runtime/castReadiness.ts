import type { ActionAdjustment, CombatContentCatalog, CombatTag } from '../definitions/types';
import { checkedAdd, multiplyDivideFloor } from '../../kernel/numeric';
import { findCombatDefinition } from './catalog';
import { alive, conditionPasses, definition, emptyContext, mechanics, queryStat, sourceActive, statusActive, tagsMatch, within } from './queries';
import type { BattleAction, BattleState, Provenance } from './types';

export type CastReadinessReason = 'battle-ended' | 'actor-unavailable' | 'actor-downed' | 'actor-dead' | 'recovery-lock' | 'action-lock' | 'actor-casting' | 'unknown-skill' | 'not-active-skill' | 'cooldown' | 'missing-target' | 'target-team' | 'target-downed' | 'target-dead' | 'out-of-range' | 'insufficient-spirit' | 'condition';
export interface CastReadiness {
  readonly ready: boolean;
  readonly reason: CastReadinessReason | null;
  readonly spiritCostUnits: number;
  readonly availableSpiritUnits: number;
  readonly rangeUnits: number;
  readonly castTicks: number;
  readonly cooldownRemainingTicks: number;
  readonly recoveryRemainingTicks: number;
  readonly targetTeam: BattleAction['targetTeam'] | null;
}

/** Borrowed immutable adjustments, in the same order used when committing an action.
 * No IDs, roots, reservations, charges, random draws or state writes are performed.
 * Execution must copy the returned values before storing them in a mutable battle. */
export function collectActionAdjustments(state: BattleState, catalog: CombatContentCatalog, actorId: string, tags: readonly CombatTag[], targetId: string, root: Provenance) {
  const adjustments: ActionAdjustment[] = []; const chargeIds: string[] = [];
  for (const source of Object.values(state.sources).sort((a, b) => a.createdSequence - b.createdSequence)) {
    if (source.executionKind === 'committed' || source.holderId !== actorId || !sourceActive(state, catalog, source.sourceInstanceId)) continue;
    const rules = mechanics(catalog, source)?.actionRules; if (!rules?.length) continue;
    const ctx = emptyContext(state, actorId, tags);
    ctx.provenance = root; ctx.sourceInstanceId = source.sourceInstanceId; ctx.sourceDefinitionId = source.sourceDefinitionId; ctx.boundHolderId = source.boundHolderId;
    ctx.statusApplierId = source.statusInstanceId ? state.statuses.find(status => status.statusInstanceId === source.statusInstanceId)?.applierId ?? null : null;
    ctx.targetId = targetId; ctx.intentId = targetId;
    ctx.event = { ...root, eventId: 'event:0', sequence: 0, tick: state.tick, kind: 'action.reserved', actorId, targetId, sourceInstanceId: source.sourceInstanceId, sourceDefinitionId: source.sourceDefinitionId, values: { idleTicks: state.tick - state.entities[actorId]!.lastCommittedTick }, flags: {}, statusId: null, consumedApplierIds: [], shieldInstanceId: null, reason: null };
    for (const rule of rules) if (tagsMatch(rule.tags, tags) && conditionPasses(state, catalog, rule.condition, ctx)) adjustments.push(rule.adjustment);
  }
  for (const charge of state.augments) if (sourceActive(state, catalog, charge.sourceInstanceId) && charge.recipientIds.includes(actorId) && charge.uses > 0 && (charge.expiresAtTick === null || charge.expiresAtTick > state.tick) && tagsMatch(charge.tags, tags) && state.sources[charge.sourceInstanceId]) { adjustments.push(charge.adjustment); chargeIds.push(charge.chargeId); }
  return { adjustments, chargeIds };
}
export function actionAdjustmentSum(adjustments: readonly ActionAdjustment[], kind: ActionAdjustment['kind']): number {
  let sum = 0; for (const adjustment of adjustments) if (adjustment.kind === kind) sum = checkedAdd(sum, adjustment.value); return sum;
}
export function adjustedActionCost(cost: number, adjustments: readonly ActionAdjustment[]): number {
  let discount = 0; let minimum = 0;
  for (const adjustment of adjustments) if (adjustment.kind === 'costReductionBps') { discount = checkedAdd(discount, adjustment.value); minimum = Math.max(minimum, adjustment.minimumCostUnits); }
  return cost === 0 ? 0 : Math.min(cost, Math.max(minimum, multiplyDivideFloor(cost, Math.max(0, 10_000 - discount), 10_000)));
}
export function actorActionBlock(state: BattleState, catalog: CombatContentCatalog, actorId: string): CastReadinessReason | null {
  const actor = state.entities[actorId];
  if (!actor || actor.kind !== 'combatant') return 'actor-unavailable';
  if (actor.life === 'Dead') return 'actor-dead';
  if (actor.life === 'Downed') return 'actor-downed';
  if (state.tick < actor.recoveryUntilTick) return 'recovery-lock';
  if (state.statuses.some(status => status.holderId === actorId && statusActive(state, catalog, status) && (definition(catalog, status.definitionId) as { actionLock?: string }).actionLock === 'untilRemoved')) return 'action-lock';
  return null;
}
export function actionTargetBlock(state: BattleState, actorId: string, targetId: string | null, team: BattleAction['targetTeam'], range: number, allowDowned = false): CastReadinessReason | null {
  const actor = state.entities[actorId]; const target = targetId === null ? undefined : state.entities[targetId];
  if (!actor || !target || targetId === null) return 'missing-target';
  if (team === 'self' ? actorId !== targetId : (actor.team === target.team) !== (team === 'ally')) return 'target-team';
  if (target.life === 'Dead') return 'target-dead';
  if (!alive(state, targetId) && !(allowDowned && target.life === 'Downed')) return 'target-downed';
  return within(state, actorId, targetId, range) ? null : 'out-of-range';
}

/** Pure admission preview shared by player input, AI and runtime. A null skillId means
 * basic attack. Range-only failures remain movement candidates for AI; all resource,
 * condition and life checks are evaluated before returning out-of-range. No battle
 * cloning/simulation, ID allocation, RNG, reservation or charge consumption occurs. */
export function queryCastReadiness(state: BattleState, catalog: CombatContentCatalog, actorId: string, skillId: string | null, targetId: string | null): CastReadiness {
  const actor = state.entities[actorId];
  const result = { ready: false, reason: null as CastReadinessReason | null, spiritCostUnits: 0, availableSpiritUnits: Math.max(0, (actor?.spirit ?? 0) - (actor?.reservedSpirit ?? 0)), rangeUnits: 0, castTicks: 0, cooldownRemainingTicks: Math.max(0, (actor?.cooldowns[skillId ?? 'runtime.basic'] ?? 0) - state.tick), recoveryRemainingTicks: Math.max(0, (actor?.recoveryUntilTick ?? 0) - state.tick), targetTeam: null as BattleAction['targetTeam'] | null };
  const blocked = (reason: CastReadinessReason): CastReadiness => ({ ...result, reason });
  if (!actor || actor.kind !== 'combatant') return blocked('actor-unavailable');
  const d = skillId === null ? null : findCombatDefinition(catalog, skillId);
  if (skillId !== null && !actor.skills.includes(skillId)) return blocked('unknown-skill');
  if (skillId !== null && (d?.kind !== 'skill' || d.activation !== 'active')) return blocked('not-active-skill');
  const active = d?.kind === 'skill' && d.activation === 'active' ? d.action : null;
  const tags: readonly CombatTag[] = d?.tags ?? [actor.basic.school, 'basic', 'damage', 'physical'];
  const ctx = emptyContext(state, actorId, tags); ctx.provenance.school = d?.kind === 'skill' ? d.school : actor.basic.school; ctx.targetId = targetId; ctx.intentId = targetId;
  const current = collectActionAdjustments(state, catalog, actorId, tags, targetId ?? '', ctx.provenance);
  result.spiritCostUnits = adjustedActionCost(active?.spiritCostUnits ?? 0, current.adjustments);
  result.rangeUnits = Math.max(0, checkedAdd(active?.rangeUnits ?? actor.basic.rangeUnits, actionAdjustmentSum(current.adjustments, 'rangeUnits')));
  result.castTicks = multiplyDivideFloor(Math.max(0, checkedAdd(active?.castTicks ?? actor.basic.castTicks, actionAdjustmentSum(current.adjustments, 'castTimeTicks'))), 10_000, Math.max(1, 10_000 + queryStat(state, catalog, actorId, 'hasteBps', tags)));
  result.targetTeam = active?.targetTeam ?? 'enemy';
  if (state.ended) return blocked('battle-ended');
  const actorBlock = actorActionBlock(state, catalog, actorId); if (actorBlock) return blocked(actorBlock);
  if (actor.currentActionId) return blocked('actor-casting');
  if (result.cooldownRemainingTicks > 0) return blocked('cooldown');
  const targetBlock = actionTargetBlock(state, actorId, targetId, result.targetTeam, result.rangeUnits, active?.effects.some(effect => effect.kind === 'rescue'));
  if (targetBlock && targetBlock !== 'out-of-range') return blocked(targetBlock);
  if (result.availableSpiritUnits < result.spiritCostUnits) return blocked('insufficient-spirit');
  if (active && !conditionPasses(state, catalog, active.condition, ctx)) return blocked('condition');
  if (targetBlock) return blocked(targetBlock);
  return { ...result, ready: true };
}
