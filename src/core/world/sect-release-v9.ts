import { classifyAutomaticHandle, isAutomaticJobId, liveProductionAt } from '../economy/automatic-production';
import { iterateArchivedCommandReceipts, lookupArchivedProduction } from '../history';
import type { CommandReceipt } from '../kernel/contracts';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../kernel/simulation-v9';
import { canonicalStringify } from '../kernel/serialization';
import type { ProgressionReservationAssessment } from '../save-budget/progression-bounds';
import { verifyProgressionReservationDischarges } from '../save-budget/progression-bounds';
import type { SectObligationAssessmentV9 } from '../save-budget/sect-obligations-v9';
import { releaseSectReservation, sectReservationLines } from '../sect-expansion/ledger';
import { lookupCommandReceipt, lookupEvent, lookupProduction } from './history-access';
import type { WorldStateV9 } from './v9-types';

export interface ReservedDischargesV9 { supported: boolean; discharged: string[]; unknowns: string[] }
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const preserved = (left: object, right: object, keys: readonly string[]): boolean => keys.every(key =>
  same((left as Record<string, unknown>)[key] ?? null, (right as Record<string, unknown>)[key] ?? null));
function receipts(world: WorldStateV9): CommandReceipt[] {
  return [...iterateArchivedCommandReceipts(world.history), ...Object.values(world.commandReceipts)];
}
function unavailable(world: WorldStateV9, id: string): boolean {
  return world.cultivation.pendingDeaths.some(death => death.discipleId === id)
    || world.cultivation.deaths.some(death => death.discipleId === id);
}
function releasedWorkClaims(world: WorldStateV9, id: string): boolean {
  return !world.activeProductionTransactionIds.includes(id)
    && !world.disciples.some(actor => actor.assignmentTransactionId === id)
    && !world.buildings.some(site => site.stationTransactionId === id);
}
function cancellationReceipt(before: WorldStateV9, after: WorldStateV9, id: string, eventId: string, workerId: string): boolean {
  return receipts(after).some(receipt => !lookupCommandReceipt(before, receipt.commandId) && receipt.result.status === 'accepted'
    && receipt.result.eventIds.includes(eventId) && (receipt.fingerprint === canonicalStringify({ kind: 'production.cancel', payload: { transactionId: id } })
      || receipt.result.cultivationResult?.outcome === 'death' && unavailable(after, workerId)));
}
/** Only complete supported sources may call this proof. The runtime module checks
 * both complete Worlds and actual hard limits first. These checks authenticate
 * real owned terminal records; missing owners are never treated as a release. */
