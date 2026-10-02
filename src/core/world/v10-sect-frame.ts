import { liveProductionAt } from '../economy/automatic-production';
import { isPaused } from '../kernel/clock';
import { compareStable } from '../kernel/serialization';
import type { ConstructionClaim, ConstructionContext, ConstructionPerson } from '../sect-expansion/construction-types';
import type { SectExpansionOwnedRecordsV10, SectUpgradeFrameV10, WorldStateV10 } from '../sect-expansion/upgrade-types';
import { isCultivationWorkerAvailable } from './cultivation-bridge';

/** Pure projection/composition ports below v10 lifecycle/runtime integration.
 * Call only on authenticated owned source/candidate records; none is admission.
 * No v9 World disguise, field filtering or duplicate persisted authority is used. */
/** Single explicit v10 work-owner union, including non-worker patient care. */
export type V10WorkOwner = { kind: 'legacy-production' | 'construction' | 'sect-production' | 'research' | 'care' | 'upgrade'; id: string; workerId: string };
export function v10WorkOwners(world: WorldStateV10): V10WorkOwner[] {
  return [
    ...world.activeProductionTransactionIds.map(id => ({ kind: 'legacy-production' as const, id, workerId: liveProductionAt(world, id)!.transaction.workerId })),
    ...world.sectExpansion.construction.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'construction' as const, id: job.jobId, workerId: job.workerId })),
    ...world.sectExpansion.production.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'sect-production' as const, id: job.transactionId, workerId: job.workerId })),
    ...world.sectExpansion.research.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'research' as const, id: job.jobId, workerId: job.workerId })),
    ...world.sectExpansion.upgrade.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'upgrade' as const, id: job.jobId, workerId: job.workerId })),
    ...world.sectExpansion.care.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'care' as const, id: job.jobId, workerId: job.patientId })),
  ];
}
export function v10WorkerAvailable(world: WorldStateV10, workerId: string): boolean {
  const actor = world.disciples.find(actor => actor.id === workerId);
  return !!actor && actor.canWork && !actor.traveling && isCultivationWorkerAvailable(world, workerId)
    && !world.builds.disciples.find(member => member.discipleId === workerId)?.lock
    && !v10WorkOwners(world).some(owner => owner.workerId === workerId);
}
export function v10SectContext(world: WorldStateV10): ConstructionContext {
  const claims: ConstructionClaim[] = [];
  for (const id of world.activeProductionTransactionIds.slice().sort(compareStable)) {
    const job = liveProductionAt(world, id)!.transaction;
    claims.push({ kind: 'worker', key: job.workerId, ownerId: id });
    if (job.storageId !== null) {
      const storage = world.buildings.find(site => site.id === job.storageId)!;
      const key = `${storage.x},${storage.y}`;
      if (!claims.some(claim => claim.kind === 'entrance' && claim.key === key)) claims.push({ kind: 'entrance', key, ownerId: id });
    }
  }
  for (const site of world.buildings) if (site.stationTransactionId !== null) {
    claims.push({ kind: 'seat', key: site.id, ownerId: site.stationTransactionId });
    const key = `${site.x},${site.y}`;
    if (!claims.some(claim => claim.kind === 'entrance' && claim.key === key)) claims.push({ kind: 'entrance', key, ownerId: site.stationTransactionId });
  }
  return { simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick, mode: world.clock.mode,
    paused: isPaused(world.clock), expeditionActive: false, externalActiveJobs: world.activeProductionTransactionIds.length, externalClaims: claims };
}
/** Borrow real authority only for a synchronous internal stage. No second current map,
 * people, base ledger or clock is persisted. An active sect owner owns its own travel. */
export function projectV10SectFrame(world: WorldStateV10): SectUpgradeFrameV10 {
  const records = world.sectExpansion;
  const owners = v10WorkOwners(world);
  const people = world.disciples.map((actor): ConstructionPerson => {
    const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    const build = world.builds.disciples.find(member => member.discipleId === actor.id)!;
    const student = world.cultivation.disciples.find(member => member.teaching?.studentId === actor.id);
    return { id: actor.id, position: actor.position, lifeState: profile.lifeState,
      canWork: actor.canWork && profile.trainingMode === 'duty' && (!actor.traveling || owners.some(owner => owner.workerId === actor.id && owner.kind !== 'legacy-production')),
      away: profile.activityOwner !== null, productionTransactionId: actor.assignmentTransactionId,
      cultivationOwnerId: profile.activeAttemptId ?? profile.teaching?.teachingId ?? student?.teaching?.teachingId ?? profile.activityOwner?.lockId ?? null,
      otherOwnerId: build.lock?.lockId ?? null };
  });
  return { schemaVersion: 2, construction: { ...records.construction, map: world.map, people,
    lastSimulationTick: world.clock.simulationTick, lastCalendarTick: world.clock.calendarTick,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    ledger: { inventory: world.inventory, stock: records.stock, reservations: records.reservations } },
    production: records.production, research: records.research, maintenance: records.maintenance, care: records.care, upgrade: records.upgrade };
}
export function ownedV10SectRecords(frame: SectUpgradeFrameV10): SectExpansionOwnedRecordsV10 {
  const { schemaVersion, catalogIdentity, revision, nextId, blueprints, jobs, buildings, receipts } = frame.construction;
  return { schemaVersion: 2, construction: { schemaVersion, catalogIdentity, revision, nextId, blueprints, jobs, buildings, receipts },
    stock: frame.construction.ledger.stock, reservations: frame.construction.ledger.reservations,
    production: frame.production, research: frame.research, maintenance: frame.maintenance, care: frame.care, upgrade: frame.upgrade };
}
export function composeV10SectFrame(world: WorldStateV10, frame: SectUpgradeFrameV10): WorldStateV10 {
  const records = ownedV10SectRecords(frame);
  return { ...world, map: frame.construction.map, inventory: frame.construction.ledger.inventory, sectExpansion: records,
    disciples: world.disciples.map(actor => {
      const person = frame.construction.people.find(person => person.id === actor.id)!;
      if (actor.assignmentTransactionId !== null || records.care.jobs.some(job => job.patientId === actor.id && !job.terminal)) return actor;
      const jobs = [...records.construction.jobs, ...records.production.jobs, ...records.research.jobs, ...records.upgrade.jobs];
      const job = jobs.find(job => job.workerId === actor.id && job.terminal === null);
      return { ...actor, position: { ...person.position }, traveling: !!job && job.navigation.path.length > 0 && (('state' in job ? job.blockedReason === null : job.blocked === null)) };
    }) };
}
