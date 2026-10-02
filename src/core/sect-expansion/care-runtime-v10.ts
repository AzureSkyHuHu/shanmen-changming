import { emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { prepareWoundPowderEffectV9 } from '../cultivation/care-effect-v9';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import type { SectProductionJobV10, SectUpgradeFrameV10, WorldStateV10 } from './upgrade-types';
import { constructionEffectiveMap } from './construction-runtime';
import type { ConstructionClaim, ConstructionContext } from './construction-types';
import { SECT_CARE_LIMITS, WOUND_POWDER_COST_V9, type SectCareCancellation, type SectCareCommand, type SectCareJob } from './care-types';
import { commitSectReservation, releaseSectReservation, reserveSectResources } from './ledger';
import { sectUpgradeAllLocalClaimsV10 } from './upgrade-validation';
import { careTrainingModeAtRevision } from './care-runtime';

const MAX = Number.MAX_SAFE_INTEGER;
export function sectCareClaimsV10(world: WorldStateV10): ConstructionClaim[] {
  return world.sectExpansion.care.jobs.filter(job => !job.terminal).flatMap(job => [
    { kind: 'worker' as const, key: job.patientId, ownerId: job.jobId },
    { kind: 'entrance' as const, key: `${job.storagePosition.x},${job.storagePosition.y}`, ownerId: job.jobId },
  ]);
}
/** Real patient eligibility, deliberately independent of adult duty-worker eligibility. */
export function v10CarePatientEligible(world: WorldStateV10, patientId: string, ownJobId?: string): boolean {
  const actor = world.disciples.find(actor => actor.id === patientId);
  const patient = world.cultivation.disciples.find(profile => profile.discipleId === patientId);
  const own = world.sectExpansion.care.jobs.find(job => job.jobId === ownJobId && job.patientId === patientId && !job.terminal);
  return !!actor && !!patient && actor.lifeState === 'alive' && patient.lifeState === 'alive' && patient.injury > 0
    && patient.pendingDeathId === null && patient.activeAttemptId === null && patient.activityOwner === null
    && (patient.trainingMode === 'duty' || patient.trainingMode === 'rest' && careTrainingModeAtRevision(world.cultivation, world.cultivation.revision, patientId) === 'rest') && patient.teaching === null
    && !world.cultivation.disciples.some(profile => profile.teaching?.studentId === patientId)
    && !world.cultivation.pendingDeaths.some(death => death.discipleId === patientId)
    && !world.builds.disciples.find(profile => profile.discipleId === patientId)?.lock
    && actor.assignmentTransactionId === null && (!actor.traveling || !!own)
    && !world.sectExpansion.construction.jobs.some(job => job.workerId === patientId && !job.terminal)
    && !world.sectExpansion.production.jobs.some(job => job.workerId === patientId && !job.terminal)
    && !world.sectExpansion.research.jobs.some(job => job.workerId === patientId && !job.terminal)
    && !world.sectExpansion.upgrade.jobs.some(job => job.workerId === patientId && !job.terminal)
    && !world.sectExpansion.care.jobs.some(job => job.patientId === patientId && !job.terminal && job.jobId !== ownJobId);
}
/** Fixed v10 selector, called only AFTER the root authenticates complete construction,
 * research, upgrade, maintenance and production records/receipts. This query creates
 * no authority: neither stock nor output resemblance proves a physical dose. */
export function deliveredPowderJobsV10(frame: SectUpgradeFrameV10, tick: number): SectProductionJobV10[] {
  return frame.production.jobs.filter(job => (job.recipeId === 'craft.wound-powder.v9' || job.recipeId === 'craft.wound-powder-alt.v9') && job.terminal?.kind === 'completed'
    && job.terminal.tick <= tick && job.deliveryVisit !== null
    && canonicalStringify(job.terminal.outputs) === canonicalStringify(WOUND_POWDER_COST_V9))
    .slice().sort((a, b) => a.terminal!.tick - b.terminal!.tick || compareStable(a.transactionId, b.transactionId));
}
function replace(world: WorldStateV10, job: SectCareJob): WorldStateV10 {
  return { ...world, sectExpansion: { ...world.sectExpansion, care: { ...world.sectExpansion.care,
    jobs: world.sectExpansion.care.jobs.map(value => value.jobId === job.jobId ? job : value) } } };
}
function block(world: WorldStateV10, job: SectCareJob, reason: Exclude<SectCareJob['blocked'], null>): WorldStateV10 {
  return replace({ ...world, disciples: world.disciples.map(actor => actor.id === job.patientId ? { ...actor, traveling: false } : actor) }, { ...job, blocked: reason });
}
const ledgerOf = (world: WorldStateV10) => ({ inventory: world.inventory, stock: world.sectExpansion.stock, reservations: world.sectExpansion.reservations });
export type SectCareStageResultV10 = { world: WorldStateV10; relatedId: string; repeated: boolean } | { code: string };
/** Internal stage. Only the enclosing v10 root can authenticate and publish the candidate. */
export function applyValidatedCareCommandV10(world: WorldStateV10, frame: SectUpgradeFrameV10, context: ConstructionContext,
  command: SectCareCommand, cancellation: SectCareCancellation = { kind: 'requested' }): SectCareStageResultV10 {
  const domain = world.sectExpansion.care;
  const previous = domain.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return canonicalStringify(previous.command) === canonicalStringify(command)
    ? { world, relatedId: previous.jobId, repeated: true } : { code: 'IDENTITY_CONFLICT' };
  if (command.expectedRevision !== domain.revision) return { code: 'STALE_REVISION' };
  if (domain.revision >= MAX) return { code: 'CAPACITY_EXCEEDED' };
  let next = world; let jobId: string;
  if (command.kind === 'care.start') {
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return { code: 'MANAGEMENT_REQUIRED' };
    const live = domain.jobs.filter(job => !job.terminal);
    if (domain.jobs.length >= SECT_CARE_LIMITS.records || domain.receipts.length + live.length + 2 > SECT_CARE_LIMITS.receipts
      || domain.nextId > MAX - 2 || domain.revision > MAX - live.length - 2 || world.cultivation.revision > MAX - live.length - 1
      || frame.construction.ledger.reservations.length >= 384 || context.simulationTick > MAX - 40
      || context.externalActiveJobs + sectUpgradeAllLocalClaimsV10(frame).filter(claim => claim.kind === 'worker').length >= 36) return { code: 'CAPACITY_EXCEEDED' };
    if (!v10CarePatientEligible(world, command.patientId)) return { code: 'PATIENT_UNAVAILABLE' };
    const dose = deliveredPowderJobsV10(frame, context.simulationTick).find(source => !domain.jobs.some(job => job.doseProductionJobId === source.transactionId && job.terminal?.kind !== 'cancelled'));
    if (!dose) return { code: 'NO_AVAILABLE_DOSE' };
    const storage = frame.construction.legacyStations.filter(site => site.blueprintId === 'storage' && site.operational).sort((a, b) => compareStable(a.id, b.id))[0];
    if (!storage) return { code: 'STORAGE_UNAVAILABLE' };
    if ([...context.externalClaims, ...sectUpgradeAllLocalClaimsV10(frame)].some(claim => claim.kind === 'entrance' && claim.key === `${storage.x},${storage.y}`)) return { code: 'CLAIM_CONFLICT' };
    const actor = world.disciples.find(actor => actor.id === command.patientId)!;
    jobId = `sect-care:${domain.nextId}`; const reservationId = `sect-care-reservation:${domain.nextId + 1}`;
    const reserved = reserveSectResources(ledgerOf(world), { reservationId, ownerTransactionId: jobId }, WOUND_POWDER_COST_V9, 'on-completion');
    if (!reserved.ok) return { code: reserved.rejection.code };
    const previousUse = domain.jobs.filter(job => job.doseProductionJobId === dose.transactionId).at(-1);
    const job: SectCareJob = { jobId, reservationId, patientId: actor.id, doseProductionJobId: dose.transactionId,
      previousCancelledCareId: previousUse?.jobId ?? null, startedTick: context.simulationTick, startedCalendarTick: context.calendarTick,
      origin: { ...actor.position }, storageId: storage.id, storagePosition: { x: storage.x, y: storage.y }, phase: 'to-storage', activeTicks: 0,
      visits: [], workSpans: [], navigation: emptyNavigation(), blocked: null, terminal: null };
    next = { ...world, inventory: reserved.context.inventory, sectExpansion: { ...world.sectExpansion,
      stock: reserved.context.stock, reservations: reserved.context.reservations,
      care: { ...domain, nextId: domain.nextId + 2, jobs: [...domain.jobs, job] } } };
  } else {
    const job = domain.jobs.find(job => job.jobId === command.jobId);
    if (!job) return { code: 'UNKNOWN_JOB' };
    if (job.terminal) return { code: 'TRANSACTION_FINISHED' };
    const actor = world.disciples.find(actor => actor.id === job.patientId);
    if (!actor || !isWalkable(constructionEffectiveMap(frame.construction), actor.position)) return { code: 'UNSAFE_POSITION' };
    jobId = job.jobId;
    const released = releaseSectReservation(ledgerOf(world), { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!released.ok) return { code: 'INVALID_RESERVATION' };
    next = replace({ ...world, inventory: released.context.inventory, sectExpansion: { ...world.sectExpansion,
      stock: released.context.stock, reservations: released.context.reservations },
      disciples: world.disciples.map(value => value.id === actor.id ? { ...value, traveling: false } : value) }, {
      ...job, phase: 'cancelled', navigation: emptyNavigation(), blocked: null,
      terminal: { kind: 'cancelled', previousPhase: job.phase as 'to-storage' | 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
        position: { ...actor.position }, consumed: [], released: cloneJson(WOUND_POWDER_COST_V9), effect: null, cancellation: cloneJson(cancellation), careRevision: domain.revision + 1 } });
  }
  next = { ...next, sectExpansion: { ...next.sectExpansion, care: { ...next.sectExpansion.care, revision: domain.revision + 1,
    receipts: [...domain.receipts, { command: cloneJson(command), revision: domain.revision + 1, jobId }] } } };
  return { world: next, relatedId: jobId, repeated: false };
}
export function tickValidatedCareV10(world: WorldStateV10, frame: SectUpgradeFrameV10, context: ConstructionContext, budget: WorkPathBudget): WorldStateV10 {
  if (context.paused || context.mode !== 'management' || context.expeditionActive) return world;
  let next = world;
  for (const original of world.sectExpansion.care.jobs.filter(job => !job.terminal).slice().sort((a, b) => compareStable(a.jobId, b.jobId))) {
    const job = next.sectExpansion.care.jobs.find(job => job.jobId === original.jobId)!;
    if (!v10CarePatientEligible(next, job.patientId, job.jobId)) throw new TypeError('Care lifecycle must reconcile before treatment');
    const actor = next.disciples.find(actor => actor.id === job.patientId)!;
    if (!frame.construction.legacyStations.some(site => site.id === job.storageId && site.operational)) { next = block(next, job, 'STORAGE_UNAVAILABLE'); continue; }
    if ([...context.externalClaims, ...sectUpgradeAllLocalClaimsV10(frame)].some(claim => claim.ownerId !== job.jobId && claim.kind === 'entrance' && claim.key === `${job.storagePosition.x},${job.storagePosition.y}`)) {
      next = block(next, job, 'ENTRANCE_BUSY'); continue;
    }
    const map = constructionEffectiveMap(frame.construction);
    if (job.phase === 'to-storage' || !sameCell(actor.position, job.storagePosition) || !isWalkable(map, actor.position)) {
      if (job.visits.length >= SECT_CARE_LIMITS.visits) { next = block(next, job, 'VISIT_CAPACITY'); continue; }
      const movement = advanceWorkNavigationWithBudget({ map, position: actor.position, target: job.storagePosition, navigation: job.navigation, simulationTick: context.simulationTick }, budget);
      next = { ...next, disciples: next.disciples.map(value => value.id === actor.id ? { ...value, position: movement.position ?? value.position, traveling: movement.traveling } : value) };
      next = replace(next, { ...job, phase: movement.status === 'arrived' ? 'working' : 'to-storage', navigation: movement.navigation,
        blocked: movement.status === 'path-blocked' ? 'PATH_BLOCKED' : movement.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null,
        visits: movement.status === 'arrived' ? [...job.visits, { tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...job.storagePosition } }] : job.visits });
      continue; // Arrival is never one of the forty productive treatment ticks.
    }
    const last = job.workSpans.at(-1); const visitIndex = job.visits.length - 1;
    const spans = last && last.visitIndex === visitIndex && last.lastTick + 1 === context.simulationTick
      ? [...job.workSpans.slice(0, -1), { ...last, lastTick: context.simulationTick }]
      : [...job.workSpans, { firstTick: context.simulationTick, lastTick: context.simulationTick, visitIndex }];
    const progressed: SectCareJob = { ...job, workSpans: spans, activeTicks: job.activeTicks + 1, blocked: null };
    if (progressed.activeTicks < SECT_CARE_LIMITS.workTicks) { next = replace(next, progressed); continue; }
    const paid = commitSectReservation(ledgerOf(next), { reservationId: job.reservationId, ownerTransactionId: job.jobId }, `complete:${job.jobId}`, []);
    if (!paid.ok) throw new TypeError('Care payment failed');
    const effect = prepareWoundPowderEffectV9(next.cultivation, job.jobId, job.patientId, context.simulationTick);
    const revision = next.sectExpansion.care.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('Care revision exhausted');
    next = replace({ ...next, cultivation: effect.cultivation, inventory: paid.context.inventory,
      sectExpansion: { ...next.sectExpansion, stock: paid.context.stock, reservations: paid.context.reservations,
        care: { ...next.sectExpansion.care, revision } } }, { ...progressed, phase: 'completed', navigation: emptyNavigation(),
      terminal: { kind: 'completed', previousPhase: 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
        position: { ...actor.position }, consumed: cloneJson(WOUND_POWDER_COST_V9), released: [], effect: effect.receipt, cancellation: null, careRevision: revision } });
  }
  return next;
}
