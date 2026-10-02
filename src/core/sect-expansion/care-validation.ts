import { cardinalDistance, emptyNavigation, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isWoundPowderEffectReceiptV9 } from '../cultivation/care-effect-v9';
import { isCultivationCommand } from '../cultivation/validation';
import { CULTIVATION_RULES, PERMANENT_TALENT_RULES } from '../cultivation/rules';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify } from '../kernel/serialization';
import { canonicalUtf8ByteLength } from '../save-budget';
import { lookupEvent } from '../world/history-access';
import type { WorldStateV9 } from '../world/v9-types';
import { SECT_CARE_LIMITS, WOUND_POWDER_COST_V9, type SectCareCommand, type SectCareJob } from './care-types';
import { careTrainingModeAtRevision, deliveredPowderJobs, sectCareClaims, v9CarePatientEligible } from './care-runtime';
import type { ConstructionValidationIssue } from './construction-types';
import { isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from './history-identity';
import { ownSectFields } from './layout';
import { sectReservationLines } from './ledger';
import type { SectMaintenanceFrame } from './maintenance-types';
import { sectAllLocalClaims, sectClaimsConflict } from './research-validation';

const integer = isNonNegativeInteger;
const fields = ownSectFields;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const playerCommandId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const array = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && isLedgerDataArray(value) && value.length <= maximum;
export function isSectCareCommand(value: unknown): value is SectCareCommand {
  try {
    canonicalUtf8ByteLength(value);
    if (!fields(value, ['kind', 'commandId', 'expectedRevision'], false) || !id(value.commandId) || !integer(value.expectedRevision)) return false;
    return value.kind === 'care.start' ? fields(value, ['kind', 'commandId', 'expectedRevision', 'patientId']) && playerCommandId(value.commandId) && id(value.patientId)
      : value.kind === 'care.cancel' && fields(value, ['kind', 'commandId', 'expectedRevision', 'jobId']) && id(value.jobId);
  } catch { return false; }
}
/** Record-only leaf after genuine four-domain provenance. No alleged stock/eligibility flag
 * can authorize treatment. Historical identities are admitted by the v9 lifecycle source. */
export function validateCareRecordsV9(world: WorldStateV9, frame: SectMaintenanceFrame, identities: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path = 'care'): readonly ConstructionValidationIssue[] => [{ code, path }];
  const domain = world.sectExpansion.care; const tick = world.clock.simulationTick;
  if (!fields(domain, ['revision', 'nextId', 'jobs', 'receipts']) || !integer(domain.revision) || !integer(domain.nextId) || domain.nextId < 1
    || !array(domain.jobs, SECT_CARE_LIMITS.records) || !array(domain.receipts, SECT_CARE_LIMITS.receipts)
    || domain.jobs.some(job => !isLedgerDataRecord(job))) return fail('INVALID_CARE_DOMAIN');
  const active = domain.jobs.filter(job => !job.terminal);
  if (domain.revision > Number.MAX_SAFE_INTEGER - active.length || domain.receipts.length + active.length > SECT_CARE_LIMITS.receipts)
    return fail('CARE_TERMINAL_CAPACITY');
  const cell = (value: unknown): value is { x: number; y: number } => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y)
    && value.x < world.map.width && value.y < world.map.height;
  const allocations = new Set<number>();
  const allocation = (value: string, prefix: string): number | null => {
    if (!id(value) || !value.startsWith(`${prefix}:`)) return null;
    const suffix = value.slice(prefix.length + 1); const n = Number(suffix);
    if (!integer(n) || n < 1 || String(n) !== suffix || n >= domain.nextId || allocations.has(n)
      || world.disciples.some(actor => actor.id === value) || world.buildings.some(site => site.id === value)) return null;
    allocations.add(n); return n;
  };
  const commandIds = new Set<string>(); let lastReceiptRevision = 0;
  for (const receipt of domain.receipts) {
    if (!fields(receipt, ['command', 'revision', 'jobId']) || !isSectCareCommand(receipt.command) || !integer(receipt.revision)
      || receipt.revision !== receipt.command.expectedRevision + 1 || receipt.revision > domain.revision || receipt.revision <= lastReceiptRevision
      || commandIds.has(receipt.command.commandId) || !id(receipt.jobId)) return fail('INVALID_CARE_RECEIPT');
    const job = domain.jobs.find(job => job.jobId === receipt.jobId); const command = receipt.command;
    if (!job || (command.kind === 'care.start' ? command.patientId !== job.patientId
      : command.jobId !== job.jobId || job.terminal?.kind !== 'cancelled' || job.terminal.careRevision !== receipt.revision)) return fail('INVALID_CARE_RECEIPT_SOURCE');
    lastReceiptRevision = receipt.revision; commandIds.add(receipt.command.commandId);
  }
  let previousAllocation = 0; let previousStartRevision = 0; let previousStartTick = 0;
  const history: SectCareJob[] = []; const revisions: { revision: number; tick: number }[] = [];
  const effectRevisions = new Set<number>();
  for (const job of domain.jobs) {
    if (!fields(job, ['jobId', 'reservationId', 'patientId', 'doseProductionJobId', 'previousCancelledCareId', 'startedTick', 'startedCalendarTick', 'origin',
      'storageId', 'storagePosition', 'phase', 'activeTicks', 'visits', 'workSpans', 'navigation', 'blocked', 'terminal'])
      || !id(job.patientId) || !id(job.doseProductionJobId) || !(job.previousCancelledCareId === null || id(job.previousCancelledCareId))
      || !integer(job.startedTick) || job.startedTick > tick || job.startedCalendarTick !== job.startedTick || !cell(job.origin) || !cell(job.storagePosition)
      || !integer(job.activeTicks) || job.activeTicks > SECT_CARE_LIMITS.workTicks || !['to-storage', 'working', 'completed', 'cancelled'].includes(job.phase)
      || ![null, 'PATH_BLOCKED', 'PATH_BUDGET', 'STORAGE_UNAVAILABLE', 'ENTRANCE_BUSY', 'VISIT_CAPACITY'].includes(job.blocked)
      || !array(job.visits, SECT_CARE_LIMITS.visits) || !array(job.workSpans, SECT_CARE_LIMITS.workTicks)) return fail('INVALID_CARE_JOB');
    const n = allocation(job.jobId, 'sect-care'); const r = allocation(job.reservationId, 'sect-care-reservation');
    if (n === null || r !== n + 1 || n <= previousAllocation) return fail('INVALID_CARE_ALLOCATION', job.jobId);
    previousAllocation = n + 1;
    const starts = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'care.start');
    const cancels = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'care.cancel');
    if (starts.length !== 1 || cancels.length !== (job.terminal?.kind === 'cancelled' ? 1 : 0)
      || starts[0]!.revision <= previousStartRevision || job.startedTick < previousStartTick) return fail('INVALID_CARE_COMMAND_CHRONOLOGY', job.jobId);
    const startRevision = starts[0]!.revision;
    previousStartRevision = startRevision; previousStartTick = job.startedTick; revisions.push({ revision: startRevision, tick: job.startedTick });
    const actor = world.disciples.find(actor => actor.id === job.patientId);
    if (!actor && !isArchivedSectWorkerReference(identities, job.patientId, job.terminal)) return fail('INVALID_CARE_PATIENT_REFERENCE', job.jobId);
    const storage = world.buildings.find(site => site.id === job.storageId && site.blueprintId === 'storage');
    if (!storage || !same(job.storagePosition, { x: storage.x, y: storage.y })) return fail('INVALID_CARE_STORAGE', job.jobId);
    const isReleasedBeforeStart = (use: SectCareJob): boolean => use.terminal?.kind === 'cancelled'
      && use.terminal.tick <= job.startedTick && use.terminal.careRevision < startRevision;
    const expectedDose = deliveredPowderJobs(frame, job.startedTick).find(source => !history.some(use => use.doseProductionJobId === source.transactionId && !isReleasedBeforeStart(use)));
    if (!expectedDose || expectedDose.transactionId !== job.doseProductionJobId) return fail('INVALID_CARE_DOSE_PROVENANCE', job.jobId);
    const previous = history.filter(use => use.doseProductionJobId === job.doseProductionJobId).at(-1);
    if (job.previousCancelledCareId !== (previous?.jobId ?? null) || previous && !isReleasedBeforeStart(previous)) return fail('INVALID_CARE_DOSE_REUSE', job.jobId);
    if (history.some(use => use.patientId === job.patientId && (!use.terminal || use.terminal.tick > job.startedTick || use.terminal.careRevision >= startRevision))) return fail('CARE_PATIENT_OVERLAP', job.jobId);
    let previousVisitTick = job.startedTick;
    for (const [i, visit] of job.visits.entries()) {
      if (!fields(visit, ['tick', 'calendarTick', 'position']) || !integer(visit.tick) || visit.tick <= previousVisitTick || visit.tick > tick
        || visit.calendarTick !== visit.tick || !same(visit.position, job.storagePosition)
        || i === 0 && visit.tick - job.startedTick < Math.max(1, cardinalDistance(job.origin, job.storagePosition) * MOVEMENT_TICKS_PER_CELL)) return fail('INVALID_CARE_VISIT', job.jobId);
      previousVisitTick = visit.tick;
    }
    let count = 0; let lastTick = job.startedTick; let lastVisit = -1;
    for (const span of job.workSpans) {
      if (!fields(span, ['firstTick', 'lastTick', 'visitIndex']) || !integer(span.firstTick) || !integer(span.lastTick) || !integer(span.visitIndex)
        || span.visitIndex < lastVisit || span.visitIndex >= job.visits.length || span.firstTick <= lastTick || span.lastTick < span.firstTick || span.lastTick > tick
        || span.firstTick <= job.visits[span.visitIndex]!.tick || job.visits[span.visitIndex + 1] && span.lastTick >= job.visits[span.visitIndex + 1]!.tick
        || count > 0 && lastVisit === span.visitIndex && span.firstTick === lastTick + 1) return fail('INVALID_CARE_WORK', job.jobId);
      count += span.lastTick - span.firstTick + 1; lastTick = span.lastTick; lastVisit = span.visitIndex;
    }
    if (count !== job.activeTicks || job.phase === 'working' && !job.visits.length) return fail('INVALID_CARE_WORK', job.jobId);
    const claim = frame.construction.ledger.reservations.find(claim => claim.ownerTransactionId === job.jobId && claim.reservationId === job.reservationId);
    if (!claim || claim.policy !== 'on-completion' || !same(sectReservationLines(claim, 'lines'), WOUND_POWDER_COST_V9)
      || claim.base.checkpoints.length || claim.sect.checkpoints.length) return fail('INVALID_CARE_COST', job.jobId);
    const nav = job.navigation;
    if (!fields(nav, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !array(nav.path, world.map.width * world.map.height)
      || nav.path.some(p => !cell(p)) || !(nav.target === null || cell(nav.target) && same(nav.target, job.storagePosition))
      || !(nav.routeVersion === null || integer(nav.routeVersion) && nav.routeVersion <= world.map.navVersion)
      || !integer(nav.movementTicks) || nav.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(nav.retryAtTick)
      || nav.path.some((p, i) => i > 0 && cardinalDistance(p, nav.path[i - 1]!) !== 1)) return fail('INVALID_CARE_NAVIGATION', job.jobId);
    if (job.terminal === null) {
      if (!['to-storage', 'working'].includes(job.phase) || count >= SECT_CARE_LIMITS.workTicks || claim.base.settlement !== null || claim.sect.settlement !== null
        || !same(sectReservationLines(claim, 'remainingReservation'), WOUND_POWDER_COST_V9) || sectReservationLines(claim, 'consumed').length
        || !actor || !v9CarePatientEligible(world, job.patientId, job.jobId)
        || job.phase === 'working' && (!same(actor.position, job.storagePosition) || !same(nav, emptyNavigation()))
        || actor.traveling !== (nav.path.length > 0 && job.blocked === null)
        || nav.path.length > 0 && nav.routeVersion === world.map.navVersion && cardinalDistance(actor.position, nav.path[0]!) !== 1) return fail('INVALID_ACTIVE_CARE', job.jobId);
    } else {
      const terminal = job.terminal;
      if (!fields(terminal, ['kind', 'previousPhase', 'tick', 'calendarTick', 'position', 'consumed', 'released', 'effect', 'cancellation', 'careRevision'])
        || !['completed', 'cancelled'].includes(terminal.kind) || job.phase !== terminal.kind || !['to-storage', 'working'].includes(terminal.previousPhase)
        || !integer(terminal.tick) || terminal.tick < Math.max(lastTick, previousVisitTick) || terminal.tick > tick || terminal.calendarTick !== terminal.tick
        || !cell(terminal.position) || !integer(terminal.careRevision) || terminal.careRevision <= startRevision || terminal.careRevision > domain.revision
        || terminal.tick - job.startedTick < job.activeTicks + cardinalDistance(job.origin, terminal.position) * MOVEMENT_TICKS_PER_CELL
        || !same(nav, emptyNavigation()) || job.blocked !== null || !same(terminal.consumed, sectReservationLines(claim, 'consumed'))
        || terminal.previousPhase === 'working' && !job.visits.length) return fail('INVALID_CARE_TERMINAL', job.jobId);
      revisions.push({ revision: terminal.careRevision, tick: terminal.tick });
      if (terminal.kind === 'completed') {
        const effect = terminal.effect;
        if (count !== SECT_CARE_LIMITS.workTicks || terminal.previousPhase !== 'working' || terminal.tick !== lastTick || !same(terminal.position, job.storagePosition)
          || !same(terminal.consumed, WOUND_POWDER_COST_V9) || !same(terminal.released, []) || terminal.cancellation !== null
          || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
          || claim.base.settlement.operationId !== `complete:${job.jobId}` || claim.sect.settlement.operationId !== `complete:${job.jobId}`
          || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length
          || !isWoundPowderEffectReceiptV9(effect) || effect.careJobId !== job.jobId || effect.patientId !== job.patientId || effect.tick !== terminal.tick
          || effect.afterRevision > world.cultivation.revision || effectRevisions.has(effect.afterRevision)) return fail('INVALID_CARE_EFFECT', job.jobId);
        effectRevisions.add(effect.afterRevision);
        const patient = world.cultivation.disciples.find(profile => profile.discipleId === job.patientId);
        if (effect.afterRevision === world.cultivation.revision && patient?.injury !== effect.afterInjury) return fail('CARE_EFFECT_STATE_DIFFERS', job.jobId);
      } else {
        if (count >= SECT_CARE_LIMITS.workTicks || terminal.effect !== null || !same(terminal.consumed, []) || !same(terminal.released, WOUND_POWDER_COST_V9)
          || claim.base.settlement?.kind !== 'released' || claim.sect.settlement?.kind !== 'released'
          || claim.base.settlement.operationId !== `cancel:${job.jobId}` || claim.sect.settlement.operationId !== `cancel:${job.jobId}`) return fail('INVALID_CARE_CANCELLATION', job.jobId);
        const reason = terminal.cancellation; const receipt = cancels[0]!;
        if (reason === null || !isLedgerDataRecord(reason)) return fail('INVALID_CARE_CANCELLATION_SOURCE', job.jobId);
        if (reason.kind === 'requested') {
          if (!fields(reason, ['kind']) || !playerCommandId(receipt.command.commandId)) return fail('INVALID_CARE_CANCELLATION_SOURCE', job.jobId);
        } else if (reason.kind === 'death') {
          if (!fields(reason, ['kind', 'deathId'])) return fail('INVALID_CARE_DEATH_SOURCE', job.jobId);
          const death = [...world.cultivation.pendingDeaths, ...world.cultivation.deaths].find(death => death.deathId === reason.deathId && death.discipleId === job.patientId);
          const event = world.cultivation.events.find(event => event.discipleId === job.patientId && event.relatedId === death?.deathId && event.kind === 'cultivation.expiryPending');
          if (!death || !event || lookupEvent(world, event.eventId)?.tick !== terminal.tick
            || receipt.command.commandId !== `system/v9/death/${death.deathId}/${job.jobId}`) return fail('INVALID_CARE_DEATH_SOURCE', job.jobId);
        } else if (reason.kind === 'rest-healed') {
          // Receipt consistency only: beforeRevision is captured from the actual runtime
          // source, not independently reconstructed as a tamper-proof historical timeline.
          if (careTrainingModeAtRevision(world.cultivation, reason.beforeRevision, job.patientId) !== 'rest') return fail('INVALID_CARE_HEAL_SOURCE', job.jobId);
          const patient = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(profile => profile.discipleId === job.patientId)!;
          if (!array(reason.healingSourceInstanceIds, 3) || reason.healingSourceInstanceIds.some(sourceId => !id(sourceId))
            || new Set(reason.healingSourceInstanceIds).size !== reason.healingSourceInstanceIds.length
            || !same(reason.healingSourceInstanceIds, [...reason.healingSourceInstanceIds].sort())) return fail('INVALID_CARE_HEAL_SOURCE', job.jobId);
          let healing = CULTIVATION_RULES.rest.healingPerMonth;
          for (const sourceId of reason.healingSourceInstanceIds) {
            const talent = patient.talents.find(talent => talent.sourceInstanceId === sourceId);
            const event = world.cultivation.events.find(event => event.kind === 'cultivation.talentGranted' && event.discipleId === job.patientId && event.relatedId === sourceId);
            const granted = event && lookupEvent(world, event.eventId);
            if (!talent || !granted || granted.tick >= terminal.tick || PERMANENT_TALENT_RULES[talent.sourceDefinitionId].healing <= 0)
              return fail('INVALID_CARE_HEAL_SOURCE', job.jobId);
            const grantMatches = world.cultivation.receipts.some(receipt => {
              if (receipt.result.kind !== 'talent.grant' || receipt.result.relatedId !== sourceId || receipt.result.outcome !== 'accepted') return false;
              try {
                const command: unknown = JSON.parse(receipt.fingerprint);
                return isCultivationCommand(command) && command.kind === 'talent.grant' && command.commandId === receipt.commandId
                  && receipt.result.commandId === command.commandId && command.discipleId === job.patientId && command.talentId === talent.sourceDefinitionId
                  && command.expectedRevision < reason.beforeRevision && canonicalStringify(command) === receipt.fingerprint;
              } catch { return false; }
            });
            if (!grantMatches) return fail('INVALID_CARE_HEAL_SOURCE', job.jobId);
            // The source persists after death revokes its active flag. The actual pre-month
            // runtime selected it; its immutable grant event establishes historical ownership.
            healing += PERMANENT_TALENT_RULES[talent.sourceDefinitionId].healing;
          }
          if (!fields(reason, ['kind', 'beforeInjury', 'beforeRevision', 'afterRevision', 'month', 'healingSourceInstanceIds']) || !integer(reason.beforeInjury) || reason.beforeInjury <= 0 || reason.beforeInjury > healing
            || !integer(reason.beforeRevision) || !integer(reason.afterRevision) || !integer(reason.month) || reason.afterRevision !== reason.beforeRevision + 1 || reason.afterRevision > world.cultivation.revision
            || reason.month * CALENDAR_TICKS_PER_MONTH !== terminal.tick || receipt.command.commandId !== `system/v9/healed/${reason.month}/${job.jobId}`
            || reason.afterRevision === world.cultivation.revision && patient.injury !== 0) return fail('INVALID_CARE_HEAL_SOURCE', job.jobId);
        } else return fail('INVALID_CARE_CANCELLATION_SOURCE', job.jobId);
      }
    }
    history.push(job);
  }
  revisions.sort((a, b) => a.revision - b.revision);
  if (revisions.some((value, i) => i > 0 && (value.revision === revisions[i - 1]!.revision || value.tick < revisions[i - 1]!.tick))) return fail('INVALID_CARE_REVISION_CHRONOLOGY');
  return [];
}
/** Explicit FIVE-owner closure. Every reservation is retained and counted once. */
export function validateCareOwnerClosureV9(world: WorldStateV9, frame: SectMaintenanceFrame): readonly ConstructionValidationIssue[] {
  for (const claim of frame.construction.ledger.reservations) {
    const owners = frame.construction.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.production.jobs.filter(job => job.transactionId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.research.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.maintenance.payments.filter(payment => payment.paymentId === claim.ownerTransactionId && payment.reservationId === claim.reservationId).length
      + world.sectExpansion.care.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length;
    if (owners !== 1) return [{ code: 'ORPHAN_RESERVATION', path: claim.reservationId }];
  }
  const claims = [...sectAllLocalClaims(frame), ...sectCareClaims(world)];
  if (claims.filter(claim => claim.kind === 'worker').length > 36 || sectClaimsConflict(claims)) return [{ code: 'CARE_OWNER_CONFLICT', path: 'care' }];
  return [];
}