export function inspectReservedDischargesV9(before: WorldStateV9, after: WorldStateV9,
  previous: { sect: SectObligationAssessmentV9; progression: ProgressionReservationAssessment },
  current: { sect: SectObligationAssessmentV9; progression: ProgressionReservationAssessment }): ReservedDischargesV9 {
  const result: ReservedDischargesV9 = { supported: false, discharged: [], unknowns: [] };
  if (!previous.sect.supported || !current.sect.supported || !previous.progression.supported || !current.progression.supported) {
    result.unknowns.push('Unsupported owner envelope'); return result;
  }
  const fail = (owner: string): void => { result.unknowns.push(`Missing authentic terminal evidence for ${owner}`); };
  let authenticTick: boolean | undefined;
  const isActualTick = (): boolean => {
    if (authenticTick !== undefined) return authenticTick;
    authenticTick = false;
    if (after.clock.simulationTick !== before.clock.simulationTick + 1 || after.clock.calendarTick !== before.clock.calendarTick + 1) return false;
    for (const prepare of [prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9]) {
      try { if (same(prepare(before), after)) { authenticTick = true; break; } } catch { /* An unpreparable path supplies no witness. */ }
    }
    return authenticTick;
  };
  const left = before.sectExpansion; const right = after.sectExpansion;
  for (const owner of previous.sect.owners) {
    if (current.sect.owners.some(next => next.kind === owner.kind && next.id === owner.id)) continue;
    const label = `sect.${owner.kind}:${owner.id}`;
    if (owner.kind === 'planned-blueprint') {
      const bp = left.construction.blueprints.find(bp => bp.blueprintId === owner.id)!;
      const next = right.construction.blueprints.find(value => value.blueprintId === owner.id);
      const immutable = ['definitionId', 'anchor', 'rotation', 'researchGate', 'blueprintId', 'placedTick', 'placedCalendarTick'];
      // Starting transfers the planned obligation to its actual construction owner.
      // It is never a discharge eligible for deficient-headroom recovery.
      if (next?.status === 'started' && preserved(bp, next, immutable)
        && current.sect.owners.some(value => value.kind === 'construction' && value.id === next.jobId)) continue;
      const receipt = right.construction.receipts.find(value => value.command.kind === 'construction.cancel'
        && value.command.blueprintId === owner.id && value.relatedId === owner.id
        && value.command.expectedRevision >= left.construction.revision
        && !left.construction.receipts.some(old => old.command.commandId === value.command.commandId));
      if (!next || next.status !== 'cancelled' || next.jobId !== null || next.endedTick !== after.clock.simulationTick
        || !preserved(bp, next, immutable) || !receipt) fail(label);
      else result.discharged.push(label);
      continue;
    }
    const priorJob = owner.kind === 'construction' ? left.construction.jobs.find(job => job.jobId === owner.id)
      : owner.kind === 'production' ? left.production.jobs.find(job => job.transactionId === owner.id)
        : owner.kind === 'research' ? left.research.jobs.find(job => job.jobId === owner.id)
          : left.care.jobs.find(job => job.jobId === owner.id);
    const nextJob = owner.kind === 'construction' ? right.construction.jobs.find(job => job.jobId === owner.id)
      : owner.kind === 'production' ? right.production.jobs.find(job => job.transactionId === owner.id)
        : owner.kind === 'research' ? right.research.jobs.find(job => job.jobId === owner.id)
          : right.care.jobs.find(job => job.jobId === owner.id);
    const terminal = nextJob?.terminal;
    const immutable = ['jobId', 'transactionId', 'blueprintId', 'reservationId', 'resultBuildingId', 'workerId', 'patientId',
      'recipeId', 'researchId', 'researchGate', 'doseProductionJobId', 'previousCancelledCareId', 'startedTick', 'startedCalendarTick', 'origin'];
    const priorClaim = priorJob && left.reservations.find(claim => claim.reservationId === priorJob.reservationId && claim.ownerTransactionId === owner.id);
    const nextClaim = nextJob && right.reservations.find(claim => claim.reservationId === nextJob.reservationId && claim.ownerTransactionId === owner.id);
    if (!priorJob || priorJob.terminal || !nextJob || !terminal || !preserved(priorJob, nextJob, immutable)
      || !priorClaim || !nextClaim || terminal.tick !== after.clock.simulationTick || terminal.calendarTick !== after.clock.calendarTick
      || terminal.tick < before.clock.simulationTick) { fail(label); continue; }
    if (terminal.kind === 'cancelled') {
      const released = releaseSectReservation({ inventory: before.inventory, stock: left.stock, reservations: left.reservations },
        { reservationId: priorClaim.reservationId, ownerTransactionId: owner.id }, `cancel:${owner.id}`);
      const domain = owner.kind === 'construction' ? right.construction : owner.kind === 'production' ? right.production : owner.kind === 'research' ? right.research : right.care;
      const priorDomain = owner.kind === 'construction' ? left.construction : owner.kind === 'production' ? left.production : owner.kind === 'research' ? left.research : left.care;
      const receipt = domain.receipts.find(value => {
        const command = value.command;
        const targetsOwner = command.kind === 'construction.cancel' ? 'blueprintId' in priorJob && command.blueprintId === priorJob.blueprintId
          : ['production.cancel', 'research.cancel', 'care.cancel'].includes(command.kind) && 'jobId' in command && command.jobId === owner.id;
        return targetsOwner && command.expectedRevision >= priorDomain.revision
          && !priorDomain.receipts.some(old => old.command.commandId === command.commandId);
      });
      if (!released.ok || !same(released.reservation, nextClaim) || !receipt
        || !same(terminal.consumed, sectReservationLines(priorClaim, 'consumed'))
        || !same(terminal.released, sectReservationLines(priorClaim, 'remainingReservation'))
        || terminal.previousPhase !== priorJob.phase
        || !preserved(priorJob, nextJob, ['activeTicks', 'workSpans', 'visits', 'storageVisit', 'siteVisit', 'workVisit', 'deliveryVisit'])) {
        fail(label); continue;
      }
    } else {
      if (nextClaim.base.settlement?.kind !== 'committed' || nextClaim.sect.settlement?.kind !== 'committed'
        || nextClaim.base.settlement.operationId !== `complete:${owner.id}` || nextClaim.sect.settlement.operationId !== `complete:${owner.id}`
        || !same(priorClaim.base.lines, nextClaim.base.lines) || !same(priorClaim.sect.lines, nextClaim.sect.lines)) { fail(label); continue; }
      if (owner.kind === 'construction') {
        const bp = right.construction.blueprints.find(value => value.jobId === owner.id);
        const building = right.construction.buildings.find(value => value.sourceJobId === owner.id);
        if (bp?.status !== 'completed' || !building || !('resultBuildingId' in priorJob) || building.buildingId !== priorJob.resultBuildingId) { fail(label); continue; }
      }
      // Exact completion work/payment, care effect and research provenance are
      // checked by the complete after-source validators, never inferred from ID loss.
    }
    result.discharged.push(label);
  }
  for (const id of before.activeProductionTransactionIds) {
    if (after.activeProductionTransactionIds.includes(id)) continue;
    const source = liveProductionAt(before, id);
    const label = `${isAutomaticJobId(id) ? 'automatic' : 'manual'}-production:${id}`;
    if (!source || !releasedWorkClaims(after, id)) { fail(label); continue; }
    const job = source.transaction;
    if (!isAutomaticJobId(id)) {
      const terminal = lookupProduction(after, id); const archived = lookupArchivedProduction(after.history, id);
      const reservation = archived?.reservation ?? (terminal && after.reservations[terminal.reservationId]);
      const event = terminal?.resultEventId && lookupEvent(after, terminal.resultEventId);
      if (!terminal || !reservation || !event || !['Cancelled', 'Committed'].includes(terminal.state)
        || !preserved(job, terminal, ['transactionId', 'rootActionId', 'commandId', 'recipeId', 'workerId', 'reservationId', 'requiredTicks', 'startedTick'])
        || reservation.state !== (terminal.state === 'Cancelled' ? 'released' : 'committed')
        || !same(reservation.lines, source.reservation.lines) || reservation.ownerTransactionId !== id
        || event.rootActionId !== job.rootActionId || event.tick !== after.clock.simulationTick
        || !same(event.payload, { transactionId: id, recipeId: job.recipeId, workerId: job.workerId })
        || event.kind !== (terminal.state === 'Cancelled' ? 'production.cancelled' : 'production.committed')) { fail(label); continue; }
      if (terminal.state === 'Cancelled' && (terminal.activeTicks !== job.activeTicks
        || !(cancellationReceipt(before, after, id, event.eventId, job.workerId) || unavailable(after, job.workerId)))) { fail(label); continue; }
      result.discharged.push(label); continue;
    }
    const handle = classifyAutomaticHandle(after, id);
    if (handle.kind === 'pinned') {
      const pin = handle.pin; const event = pin.resultEventId && lookupEvent(after, pin.resultEventId);
      if (pin.state !== 'Cancelled' || pin.rootActionId !== job.rootActionId || pin.workerId !== job.workerId || pin.recipeId !== job.recipeId
        || pin.completedTick !== after.clock.simulationTick || !event || event.kind !== 'production.cancelled'
        || !same(event.payload, { transactionId: id, recipeId: job.recipeId, workerId: job.workerId, settledTick: pin.completedTick })
        || !cancellationReceipt(before, after, id, event.eventId, job.workerId)) { fail(label); continue; }
    } else {
      // System auto cancellation/completion has no durable pin. Its fresh journal
      // notice identifies the transition, but is not payment/work evidence. A
      // source-derived real tick replay must match the COMPLETE candidate. This
      // rare recovery check cannot be replaced by a fabricated journal notice.
      const cycle = 'origin' in job ? job.origin.cycle : -1;
      const notice = after.automaticProduction.journal.find(value => value.cycle === cycle && value.workerId === job.workerId
        && value.recipeId === job.recipeId && value.tick === after.clock.simulationTick && ['cancelled', 'committed'].includes(value.kind)
        && !before.automaticProduction.journal.some(old => old.eventId === value.eventId));
      if (handle.kind !== 'retired' || !notice || !isActualTick() || notice.kind === 'cancelled' && !unavailable(after, job.workerId)) { fail(label); continue; }
    }
    result.discharged.push(label);
  }
  const progression = verifyProgressionReservationDischarges({ world: before, assessment: previous.progression }, { world: after, assessment: current.progression });
  result.discharged.push(...progression.discharged); result.unknowns.push(...progression.unknowns);
  result.supported = result.unknowns.length === 0; return result;
}
