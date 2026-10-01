import type { Realm, PermanentTalentId } from './types';
import type { ResourceLine } from '../economy/types';

/** Versioned prototype balancing data, not playtested final values. Units are months / integers / BPS. */
export const CULTIVATION_RULES_VERSION = 1 as const;
export const MAX_CULTIVATORS = 36;
export const MAX_MONTHS_PER_STEP = 12;
export const MAX_CULTIVATION_HISTORY = 100_000;
export const CULTIVATION_RULES = {
  success: { baseBps: 4500, minimumBps: 500, maximumBps: 9500, understandingCoefficient: 20, foundationCoefficient: 15,
    mindsetCoefficient: 15, arrayLevelBps: 500, injuryCoefficient: -25, tribulationCoefficient: -20, forcedBonusBps: 500 },
  failure: { forcedDeathBps: 2000, severeInjuryThreshold: 30, injuryDeathCoefficient: 80, maximumDeathBps: 9500,
    normalInjury: 20, forcedInjury: 35, cultivationLossBps: 2000 },
  training: { baseUnits: 8, aptitudeDivisor: 10, understandingPerMonth: 1, foundationPerMonth: 1, maximumTrainableInjury: 59 },
  rest: { healingPerMonth: 8, mindsetPerMonth: 2 },
  standardMaximumInjury: 50,
  monthlyMealCost: 1,
  teachingMonths: 2,
} as const;
export interface RealmRule { lifespanMonths: number; cultivationRequired: number; seclusionMonths: number; tribulation: number; baseFailureDeathBps: number; costs: readonly ResourceLine[] }
export const REALM_RULES: Readonly<Record<Realm, RealmRule>> = {
  mortal: { lifespanMonths: 80 * 12, cultivationRequired: 120, seclusionMonths: 1, tribulation: 0, baseFailureDeathBps: 0, costs: [{ resourceId: 'herbs', quantity: 2 }] },
  qi: { lifespanMonths: 110 * 12, cultivationRequired: 360, seclusionMonths: 3, tribulation: 10, baseFailureDeathBps: 0, costs: [{ resourceId: 'herbs', quantity: 6 }, { resourceId: 'stone', quantity: 4 }] },
  foundation: { lifespanMonths: 180 * 12, cultivationRequired: 900, seclusionMonths: 6, tribulation: 25, baseFailureDeathBps: 500, costs: [{ resourceId: 'herbs', quantity: 12 }, { resourceId: 'stone', quantity: 10 }] },
  'golden-core': { lifespanMonths: 360 * 12, cultivationRequired: 1800, seclusionMonths: 12, tribulation: 40, baseFailureDeathBps: 1200, costs: [{ resourceId: 'herbs', quantity: 24 }, { resourceId: 'stone', quantity: 24 }] },
  'nascent-soul': { lifespanMonths: 600 * 12, cultivationRequired: 0, seclusionMonths: 0, tribulation: 0, baseFailureDeathBps: 0, costs: [] },
};
export const PERMANENT_TALENT_RULES: Readonly<Record<PermanentTalentId, { trainingUnits: number; understanding: number; healing: number }>> = {
  'cultivation.steady-breath': { trainingUnits: 2, understanding: 0, healing: 0 },
  'cultivation.patient-scholar': { trainingUnits: 0, understanding: 1, healing: 0 },
  'cultivation.resilient-body': { trainingUnits: 0, understanding: 0, healing: 2 },
};
