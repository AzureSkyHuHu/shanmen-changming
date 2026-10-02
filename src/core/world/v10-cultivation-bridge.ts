import { copy } from '../expeditions/shared';
import { managementV10BuildContext } from '../../content/sect-v10/world-content';
import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { MilestoneRuleId } from '../builds/types';
import type { CultivationState } from '../cultivation/v3';
import { applyValidatedCareCommandV10, v10CarePatientEligible } from '../sect-expansion/care-runtime-v10';
import type { SectCareCancellation } from '../sect-expansion/care-types';
import { PERMANENT_TALENT_RULES } from '../cultivation/rules';
import { REALMS } from '../cultivation/types';
import { liveProductionAt } from '../economy/automatic-production';
import type { ProductionReceiptContext } from '../economy/automatic-types';
import { cancelProduction } from '../economy/production';
import { setPauseReason } from '../kernel/clock';
import { cloneJson } from '../kernel/serialization';
import { isCultivationWorkerAvailable } from './cultivation-bridge';
import { prepareEstateResponsibilities, prepareEstateSettlement } from './estate-preparation';
import { applyV10SectStage } from './v10-sect-bridge';
import { composeV10SectFrame, projectV10SectFrame, v10SectContext, v10WorkOwners } from './v10-sect-frame';
import { cancelValidatedSectUpgradesForLifecycleV10 } from '../sect-expansion/upgrade-runtime';
import type { V10CultivationPreparation } from './v10-cultivation-preparation';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';

