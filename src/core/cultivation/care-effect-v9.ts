import type { CultivationState } from './v3';
import { ownSectFields } from '../sect-expansion/layout';

/** Version-owned fixed primitive. It is not a player cultivation command or arbitrary patch. */
export const WOUND_POWDER_EFFECT_V9 = Object.freeze({ id: 'care.wound-powder.reduce-injury.v9.1', amount: 20 });
export interface WoundPowderEffectReceiptV9 {
  readonly effectId: typeof WOUND_POWDER_EFFECT_V9.id; readonly careJobId: string; readonly patientId: string;
  readonly tick: number; readonly beforeInjury: number; readonly afterInjury: number;
  readonly beforeRevision: number; readonly afterRevision: number;
}
export function prepareWoundPowderEffectV9(cultivation: CultivationState, careJobId: string, patientId: string, tick: number): {
  cultivation: CultivationState; receipt: WoundPowderEffectReceiptV9;
} {
  const patient = cultivation.disciples.find(profile => profile.discipleId === patientId);
  if (!patient || patient.lifeState !== 'alive' || patient.pendingDeathId !== null || patient.activeAttemptId !== null
    || patient.activityOwner !== null || patient.teaching !== null || cultivation.disciples.some(profile => profile.teaching?.studentId === patientId)
    || !Number.isSafeInteger(patient.injury) || patient.injury <= 0 || patient.injury > 100) throw new TypeError('Ineligible wound-powder effect');
  if (cultivation.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('Care cultivation revision exhausted');
  const afterInjury = Math.max(0, patient.injury - WOUND_POWDER_EFFECT_V9.amount);
  const receipt: WoundPowderEffectReceiptV9 = { effectId: WOUND_POWDER_EFFECT_V9.id, careJobId, patientId, tick,
    beforeInjury: patient.injury, afterInjury, beforeRevision: cultivation.revision, afterRevision: cultivation.revision + 1 };
  return { cultivation: { ...cultivation, revision: receipt.afterRevision,
    disciples: cultivation.disciples.map(profile => profile.discipleId === patientId ? { ...profile, injury: afterInjury } : profile) }, receipt };
}
export function isWoundPowderEffectReceiptV9(value: unknown): value is WoundPowderEffectReceiptV9 {
  return ownSectFields(value, ['effectId', 'careJobId', 'patientId', 'tick', 'beforeInjury', 'afterInjury', 'beforeRevision', 'afterRevision'])
    && value.effectId === WOUND_POWDER_EFFECT_V9.id && typeof value.careJobId === 'string' && typeof value.patientId === 'string'
    && [value.tick, value.beforeInjury, value.afterInjury, value.beforeRevision, value.afterRevision].every(n => Number.isSafeInteger(n) && (n as number) >= 0)
    && (value.beforeInjury as number) > 0 && (value.beforeInjury as number) <= 100
    && value.afterInjury === Math.max(0, (value.beforeInjury as number) - WOUND_POWDER_EFFECT_V9.amount)
    && value.afterRevision === (value.beforeRevision as number) + 1;
}
