import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { validateWorldStateV8 } from '../kernel/validation';
import { canonicalUtf8ByteLength } from '../save-budget';
import { lookupEvent } from '../world/history-access';
import type { WorldStateV8 } from '../world/v8-types';

// Runtime provenance is module-owned. TypeScript's private constructor is only a type check:
// Reflect.construct can still install a genuine #deaths brand on a forged instance.
const admittedHistoricalSources = new WeakSet<object>();
interface HistoricalDeathAnchor { readonly tick: number; readonly calendarMinimum: number; readonly calendarMaximum: number }

/** A transient, version-authenticated identity view, never save data or a supplied ID list.
 * Only terminal references may use it. A retired person has no spatial actor or work claim.
 * A future World version needs its own factory after its complete validator exists. */
class SectHistoricalIdentitySource {
  readonly #deaths: ReadonlyMap<string, HistoricalDeathAnchor>;
  private constructor(deaths: ReadonlyMap<string, HistoricalDeathAnchor>) {
    this.#deaths = deaths;
    Object.freeze(this);
  }
  static fromWorldV8(world: WorldStateV8): SectHistoricalIdentitySource {
    // Descriptor-only byte walking rejects accessors before the legacy validator reads data.
    canonicalUtf8ByteLength(world);
    if (Object.hasOwn(world, 'sectExpansion') || validateWorldStateV8(world).length) throw new TypeError('Invalid v8 history authority');
    const deaths = new Map<string, HistoricalDeathAnchor>();
    for (const identity of world.legacy.archivedIdentities) {
      const profile = world.cultivation.archivedDisciples.find(value => value.discipleId === identity.discipleId && value.deathId === identity.deathId);
      const estate = world.legacy.estates.find(value => value.discipleId === identity.discipleId && value.deathId === identity.deathId && value.settledMonth !== null);
      const death = world.cultivation.deaths.find(value => value.discipleId === identity.discipleId && value.deathId === identity.deathId);
      const event = world.cultivation.events.find(value => value.kind === 'cultivation.died' && value.discipleId === identity.discipleId && value.relatedId === identity.deathId);
      const worldEvent = event && lookupEvent(world, event.eventId);
      // Old migration exceptions without an exact World event cannot establish new work chronology.
      if (!profile || !estate || !death || !event || !worldEvent || worldEvent.kind !== 'cultivation.died'
        || worldEvent.payload.discipleId !== identity.discipleId || worldEvent.payload.relatedId !== identity.deathId
        || worldEvent.payload.month !== death.month || event.month !== death.month) continue;
      // World mirrors record simulation tick and calendar month, not an invented exact calendar.
      // Intersect that month's bounds with the actual current clock's necessary continuity.
      const monthStart = death.month * CALENDAR_TICKS_PER_MONTH;
      const monthEnd = Math.min(Number.MAX_SAFE_INTEGER - (CALENDAR_TICKS_PER_MONTH - 1), monthStart) + CALENDAR_TICKS_PER_MONTH - 1;
      const calendarMinimum = Math.max(monthStart, world.clock.calendarTick - (world.clock.simulationTick - worldEvent.tick));
      const calendarMaximum = Math.min(monthEnd, world.clock.calendarTick, worldEvent.tick);
      if (calendarMinimum > calendarMaximum) continue;
      deaths.set(identity.discipleId, { tick: worldEvent.tick, calendarMinimum, calendarMaximum });
    }
    const source = new SectHistoricalIdentitySource(deaths);
    admittedHistoricalSources.add(source);
    return source;
  }
  static permits(source: SectHistoricalIdentitySource | undefined, workerId: string,
    terminal: { readonly tick: number; readonly calendarTick: number } | null): boolean {
    if (!source || typeof source !== 'object' || !admittedHistoricalSources.has(source) || !(#deaths in source) || terminal === null) return false;
    const death = source.#deaths.get(workerId);
    return !!death && Number.isSafeInteger(terminal.tick) && terminal.tick >= 0 && terminal.tick <= death.tick
      && Number.isSafeInteger(terminal.calendarTick) && terminal.calendarTick >= 0 && terminal.calendarTick <= terminal.tick
      && terminal.calendarTick <= death.calendarMaximum
      // There must exist a death calendar within the interval reachable from this terminal.
      // Subtraction avoids overflow from adding two unrelated absolute safe-integer clocks.
      && Math.max(0, death.calendarMinimum - terminal.calendarTick) <= death.tick - terminal.tick;
  }
}
// A token reveals its prototype constructor. Keep its authentication methods immutable too;
// otherwise reflective callers could replace permits/fromWorldV8 without forging a token.
Object.freeze(SectHistoricalIdentitySource);
Object.freeze(SectHistoricalIdentitySource.prototype);
export type { SectHistoricalIdentitySource };
export const captureSectHistoricalIdentitiesV8 = (world: WorldStateV8): SectHistoricalIdentitySource => SectHistoricalIdentitySource.fromWorldV8(world);
/** Internal record leaf. This does not authenticate a frame, close owners or authorize work. */
export const isArchivedSectWorkerReference = (source: SectHistoricalIdentitySource | undefined, workerId: string,
  terminal: { readonly tick: number; readonly calendarTick: number } | null): boolean => SectHistoricalIdentitySource.permits(source, workerId, terminal);
