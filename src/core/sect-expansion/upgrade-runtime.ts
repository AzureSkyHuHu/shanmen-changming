import { BLOCKED_PATH_RETRY_TICKS, emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionEffectiveMap } from './construction-runtime';
import { validateConstructionContext } from './construction-record-validation';
import type { ConstructionContext } from './construction-types';
import type { SectHistoricalIdentitySource } from './history-identity';
import { commitSectReservation, consumeSectConstructionCheckpoint, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { inspectSectUpgradeStartV10, isSectUpgradeCommandV10, isSectUpgradeDataTreeV10, sectBuildingL1PaidRangeV10,
  sectUpgradeAllLocalClaimsV10, sectUpgradeCostsV10, sectUpgradeGateFromRecordsV10, sectUpgradeSiteFromRecordsV10,
  sectUpgradeWorkerEligibleV10, validateSectUpgradeRecordsV10 } from './upgrade-validation';
import type { SectUpgradeBlockV10, SectUpgradeCommandV10, SectUpgradeFrameV10, SectUpgradeJobV10,
  SectUpgradeLivePhaseV10, SectUpgradeRejectionV10, SectUpgradeResultV10 } from './upgrade-types';

export { createSectUpgradeStateV10, isSectUpgradeCommandV10, sectUpgradeClaimsV10 } from './upgrade-validation';
const MAX = Number.MAX_SAFE_INTEGER;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const rejected = (frame: SectUpgradeFrameV10, code: SectUpgradeRejectionV10): SectUpgradeResultV10 => ({ ok: false, frame, code });
const accepted = (frame: SectUpgradeFrameV10, jobId: string | null = null, repeated = false): SectUpgradeResultV10 =>
  ({ ok: true, frame: cloneJson(frame), repeated, jobId });
function replace(frame: SectUpgradeFrameV10, job: SectUpgradeJobV10): SectUpgradeFrameV10 {
  return { ...frame, upgrade: { ...frame.upgrade, jobs: frame.upgrade.jobs.map(value => value.jobId === job.jobId ? job : value) } };
}
function baseAdmission(frame: SectUpgradeFrameV10, context: ConstructionContext): SectUpgradeRejectionV10 | null {
  if (!isSectUpgradeDataTreeV10(context, 600) || !validateConstructionContext(context) || context.simulationTick !== context.calendarTick) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
/** Internal fixed stage only. Complete source World, duty/build/teaching/lifecycle locks,
 * external claims, legacy balances, six-owner closure and whole-save future obligations are
 * authenticated by the v10 root. Successful return is an isolated DOMAIN CANDIDATE, not admission.
 * No deathId/trusted flag/callback overload exists; forced death remains root-owned and closed
 * until a version-authenticated exact lifecycle transition port is supplied. */
export function applyValidatedSectUpgradeCommandV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  command: SectUpgradeCommandV10): SectUpgradeResultV10 {
  const invalid = baseAdmission(frame, context); if (invalid) return rejected(frame, invalid);
  if (!isSectUpgradeCommandV10(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.upgrade.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if ([...frame.construction.receipts, ...frame.production.receipts, ...frame.research.receipts, ...frame.care.receipts]
    .some(receipt => receipt.command.commandId === command.commandId)) return rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.upgrade.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.upgrade.revision === MAX || frame.upgrade.receipts.length >= 256) return rejected(frame, 'CAPACITY_EXCEEDED');
  const revision = frame.upgrade.revision + 1;
  let next = frame; let jobId: string;
  if (command.kind === 'upgrade.start') {
    const reason = inspectSectUpgradeStartV10(frame, context, command.buildingId, command.workerId);
    if (reason) return rejected(frame, reason);
    const site = sectUpgradeSiteFromRecordsV10(frame, command.buildingId)!;
    const researchGate = sectUpgradeGateFromRecordsV10(frame, context.simulationTick)!;
    const worker = frame.construction.people.find(value => value.id === command.workerId)!;
    const storage = frame.construction.legacyStations.find(value => value.blueprintId === 'storage' && value.operational)!;
    jobId = `sect-upgrade:${frame.upgrade.nextId}`;
    const reservationId = `sect-upgrade-reservation:${frame.upgrade.nextId + 1}`;
    const reserve = reserveSectResources(frame.construction.ledger, { reservationId, ownerTransactionId: jobId }, sectUpgradeCostsV10(), 'construction-checkpoints');
    if (!reserve.ok) return rejected(frame, reserve.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    const job: SectUpgradeJobV10 = { jobId, reservationId, workerId: worker.id, buildingId: command.buildingId, fromLevel: 1, toLevel: 2, requiredTicks: 400,
      researchGate, site, storageId: storage.id, storagePosition: { x: storage.x, y: storage.y }, seatToken: command.buildingId,
      entranceToken: `${site.position.x},${site.position.y}`, startedTick: context.simulationTick, startedCalendarTick: context.calendarTick,
      origin: { ...worker.position }, phase: 'to-storage', storageVisit: null, siteVisits: [], workSpans: [], checkpoints: [], activeTicks: 0,
      navigation: emptyNavigation(), blocked: null, terminal: null };
    next = { ...frame, construction: { ...frame.construction, ledger: reserve.context },
      upgrade: { ...frame.upgrade, nextId: frame.upgrade.nextId + 2, jobs: [...frame.upgrade.jobs, job] } };
  } else {
    const job = frame.upgrade.jobs.find(value => value.jobId === command.jobId);
    if (!job) return rejected(frame, 'UNKNOWN_JOB');
    if (job.terminal !== null) return rejected(frame, 'TRANSACTION_FINISHED');
    const worker = frame.construction.people.find(value => value.id === job.workerId);
    if (!worker || !isWalkable(constructionEffectiveMap(frame.construction), worker.position)) return rejected(frame, 'UNSAFE_POSITION');
    jobId = job.jobId;
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    const release = releaseSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!release.ok) return rejected(frame, 'INVALID_RESERVATION');
    next = replace({ ...frame, construction: { ...frame.construction, ledger: release.context } }, { ...job, phase: 'cancelled', navigation: emptyNavigation(), blocked: null,
      terminal: { kind: 'cancelled', previousPhase: job.phase as SectUpgradeLivePhaseV10, resultLevel: 1, cancellation: { kind: 'requested' },
        tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position }, consumed: sectReservationLines(claim, 'consumed'),
        released: sectReservationLines(claim, 'remainingReservation'), upgradeRevision: revision } });
  }
  next = { ...next, upgrade: { ...next.upgrade, revision,
    receipts: [...next.upgrade.receipts, { command: cloneJson(command), revision, jobId }] } };
  if (next.upgrade.revision !== frame.upgrade.revision + 1 || next.upgrade.nextId !== frame.upgrade.nextId + (command.kind === 'upgrade.start' ? 2 : 0)
    || next.construction.map.navVersion !== frame.construction.map.navVersion) return rejected(frame, 'INVALID_FRAME');
  return accepted(next, jobId);
}
function block(frame: SectUpgradeFrameV10, job: SectUpgradeJobV10, reason: Exclude<SectUpgradeBlockV10, null>): SectUpgradeFrameV10 {
  return job.blocked === reason ? frame : replace(frame, { ...job, blocked: reason });
}
/** The enclosing tick has ALREADY advanced its single construction projection clock. Exactly
 * one call per tick is the root's responsibility (there is no duplicate saved upgrade clock).
 * Shared budget is not replenished here. All changed jobs share a single post-stage revision. */
export function tickValidatedSectUpgradeV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  budget: WorkPathBudget): SectUpgradeResultV10 {
  const invalid = baseAdmission(frame, context); if (invalid) return rejected(frame, invalid);
  if (context.mode !== 'management' || context.expeditionActive || context.paused) return accepted(frame);
  const jobs = frame.upgrade.jobs.filter(job => job.terminal === null).slice()
    .sort((a, b) => a.startedTick - b.startedTick || compareStable(a.jobId, b.jobId));
  if (!jobs.length) return accepted(frame);
  // Pending/dead actors must be reconciled by the preceding lifecycle stage. Never let any
  // other job partially publish or let the would-be 400th work tick outrun that cleanup.
  if (jobs.some(job => frame.construction.people.find(person => person.id === job.workerId)?.lifeState !== 'alive')) return rejected(frame, 'WORKER_UNAVAILABLE');
  let next = frame;
  for (const original of jobs) {
    const job = next.upgrade.jobs.find(value => value.jobId === original.jobId)!;
    if (context.simulationTick <= job.startedTick) continue;
    const worker = next.construction.people.find(value => value.id === job.workerId)!;
    if (!sectUpgradeWorkerEligibleV10(worker)) { next = block(next, job, 'WORKER_UNAVAILABLE'); continue; }
    const map = constructionEffectiveMap(next.construction);
    if (!isWalkable(map, job.site.position)) { next = block(next, job, 'SITE_UNAVAILABLE'); continue; }
    if (!sectBuildingL1PaidRangeV10(next, job.buildingId, context.simulationTick, context.simulationTick, context.calendarTick, context.calendarTick)) {
      next = block(next, job, 'MAINTENANCE_UNPAID'); continue;
    }
    const otherClaims = [...sectUpgradeAllLocalClaimsV10(next), ...context.externalClaims].filter(claim => claim.ownerId !== job.jobId);
    if (otherClaims.some(claim => claim.kind === 'worker' && claim.key === job.workerId)) { next = block(next, job, 'WORKER_UNAVAILABLE'); continue; }
    if (otherClaims.some(claim => claim.kind === 'seat' && claim.key === job.buildingId || claim.kind === 'entrance' && claim.key === job.entranceToken)) {
      next = block(next, job, 'ENTRANCE_BUSY'); continue;
    }
    const toStorage = job.phase === 'to-storage';
    const target = toStorage ? job.storagePosition : job.site.position;
    if (toStorage && (!next.construction.legacyStations.some(value => value.id === job.storageId && value.operational)
      || !isWalkable(map, target) || otherClaims.some(claim => claim.kind === 'entrance' && claim.key === `${target.x},${target.y}`))) {
      next = block(next, job, 'STORAGE_UNAVAILABLE'); continue;
    }
    if (!toStorage && next.construction.people.some(person => person.id !== worker.id && !person.away && person.lifeState !== 'dead' && sameCell(person.position, target))) {
      next = block(next, job, 'ENTRANCE_BUSY'); continue;
    }
    if (job.phase !== 'working' || !sameCell(worker.position, job.site.position) || !isWalkable(map, worker.position)) {
      if (!toStorage && job.siteVisits.length >= 401) { next = block(next, job, 'VISIT_CAPACITY'); continue; }
      if (context.simulationTick > MAX - BLOCKED_PATH_RETRY_TICKS) return rejected(frame, 'CAPACITY_EXCEEDED');
      let movement;
      try { movement = advanceWorkNavigationWithBudget({ map, position: worker.position, target, navigation: job.navigation, simulationTick: context.simulationTick }, budget); }
      catch { return rejected(frame, 'INVALID_CONTEXT'); }
      if (movement.position) next = { ...next, construction: { ...next.construction,
        people: next.construction.people.map(person => person.id === worker.id ? { ...person, position: { ...movement.position! } } : person) } };
      const arrived = movement.status === 'arrived';
      const position = { ...target };
      next = replace(next, { ...job, phase: arrived ? toStorage ? 'to-site' : 'working' : toStorage ? 'to-storage' : 'to-site', navigation: movement.navigation,
        blocked: movement.status === 'path-blocked' ? 'PATH_BLOCKED' : movement.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null,
        storageVisit: arrived && toStorage ? { tick: context.simulationTick, calendarTick: context.calendarTick, position } : job.storageVisit,
        siteVisits: arrived && !toStorage ? [...job.siteVisits, { tick: context.simulationTick, calendarTick: context.calendarTick, position }] : job.siteVisits });
      continue; // Arrival is its own boundary, never productive work.
    }
    const visitIndex = job.siteVisits.length - 1;
    const last = job.workSpans.at(-1);
    if (job.siteVisits[visitIndex]!.tick >= context.simulationTick || last && last.lastTick >= context.simulationTick) continue;
    const merge = last && last.visitIndex === visitIndex && last.lastTick === context.simulationTick - 1 && last.lastCalendarTick === context.calendarTick - 1;
    if (!merge && job.workSpans.length >= 400) { next = block(next, job, 'VISIT_CAPACITY'); continue; }
    const workSpans = merge ? [...job.workSpans.slice(0, -1), { ...last, lastTick: context.simulationTick, lastCalendarTick: context.calendarTick }]
      : [...job.workSpans, { firstTick: context.simulationTick, lastTick: context.simulationTick, firstCalendarTick: context.calendarTick, lastCalendarTick: context.calendarTick, visitIndex }];
    let progressed: SectUpgradeJobV10 = { ...job, activeTicks: job.activeTicks + 1, workSpans, blocked: null };
    const identity = { reservationId: job.reservationId, ownerTransactionId: job.jobId };
    if (progressed.activeTicks === 200 || progressed.activeTicks === 400) {
      const checkpoint = progressed.activeTicks === 200 ? 'half' : 'remainder';
      const consumed = consumeSectConstructionCheckpoint(next.construction.ledger, identity, checkpoint);
      if (!consumed.ok) return rejected(frame, 'INVALID_RESERVATION');
      next = { ...next, construction: { ...next.construction, ledger: consumed.context } };
      progressed = { ...progressed, checkpoints: [...progressed.checkpoints, progressed.activeTicks === 200
        ? { checkpointId: 'construction.half', activeTicks: 200, tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position } }
        : { checkpointId: 'construction.remainder', activeTicks: 400, tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position } }] };
    }
    if (progressed.activeTicks === 400) {
      const completed = commitSectReservation(next.construction.ledger, identity, `complete:${job.jobId}`, []);
      if (!completed.ok) return rejected(frame, 'INVALID_RESERVATION');
      next = { ...next, construction: { ...next.construction, ledger: completed.context } };
      progressed = { ...progressed, phase: 'completed', navigation: emptyNavigation(), terminal: {
        kind: 'completed', previousPhase: 'working', resultLevel: 2, cancellation: null,
        tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position },
        consumed: sectReservationLines(completed.reservation, 'consumed'), released: [], upgradeRevision: frame.upgrade.revision + 1 } };
    }
    next = replace(next, progressed);
  }
  const changed = !same(next.upgrade.jobs, frame.upgrade.jobs) || !same(next.construction.people, frame.construction.people);
  if (!changed) return accepted(frame);
  const remaining = next.upgrade.jobs.filter(job => job.terminal === null).length;
  if (frame.upgrade.revision >= MAX - remaining) return rejected(frame, 'CAPACITY_EXCEEDED');
  next = { ...next, upgrade: { ...next.upgrade, revision: frame.upgrade.revision + 1 } };
  if (next.upgrade.nextId !== frame.upgrade.nextId || next.upgrade.receipts.length !== frame.upgrade.receipts.length
    || next.construction.map.navVersion !== frame.construction.map.navVersion) return rejected(frame, 'INVALID_FRAME');
  return accepted(next);
}

