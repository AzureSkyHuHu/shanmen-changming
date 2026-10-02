import { copy } from '../expeditions/shared';
import { managementV9BuildContext } from '../../content/sect-v9/world-content';
import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { MilestoneRuleId } from '../builds/types';
import type { CultivationFrame } from '../cultivation/v3';
import { REALMS } from '../cultivation/types';
import { liveProductionAt } from '../economy/automatic-production';
import type { ProductionReceiptContext } from '../economy/automatic-types';
import { cancelProduction } from '../economy/production';
import { setPauseReason } from '../kernel/clock';
import { cloneJson } from '../kernel/serialization';
import { isCultivationWorkerAvailable } from './cultivation-bridge';
import { prepareCultivationWorldEvents, projectCultivationDisciples } from './cultivation-preparation';
import { prepareEstateResponsibilities, prepareEstateSettlement } from './estate-preparation';
import { appendWorldEvents } from './history-access';
import { applyV9SectStage, v9WorkOwners } from './v9-sect-bridge';
import type { WorldStateV9 } from './v9-types';

export function withV9CultivationPause(world: WorldStateV9): WorldStateV9 {
  const pending = world.cultivation.pendingDeaths.length > 0 || world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady');
  return world.clock.pauseReasons.includes('cultivation') === pending ? world : { ...world, clock: setPauseReason(world.clock, 'cultivation', pending) };
}
export function reconcileV9Lifecycle(world: WorldStateV9, receiptContext?: ProductionReceiptContext): WorldStateV9 {
  let next = { ...world, disciples: projectCultivationDisciples(world.disciples, world.cultivation) };
  for (const id of [...next.activeProductionTransactionIds]) {
    const job = liveProductionAt(next, id)!.transaction;
    if (isCultivationWorkerAvailable(next, job.workerId)) continue;
    const cancelled = cancelProduction(next, id, receiptContext); if (!cancelled.ok) throw new TypeError('Cannot release unavailable legacy work'); next = cancelled.world;
  }
  // Release every sect owner while its real actor/position still exists. System receipt IDs
  // bind exact domain cancellation to the actual pending/final death; never player commands.
  for (const owner of v9WorkOwners(next)) {
    if (owner.kind === 'legacy-production' || isCultivationWorkerAvailable(next, owner.workerId)) continue;
    const death = [...next.cultivation.pendingDeaths, ...next.cultivation.deaths].find(death => death.discipleId === owner.workerId);
    if (!death) throw new TypeError('Conflicting work owner has no lifecycle cancellation source');
    const commandId = `system/v9/death/${death.deathId}/${owner.id}`;
    const result = owner.kind === 'construction' ? applyV9SectStage(next, { domain: 'construction', command: {
      kind: 'construction.cancel', commandId, expectedRevision: next.sectExpansion.construction.revision,
      blueprintId: next.sectExpansion.construction.jobs.find(job => job.jobId === owner.id)!.blueprintId } })
      : owner.kind === 'sect-production' ? applyV9SectStage(next, { domain: 'production', command: {
        kind: 'production.cancel', commandId, expectedRevision: next.sectExpansion.production.revision, jobId: owner.id } })
        : applyV9SectStage(next, { domain: 'research', command: {
          kind: 'research.cancel', commandId, expectedRevision: next.sectExpansion.research.revision, jobId: owner.id } });
    if ('code' in result) throw new TypeError(`Cannot release unavailable sect work: ${result.code}`); next = result.world;
  }
  const context = managementV9BuildContext(next.contentIdentity);
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
    if (v9WorkOwners(next).some(owner => next.cultivation.disciples.some(profile => profile.discipleId === owner.workerId && profile.lifeState === 'dead'))) throw new TypeError('Estate retains a sect work owner');
    const settlement = prepareEstateSettlement(next, context); if (!settlement.ok) throw new TypeError(settlement.details.join('; '));
    next = { ...next, ...settlement.frame, sectEconomy: { ...next.sectEconomy,
      plans: next.sectEconomy.plans.filter(plan => !settlement.retiredDiscipleIds.includes(plan.workerId)) } };
  }
  return withV9CultivationPause(next);
}
export function composeV9CultivationFrame(world: WorldStateV9, frame: CultivationFrame, receiptContext?: ProductionReceiptContext): WorldStateV9 {
  return reconcileV9Lifecycle(appendWorldEvents({ ...world, ...frame }, prepareCultivationWorldEvents(world, frame)), receiptContext);
}