export function withV10CultivationPause(world: WorldStateV10): WorldStateV10 {
  const pending = world.cultivation.pendingDeaths.length > 0 || world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady');
  return world.clock.pauseReasons.includes('cultivation') === pending ? world : { ...world, clock: setPauseReason(world.clock, 'cultivation', pending) };
}
function reconcileV10Lifecycle(world: WorldStateV10, receiptContext?: ProductionReceiptContext, previousCultivation?: CultivationState): WorldStateV10 {
  let next = world;
  for (const id of [...next.activeProductionTransactionIds]) {
    const job = liveProductionAt(next, id)!.transaction;
    if (isCultivationWorkerAvailable(next, job.workerId)) continue;
    const cancelled = cancelProduction(next, id, receiptContext); if (!cancelled.ok) throw new TypeError('Cannot release unavailable legacy work'); next = cancelled.world;
  }
  // Release every sect owner while its real actor/position still exists. System receipt IDs
  // bind exact domain cancellation to the actual pending/final death; never player commands.
  for (const owner of v10WorkOwners(next)) {
    if (owner.kind === 'care') {
      if (v10CarePatientEligible(next, owner.workerId, owner.id)) continue;
      const patient = next.cultivation.disciples.find(profile => profile.discipleId === owner.workerId)!;
      const death = [...next.cultivation.pendingDeaths, ...next.cultivation.deaths].find(death => death.discipleId === owner.workerId);
      const previous = previousCultivation?.disciples.find(profile => profile.discipleId === owner.workerId);
      let cancellation: SectCareCancellation; let commandId: string;
      if (death) { cancellation = { kind: 'death', deathId: death.deathId }; commandId = `system/v9/death/${death.deathId}/${owner.id}`; }
      else if (patient?.injury === 0 && previous && previous.injury > 0 && previous.trainingMode === 'rest'
        && next.cultivation.calendarMonth === previousCultivation!.calendarMonth + 1) {
        cancellation = { kind: 'rest-healed', beforeInjury: previous.injury, beforeRevision: previousCultivation!.revision,
          afterRevision: next.cultivation.revision, month: next.cultivation.calendarMonth,
          healingSourceInstanceIds: previous.talents.filter(talent => talent.active && PERMANENT_TALENT_RULES[talent.sourceDefinitionId].healing > 0)
            .map(talent => talent.sourceInstanceId).sort() };
        commandId = `system/v9/healed/${next.cultivation.calendarMonth}/${owner.id}`;
      } else throw new TypeError('Unavailable care patient lacks lifecycle source');
      const cancelled = applyValidatedCareCommandV10(next, projectV10SectFrame(next), v10SectContext(next), {
        kind: 'care.cancel', commandId, expectedRevision: next.sectExpansion.care.revision, jobId: owner.id }, cancellation);
      if ('code' in cancelled) throw new TypeError(`Cannot release care patient: ${cancelled.code}`);
      next = cancelled.world; continue;
    }
    if (owner.kind === 'legacy-production' || isCultivationWorkerAvailable(next, owner.workerId)) continue;
    if (owner.kind === 'upgrade') throw new TypeError('Upgrade lifecycle must settle in the exact pre-work batch');
    const death = [...next.cultivation.pendingDeaths, ...next.cultivation.deaths].find(death => death.discipleId === owner.workerId);
    if (!death) throw new TypeError('Conflicting work owner has no lifecycle cancellation source');
    const commandId = `system/v9/death/${death.deathId}/${owner.id}`;
    const result = owner.kind === 'construction' ? applyV10SectStage(next, { domain: 'construction', command: {
      kind: 'construction.cancel', commandId, expectedRevision: next.sectExpansion.construction.revision,
      blueprintId: next.sectExpansion.construction.jobs.find(job => job.jobId === owner.id)!.blueprintId } })
      : owner.kind === 'sect-production' ? applyV10SectStage(next, { domain: 'production', command: {
        kind: 'production.cancel', commandId, expectedRevision: next.sectExpansion.production.revision, jobId: owner.id } })
        : applyV10SectStage(next, { domain: 'research', command: {
          kind: 'research.cancel', commandId, expectedRevision: next.sectExpansion.research.revision, jobId: owner.id } });
    if ('code' in result) throw new TypeError(`Cannot release unavailable sect work: ${result.code}`); next = result.world;
  }
  const context = managementV10BuildContext(next.contentIdentity);
  for (const profile of next.cultivation.disciples) for (const realm of REALMS.slice(1, REALMS.indexOf(profile.realm) + 1)) {
    const ruleId = `realm.${realm}` as MilestoneRuleId;
    if (next.builds.awards.some(award => award.discipleId === profile.discipleId && award.ruleId === ruleId)) continue;
    const granted = applyBuildAuthorityCommandV2({ builds: next.builds, sequences: next.sequences }, { kind: 'milestone.award',
      commandId: `system/realm/${profile.discipleId}/${realm}`, expectedRevision: next.builds.revision,
      milestoneId: `realm/${profile.discipleId}/${realm}`, discipleId: profile.discipleId, ruleId }, context);
    if (!granted.ok) throw new TypeError(`Realm award failed: ${granted.code}`);
    next = { ...next, builds: copy(granted.frame.builds), sequences: cloneJson(granted.frame.sequences) };
  }
  if (next.cultivation.deaths.some(death => !next.legacy.estates.some(estate => estate.deathId === death.deathId))
    || next.cultivation.disciples.some(profile => profile.lifeState === 'dead')) {
    const responsibilities = prepareEstateResponsibilities(next); if (!responsibilities.ok) throw new TypeError(responsibilities.details.join('; '));
    next = { ...next, legacy: responsibilities.legacy };
    if (v10WorkOwners(next).some(owner => next.cultivation.disciples.some(profile => profile.discipleId === owner.workerId && profile.lifeState === 'dead'))) throw new TypeError('Estate retains a sect work owner');
    const settlement = prepareEstateSettlement(next, context); if (!settlement.ok) throw new TypeError(settlement.details.join('; '));
    next = { ...next, ...settlement.frame, sectEconomy: { ...next.sectEconomy,
      plans: next.sectEconomy.plans.filter(plan => !settlement.retiredDiscipleIds.includes(plan.workerId)) } };
  }
  return withV10CultivationPause(next);
}
/** Consume the fixed reducer preparation BEFORE any legacy/sect cancellation, realm
 * award, estate responsibility/retirement/archive or World identity removal. Never
 * project a fresh equivalent frame here: evidence binds these exact three objects. */
export function reconcilePreparedV10Cultivation(source: WorldStateV10, preparation: V10CultivationPreparation,
  receiptContext?: ProductionReceiptContext): WorldStateV10 {
  const cancelled = cancelValidatedSectUpgradesForLifecycleV10(preparation.frame, preparation.context, preparation.evidence);
  if (!cancelled.ok) {
    if (cancelled.code === 'CAPACITY_EXCEEDED') throw new RangeError(cancelled.code);
    throw new TypeError(`Cannot release unavailable upgrade work: ${cancelled.code}`);
  }
  const composed = composeV10SectFrame(preparation.world, cancelled.frame);
  return reconcileV10Lifecycle(composed, receiptContext, source.cultivation);
}
