/** Internal terminal proof only. It confers no capacity, runtime or save admission. */
import { classifyAutomaticHandle, isAutomaticJobId, liveProductionAt } from '../economy/automatic-production';
import { iterateArchivedCommandReceipts, lookupArchivedProduction } from '../history';
import { isCommandV10, prepareUnregisteredCommandCandidateV10 } from '../kernel/commands-v10';
import type { CommandV10 } from '../kernel/contracts-v10';
import { canonicalStringify } from '../kernel/serialization';
import { prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10 } from '../kernel/simulation-v10';
import { verifyProgressionReservationDischarges } from '../save-budget/progression-bounds';
import { deriveProgressionReservationsTimeV9 } from '../save-budget/progression-time-v9';
import { deriveSectReservationsV10 } from '../save-budget/sect-obligations-v10';
import { releaseSectReservation, sectReservationLines } from '../sect-expansion/ledger';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { lookupCommandReceipt, lookupEvent, lookupProduction } from './history-access';
import { deriveV10BuildObligationFacts } from './v10-build-obligations';
import { captureValidatedV10PreparationSource } from './v10-sect-bridge';

export interface ReservedDischargesV10 {
  supported: boolean;
  /** Existing owners with complete retained terminal evidence, never byte credits. */
  discharged: string[];
  unknowns: string[];
}
/** Record comparison diagnostics only. No supported/executable/admitted flag. */
export interface ReservedDischargeRecordsV10 {
  readonly scope: 'v10-cross-boundary-records-only';
  readonly issues: readonly string[];
  readonly discharged: readonly string[];
}
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const preserved = (left: object, right: object, keys: readonly string[]): boolean => keys.every(key => {
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  return Object.hasOwn(a, key) === Object.hasOwn(b, key) && (!Object.hasOwn(a, key) || same(a[key], b[key]));
});
const SECT_DOMAINS = ['construction', 'production', 'research', 'care', 'upgrade'] as const;
function receipts(world: WorldStateV10) {
  return [...iterateArchivedCommandReceipts(world.history), ...Object.values(world.commandReceipts)];
}
function unavailable(world: WorldStateV10, id: string): boolean {
  return world.cultivation.pendingDeaths.some(death => death.discipleId === id)
    || world.cultivation.deaths.some(death => death.discipleId === id);
}
/** Complete, source-derived candidate equality is required even when every local
 * terminal is individually valid. This rejects unrelated stock/RNG/history edits,
 * forged work/payment, erased owners and spliced valid terminal boundaries alike. */
function actualTransition(before: WorldStateV10, after: WorldStateV10): boolean {
  if (same(before, after)) return true;
  if (after.clock.simulationTick === before.clock.simulationTick + 1
    && after.clock.calendarTick === before.clock.calendarTick + 1) {
    for (const prepare of [prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10]) {
      try { if (same(prepare(before), after)) return true; } catch { /* A failing preparation supplies no witness. */ }
    }
    return false;
  }
  if (after.clock.simulationTick !== before.clock.simulationTick || after.clock.calendarTick !== before.clock.calendarTick) return false;
  const candidates: CommandV10[] = [];
  for (const receipt of receipts(after)) {
    if (lookupCommandReceipt(before, receipt.commandId)) continue;
    try {
      const parsed: unknown = JSON.parse(receipt.fingerprint);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const input = { ...parsed, commandId: receipt.commandId, sequence: 0, issuedTick: before.clock.simulationTick };
      if (!isCommandV10(input)) return false;
      candidates.push(input);
    } catch { return false; }
  }
  for (const domain of SECT_DOMAINS) for (const receipt of after.sectExpansion[domain].receipts) {
    if (before.sectExpansion[domain].receipts.some(old => old.command.commandId === receipt.command.commandId)) continue;
    // Real lifecycle cascades also create system receipts. Their authority is
    // supplied only by the triggering actual tick/World command, never replayed
    // as a forged player command or accepted from a caller's death flag.
    if (receipt.command.commandId.startsWith('system/')) continue;
    const input = { kind: 'sect.command', commandId: receipt.command.commandId, sequence: 0,
      issuedTick: before.clock.simulationTick, payload: { domain, command: receipt.command } };
    if (!isCommandV10(input)) return false;
    candidates.push(input);
  }
  // A same-clock player boundary owns exactly one new outer command. Replaying
  // arbitrary combinations would silently widen this single-candidate contract.
  if (candidates.length !== 1) return false;
  try {
    const candidate = prepareUnregisteredCommandCandidateV10(before, candidates[0]);
    return candidate.world !== before && same(candidate.world, after);
  } catch { return false; }
}

