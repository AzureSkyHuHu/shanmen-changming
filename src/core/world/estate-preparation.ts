import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { BuildAuthorityCommandV2, BuildContentContext, BuildDataV2, EquipmentOwner } from '../builds/v2-types';
import { applyCultivationAuthorityCommandV3 } from '../cultivation/v3';
import type { CultivationFrame } from '../cultivation/v3';
import { copy } from '../expeditions/shared';
import { cloneJson } from '../kernel/serialization';
import type { WorldDeceasedIdentity, WorldEstateRecord, WorldLegacyState } from './campaign-state';
import type { Disciple } from './types';

export interface EstateDisciple extends Pick<Disciple, 'id' | 'nameKey' | 'birthCalendarTick' | 'assignmentTransactionId' | 'traveling'> {
  presentationId: WorldDeceasedIdentity['presentationId'];
}
/** A lifecycle patch, never a complete or admitted World. The owning version must
 * authenticate death/history/content provenance, cancel every work owner, compose
 * its aggregate ledger, and check the complete candidate before publication. */
export interface EstatePreparationFrame<TDisciple extends EstateDisciple = EstateDisciple> extends CultivationFrame {
  builds: BuildDataV2;
  disciples: TDisciple[];
  legacy: WorldLegacyState;
}
/** Concrete legacy work remains a guard, not a complete work-owner registry.
 * Future versions must release their additional owners before this stage; no
 * callback, exemption list or caller-supplied authorization can admit them here. */
export interface EstateSettlementSource<TDisciple extends EstateDisciple = EstateDisciple> extends EstatePreparationFrame<TDisciple> {
  activeProductionTransactionIds: readonly string[];
  transactions: Readonly<Record<string, { workerId: string }>>;
  automaticProduction: { live: Readonly<Record<string, { transaction: { transactionId: string; workerId: string } }>> };
}
export interface EstatePreparationFailure {
  ok: false;
  code: 'INVALID_STATE' | 'BUILD_REJECTED' | 'CULTIVATION_REJECTED' | 'SAVE_CAPACITY_EXCEEDED';
  details: string[];
}
export type EstateResponsibilityPreparation = { ok: true; legacy: WorldLegacyState } | EstatePreparationFailure;
export type EstateSettlementPreparation<TDisciple extends EstateDisciple = EstateDisciple> =
  | { ok: true; frame: EstatePreparationFrame<TDisciple>; settledDeathIds: string[]; pendingDeathIds: string[]; retiredDiscipleIds: string[] }
  | EstatePreparationFailure;

function failure(code: EstatePreparationFailure['code'], details: string[]): EstatePreparationFailure { return { ok: false, code, details }; }
function caughtFailure(error: unknown): EstatePreparationFailure {
  const message = error instanceof Error ? error.message : 'Unknown estate preparation failure';
  return failure(message === 'SAVE_CAPACITY_EXCEEDED' ? 'SAVE_CAPACITY_EXCEEDED' : message.startsWith('BUILD_REJECTED:') ? 'BUILD_REJECTED' : 'INVALID_STATE', [message]);
}

/** Kept before settlement so each version can retain its own initial validation
 * boundary. Responsibilities come from finalized deaths, never a player list. */
export function prepareEstateResponsibilities(source: Pick<EstatePreparationFrame, 'cultivation' | 'builds' | 'legacy'>): EstateResponsibilityPreparation {
  try {
    const legacy = copy(source.legacy);
    for (const death of source.cultivation.deaths) if (!legacy.estates.some(estate => estate.deathId === death.deathId)) {
      const profile = source.cultivation.disciples.find(member => member.discipleId === death.discipleId);
      if (!profile || profile.lifeState !== 'dead' || profile.deathId !== death.deathId) return failure('INVALID_STATE', ['Death responsibility lacks its full profile']);
      legacy.estates.push({ estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId: death.discipleId, beneficiaryId: death.beneficiaryId,
        itemInstanceIds: source.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === death.discipleId).map(item => item.instanceId),
        pendingRunId: profile.activityOwner?.runId ?? null, transferCommandIds: [], recordedMonth: death.month, settledMonth: null, settledOwner: null });
    }
    legacy.estates = legacy.estates.map(estate => {
      if (estate.settledMonth !== null) return estate;
      const profile = source.cultivation.disciples.find(member => member.discipleId === estate.discipleId);
      const build = source.builds.disciples.find(member => member.discipleId === estate.discipleId);
      return profile?.activityOwner === null && build?.lock === null ? { ...estate, pendingRunId: null } : estate;
    });
    return { ok: true, legacy };
  } catch (error) { return caughtFailure(error); }
}

/** Pure build-2/cultivation-3 preparation after responsibility registration and
 * owning-version reconciliation. Domain commands retain their strict validation;
 * success does not authenticate World history, aggregate reservations or capacity.
 * Locked deceased members retain all sources/items until actual run unlock. */
