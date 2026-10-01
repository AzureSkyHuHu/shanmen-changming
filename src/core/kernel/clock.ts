import { assertNonNegativeInteger, checkedAdd } from './numeric';

export const TICKS_PER_SECOND = 20;
export const TICK_MILLISECONDS = 50;
/** Prototype calendar pacing: 60 real seconds at 1x is one month. */
export const CALENDAR_TICKS_PER_MONTH = 1200;
export const SYSTEM_ORDER = ['commands', 'expiry', 'economy', 'calendar', 'events', 'snapshot'] as const;
export const SYSTEM_ORDER_VERSION = 1;
export type SimulationMode = 'management' | 'combat';
export type SimulationSpeed = 1 | 3;
export const PAUSE_REASONS = ['player', 'choice', 'danger', 'hidden', 'error'] as const;
export type PauseReason = typeof PAUSE_REASONS[number];
export interface WorldClock {
  simulationTick: number;
  calendarTick: number;
  encounterTick: number;
  mode: SimulationMode;
  speed: SimulationSpeed;
  pauseReasons: PauseReason[];
}

export function createClock(): WorldClock {
  return { simulationTick: 0, calendarTick: 0, encounterTick: 0, mode: 'management', speed: 1, pauseReasons: [] };
}
export function isPaused(clock: WorldClock): boolean { return clock.pauseReasons.length > 0; }
export function setPauseReason(clock: WorldClock, reason: PauseReason, paused: boolean): WorldClock {
  return { ...clock, pauseReasons: PAUSE_REASONS.filter((entry) => entry === reason ? paused : clock.pauseReasons.includes(entry)) };
}
export function setClockSpeed(clock: WorldClock, speed: SimulationSpeed): WorldClock { return { ...clock, speed }; }
export function setClockMode(clock: WorldClock, mode: SimulationMode): WorldClock { return { ...clock, mode }; }
export function tickClock(clock: WorldClock): WorldClock {
  if (isPaused(clock)) return clock;
  return {
    ...clock,
    simulationTick: checkedAdd(clock.simulationTick, 1),
    calendarTick: clock.mode === 'management' ? checkedAdd(clock.calendarTick, 1) : clock.calendarTick,
    encounterTick: clock.mode === 'combat' ? checkedAdd(clock.encounterTick, 1) : clock.encounterTick,
  };
}

/** Adapter-owned timing state; no wall clock, timers or hidden elapsed time in the core. */
export interface FrameAccumulator { remainderMicroseconds: number }
export function createFrameAccumulator(): FrameAccumulator { return { remainderMicroseconds: 0 }; }
export function accumulateFrame(accumulator: FrameAccumulator, elapsedMilliseconds: number, clock: WorldClock, maxTicks = 120): { accumulator: FrameAccumulator; ticks: number } {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) throw new RangeError('Invalid frame delta');
  assertNonNegativeInteger(maxTicks, 'maxTicks');
  assertNonNegativeInteger(accumulator.remainderMicroseconds, 'frame remainder');
  // Paused wall time is discarded; pre-pause incomplete-tick remainder is retained.
  if (isPaused(clock)) return { accumulator: { ...accumulator }, ticks: 0 };
  const elapsed = Math.floor(elapsedMilliseconds * 1000) * clock.speed;
  assertNonNegativeInteger(elapsed, 'elapsed microseconds');
  const total = checkedAdd(accumulator.remainderMicroseconds, elapsed);
  const ticks = Math.min(Math.floor(total / 50000), maxTicks);
  // Keep the backlog when the catch-up budget is exhausted: never skip ticks.
  return { accumulator: { remainderMicroseconds: total - ticks * 50000 }, ticks };
}