const IMMUTABLE_JOB_FIELDS = ['jobId', 'transactionId', 'blueprintId', 'reservationId', 'resultBuildingId',
  'workerId', 'patientId', 'recipeId', 'researchId', 'researchGate', 'doseProductionJobId', 'previousCancelledCareId',
  'startedTick', 'startedCalendarTick', 'origin', 'requiredTicks', 'productiveSite', 'site', 'prerequisites',
  'buildingId', 'fromLevel', 'toLevel', 'storagePosition', 'seatToken', 'entranceToken'] as const;
const PAID_WORK_FIELDS = ['activeTicks', 'workSpans', 'visits', 'storageVisit', 'siteVisit', 'siteVisits',
  'workVisit', 'deliveryVisit', 'checkpoints'] as const;

/** INTERNAL residual cross-boundary RECORD comparisons only. This is NOT an
 * executable-transition witness, capacity decision or reusable admission proof.
 * Callers here already own completely validated Worlds: the public inspector
 * obtains them by capture/validation/replay; the private tick pipeline obtains
 * them only by its own fixed actual producer and complete capacity assessment.
 * This leaf derives its own structural owner envelopes, accepting no supplied
 * assessment, budget, trust flag, policy, callback or purported producer witness.
 *
 * Keep these comparisons shared, not duplicated or weakened for the private
 * producer. Public arbitrary candidates still require independent actual replay.
 * Old version wrappers are never called; the shared progression structural leaves
 * retain their version-neutral record contract and pinned build identity.
 *
 * A pending death may terminate work, but cannot discharge disciple-lifecycle.
 * That owner requires actual death finalization, settled estate/transfers, build
 * retirement, cultivation archive and World identity archive together. */
