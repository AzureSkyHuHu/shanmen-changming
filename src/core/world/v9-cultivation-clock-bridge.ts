import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { checkedAdd } from '../kernel/numeric';
import { prepareCultivationClockAdvance } from './cultivation-preparation';
import { composeV9CultivationFrame } from './v9-cultivation-bridge';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';
import type { WorldStateV9 } from './v9-types';

/** Invoked after the candidate clock tick, before lifecycle/work. Reserve the row
 * before calling the reducer; an exhausted candidate cannot advance or consume RNG.
 * Immediate cancellation never calls this bridge or allocates a clock record. */
export function advanceV9CultivationClock(world: WorldStateV9): WorldStateV9 {
  const month = Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
  const monthChanged = month !== world.cultivation.calendarMonth;
  const birthday = world.disciples.some(actor => {
    const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id);
    if (!profile) throw new TypeError('Missing cultivation clock identity');
    return profile.lifeState === 'alive' && Math.floor(checkedAdd(world.clock.calendarTick, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH) !== profile.ageMonths;
  });
  if (!monthChanged && !birthday) return world;
  if (world.cultivationClock.transitions.length >= V9_CULTIVATION_CLOCK_LIMIT) throw new RangeError('Cultivation clock record capacity exhausted');
  const frame = prepareCultivationClockAdvance(world);
  if (!frame || frame.cultivation.revision !== world.cultivation.revision + 1
    || frame.sequences.nextAction !== world.sequences.nextAction + 1) throw new TypeError('Unexpected cultivation clock transition');
  const candidate: WorldStateV9 = { ...world, cultivationClock: { transitions: [...world.cultivationClock.transitions,
    { kind: monthChanged ? 'month' : 'age-sync', tick: world.clock.simulationTick,
      beforeRevision: world.cultivation.revision, rootActionId: `action:${world.sequences.nextAction}` }] } };
  return composeV9CultivationFrame(candidate, frame);
}
