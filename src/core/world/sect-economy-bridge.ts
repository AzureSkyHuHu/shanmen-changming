import { applySectEconomyCommand } from '../sect-economy/state';
import type { SectEconomyCommand, SectEconomyError } from '../sect-economy/types';
import type { WorldState } from './types';

/** Fail closed until the independently versioned retention/admission contract is implemented. */
export const WORLD_AUTO_START_ALLOWANCE: number = 2;
export interface WorldSectEconomyResult { kind: SectEconomyCommand['kind']; workerId: string | null }
export type WorldSectEconomyTransition = { ok: true; world: WorldState; result: WorldSectEconomyResult }
  | { ok: false; code: SectEconomyError };

/** Configuration only. Kernel owns immutable command identity and exact retry results. */
export function dispatchWorldSectEconomy(world: WorldState, command: SectEconomyCommand): WorldSectEconomyTransition {
  const operation = applySectEconomyCommand(world.sectEconomy, command, world.disciples.map((disciple) => disciple.id));
  if (!operation.ok) return operation;
  return { ok: true, world: { ...world, sectEconomy: operation.state, automaticProduction: command.kind === 'enabled.set'
      ? { ...world.automaticProduction, activationReviewRequired: false } : world.automaticProduction },
    result: { kind: command.kind, workerId: command.kind === 'plan.set' ? command.plan.workerId : null } };
}