export function inspectReservedDischargeRecordsV10(before: WorldStateV10, after: WorldStateV10): ReservedDischargeRecordsV10 {
  const result: { scope: 'v10-cross-boundary-records-only'; discharged: string[]; issues: string[] } = {
    scope: 'v10-cross-boundary-records-only', discharged: [], issues: [],
  };
  const fail = (owner: string): void => { result.issues.push(`Missing authentic terminal evidence for ${owner}`); };
  try {
    const previous = { sect: deriveSectReservationsV10(before), progression: deriveProgressionReservationsTimeV9({
      world: before, buildFacts: deriveV10BuildObligationFacts(before) }) };
    const current = { sect: deriveSectReservationsV10(after), progression: deriveProgressionReservationsTimeV9({
      world: after, buildFacts: deriveV10BuildObligationFacts(after) }) };
    if (!previous.sect.supported || !current.sect.supported || !previous.progression.supported || !current.progression.supported) {
      result.issues.push('Unsupported v10 owner envelope'); return result;
    }
    const left = before.sectExpansion; const right = after.sectExpansion;
    for (const owner of previous.sect.owners) {
      if (current.sect.owners.some(next => next.kind === owner.kind && next.id === owner.id)) continue;
      const label = `sect.${owner.kind}:${owner.id}`;
      if (owner.kind === 'planned-blueprint') {
        const bp = left.construction.blueprints.find(value => value.blueprintId === owner.id);
        const next = right.construction.blueprints.find(value => value.blueprintId === owner.id);
        const immutable = ['definitionId', 'anchor', 'rotation', 'researchGate', 'blueprintId', 'placedTick', 'placedCalendarTick'];
        if (!bp || !next || !preserved(bp, next, immutable)) { fail(label); continue; }
        // The planned reserve becomes actual paid construction. It is not an
        // extinguished obligation eligible for deficient-headroom recovery.
        if (next.status === 'started' && current.sect.owners.some(value => value.kind === 'construction' && value.id === next.jobId)) continue;
        const receipt = right.construction.receipts.find(value => value.command.kind === 'construction.cancel'
          && value.command.blueprintId === owner.id && value.relatedId === owner.id
          && value.command.expectedRevision >= left.construction.revision
          && !left.construction.receipts.some(old => old.command.commandId === value.command.commandId));
        if (next.status !== 'cancelled' || next.jobId !== null || next.endedTick !== after.clock.simulationTick || !receipt) fail(label);
        else result.discharged.push(label);
        continue;
      }
      const priorJob = owner.kind === 'production' ? left.production.jobs.find(job => job.transactionId === owner.id)
        : left[owner.kind].jobs.find(job => job.jobId === owner.id);
      const nextJob = owner.kind === 'production' ? right.production.jobs.find(job => job.transactionId === owner.id)
        : right[owner.kind].jobs.find(job => job.jobId === owner.id);
      const terminal = nextJob?.terminal;
      const priorClaim = priorJob && left.reservations.find(claim => claim.reservationId === priorJob.reservationId && claim.ownerTransactionId === owner.id);
      const nextClaim = nextJob && right.reservations.find(claim => claim.reservationId === nextJob.reservationId && claim.ownerTransactionId === owner.id);
      // ProductiveSite is compared WHOLE, retaining L2 upgradeJobId, construction
      // origin, position, level and first paid maintenance boundary unchanged.
      if (!priorJob || priorJob.terminal || !nextJob || !terminal || !preserved(priorJob, nextJob, IMMUTABLE_JOB_FIELDS)
        || !priorClaim || !nextClaim || terminal.tick !== after.clock.simulationTick || terminal.calendarTick !== after.clock.calendarTick) {
        fail(label); continue;
      }
      if (terminal.kind === 'cancelled') {
        const released = releaseSectReservation({ inventory: before.inventory, stock: left.stock, reservations: left.reservations },
          { reservationId: priorClaim.reservationId, ownerTransactionId: owner.id }, `cancel:${owner.id}`);
        const domain = right[owner.kind]; const priorDomain = left[owner.kind];
        const receipt = domain.receipts.find(value => {
          const command = value.command;
          const target = command.kind === 'construction.cancel' ? 'blueprintId' in priorJob && command.blueprintId === priorJob.blueprintId
            : ['production.cancel', 'research.cancel', 'care.cancel', 'upgrade.cancel'].includes(command.kind)
              && 'jobId' in command && command.jobId === owner.id;
          return target && command.expectedRevision >= priorDomain.revision
            && !priorDomain.receipts.some(old => old.command.commandId === command.commandId);
        });
        if (!released.ok || !same(released.reservation, nextClaim) || !receipt
          || !same(terminal.consumed, sectReservationLines(priorClaim, 'consumed'))
          || !same(terminal.released, sectReservationLines(priorClaim, 'remainingReservation'))
          || terminal.previousPhase !== priorJob.phase || !preserved(priorJob, nextJob, PAID_WORK_FIELDS)) {
          fail(label); continue;
        }
      } else {
        if (nextClaim.base.settlement?.kind !== 'committed' || nextClaim.sect.settlement?.kind !== 'committed'
          || nextClaim.base.settlement.operationId !== `complete:${owner.id}` || nextClaim.sect.settlement.operationId !== `complete:${owner.id}`
          || !same(priorClaim.base.lines, nextClaim.base.lines) || !same(priorClaim.sect.lines, nextClaim.sect.lines)
          || !same(terminal.consumed, sectReservationLines(nextClaim, 'consumed')) || terminal.released.length !== 0) {
          fail(label); continue;
        }
        if (owner.kind === 'construction') {
          const bp = right.construction.blueprints.find(value => value.jobId === owner.id);
          const building = right.construction.buildings.find(value => value.sourceJobId === owner.id);
          if (bp?.status !== 'completed' || !building || !('resultBuildingId' in priorJob) || building.buildingId !== priorJob.resultBuildingId) {
            fail(label); continue;
          }
        }
      }
      if (owner.kind === 'upgrade') {
        const job = right.upgrade.jobs.find(value => value.jobId === owner.id)!;
        const origin = left.construction.buildings.find(value => value.buildingId === job.buildingId);
        const retained = right.construction.buildings.find(value => value.buildingId === job.buildingId);
        if (!origin || !retained || !same(origin, retained) || origin.level !== 1
          || job.terminal?.resultLevel !== (terminal.kind === 'completed' ? 2 : 1)) { fail(label); continue; }
      }
      result.discharged.push(label);
    }
    for (const id of before.activeProductionTransactionIds) {
      if (after.activeProductionTransactionIds.includes(id)) continue;
      const source = liveProductionAt(before, id);
      const label = `${isAutomaticJobId(id) ? 'automatic' : 'manual'}-production:${id}`;
      if (!source || after.disciples.some(actor => actor.assignmentTransactionId === id)
        || after.buildings.some(site => site.stationTransactionId === id)) { fail(label); continue; }
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
          || event.kind !== (terminal.state === 'Cancelled' ? 'production.cancelled' : 'production.committed')
          || terminal.state === 'Cancelled' && terminal.activeTicks !== job.activeTicks) { fail(label); continue; }
      } else {
        const handle = classifyAutomaticHandle(after, id);
        if (handle.kind === 'pinned') {
          const pin = handle.pin; const event = pin.resultEventId && lookupEvent(after, pin.resultEventId);
          if (pin.state !== 'Cancelled' || pin.rootActionId !== job.rootActionId || pin.workerId !== job.workerId || pin.recipeId !== job.recipeId
            || pin.completedTick !== after.clock.simulationTick || !event || event.kind !== 'production.cancelled'
            || !same(event.payload, { transactionId: id, recipeId: job.recipeId, workerId: job.workerId, settledTick: pin.completedTick })) {
            fail(label); continue;
          }
        } else {
          const cycle = 'origin' in job ? job.origin.cycle : -1;
          const notice = after.automaticProduction.journal.find(value => value.cycle === cycle && value.workerId === job.workerId
            && value.recipeId === job.recipeId && value.tick === after.clock.simulationTick && ['cancelled', 'committed'].includes(value.kind)
            && !before.automaticProduction.journal.some(old => old.eventId === value.eventId));
          if (handle.kind !== 'retired' || !notice || notice.kind === 'cancelled' && !unavailable(after, job.workerId)) { fail(label); continue; }
        }
      }
      result.discharged.push(label);
    }
    const progression = verifyProgressionReservationDischarges({ world: before, assessment: previous.progression }, { world: after, assessment: current.progression });
    result.discharged.push(...progression.discharged); result.issues.push(...progression.unknowns);
    // Pending expiry has no lifecycle discharge. Explicitly retain this invariant
    // even if a future structural owner derivation accidentally drops the owner.
    for (const death of after.cultivation.pendingDeaths) if (previous.progression.owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === death.discipleId)
      && !current.progression.owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === death.discipleId)) fail(`disciple-lifecycle:${death.discipleId}`);
    if (result.issues.length) result.discharged = [];
    return result;
  } catch {
    // Fixed callers already own descriptor snapshots. Never inspect exceptions.
    return { scope: 'v10-cross-boundary-records-only', discharged: [],
      issues: ['Unsupported complete v10 discharge source or terminal records'] };
  }
}

