import type { CombatContentCatalog, EffectPrimitive } from '../definitions';
import { checkedAdd, multiplyDivideFloor } from '../../kernel/numeric';
import { compareStable, stableHash } from '../../kernel/serialization';
import { arenaWalkable, battleCell, bindBattleArena, endBattle, issueCommand, queryCastReadiness, queryStat, shieldUnits, statusStacks, stepBattle, validateBattleArena } from '../runtime';
import type { BattleMovementIntent, BattleState } from '../runtime';
import { copyCombatData } from '../runtime/catalog';
import { alive, definition, statusActive, within } from '../runtime/queries';
import { approachBattleTarget } from './navigation';
import { COMBAT_CONTROLLER_VERSION } from './types';
import type { CombatControllerConfig, CombatControllerData, CombatControllerOptions, CombatControllerState, TacticalCommand, UnitCombatPolicy } from './types';

export const MAX_COMBAT_PATH_REQUESTS_PER_TICK = 4;
export const DEFAULT_COMBAT_POLICY: UnitCombatPolicy = Object.freeze({ skillPriority: Object.freeze([] as string[]), healBelowBps: 6500, minimumSpiritReserve: 0, allowUltimates: false, seekInterrupts: true });
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
export const immutableController = (state: CombatControllerData): CombatControllerState => { for (const agent of Object.values(state.agents)) if (agent.desiredTargetId && !state.battle.entities[agent.desiredTargetId]) { agent.desiredTargetId = null; agent.desiredRangeUnits = 0; } return freeze(state); };
function draft(state: CombatControllerState): CombatControllerData { return { ...copyCombatData({ ...state, battle: null }), battle: state.battle }; }
function integer(value: number, name: string, minimum = 0, maximum = 1_000_000): void { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid controller ${name}`); }
export function validateControllerConfig(config: CombatControllerConfig, battle: BattleState, catalog: CombatContentCatalog): void {
  validateBattleArena(config.arena); if (!battle.arena || stableHash(battle.arena) !== stableHash(config.arena)) throw new Error('Controller/runtime arena mismatch'); if (!Object.values(battle.entities).some(entity => entity.team === config.playerTeam)) throw new Error('Player team absent from battle');
  integer(config.maximumTicks, 'maximum ticks', 1); integer(config.decisionIntervalTicks, 'decision interval', 1, 1000); integer(config.movementIntervalTicks, 'movement interval', 1, 1000); integer(config.guardCooldownTicks, 'guard cooldown', 1, 10_000); integer(config.orderDurationTicks, 'order duration', 1, 10_000);
  const occupied = new Set<string>();
  for (const entity of Object.values(battle.entities)) {
    if (!battleCell(config.arena, entity.position) || !arenaWalkable(config.arena, entity.position)) throw new Error('Battle entity is outside the walkable arena grid');
    const key = `${entity.position.x},${entity.position.y}`; if (entity.life !== 'Dead') { if (occupied.has(key)) throw new Error('Battle entities overlap'); occupied.add(key); }
    if (entity.kind === 'summon') continue;
    const policy = config.policies[entity.id]; if (!policy || !Array.isArray(policy.skillPriority) || typeof policy.allowUltimates !== 'boolean' || typeof policy.seekInterrupts !== 'boolean') throw new Error('Invalid unit policy');
    integer(policy.healBelowBps, 'heal threshold', 0, 10_000); integer(policy.minimumSpiritReserve, 'spirit reserve', 0, 1_000_000);
    if (new Set(policy.skillPriority).size !== policy.skillPriority.length || policy.skillPriority.some(id => definition(catalog, id).kind !== 'skill')) throw new Error('Invalid skill priority');
  }
  if (Object.keys(config.policies).some(id => !battle.entities[id] || battle.entities[id]!.kind !== 'combatant')) throw new Error('Policy for unknown entity');
}
function diagnostic(state: CombatControllerData, actorId: string, reason: string): void { state.diagnostics.push({ tick: state.battle.tick, actorId, reason }); if (state.diagnostics.length > 64) state.diagnostics.splice(0, state.diagnostics.length - 64); }
function controllable(state: BattleState, catalog: CombatContentCatalog, actorId: string): boolean { const actor = state.entities[actorId]; return !!actor && actor.kind === 'combatant' && alive(state, actorId) && actor.health > 0 && actor.recoveryUntilTick <= state.tick && !actor.currentActionId && !state.statuses.some(status => { if (status.holderId !== actorId || !statusActive(state, catalog, status)) return false; const d = definition(catalog, status.definitionId); return d.kind === 'status' && d.actionLock === 'untilRemoved'; }); }
function settleOutcome(state: CombatControllerData, catalog: CombatContentCatalog): void {
  if (state.outcome.status !== 'running') return;
  const liveTeams = [...new Set(Object.values(state.battle.entities).filter(entity => entity.kind === 'combatant' && alive(state.battle, entity.id) && entity.health > 0).map(entity => entity.team))].sort(compareStable);
  const playerAlive = liveTeams.includes(state.config.playerTeam); const hostileAlive = liveTeams.some(team => team !== state.config.playerTeam);
  if (!playerAlive || !hostileAlive) {
    const status = !playerAlive && !hostileAlive ? 'draw' : playerAlive ? 'victory' : 'defeat';
    state.outcome = { status, reason: liveTeams.length === 0 ? 'mutual-elimination' : 'team-eliminated', resolvedTick: state.battle.tick, winnerTeam: status === 'victory' ? state.config.playerTeam : status === 'defeat' && liveTeams.length === 1 ? liveTeams[0]! : null };
  } else if (state.elapsedTicks >= state.config.maximumTicks) state.outcome = { status: 'draw', reason: 'timeout', resolvedTick: state.battle.tick, winnerTeam: null };
  if (state.outcome.status !== 'running') { for (const actor of Object.values(state.battle.entities)) if (state.battle.focusByTeam[actor.team]) state.battle = issueCommand(state.battle, catalog, { kind: 'clearFocus', actorId: actor.id }); state.orders = []; state.battle = endBattle(state.battle, catalog); }
}
export function createCombatController(catalog: CombatContentCatalog, battle: BattleState, options: CombatControllerOptions): CombatControllerState {
  if (battle.ended) throw new Error('Cannot control an ended battle');
  battle = bindBattleArena(battle, catalog, options.arena);
  const policies: Record<string, UnitCombatPolicy> = {};
  for (const entity of Object.values(battle.entities).filter(entity => entity.kind === 'combatant')) policies[entity.id] = { ...DEFAULT_COMBAT_POLICY, ...copyCombatData(options.policies?.[entity.id] ?? {}), skillPriority: [...(options.policies?.[entity.id]?.skillPriority ?? [])] };
  if (Object.keys(options.policies ?? {}).some(id => !battle.entities[id] || battle.entities[id]!.kind !== 'combatant')) throw new Error('Policy for unknown entity');
  const config: CombatControllerConfig = { playerTeam: options.playerTeam, arena: copyCombatData(options.arena), maximumTicks: options.maximumTicks ?? 2400, decisionIntervalTicks: options.decisionIntervalTicks ?? 4, movementIntervalTicks: options.movementIntervalTicks ?? 2, guardCooldownTicks: options.guardCooldownTicks ?? 80, orderDurationTicks: options.orderDurationTicks ?? 100, policies };
  validateControllerConfig(config, battle, catalog);
  const agents = Object.fromEntries(Object.keys(battle.entities).filter(id => battle.entities[id]!.kind === 'combatant').sort(compareStable).map(id => [id, { nextDecisionTick: battle.tick, nextMovementTick: battle.tick, desiredTargetId: null, desiredRangeUnits: 0, lastChoice: null }]));
  const state: CombatControllerData = { version: COMBAT_CONTROLLER_VERSION, battle, config, configHash: stableHash(config), startTick: battle.tick, elapsedTicks: 0, nextOrderSequence: 1, navigationCursor: 0, agents, orders: [], guardReadyAt: {}, outcome: { status: 'running', reason: 'ongoing', resolvedTick: null, winnerTeam: null }, diagnostics: [] };
  settleOutcome(state, catalog); return immutableController(state);
}
function expireOrders(state: CombatControllerData, catalog: CombatContentCatalog): void {
  for (const order of state.orders) if (order.kind === 'focus' && (order.expiresAtTick <= state.battle.tick || !alive(state.battle, order.actorId) || !order.targetId || !alive(state.battle, order.targetId))) state.battle = issueCommand(state.battle, catalog, { kind: 'clearFocus', actorId: order.actorId });
  state.orders = state.orders.filter(order => order.expiresAtTick > state.battle.tick && alive(state.battle, order.actorId) && (order.targetId === null || alive(state.battle, order.targetId)));
}
export function issueTacticalOrder(previous: CombatControllerState, catalog: CombatContentCatalog, command: TacticalCommand): CombatControllerState {
  const state = draft(previous); const actor = state.battle.entities[command.actorId];
  if (!['focus', 'guard', 'hold', 'clearFocus', 'cast'].includes(command.kind)) { diagnostic(state, command.actorId, 'unsupported-tactical-command'); return immutableController(state); }
  if (state.outcome.status !== 'running' || !actor || actor.kind !== 'combatant' || actor.team !== state.config.playerTeam || !alive(state.battle, actor.id)) { diagnostic(state, command.actorId, 'unavailable-tactical-actor'); return immutableController(state); }
  if (command.kind === 'clearFocus') { state.orders = state.orders.filter(order => order.kind !== 'focus'); state.battle = issueCommand(state.battle, catalog, command); return immutableController(state); }
  if (command.kind === 'cast') { state.battle = issueCommand(state.battle, catalog, command); state.agents[actor.id]!.nextDecisionTick = checkedAdd(state.battle.tick, state.config.decisionIntervalTicks); expireOrders(state, catalog); settleOutcome(state, catalog); return immutableController(state); }
  const duration = command.durationTicks ?? state.config.orderDurationTicks; integer(duration, 'order duration', 1, 10_000);
  const target = command.kind === 'hold' ? null : state.battle.entities[command.targetId];
  if (command.kind !== 'hold' && (!target || !alive(state.battle, target.id) || (target.team === actor.team) !== (command.kind === 'guard'))) { diagnostic(state, actor.id, 'invalid-tactical-target'); return immutableController(state); }
  if (command.kind === 'guard' && (state.guardReadyAt[actor.team] ?? 0) > state.battle.tick) { diagnostic(state, actor.id, 'guard-command-cooldown'); return immutableController(state); }
  if (command.kind === 'focus' || command.kind === 'guard') {
    const rejected = state.battle.statistics.rejectedCommands;
    state.battle = issueCommand(state.battle, catalog, { kind: command.kind, actorId: actor.id, targetId: target!.id });
    if (state.battle.statistics.rejectedCommands > rejected) { diagnostic(state, actor.id, 'tactical-issuer-locked'); return immutableController(state); }
    if (command.kind === 'guard') state.guardReadyAt[actor.team] = checkedAdd(state.battle.tick, state.config.guardCooldownTicks);
  }
  if (command.kind === 'focus') state.orders = state.orders.filter(order => order.kind !== 'focus');
  else state.orders = state.orders.filter(order => order.actorId !== actor.id || order.kind === 'focus');
  state.orders.push({ kind: command.kind, actorId: actor.id, targetId: target?.id ?? null, expiresAtTick: checkedAdd(state.battle.tick, duration), sequence: state.nextOrderSequence }); state.nextOrderSequence = checkedAdd(state.nextOrderSequence, 1);
  state.agents[actor.id]!.nextDecisionTick = state.battle.tick;
  return immutableController(state);
}
function healthOrder(state: BattleState, catalog: CombatContentCatalog, a: string, b: string): number { const left = state.entities[a]!; const right = state.entities[b]!; return multiplyDivideFloor(left.health, 10_000, queryStat(state, catalog, a, 'maxHealth')) - multiplyDivideFloor(right.health, 10_000, queryStat(state, catalog, b, 'maxHealth')) || compareStable(a, b); }
function offensiveTargets(state: CombatControllerData, actorId: string): string[] {
  const actor = state.battle.entities[actorId]!; const guard = state.orders.find(order => order.kind === 'guard' && order.actorId === actorId); const focus = state.orders.find(order => order.kind === 'focus' && state.battle.entities[order.actorId]?.team === actor.team)?.targetId;
  return Object.keys(state.battle.entities).filter(id => alive(state.battle, id) && state.battle.entities[id]!.team !== actor.team).sort((a, b) => {
    const focused = Number(b === focus) - Number(a === focus); if (focused) return focused;
    if (guard?.targetId) { const threatens = (id: string) => { const unit = state.battle.entities[id]!; return !!unit.currentActionId && state.battle.actions[unit.currentActionId]?.targetId === guard.targetId; }; const threat = Number(threatens(b)) - Number(threatens(a)); if (threat) return threat; }
    const decoy = (id: string) => state.battle.summons.some(summon => summon.entityId === id && summon.role === 'threatDecoy');
    const decoyPreference = Number(decoy(b)) - Number(decoy(a)); if (decoyPreference) return decoyPreference;
    const anchor = guard?.targetId ? state.battle.entities[guard.targetId]!.position : actor.position;
    const distance = (id: string) => { const position = state.battle.entities[id]!.position; return (position.x - anchor.x) ** 2 + (position.y - anchor.y) ** 2; };
    return distance(a) - distance(b) || compareStable(a, b);
  });
}
function hasEffect(effects: readonly EffectPrimitive[], kind: EffectPrimitive['kind']): boolean { return effects.some(effect => effect.kind === kind || (effect.kind === 'zone' && hasEffect(effect.effects, kind))); }
interface Choice { skillId: string | null; targetId: string; rangeUnits: number; score: number }
function chooseAction(state: CombatControllerData, catalog: CombatContentCatalog, actorId: string): Choice | null {
  const battle = state.battle; const actor = battle.entities[actorId]!; const policy = state.config.policies[actorId]!;
  const enemies = offensiveTargets(state, actorId); const allies = Object.keys(battle.entities).filter(id => battle.entities[id]!.kind === 'combatant' && alive(battle, id) && battle.entities[id]!.team === actor.team).sort((a, b) => healthOrder(battle, catalog, a, b));
  const candidates: Choice[] = [];
  for (const skillId of actor.skills) {
    const d = definition(catalog, skillId); if (d.kind !== 'skill' || d.activation !== 'active' || (d.ultimate && !policy.allowUltimates)) continue;
    const effects = d.action.effects; const rescue = hasEffect(effects, 'rescue'); const healing = hasEffect(effects, 'heal'); const shielding = hasEffect(effects, 'shield'); const cleanse = hasEffect(effects, 'dispel');
    let targets = d.action.targetTeam === 'self' ? [actorId] : d.action.targetTeam === 'enemy' ? enemies : allies;
    if (rescue) targets = Object.keys(battle.entities).filter(id => battle.entities[id]!.kind === 'combatant' && battle.entities[id]!.team === actor.team && battle.entities[id]!.life === 'Downed').sort(compareStable);
    // A zone's periodic healing is healing too. Even a 100% threshold must not
    // spend a healing ultimate when every possible anchor is already full.
    if (healing) targets = targets.filter(id => { const maximum = queryStat(battle, catalog, id, 'maxHealth'); return battle.entities[id]!.health < maximum && multiplyDivideFloor(battle.entities[id]!.health, 10_000, maximum) <= policy.healBelowBps; });
    if (shielding) targets = targets.filter(id => shieldUnits(battle, id) === 0);
    if (cleanse) targets = targets.filter(id => battle.statuses.some(status => { if (status.holderId !== id) return false; const s = definition(catalog, status.definitionId); return s.kind === 'status' && ['poison', 'control', 'debuff'].includes(s.dispelCategory); }));
    for (const targetId of targets) {
      const readiness = queryCastReadiness(battle, catalog, actorId, skillId, targetId);
      if ((!readiness.ready && readiness.reason !== 'out-of-range') || readiness.spiritCostUnits > readiness.availableSpiritUnits - policy.minimumSpiritReserve) continue;
      const required = effects.filter((effect): effect is Extract<EffectPrimitive, { kind: 'consumeStatus' }> => effect.kind === 'consumeStatus');
      if (required.some(effect => statusStacks(battle, catalog, effect.target.kind === 'self' ? actorId : targetId, effect.statusId) < effect.maximumStacks)) continue;
      const target = battle.entities[targetId]!; const action = target.currentActionId ? battle.actions[target.currentActionId] : null;
      const canInterrupt = policy.seekInterrupts && hasEffect(effects, 'interrupt') && action?.state === 'Casting' && action.castEndTick - battle.tick >= readiness.castTicks;
      const priority = policy.skillPriority.indexOf(skillId); const preference = priority < 0 ? 0 : (policy.skillPriority.length - priority) * 10;
      candidates.push({ skillId, targetId, rangeUnits: readiness.rangeUnits, score: (rescue ? 10_000 : healing ? 9000 : canInterrupt ? 8000 : cleanse ? 7000 : shielding ? 6000 : 4000) + preference });
      break;
    }
  }
  if (enemies[0]) { const readiness = queryCastReadiness(battle, catalog, actorId, null, enemies[0]); if (readiness.ready || readiness.reason === 'out-of-range' || readiness.reason === 'cooldown') candidates.push({ skillId: null, targetId: enemies[0], rangeUnits: readiness.rangeUnits, score: 1000 }); }
  candidates.sort((a, b) => b.score - a.score || compareStable(a.skillId ?? '~basic', b.skillId ?? '~basic') || compareStable(a.targetId, b.targetId));
  return candidates[0] ?? null;
}
export function stepCombatController(previous: CombatControllerState, catalog: CombatContentCatalog, ticks = 1): CombatControllerState {
  integer(ticks, 'step ticks', 0, 100_000); if (ticks === 0 || previous.outcome.status !== 'running') return previous;
  const state = draft(previous);
  for (let count = 0; count < ticks && state.outcome.status === 'running'; count++) {
    expireOrders(state, catalog);
    const ids = Object.keys(state.agents).sort(compareStable);
    for (const actorId of ids) {
      const agent = state.agents[actorId]!;
      if (agent.nextDecisionTick > state.battle.tick || !controllable(state.battle, catalog, actorId) || state.orders.some(order => order.actorId === actorId && order.kind === 'hold')) continue;
      agent.nextDecisionTick = checkedAdd(state.battle.tick, state.config.decisionIntervalTicks);
      const choice = chooseAction(state, catalog, actorId); agent.desiredTargetId = choice?.targetId ?? null; agent.desiredRangeUnits = choice?.rangeUnits ?? 0; agent.lastChoice = choice?.skillId ?? (choice ? 'runtime.basic' : null);
      if (!choice || !within(state.battle, actorId, choice.targetId, choice.rangeUnits)) continue;
      const actor = state.battle.entities[actorId]!; if (choice.skillId === null && (actor.cooldowns['runtime.basic'] ?? 0) > state.battle.tick) continue;
      state.battle = issueCommand(state.battle, catalog, choice.skillId === null ? { kind: 'basic', actorId, targetId: choice.targetId } : { kind: 'cast', actorId, skillId: choice.skillId, targetId: choice.targetId });
      expireOrders(state, catalog);
    }
    const movement: BattleMovementIntent[] = []; let pathRequests = 0; const navigationStart = state.navigationCursor;
    for (let offset = 0; offset < ids.length && pathRequests < MAX_COMBAT_PATH_REQUESTS_PER_TICK; offset++) {
      const index = (navigationStart + offset) % ids.length; const actorId = ids[index]!; const agent = state.agents[actorId]!;
      if (agent.nextMovementTick > state.battle.tick || !agent.desiredTargetId || !controllable(state.battle, catalog, actorId) || state.orders.some(order => order.actorId === actorId && order.kind === 'hold') || (!alive(state.battle, agent.desiredTargetId) && state.battle.entities[agent.desiredTargetId]?.life !== 'Downed') || within(state.battle, actorId, agent.desiredTargetId, agent.desiredRangeUnits)) continue;
      agent.nextMovementTick = checkedAdd(state.battle.tick, state.config.movementIntervalTicks); pathRequests++;
      const to = approachBattleTarget(state.battle, state.config.arena, actorId, agent.desiredTargetId, agent.desiredRangeUnits); if (to) movement.push({ actorId, to });
      state.navigationCursor = (index + 1) % ids.length;
    }
    state.battle = stepBattle(state.battle, catalog, 1, { movement: { arena: state.config.arena, intents: movement } }); state.elapsedTicks = checkedAdd(state.elapsedTicks, 1);
    expireOrders(state, catalog); settleOutcome(state, catalog);
  }
  return immutableController(state);
}
