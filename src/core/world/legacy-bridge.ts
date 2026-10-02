import { validateWorldStateV8 } from '../kernel/validation';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { cloneWorldWithSharedHistory } from './history-access';
import { getWorldBuildContentContext } from './content-access';
import { assessWorldBuildHistoryObligations } from './progression-obligations';
import { prepareEstateResponsibilities, prepareEstateSettlement } from './estate-preparation';
import type { EstatePreparationFailure } from './estate-preparation';
import type { WorldStateV8 } from './v8-types';

export type WorldEstatePreparation =
  | { ok: true; candidate: WorldStateV8; settledDeathIds: string[]; pendingDeathIds: string[] }
  | EstatePreparationFailure;

/** Strict v8 complete-candidate boundary, not a command gateway or budget bypass.
 * Its caller must have published the actual death event and cleared production,
 * reconciled run member deaths, and unlocked any finished run in the same draft.
 * Other versions compose their own owner cleanup and admission around preparation. */
export function prepareWorldEstateSettlement(world: WorldStateV8): WorldEstatePreparation {
  let candidate = cloneWorldWithSharedHistory(world);
  const context = getWorldBuildContentContext(world);
  if (!context) return { ok: false, code: 'INVALID_STATE', details: ['Missing current build content'] };
  const fail = (code: EstatePreparationFailure['code'], details: string[]): EstatePreparationFailure => ({ ok: false, code, details });
  try {
    const responsibilities = prepareEstateResponsibilities(candidate);
    if (!responsibilities.ok) return responsibilities;
    candidate = { ...candidate, legacy: responsibilities.legacy };
    const initialErrors = validateWorldStateV8(candidate);
    if (initialErrors.length) return fail('INVALID_STATE', initialErrors);
    const beforeRows = assessWorldBuildHistoryObligations(candidate);
    const prepared = prepareEstateSettlement(candidate, context);
    if (!prepared.ok) return prepared;
    candidate = { ...candidate, ...prepared.frame,
      sectEconomy: { ...candidate.sectEconomy, plans: candidate.sectEconomy.plans.filter(plan => !prepared.retiredDiscipleIds.includes(plan.workerId)) } };
    const errors = validateWorldStateV8(candidate); if (errors.length) return fail('INVALID_STATE', errors);
    const afterRows = assessWorldBuildHistoryObligations(candidate);
    if (afterRows.historyCount + afterRows.reservedCommands > beforeRows.historyCount + beforeRows.reservedCommands
      || measureWorldSaveBytes(candidate, { saveVersion: 8 }) > SAVE_FILE_LIMIT_BYTES) return fail('SAVE_CAPACITY_EXCEEDED', ['Complete estate candidate does not fit its actual or build-row boundary']);
    return { ok: true, candidate, settledDeathIds: prepared.settledDeathIds, pendingDeathIds: prepared.pendingDeathIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown estate preparation failure';
    return fail(message === 'SAVE_CAPACITY_EXCEEDED' ? 'SAVE_CAPACITY_EXCEEDED' : message.startsWith('BUILD_REJECTED:') ? 'BUILD_REJECTED' : 'INVALID_STATE', [message]);
  }
}