/** Fixed public arbitrary-candidate proof. Preserve the original descriptor/root
 * validation, unsupported-envelope precedence and independent actualTransition
 * replay BEFORE the shared residual record leaf. Neither a privately produced
 * World nor the leaf's record-only output exempts any external candidate here. */
export function inspectReservedDischargesV10(source: WorldStateV10, candidate: WorldStateV10): ReservedDischargesV10 {
  const result: ReservedDischargesV10 = { supported: false, discharged: [], unknowns: [] };
  try {
    const before = captureValidatedV10PreparationSource(source);
    const after = captureValidatedV10PreparationSource(candidate);
    const previous = { sect: deriveSectReservationsV10(before), progression: deriveProgressionReservationsTimeV9({
      world: before, buildFacts: deriveV10BuildObligationFacts(before) }) };
    const current = { sect: deriveSectReservationsV10(after), progression: deriveProgressionReservationsTimeV9({
      world: after, buildFacts: deriveV10BuildObligationFacts(after) }) };
    if (!previous.sect.supported || !current.sect.supported || !previous.progression.supported || !current.progression.supported) {
      result.unknowns.push('Unsupported v10 owner envelope'); return result;
    }
    if (!actualTransition(before, after)) {
      result.unknowns.push('No exact actual v10 command or single-tick candidate witness'); return result;
    }
    const records = inspectReservedDischargeRecordsV10(before, after);
    return { supported: records.issues.length === 0, discharged: [...records.discharged], unknowns: [...records.issues] };
  } catch {
    return { supported: false, discharged: [], unknowns: ['Unsupported complete v10 discharge source or terminal records'] };
  }
}
