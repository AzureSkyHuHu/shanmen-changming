import { stepCultivationMonthsV3, synchronizeCultivationAgesV3 } from '../cultivation/v3';
import type { CultivationFrame, CultivationState } from '../cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import type { WorldClock } from '../kernel/clock';
import type { DomainEvent } from '../kernel/contracts';
import { checkedAdd } from '../kernel/numeric';
import type { Disciple } from './types';

/** Internal schema-3 preparation port, independent of the enclosing World version.
 * A frame is not a publishable World: the version owner must reconcile every work
 * owner, progression and death/estate obligation, authenticate aggregate ownership,
 * and admit the complete candidate before publishing it. */
export interface CultivationPreparationSource extends CultivationFrame {
  clock: WorldClock;
  disciples: Disciple[];
}

export const cultivationFrameOf = (source: CultivationFrame): CultivationFrame => ({
  cultivation: source.cultivation, inventory: source.inventory,
  randomStreams: source.randomStreams, sequences: source.sequences,
});

/** Called after the owning management clock has advanced. Do not use a newly set
 * decision pause to pretend that clock advance did not occur, or clear the pause
 * to make later work run. A null result means no cultivation frame changed. */
export function prepareCultivationClockAdvance(source: CultivationPreparationSource): CultivationFrame | null {
  if (source.clock.mode !== 'management') return null;
  const ages: Record<string, number> = {}; let changed = false;
  for (const actor of source.disciples) {
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id); if (!profile) throw new TypeError('Missing cultivation identity');
    if (profile.lifeState !== 'alive') continue;
    ages[actor.id] = Math.floor(checkedAdd(source.clock.calendarTick, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
    if (ages[actor.id] !== profile.ageMonths) changed = true;
  }
  const month = Math.floor(source.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
  if (month !== source.cultivation.calendarMonth) {
    if (month !== source.cultivation.calendarMonth + 1) throw new TypeError('Cultivation calendar skipped a month');
    const step = stepCultivationMonthsV3(cultivationFrameOf(source), 1, { ages });
    if (step.processedMonths !== 1) throw new TypeError(`Cultivation month failed: ${step.stopped}`); return step.frame;
  }
  if (!changed) return null;
  const synced = synchronizeCultivationAgesV3(cultivationFrameOf(source), ages);
  if (!synced.ok) throw new TypeError(`Cultivation birthday failed: ${synced.code}`); return synced.frame;
}

/** Reuses the exact domain identities; World history admission belongs to its
 * version. Kept separate from life projection so legacy failure order is intact. */
export function prepareCultivationWorldEvents(source: Pick<CultivationPreparationSource, 'cultivation' | 'clock'>, frame: CultivationFrame): DomainEvent[] {
  return frame.cultivation.events.slice(source.cultivation.events.length).map(event => ({
    eventId: event.eventId, kind: event.kind, tick: source.clock.simulationTick, rootActionId: event.rootActionId, parentEventId: null,
    payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month },
  }));
}

/** Compatibility mirrors only. This never releases a job, retires an identity,
 * transfers an item, allocates an ID or authorizes a complete candidate. */
export function projectCultivationDisciples<T extends Disciple>(disciples: T[], cultivation: CultivationState): T[] {
  return disciples.map(actor => {
    const profile = cultivation.disciples.find(member => member.discipleId === actor.id)!;
    return { ...actor, lifeState: profile.lifeState, ageMonths: profile.ageMonths,
      canWork: profile.lifeState !== 'alive' ? false : profile.ageMonths !== actor.ageMonths ? profile.ageMonths >= 16 * 12 : actor.canWork };
  });
}
