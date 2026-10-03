import { cloneJson } from '../kernel/serialization';
import type { SectHistoricalPlacement, SectRelocationRecordFrame } from './relocation-types';
import { validateSectRelocationRecords } from './relocation-validation';

/** Revalidates the complete local record envelope on EVERY call. There is deliberately no
 * public unchecked leaf, alleged trusted proof or external validation callback. This is a
 * detached historical query, not permission to operate a building or admit a World/save.
 * The before/after boundary disambiguates the exact relocation commit tick. Original
 * construction completion occurs earlier in the tick; its anchor is never overwritten.
 */
export function sectBuildingPlacementAt(input: unknown, buildingId: string, tick: number,
  phase: 'before-relocation' | 'after-relocation' = 'after-relocation'): SectHistoricalPlacement | null {
  if (!Number.isSafeInteger(tick) || tick < 0 || !['before-relocation', 'after-relocation'].includes(phase)
    || validateSectRelocationRecords(input).length) return null;
  const frame = input as SectRelocationRecordFrame;
  if (tick > frame.construction.lastSimulationTick) return null;
  const original = frame.construction.buildings.find(b => b.buildingId === buildingId);
  if (!original || original.completedTick > tick) return null;
  const completion = frame.relocation.jobs.filter(j => j.buildingId === buildingId && j.terminal?.kind === 'completed'
    && (phase === 'before-relocation' ? j.terminal.tick < tick : j.terminal.tick <= tick)).at(-1);
  const position = completion?.to ?? original;
  return cloneJson({ buildingId, sourceJobId: original.sourceJobId, relocationJobId: completion?.jobId ?? null,
    definitionId: original.definitionId, anchor: position.anchor, rotation: position.rotation,
    firstMaintenanceCalendarTick: original.firstMaintenanceCalendarTick });
}
