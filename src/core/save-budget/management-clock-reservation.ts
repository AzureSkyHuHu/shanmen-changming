import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { measureProgressionRecord, type ProgressionReservationAssessment } from './progression-bounds';
import { V9_CULTIVATION_CLOCK_LIMIT, type V9CultivationClockTransition } from '../world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../world/v9-types';

/** Data-only shared chronology. Version-owned roots authenticate their actual source. */
export type ManagementClockRecordSource = Pick<WorldStateV9, 'clock' | 'cultivationClock' | 'cultivation' | 'disciples'>;
const MAX = Number.MAX_SAFE_INTEGER;
export interface ManagementClockReservation {
  supported: boolean; currentRows: number; reservedRows: number;
  /** Finite accepted progression horizon only. No indefinite waiting is included. */
  calendarTicks: number; monthRows: number; ageSyncRows: number; lifecycleTriggerRows: number;
  additionalActions: number; additionalCultivationRevisions: number;
  bytes: number; decodedCharacters: number; decodedNodes: number;
  currentDecodedNodes: number; structuralNodeLimit: number;
  perTransition: { bytes: number; decodedCharacters: number; decodedNodes: number };
  progressionOwnerIds: string[]; lifecycleOwnerIds: string[]; unknowns: string[];
}
function periodicBoundariesAfter(tick: number, horizon: number, residue: number): number {
  const offset = ((residue - tick % CALENDAR_TICKS_PER_MONTH) + CALENDAR_TICKS_PER_MONTH) % CALENDAR_TICKS_PER_MONTH;
  const first = offset === 0 ? CALENDAR_TICKS_PER_MONTH : offset;
  return horizon < first ? 0 : 1 + Math.floor((horizon - first) / CALENDAR_TICKS_PER_MONTH);
}
/** The .3 bridge emits one row and one action/revision per actual month or
 * off-month birthday group; simultaneous birthdays and month ticks coalesce.
 * Progression already reserves one expiry action for each alive lifecycle owner
 * and one action/revision per committed teaching/seclusion month. Only additional
 * off-month groups in that finite horizon need additional scalar headroom here.
 * A lifecycle trigger row does not reserve the arbitrary months leading to it. */
function deriveManagementClockReservation(world: ManagementClockRecordSource, progression: ProgressionReservationAssessment, phaseAware: boolean): ManagementClockReservation {
  const witness: V9CultivationClockTransition = { kind: 'age-sync', tick: MAX, beforeRevision: MAX - 1, rootActionId: `action:${MAX - 1}` };
  const maximum = measureProgressionRecord(witness);
  const emptyNodes = measureProgressionRecord({ transitions: [] }).decodedNodes;
  const current = measureProgressionRecord(world.cultivationClock);
  const result: ManagementClockReservation = { supported: false, currentRows: world.cultivationClock.transitions.length, reservedRows: 0,
    calendarTicks: 0, monthRows: 0, ageSyncRows: 0, lifecycleTriggerRows: 0, additionalActions: 0, additionalCultivationRevisions: 0,
    bytes: 0, decodedCharacters: 0, decodedNodes: 0, currentDecodedNodes: current.decodedNodes,
    structuralNodeLimit: emptyNodes + V9_CULTIVATION_CLOCK_LIMIT * maximum.decodedNodes,
    perTransition: { bytes: maximum.bytes + 1, decodedCharacters: maximum.decodedCharacters + 1, decodedNodes: maximum.decodedNodes },
    progressionOwnerIds: [], lifecycleOwnerIds: [], unknowns: [] };
  if (!progression.supported) { result.unknowns.push('Clock row reservation requires a supported progression derivation'); return result; }
  const horizon = progression.totals.counterReserve.calendarTicks;
  if (!Number.isSafeInteger(horizon) || horizon < 0 || (!phaseAware && horizon % CALENDAR_TICKS_PER_MONTH !== 0)) {
    result.unknowns.push('Clock row reservation has no finite whole-month progression horizon'); return result;
  }
  result.calendarTicks = horizon;
  result.progressionOwnerIds = progression.owners.filter(owner => owner.counterReserve.calendarTicks > 0).map(owner => `${owner.kind}:${owner.id}`);
  result.monthRows = periodicBoundariesAfter(world.clock.calendarTick, horizon, 0);
  if (result.monthRows !== progression.totals.counterReserve.calendarMonths) {
    result.unknowns.push('Clock month rows differ from already-funded progression months'); return result;
  }
  const residues = new Set<number>();
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id);
    if (!profile) { result.unknowns.push('Clock obligation lacks an active cultivation identity'); return result; }
    if (profile.lifeState !== 'alive') continue;
    const residue = ((actor.birthCalendarTick % CALENDAR_TICKS_PER_MONTH) + CALENDAR_TICKS_PER_MONTH) % CALENDAR_TICKS_PER_MONTH;
    if (residue !== 0) residues.add(residue);
  }
  for (const residue of residues) result.ageSyncRows += periodicBoundariesAfter(world.clock.calendarTick, horizon, residue);
  result.lifecycleOwnerIds = progression.owners.filter(owner => owner.kind === 'disciple-lifecycle'
    && world.cultivation.disciples.some(profile => profile.discipleId === owner.id && profile.lifeState === 'alive')).map(owner => owner.id);
  // Per-owner terminal trigger rows may coalesce with each other or a horizon
  // row. Keep that deliberate conservative duplicate: no terminal discharge or
  // equality of future death times is assumed by this read-only query.
  result.lifecycleTriggerRows = result.lifecycleOwnerIds.length;
  result.reservedRows = result.monthRows + result.ageSyncRows + result.lifecycleTriggerRows;
  result.additionalActions = result.ageSyncRows; result.additionalCultivationRevisions = result.ageSyncRows;
  result.bytes = result.reservedRows * result.perTransition.bytes;
  result.decodedCharacters = result.reservedRows * result.perTransition.decodedCharacters;
  result.decodedNodes = result.reservedRows * result.perTransition.decodedNodes;
  if (![result.reservedRows, result.bytes, result.decodedCharacters, result.decodedNodes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    result.unknowns.push('Clock reservation exceeds finite safe range'); return result;
  }
  result.supported = true; return result;
}

/** Fixed historical whole-month arithmetic; no caller-controlled horizon policy. */
export function deriveWholeMonthManagementClockReservation(source: ManagementClockRecordSource,
  progression: ProgressionReservationAssessment): ManagementClockReservation {
  return deriveManagementClockReservation(source, progression, false);
}
/** Fixed finite phase-aware arithmetic used by later management roots. */
export function derivePhaseAwareManagementClockReservation(source: ManagementClockRecordSource,
  progression: ProgressionReservationAssessment): ManagementClockReservation {
  return deriveManagementClockReservation(source, progression, true);
}
