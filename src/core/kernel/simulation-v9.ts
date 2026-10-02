import { createWorkPathBudget } from '../agents/work-navigation';
import { automaticWorkContext, startAutomaticProduction } from '../economy/automatic-production';
import { planAutomaticWork } from '../sect-economy/planner';
import { MAX_AUTO_STARTS_PER_DECISION } from '../sect-economy/types';
import { advanceV9CultivationClock } from '../world/v9-cultivation-clock-bridge';
import { withV9CultivationPause } from '../world/v9-cultivation-bridge';
import { inspectV9KnownRecordHeadroom } from '../world/v9-record-headroom';
import { prepareV9SectStagesWithoutOptionalGrowth, tickV9LegacyProduction, tickV9SectStages, v9WorkerAvailable, v9WorkOwners } from '../world/v9-sect-bridge';
import type { WorldStateV9 } from '../world/v9-types';
import { isPaused, tickClock } from './clock';
import { canonicalUtf8ByteLength } from '../save-budget';
import { dispatchUnregisteredCommandV9, isCommandV9 } from './commands-v9';
import type { CommandV9, CommandResultV9 } from './contracts-v9';
import { assertNonNegativeInteger } from './numeric';
import { canonicalStringify, cloneJson, compareStable, stableHash } from './serialization';
import { inspectUnregisteredWorldV9Records } from './validation';

export interface UnregisteredAdvanceV9Result {
  world: WorldStateV9;
  /** Records/counters only; no save capacity or codec admission is claimed. */
  stopped: null | { kind: 'record-capacity' | 'invalid-records'; details: readonly string[] };
  commandResults: readonly CommandResultV9[];
}
function prepareAutomatic(world: WorldStateV9, boundary: 'record-only' | 'complete-candidate'): WorldStateV9 {
  if (!world.sectEconomy.enabled || world.automaticProduction.activationReviewRequired || isPaused(world.clock)
    || world.clock.simulationTick < world.sectEconomy.nextDecisionTick) return world;
  const context = automaticWorkContext(world, Math.min(MAX_AUTO_STARTS_PER_DECISION, 36 - v9WorkOwners(world).length));
  const decision = planAutomaticWork(world.sectEconomy, { ...context, workers: context.workers.map(worker => ({ ...worker, available: v9WorkerAvailable(world, worker.workerId) })) });
  let next = { ...world, sectEconomy: decision.state };
  for (const intent of decision.intents) {
    if (!v9WorkerAvailable(next, intent.workerId) || v9WorkOwners(next).length >= 36) continue;
    const started = startAutomaticProduction(next, intent);
    if (started.ok && (boundary === 'complete-candidate' || inspectV9KnownRecordHeadroom(started.world).length === 0)) next = started.world;
  }
  return next;
}
/** Real fixed ticks, no second sect clock. Lifecycle is reconciled before any work;
 * a newly-created decision pause keeps that already-advanced tick but grants no work.
 * Commands are immediate boundary inputs, not a persisted v9 queue. */
export function advanceUnregisteredTicksV9(world: WorldStateV9, steps: number, commands: readonly CommandV9[] = []): UnregisteredAdvanceV9Result {
  assertNonNegativeInteger(steps, 'steps');
  let next = world; const commandResults: CommandResultV9[] = [];
  try {
    const errors = inspectUnregisteredWorldV9Records(next);
    if (errors.length) return { world, stopped: { kind: 'invalid-records', details: errors }, commandResults };
    if (next.pendingCommands.length) return { world, stopped: { kind: 'invalid-records', details: ['The internal v9 queue is not registered'] }, commandResults };
    canonicalUtf8ByteLength(commands);
    if (!Array.isArray(commands) || commands.some(command => !isCommandV9(command))) return { world, stopped: { kind: 'invalid-records', details: ['Invalid immediate v9 commands'] }, commandResults };
    const ordered = cloneJson(commands).slice().sort((a, b) => a.issuedTick - b.issuedTick || a.sequence - b.sequence || compareStable(a.commandId, b.commandId)
      || compareStable(canonicalStringify(a), canonicalStringify(b)));
    for (const command of ordered) { const applied = dispatchUnregisteredCommandV9(next, command); next = applied.world; commandResults.push(applied.result); }
    next = withV9CultivationPause(next);
  } catch (error) { return { world, stopped: { kind: 'invalid-records', details: [error instanceof Error ? error.message : 'Invalid input'] }, commandResults }; }
  for (let i = 0; i < steps; i += 1) {
    if (isPaused(next.clock)) break;
    const boundary = next;
    try {
      next = { ...next, clock: tickClock(next.clock) };
      next = advanceV9CultivationClock(next);
      if (!isPaused(next.clock)) {
        const budget = createWorkPathBudget(next.clock.simulationTick);
        next = prepareAutomatic(next, 'record-only');
        next = tickV9SectStages(next, budget);
        next = tickV9LegacyProduction(next, budget);
      }
      const errors = inspectUnregisteredWorldV9Records(next);
      if (errors.length) return { world: boundary, stopped: { kind: 'invalid-records', details: errors }, commandResults };
      const headroom = inspectV9KnownRecordHeadroom(next);
      if (headroom.length) return { world: boundary, stopped: { kind: 'record-capacity', details: headroom }, commandResults };
    } catch (error) { return { world: boundary, stopped: { kind: error instanceof RangeError ? 'record-capacity' : 'invalid-records', details: [error instanceof Error ? error.message : 'Invalid tick candidate'] }, commandResults }; }
  }
  return { world: next, stopped: null, commandResults };
}
export function unregisteredV9DomainHash(world: WorldStateV9): string {
  const { speed: _speed, pauseReasons: _pauseReasons, ...clock } = world.clock; return stableHash({ ...world, clock });
}

/** Internal complete-candidate preparations, never publication/admission. No caller
 * permission flag can claim recovery or bypass the complete capacity gate. */
export function prepareNormalTickCandidateV9(world: WorldStateV9): WorldStateV9 {
  let next = advanceV9CultivationClock({ ...world, clock: tickClock(world.clock) });
  if (isPaused(next.clock)) return next;
  const budget = createWorkPathBudget(next.clock.simulationTick);
  next = prepareAutomatic(next, 'complete-candidate');
  next = tickV9SectStages(next, budget);
  return tickV9LegacyProduction(next, budget);
}
export function prepareNoOptionalGrowthTickCandidateV9(world: WorldStateV9): WorldStateV9 {
  let next = advanceV9CultivationClock({ ...world, clock: tickClock(world.clock) });
  if (isPaused(next.clock)) return next;
  const budget = createWorkPathBudget(next.clock.simulationTick);
  next = prepareV9SectStagesWithoutOptionalGrowth(next, budget);
  return tickV9LegacyProduction(next, budget);
}
