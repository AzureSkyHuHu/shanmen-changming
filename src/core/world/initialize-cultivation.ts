import { createCultivationState, createCultivator } from '../cultivation/cultivation';
import { REALM_RULES } from '../cultivation/rules';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { allocateId } from '../kernel/ids';
import { reconcileCultivationWorld } from './cultivation-bridge';
import type { CultivationWorld } from './types';

/** No RNG/resource costs. Existing chronology and historical death facts remain explicit. */
export function attachCultivationState(input: Omit<CultivationWorld, 'cultivation'>): CultivationWorld {
  let sequences = input.sequences;
  const cultivation = createCultivationState(input.disciples.map((d) => createCultivator(d.id, {
    ageMonths: Math.min(d.ageMonths, REALM_RULES.mortal.lifespanMonths - 1), aptitude: d.aptitude,
  })), Math.floor(input.clock.calendarTick / CALENDAR_TICKS_PER_MONTH));
  for (const profile of cultivation.disciples) {
    const original = input.disciples.find((d) => d.id === profile.discipleId)!;
    profile.ageMonths = original.ageMonths;
    if (original.lifeState === 'dead') {
      const allocated = allocateId(sequences, 'instance'); sequences = allocated.sequences;
      profile.lifeState = 'dead'; profile.deathId = allocated.id;
      // Unknown old death cause/date is not fabricated. This month is archive observation time.
      cultivation.deaths.push({ deathId: allocated.id, discipleId: original.id, cause: 'legacy-unknown', month: cultivation.calendarMonth,
        beneficiaryId: null, transferredRelicIds: [], revokedSourceInstanceIds: [], cancelledAttemptId: null, cleanupDiscipleId: original.id });
    } else if (profile.ageMonths >= profile.lifespanMonths) {
      const allocated = allocateId(sequences, 'instance'); sequences = allocated.sequences;
      profile.lifeState = 'pendingDeath'; profile.pendingDeathId = allocated.id;
      cultivation.pendingDeaths.push({ deathId: allocated.id, discipleId: original.id, cause: 'lifespan', month: cultivation.calendarMonth });
    }
  }
  return reconcileCultivationWorld({ ...input, cultivation, sequences });
}