export function prepareEstateSettlement<TDisciple extends EstateDisciple>(source: EstateSettlementSource<TDisciple>, context: BuildContentContext): EstateSettlementPreparation<TDisciple> {
  try {
    let frame: EstatePreparationFrame<TDisciple> = cloneJson({ cultivation: source.cultivation, inventory: source.inventory,
      randomStreams: source.randomStreams, sequences: source.sequences, builds: source.builds, disciples: source.disciples, legacy: source.legacy });
    const settledDeathIds: string[] = []; const retiredDiscipleIds: string[] = [];
    const applyBuild = (command: BuildAuthorityCommandV2): void => {
      const result = applyBuildAuthorityCommandV2({ builds: frame.builds, sequences: frame.sequences }, command, context);
      if (!result.ok) throw new Error(result.code === 'COMMAND_LIMIT' ? 'SAVE_CAPACITY_EXCEEDED' : `BUILD_REJECTED:${result.code}`);
      frame = { ...frame, builds: copy(result.frame.builds), sequences: copy(result.frame.sequences) };
    };
    for (const oldEstate of frame.legacy.estates) {
      if (oldEstate.settledMonth !== null) continue;
      const estate: WorldEstateRecord = copy(oldEstate);
      const profile = frame.cultivation.disciples.find(member => member.discipleId === estate.discipleId)!;
      const build = frame.builds.disciples.find(member => member.discipleId === estate.discipleId)!;
      const actor = frame.disciples.find(member => member.id === estate.discipleId)!;
      if (profile.activityOwner || build.lock) continue;
      if (actor.assignmentTransactionId || actor.traveling || source.activeProductionTransactionIds.some(id =>
        source.transactions[id]?.workerId === actor.id || Object.values(source.automaticProduction.live).some(pair => pair.transaction.transactionId === id && pair.transaction.workerId === actor.id))) return failure('INVALID_STATE', ['Estate owner retains executable work']);
      const beneficiary = estate.beneficiaryId === null ? undefined : frame.cultivation.disciples.find(member => member.discipleId === estate.beneficiaryId && member.lifeState === 'alive');
      const settledOwner: EquipmentOwner = beneficiary ? { kind: 'disciple', discipleId: beneficiary.discipleId } : { kind: 'sect-estate' };
      const namespace = `death/${estate.deathId}`;
      applyBuild({ commandId: `${namespace}/retire`, expectedRevision: frame.builds.revision, kind: 'disciple.retire', discipleId: estate.discipleId, deathId: estate.deathId });
      const transferCommandIds: string[] = [];
      for (const itemInstanceId of estate.itemInstanceIds) {
        const commandId = `${namespace}/item/${itemInstanceId}`;
        applyBuild({ commandId, expectedRevision: frame.builds.revision, kind: 'equipment.transfer', transferId: commandId, itemInstanceId,
          fromOwner: { kind: 'disciple', discipleId: estate.discipleId }, toOwner: settledOwner, reason: { kind: 'death', deathId: estate.deathId } });
        transferCommandIds.push(commandId);
      }
      const archived = applyCultivationAuthorityCommandV3({ cultivation: frame.cultivation, inventory: frame.inventory, randomStreams: frame.randomStreams, sequences: frame.sequences },
        { kind: 'disciple.archive', commandId: `${namespace}/archive`, expectedRevision: frame.cultivation.revision, discipleId: estate.discipleId, deathId: estate.deathId });
      if (!archived.ok) return failure(archived.code === 'HISTORY_LIMIT' ? 'SAVE_CAPACITY_EXCEEDED' : 'CULTIVATION_REJECTED', [archived.code]);
      frame = { ...frame, ...archived.frame, disciples: frame.disciples.filter(member => member.id !== estate.discipleId),
        legacy: { ...frame.legacy, schemaVersion: 1, archivedIdentities: [...frame.legacy.archivedIdentities, { discipleId: actor.id, nameKey: actor.nameKey, presentationId: actor.presentationId,
          birthCalendarTick: actor.birthCalendarTick, ageMonths: profile.ageMonths, aptitude: profile.aptitude, school: build.school, realm: profile.realm,
          deathId: estate.deathId, archivedMonth: frame.cultivation.calendarMonth }],
          estates: frame.legacy.estates.map(entry => entry.deathId !== estate.deathId ? entry : { ...estate, pendingRunId: null, transferCommandIds,
            settledMonth: frame.cultivation.calendarMonth, settledOwner }) } };
      settledDeathIds.push(estate.deathId); retiredDiscipleIds.push(estate.discipleId);
    }
    return { ok: true, frame, settledDeathIds, retiredDiscipleIds,
      pendingDeathIds: frame.legacy.estates.filter(estate => estate.settledMonth === null).map(estate => estate.deathId) };
  } catch (error) { return caughtFailure(error); }
}
