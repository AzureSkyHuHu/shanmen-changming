import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { cloneJson } from '../kernel/serialization';
import type { BuildHistoryObligationFacts } from './build-obligations';
import { assessProgressionReservationNumbers, deriveProgressionRecordEnvelope,
  type ProgressionRecordSource, type ProgressionReservationAssessment } from './progression-bounds';

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

/** Finite ALREADY-FUNDED progression time. This is an upper bound on the chosen
 * lesson continuation route after unrelated attempts/work are cancelled, never
 * a promise that supply-blocked seclusion or arbitrary jobs eventually finish.
 * Parallel owners deliberately SUM their months; phase is subtracted ONCE. */
export function deriveProgressionReservationsTimeV9(input: { world: ProgressionRecordSource; buildFacts: BuildHistoryObligationFacts }): ProgressionReservationAssessment {
  const records = cloneJson(deriveProgressionRecordEnvelope(input));
  const { world } = input;
  if (!records.supported) return frozen({ ...records, numeric: { fits: false, diagnostics: ['No complete v9 progression record envelope'], uncovered: [] } });
  const months = records.totals.counterReserve.calendarMonths;
  const phase = world.clock.calendarTick % CALENDAR_TICKS_PER_MONTH;
  const ticks = months > 0 ? CALENDAR_TICKS_PER_MONTH * months - phase : 0;
  if (![phase, ticks].every(value => Number.isSafeInteger(value) && value >= 0)) {
    return frozen({ ...records, supported: false, unknowns: [...records.unknowns, 'No finite phase-aware v9 progression horizon'],
      numeric: { fits: false, diagnostics: ['No finite phase-aware v9 progression horizon'], uncovered: [] } });
  }
  // Owner calendarTicks remain nominal per-owner months for identification only.
  // The shared total is the sole clock/revision horizon used by the new query.
  records.totals.counterReserve.calendarTicks = ticks;
  const activeAttempts = world.cultivation.attempts.filter(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)).length;
  return frozen({ ...records, numeric: assessProgressionReservationNumbers(world, records.totals, activeAttempts) });
}
