import type { CombatContentCatalog } from '../definitions';
import { canonicalStringify, stableHash } from '../../kernel/serialization';
import { restoreBattle, serializeBattle, upgradeLegacyBattleSnapshot } from '../runtime';
import { definition } from '../runtime/queries';
import { immutableController, validateControllerConfig } from './controller';
import { COMBAT_CONTROLLER_VERSION } from './types';
import type { CombatControllerData, CombatControllerState } from './types';
function fail(reason: string): never { throw new Error(`Invalid combat controller snapshot: ${reason}`); }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail('object shape'); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail('integer'); }
function tree(value: unknown, depth = 0): void { if (depth > 40) fail('nesting'); if (value === null || typeof value === 'string' || typeof value === 'boolean') return; if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('integer'); return; } if (Array.isArray(value)) { if (value.length > 10_000) fail('array bound'); for (const child of value) tree(child, depth + 1); return; } if (typeof value !== 'object') fail('JSON'); for (const [key, child] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe key'); tree(child, depth + 1); } }
export function serializeCombatController(state: CombatControllerState): string {
  const payload = { ...state, battle: serializeBattle(state.battle) };
  return canonicalStringify({ version: COMBAT_CONTROLLER_VERSION, checksum: stableHash(payload), state: payload });
}
function readController(text: string, catalog: CombatContentCatalog, expectedConfigHash?: string, legacy = false): CombatControllerState {
  if (text.length > 16_000_000) fail('size'); const envelope: unknown = JSON.parse(text); tree(envelope); object(envelope, ['version', 'checksum', 'state']);
  if (envelope.version !== (legacy ? 1 : COMBAT_CONTROLLER_VERSION) || envelope.checksum !== stableHash(envelope.state)) fail('version/checksum');
  object(envelope.state, ['version', 'battle', 'config', 'configHash', 'startTick', 'elapsedTicks', 'nextOrderSequence', 'navigationCursor', 'agents', 'orders', 'guardReadyAt', 'outcome', 'diagnostics']);
  if (envelope.state.version !== (legacy ? 1 : COMBAT_CONTROLLER_VERSION) || typeof envelope.state.battle !== 'string') fail('version/battle');
  const configValue = envelope.state.config; object(configValue, ['playerTeam', 'arena', 'maximumTicks', 'decisionIntervalTicks', 'movementIntervalTicks', 'guardCooldownTicks', 'orderDurationTicks', 'policies']);
  const battle = legacy ? upgradeLegacyBattleSnapshot(envelope.state.battle, catalog, configValue.arena as CombatControllerData['config']['arena']) : restoreBattle(envelope.state.battle, catalog); const state = { ...envelope.state, version: COMBAT_CONTROLLER_VERSION, battle } as unknown as CombatControllerData;
  object(state.config, ['playerTeam', 'arena', 'maximumTicks', 'decisionIntervalTicks', 'movementIntervalTicks', 'guardCooldownTicks', 'orderDurationTicks', 'policies']);
  object(state.config.arena, ['origin', 'widthCells', 'heightCells', 'cellSizeUnits', 'blockedCells']); object(state.config.arena.origin, ['x', 'y']);
  if (!Array.isArray(state.config.arena.blockedCells)) fail('blocked cells'); for (const cell of state.config.arena.blockedCells) object(cell, ['x', 'y']);
  if (!state.config.policies || typeof state.config.policies !== 'object' || Array.isArray(state.config.policies)) fail('policies'); for (const policy of Object.values(state.config.policies)) object(policy, ['skillPriority', 'healBelowBps', 'minimumSpiritReserve', 'allowUltimates', 'seekInterrupts']);
  validateControllerConfig(state.config, battle, catalog);
  if (state.configHash !== stableHash(state.config) || (expectedConfigHash !== undefined && expectedConfigHash !== state.configHash)) fail('arena/policy fingerprint');
  for (const value of [state.startTick, state.elapsedTicks, state.nextOrderSequence, state.navigationCursor]) integer(value); if (state.nextOrderSequence < 1 || state.startTick + state.elapsedTicks !== battle.tick || state.elapsedTicks > state.config.maximumTicks) fail('controller clock');
  object(state.agents, Object.keys(battle.entities).filter(id => battle.entities[id]!.kind === 'combatant')); if (state.navigationCursor >= Object.keys(state.agents).length) fail('navigation cursor');
  for (const agent of Object.values(state.agents)) { object(agent, ['nextDecisionTick', 'nextMovementTick', 'desiredTargetId', 'desiredRangeUnits', 'lastChoice']); integer(agent.nextDecisionTick); integer(agent.nextMovementTick); integer(agent.desiredRangeUnits, 1_000_000); if (agent.desiredTargetId !== null && !battle.entities[agent.desiredTargetId]) fail('desired target'); if (agent.lastChoice !== null && agent.lastChoice !== 'runtime.basic' && definition(catalog, agent.lastChoice).kind !== 'skill') fail('choice'); }
  if (!Array.isArray(state.orders) || state.orders.length > Object.keys(battle.entities).length + 1) fail('orders'); const orderKeys = new Set<string>();
  for (const order of state.orders) { object(order, ['kind', 'actorId', 'targetId', 'expiresAtTick', 'sequence']); integer(order.expiresAtTick); integer(order.sequence); const actor = battle.entities[order.actorId]; const target = order.targetId ? battle.entities[order.targetId] : null; if (!actor || actor.kind !== 'combatant' || actor.team !== state.config.playerTeam || !['focus', 'guard', 'hold'].includes(order.kind) || order.expiresAtTick <= battle.tick || order.sequence < 1 || order.sequence >= state.nextOrderSequence || (order.kind === 'hold' ? order.targetId !== null : !target || (target.team === actor.team) !== (order.kind === 'guard'))) fail('order'); const key = order.kind === 'focus' ? 'focus' : order.actorId; if (orderKeys.has(key)) fail('duplicate order'); orderKeys.add(key); }
  if (!state.guardReadyAt || typeof state.guardReadyAt !== 'object' || Array.isArray(state.guardReadyAt)) fail('guard pacing'); for (const [team, tick] of Object.entries(state.guardReadyAt)) { if (team !== state.config.playerTeam) fail('guard team'); integer(tick); }
  object(state.outcome, ['status', 'reason', 'resolvedTick', 'winnerTeam']); if (!['running', 'victory', 'defeat', 'draw'].includes(state.outcome.status) || !['ongoing', 'team-eliminated', 'mutual-elimination', 'timeout'].includes(state.outcome.reason)) fail('outcome');
  if (state.outcome.status === 'running' ? state.outcome.reason !== 'ongoing' || state.outcome.resolvedTick !== null || state.outcome.winnerTeam !== null || battle.ended : state.outcome.reason === 'ongoing' || state.outcome.resolvedTick !== battle.tick || !battle.ended) fail('outcome boundary');
  if (!Array.isArray(state.diagnostics) || state.diagnostics.length > 64) fail('diagnostics'); for (const entry of state.diagnostics) { object(entry, ['tick', 'actorId', 'reason']); integer(entry.tick); if (entry.tick > battle.tick || typeof entry.actorId !== 'string' || typeof entry.reason !== 'string') fail('diagnostic'); }
  return immutableController(state);
}

export function restoreCombatController(text: string, catalog: CombatContentCatalog, expectedConfigHash?: string): CombatControllerState { return readController(text, catalog, expectedConfigHash); }
/** Frozen v1 readers are opt-in migration APIs; normal restore rejects legacy snapshots. */
export function upgradeLegacyCombatControllerSnapshot(text: string, catalog: CombatContentCatalog, expectedConfigHash?: string): CombatControllerState { return readController(text, catalog, expectedConfigHash, true); }
export function upgradeLegacyCombatControllerState(value: unknown, catalog: CombatContentCatalog, expectedConfigHash?: string): CombatControllerState {
  tree(value); object(value, ['version', 'battle', 'config', 'configHash', 'startTick', 'elapsedTicks', 'nextOrderSequence', 'navigationCursor', 'agents', 'orders', 'guardReadyAt', 'outcome', 'diagnostics']);
  if (value.version !== 1) fail('legacy controller version');
  const battle = canonicalStringify({ snapshotVersion: 1, simulationVersion: 'combat-runtime-1', checksum: stableHash(value.battle), state: value.battle });
  const state = { ...value, battle }; return upgradeLegacyCombatControllerSnapshot(canonicalStringify({ version: 1, checksum: stableHash(state), state }), catalog, expectedConfigHash);
}
