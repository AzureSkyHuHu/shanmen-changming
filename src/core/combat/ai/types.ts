import type { BattleArena, BattleState, DeepReadonly } from '../runtime';
export const COMBAT_CONTROLLER_VERSION = 2 as const;
export interface UnitCombatPolicy {
  readonly skillPriority: readonly string[];
  readonly healBelowBps: number;
  readonly minimumSpiritReserve: number;
  readonly allowUltimates: boolean;
  readonly seekInterrupts: boolean;
}
export interface CombatControllerOptions {
  readonly playerTeam: string;
  readonly arena: BattleArena;
  readonly maximumTicks?: number;
  readonly decisionIntervalTicks?: number;
  readonly movementIntervalTicks?: number;
  readonly guardCooldownTicks?: number;
  readonly orderDurationTicks?: number;
  readonly policies?: Readonly<Record<string, Partial<UnitCombatPolicy>>>;
}
export interface CombatControllerConfig {
  playerTeam: string; arena: BattleArena; maximumTicks: number; decisionIntervalTicks: number;
  movementIntervalTicks: number; guardCooldownTicks: number; orderDurationTicks: number;
  policies: Record<string, UnitCombatPolicy>;
}
export interface CombatAgentState { nextDecisionTick: number; nextMovementTick: number; desiredTargetId: string | null; desiredRangeUnits: number; lastChoice: string | null }
export interface TacticalOrder { kind: 'focus' | 'guard' | 'hold'; actorId: string; targetId: string | null; expiresAtTick: number; sequence: number }
export type TacticalCommand =
  | { readonly kind: 'focus' | 'guard'; readonly actorId: string; readonly targetId: string; readonly durationTicks?: number }
  | { readonly kind: 'hold'; readonly actorId: string; readonly durationTicks?: number }
  | { readonly kind: 'clearFocus'; readonly actorId: string }
  | { readonly kind: 'cast'; readonly actorId: string; readonly skillId: string; readonly targetId: string };
export interface CombatOutcome { status: 'running' | 'victory' | 'defeat' | 'draw'; reason: 'ongoing' | 'team-eliminated' | 'mutual-elimination' | 'timeout'; resolvedTick: number | null; winnerTeam: string | null }
export interface ControllerDiagnostic { tick: number; actorId: string; reason: string }
export interface CombatControllerData {
  version: typeof COMBAT_CONTROLLER_VERSION; battle: BattleState; config: CombatControllerConfig;
  configHash: string; startTick: number; elapsedTicks: number; nextOrderSequence: number; navigationCursor: number;
  agents: Record<string, CombatAgentState>; orders: TacticalOrder[]; guardReadyAt: Record<string, number>;
  outcome: CombatOutcome; diagnostics: ControllerDiagnostic[];
}
export type CombatControllerState = DeepReadonly<CombatControllerData>;
