import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { BuildAuthorityCommandV2, EquipmentOwner } from '../builds/v2-types';
import { applyCultivationAuthorityCommandV3 } from '../cultivation/v3';
import { copy } from '../expeditions/shared';
import { validateWorldStateV8 } from '../kernel/validation';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { cloneWorldWithSharedHistory } from './history-access';
import { getWorldBuildContentContext } from './content-access';
import { assessWorldBuildHistoryObligations } from './progression-obligations';
import type { WorldEstateRecord } from './campaign-state';
import type { WorldStateV8 } from './v8-types';

type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
export type WorldEstatePreparation =
  | { ok: true; candidate: WorldStateV8; settledDeathIds: string[]; pendingDeathIds: string[] }
  | { ok: false; code: 'INVALID_STATE' | 'BUILD_REJECTED' | 'CULTIVATION_REJECTED' | 'SAVE_CAPACITY_EXCEEDED'; details: string[] };

/** Internal complete-candidate builder, not a command gateway or budget bypass.
 * Its caller must have published the actual death event and cleared production,
 * reconciled run member deaths, and unlocked any finished run in the same draft.
 * Locked dead members retain every build source and item until that unlock. */
export function prepareWorldEstateSettlement(world: WorldStateV8): WorldEstatePreparation {
  let candidate = cloneWorldWithSharedHistory(world);
  const settledDeathIds: string[] = [];
  const context = getWorldBuildContentContext(world);
  if (!context) return { ok: false, code: 'INVALID_STATE', details: ['Missing current build content'] };
  const fail = (code: 'INVALID_STATE' | 'BUILD_REJECTED' | 'CULTIVATION_REJECTED' | 'SAVE_CAPACITY_EXCEEDED', details: string[]): WorldEstatePreparation => ({ ok: false, code, details });
  try {
    // These responsibilities come from finalized deaths, never from a player list.
    for (const death of candidate.cultivation.deaths) if (!candidate.legacy.estates.some(estate => estate.deathId === death.deathId)) {
      const profile = candidate.cultivation.disciples.find(member => member.discipleId === death.discipleId);
      if (!profile || profile.lifeState !== 'dead' || profile.deathId !== death.deathId) return fail('INVALID_STATE', ['Death responsibility lacks its full profile']);
      candidate.legacy.estates.push({ estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId: death.discipleId, beneficiaryId: death.beneficiaryId,
        itemInstanceIds: candidate.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === death.discipleId).map(item => item.instanceId),
        pendingRunId: profile.activityOwner?.runId ?? null, transferCommandIds: [], recordedMonth: death.month, settledMonth: null, settledOwner: null });
    }
    candidate.legacy.estates = candidate.legacy.estates.map(estate => {
      if (estate.settledMonth !== null) return estate;
      const profile = candidate.cultivation.disciples.find(member => member.discipleId === estate.discipleId);
      const build = candidate.builds.disciples.find(member => member.discipleId === estate.discipleId);
      return profile?.activityOwner === null && build?.lock === null ? { ...estate, pendingRunId: null } : estate;
    });
    const initialErrors = validateWorldStateV8(candidate);
    if (initialErrors.length) return fail('INVALID_STATE', initialErrors);
    const beforeRows = assessWorldBuildHistoryObligations(candidate);
    const applyBuild = (commandId: string, body: Body<BuildAuthorityCommandV2>): void => {
      const result = applyBuildAuthorityCommandV2({ builds: candidate.builds, sequences: candidate.sequences },
        { ...body, commandId, expectedRevision: candidate.builds.revision } as BuildAuthorityCommandV2, context);
      if (!result.ok) throw new Error(result.code === 'COMMAND_LIMIT' ? 'SAVE_CAPACITY_EXCEEDED' : `BUILD_REJECTED:${result.code}`);
      candidate = { ...candidate, builds: copy(result.frame.builds), sequences: copy(result.frame.sequences) };
    };
    for (const oldEstate of candidate.legacy.estates) {
      if (oldEstate.settledMonth !== null) continue;
      const estate: WorldEstateRecord = copy(oldEstate);
      const profile = candidate.cultivation.disciples.find(member => member.discipleId === estate.discipleId)!;
      const build = candidate.builds.disciples.find(member => member.discipleId === estate.discipleId)!;
      const actor = candidate.disciples.find(member => member.id === estate.discipleId)!;
      if (profile.activityOwner || build.lock) continue;
      if (actor.assignmentTransactionId || actor.traveling || candidate.activeProductionTransactionIds.some(id =>
        candidate.transactions[id]?.workerId === actor.id || Object.values(candidate.automaticProduction.live).some(pair => pair.transaction.transactionId === id && pair.transaction.workerId === actor.id))) return fail('INVALID_STATE', ['Estate owner retains executable work']);
      const beneficiary = estate.beneficiaryId === null ? undefined : candidate.cultivation.disciples.find(member => member.discipleId === estate.beneficiaryId && member.lifeState === 'alive');
      const settledOwner: EquipmentOwner = beneficiary ? { kind: 'disciple', discipleId: beneficiary.discipleId } : { kind: 'sect-estate' };
      const namespace = `death/${estate.deathId}`;
      applyBuild(`${namespace}/retire`, { kind: 'disciple.retire', discipleId: estate.discipleId, deathId: estate.deathId });
      const transferCommandIds: string[] = [];
      for (const itemInstanceId of estate.itemInstanceIds) {
        const commandId = `${namespace}/item/${itemInstanceId}`;
        applyBuild(commandId, { kind: 'equipment.transfer', transferId: commandId, itemInstanceId, fromOwner: { kind: 'disciple', discipleId: estate.discipleId },
          toOwner: settledOwner, reason: { kind: 'death', deathId: estate.deathId } });
        transferCommandIds.push(commandId);
      }
      const archived = applyCultivationAuthorityCommandV3({ cultivation: candidate.cultivation, inventory: candidate.inventory, randomStreams: candidate.randomStreams, sequences: candidate.sequences },
        { kind: 'disciple.archive', commandId: `${namespace}/archive`, expectedRevision: candidate.cultivation.revision, discipleId: estate.discipleId, deathId: estate.deathId });
      if (!archived.ok) return fail(archived.code === 'HISTORY_LIMIT' ? 'SAVE_CAPACITY_EXCEEDED' : 'CULTIVATION_REJECTED', [archived.code]);
      candidate = { ...candidate, ...archived.frame, disciples: candidate.disciples.filter(member => member.id !== estate.discipleId),
        sectEconomy: { ...candidate.sectEconomy, plans: candidate.sectEconomy.plans.filter(plan => plan.workerId !== estate.discipleId) },
        legacy: { schemaVersion: 1, archivedIdentities: [...candidate.legacy.archivedIdentities, { discipleId: actor.id, nameKey: actor.nameKey, presentationId: actor.presentationId,
          birthCalendarTick: actor.birthCalendarTick, ageMonths: profile.ageMonths, aptitude: profile.aptitude, school: build.school, realm: profile.realm,
          deathId: estate.deathId, archivedMonth: candidate.cultivation.calendarMonth }],
          estates: candidate.legacy.estates.map(entry => entry.deathId !== estate.deathId ? entry : { ...estate, pendingRunId: null, transferCommandIds,
            settledMonth: candidate.cultivation.calendarMonth, settledOwner }) } };
      settledDeathIds.push(estate.deathId);
    }
    const errors = validateWorldStateV8(candidate); if (errors.length) return fail('INVALID_STATE', errors);
    const afterRows = assessWorldBuildHistoryObligations(candidate);
    if (afterRows.historyCount + afterRows.reservedCommands > beforeRows.historyCount + beforeRows.reservedCommands
      || measureWorldSaveBytes(candidate, { saveVersion: 8 }) > SAVE_FILE_LIMIT_BYTES) return fail('SAVE_CAPACITY_EXCEEDED', ['Complete estate candidate does not fit its actual or build-row boundary']);
    return { ok: true, candidate, settledDeathIds, pendingDeathIds: candidate.legacy.estates.filter(estate => estate.settledMonth === null).map(estate => estate.deathId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown estate preparation failure';
    return fail(message === 'SAVE_CAPACITY_EXCEEDED' ? 'SAVE_CAPACITY_EXCEEDED' : message.startsWith('BUILD_REJECTED:') ? 'BUILD_REJECTED' : 'INVALID_STATE', [message]);
  }
}