/** Safe standalone domain wrapper. The identity source can establish historical persons only;
 * it cannot authorize work, excuse malformed records, or become complete World admission. */
export function applySectUpgradeCommandV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  command: SectUpgradeCommandV10, identities?: SectHistoricalIdentitySource): SectUpgradeResultV10 {
  if (validateSectUpgradeRecordsV10(frame, identities).length) return rejected(frame, 'INVALID_FRAME');
  const result = applyValidatedSectUpgradeCommandV10(frame, context, command);
  if (!result.ok) return result;
  if (validateSectUpgradeRecordsV10(result.frame, identities).length) return rejected(frame, 'INVALID_FRAME');
  return result;
}
/** Same root-clock convention as the internal stage, with full isolated domain authentication.
 * The enclosing World still owns once-per-tick execution and all other record/capacity stages. */
export function tickSectUpgradeV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  budget: WorkPathBudget, identities?: SectHistoricalIdentitySource): SectUpgradeResultV10 {
  if (validateSectUpgradeRecordsV10(frame, identities).length) return rejected(frame, 'INVALID_FRAME');
  const result = tickValidatedSectUpgradeV10(frame, context, budget);
  if (!result.ok) return result;
  if (validateSectUpgradeRecordsV10(result.frame, identities).length) return rejected(frame, 'INVALID_FRAME');
  return result;
}
