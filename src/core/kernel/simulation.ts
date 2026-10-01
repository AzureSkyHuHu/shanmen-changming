import { tickProduction } from '../economy/production';
import type { WorldState } from '../world/types';
import { CALENDAR_TICKS_PER_MONTH, isPaused, setPauseReason, tickClock } from './clock';
import { compareCommands, dispatchCommand, enqueueCommands } from './commands';
import type { Command } from './contracts';
import { assertNonNegativeInteger } from './numeric';
import { stableHash } from './serialization';

/** Integer ticks only. Speed is converted by the frame adapter, never inside simulation. */
export function advanceTicks(world: WorldState, steps: number, commands: readonly Command[] = []): WorldState {
  assertNonNegativeInteger(steps, 'steps');
  let next = commands.length ? enqueueCommands(world, commands) : world;
  for (let index = 0; index < steps; index += 1) {
    if (isPaused(next.clock)) break;
    const boundary = next;
    try {
      const due = next.pendingCommands.filter((command) => command.issuedTick <= next.clock.simulationTick).sort(compareCommands);
      next = { ...next, pendingCommands: next.pendingCommands.filter((command) => command.issuedTick > next.clock.simulationTick) };
      for (const command of due) next = dispatchCommand(next, command).world;
      // No expiring effects in this starter slice. Reserve the scheduler position for them.
      next = { ...next, clock: tickClock(next.clock) };
      next = tickProduction(next);
      if (next.clock.mode === 'management' && next.clock.calendarTick % CALENDAR_TICKS_PER_MONTH === 0) {
        next = { ...next, disciples: next.disciples.map((disciple) => {
          if (disciple.lifeState !== 'alive') return disciple;
          const ageMonths = Math.floor((next.clock.calendarTick - disciple.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
          return { ...disciple, ageMonths, canWork: ageMonths >= 16 * 12 };
        }) };
      }
    } catch (error) {
      // Roll the incomplete tick back, preserve a diagnosable complete boundary, and stop.
      next = { ...boundary, clock: setPauseReason(boundary.clock, 'error', true), diagnostics: [...boundary.diagnostics, { code: 'INVARIANT_FAILURE', tick: boundary.clock.simulationTick, message: error instanceof Error ? error.message : 'Unknown kernel invariant failure' }] };
      break;
    }
  }
  return next;
}

/** Replay hash omits rate/pause controls; snapshot checksum includes them. Mode remains authoritative. */
export function domainHash(world: WorldState): string {
  const { speed: _speed, pauseReasons: _pauseReasons, ...clock } = world.clock;
  return stableHash({ ...world, clock });
}
