/** Fixed internal v10 finite teaching proof. No runtime/save/import capability. */
import { isPaused } from '../kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../kernel/commands-v10';
import type { CommandV10 } from '../kernel/contracts-v10';
import { canonicalStringify } from '../kernel/serialization';
import { prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10 } from '../kernel/simulation-v10';
import { iterateArchivedCommandReceipts } from '../history/archive';
import { assessManagementCapacityV10, type ManagementCapacityV10 } from './management-capacity-v10';
import { lookupCommandReceipt } from './history-access';
import { inspectReservedDischargesV10 } from './sect-release-v10';
import { captureValidatedV10PreparationSource } from './v10-sect-bridge';
import { v10WorkOwners } from './v10-sect-frame';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';

export const TEACHING_DETAIL_V10 = 'Teaching requires disjoint home pairs and a funded finite continuation, with explicit cancellation of unrelated work or attempts when reported';
export const hasTeachingV10 = (world: WorldStateV10): boolean => world.cultivation.disciples.some(profile => profile.teaching !== null);
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
export interface TeachingContinuationV10 {
  supported: boolean;
  /** These are real, reachable player commands, never executed on the source.
   * They are a route witness, not standing permission or automatic cancellation. */
  recoveryActions: CommandV10[];
  unknowns: string[];
}
export function actualDimensionsFitV10(value: ManagementCapacityV10): boolean {
  return value.actualFits && Object.keys(value.current).every(key => Number.isSafeInteger(value.current[key]) && value.current[key]! >= 0
    && Number.isSafeInteger(value.limits[key]) && value.current[key]! <= value.limits[key]!);
}
/** Compare integer operands, never rounded/overflowed cost totals. */
export function deficitDoesNotIncreaseV10(before: ManagementCapacityV10, after: ManagementCapacityV10): boolean {
  const keys = new Set([...Object.keys(before.costs), ...Object.keys(after.costs)]);
  for (const key of keys) {
    const hasBefore = Object.hasOwn(before.costs, key); const hasAfter = Object.hasOwn(after.costs, key);
    const limit = hasAfter ? after.limits[key] : before.limits[key];
    if (!Number.isSafeInteger(limit) || limit! < 0 || hasBefore && hasAfter && before.limits[key] !== after.limits[key]) return false;
    const operands = [hasBefore ? before.current[key] : 0, hasBefore ? before.reserved[key] : 0,
      hasAfter ? after.current[key] : 0, hasAfter ? after.reserved[key] : 0];
    if (!operands.every(value => Number.isSafeInteger(value) && value! >= 0)) return false;
    const prior = BigInt(operands[0]!) + BigInt(operands[1]!); const next = BigInt(operands[2]!) + BigInt(operands[3]!);
    if (next > BigInt(limit!) && next > prior) return false;
  }
  return true;
}
function roles(world: WorldStateV10): string[] {
  const participants = new Set<string>(); const work = v10WorkOwners(world); const issues: string[] = [];
  for (const teacher of world.cultivation.disciples) {
    const lesson = teacher.teaching; if (!lesson) continue;
    const student = world.cultivation.disciples.find(profile => profile.discipleId === lesson.studentId);
    for (const id of [teacher.discipleId, lesson.studentId]) {
      const profile = world.cultivation.disciples.find(profile => profile.discipleId === id);
      const actor = world.disciples.find(actor => actor.id === id); const build = world.builds.disciples.find(actor => actor.discipleId === id);
      if (participants.has(id)) issues.push('Teaching pairs overlap, chain, or cycle'); participants.add(id);
      if (!profile || !actor || !build || profile.lifeState !== 'alive' || profile.activeAttemptId !== null || profile.activityOwner !== null
        || profile.pendingDeathId !== null || build.lock !== null || actor.traveling || actor.assignmentTransactionId !== null
        || work.some(owner => owner.workerId === id)) issues.push(`Teaching participant is not alive, home and exclusively available: ${id}`);
    }
    if (!student || student.teaching !== null || !teacher.knowledge.some(entry => entry.knowledgeId === lesson.knowledgeId)
      || student.knowledge.some(entry => entry.knowledgeId === lesson.knowledgeId)) issues.push('Teaching knowledge or student role differs from the real month reducer');
  }
  return [...new Set(issues)];
}
function commandIdentity(world: WorldStateV10, ordinal: number): string {
  const occupied = new Set([...iterateArchivedCommandReceipts(world.history), ...Object.values(world.commandReceipts)]
    .map(receipt => receipt.commandId));
  const local = [...world.sectExpansion.construction.receipts, ...world.sectExpansion.production.receipts,
    ...world.sectExpansion.research.receipts, ...world.sectExpansion.care.receipts, ...world.sectExpansion.upgrade.receipts];
  for (const receipt of local) occupied.add(receipt.command.commandId);
  for (const receipt of world.cultivation.receipts) occupied.add(receipt.commandId);
  // Bounded pigeonhole search across the exact current/archived ownership union.
  // Complete source limits bound occupied.size; no unbounded retry loop or RNG.
  for (let offset = 0; offset <= occupied.size; offset++) {
    const id = `teaching-recovery.${world.sequences.nextAction}.${ordinal + offset}`;
    if (!occupied.has(id)) return id;
  }
  throw new RangeError('No bounded teaching recovery command identity');
}
function nextRecoveryCommand(world: WorldStateV10, ordinal: number): CommandV10 | null {
  const commandId = commandIdentity(world, ordinal); const outer = { commandId, issuedTick: world.clock.simulationTick, sequence: 0 };
  const records = world.sectExpansion;
  // The sixth owner is discharged before any lesson continuation tick. Its
  // 400 effective-work limit is not an elapsed-time/revision funding horizon.
  const upgrade = records.upgrade.jobs.find(job => job.terminal === null);
  if (upgrade) return { ...outer, kind: 'sect.command', payload: { domain: 'upgrade', command: {
    kind: 'upgrade.cancel', commandId, expectedRevision: records.upgrade.revision, jobId: upgrade.jobId } } };
  const id = world.activeProductionTransactionIds[0];
  if (id) return { ...outer, kind: 'production.cancel', payload: { transactionId: id } };
  const bp = records.construction.blueprints.find(bp => bp.status === 'planned' || bp.status === 'started');
  if (bp) return { ...outer, kind: 'sect.command', payload: { domain: 'construction', command: {
    kind: 'construction.cancel', commandId, expectedRevision: records.construction.revision, blueprintId: bp.blueprintId } } };
  const production = records.production.jobs.find(job => !job.terminal);
  if (production) return { ...outer, kind: 'sect.command', payload: { domain: 'production', command: {
    kind: 'production.cancel', commandId, expectedRevision: records.production.revision, jobId: production.transactionId } } };
  const research = records.research.jobs.find(job => !job.terminal);
  if (research) return { ...outer, kind: 'sect.command', payload: { domain: 'research', command: {
    kind: 'research.cancel', commandId, expectedRevision: records.research.revision, jobId: research.jobId } } };
  const care = records.care.jobs.find(job => !job.terminal);
  if (care) return { ...outer, kind: 'sect.command', payload: { domain: 'care', command: {
    kind: 'care.cancel', commandId, expectedRevision: records.care.revision, jobId: care.jobId } } };
  const attempt = world.cultivation.attempts.find(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase));
  if (attempt) return { ...outer, kind: 'cultivation.command', payload: { command: {
    kind: 'breakthrough.cancel', commandId, expectedRevision: world.cultivation.revision, attemptId: attempt.attemptId } } };
  const death = world.cultivation.pendingDeaths[0];
  // The player protocol can finalize lifespan deaths only. Other causes retain
  // their pending owner and fail the unresolved-death continuation check below.
  if (death?.cause === 'lifespan') return { ...outer, kind: 'cultivation.command', payload: { command: {
    kind: 'death.finalize', commandId, expectedRevision: world.cultivation.revision,
    discipleId: death.discipleId, deathId: death.deathId, cause: death.cause, acknowledgeDeath: true } } };
  return null;
}
function recoverableOwnerCount(world: WorldStateV10): number {
  const records = world.sectExpansion;
  return world.activeProductionTransactionIds.length
    + records.construction.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length
    + records.production.jobs.filter(job => job.terminal === null).length
    + records.research.jobs.filter(job => job.terminal === null).length
    + records.care.jobs.filter(job => job.terminal === null).length
    + records.upgrade.jobs.filter(job => job.terminal === null).length
    + world.cultivation.attempts.filter(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)).length
    + world.cultivation.pendingDeaths.length;
}
/** Fixed route proof: capture/validate the exact source and derive its capacity
 * internally. No caller assessment, certificate, policy or callback is accepted.
 * Every real recovery candidate is freshly measured and its discharge certified.
 * Even an otherwise fitting source must have a REAL cancellation route: current
 * no-optional ticks still execute old production and cannot fund arbitrary churn. */
export function inspectTeachingContinuationV10(input: WorldStateV10): TeachingContinuationV10 {
  const result: TeachingContinuationV10 = { supported: false, recoveryActions: [], unknowns: [] };
  let world: WorldStateV10;
  try { world = captureValidatedV10PreparationSource(input); }
  catch { result.unknowns.push('Invalid complete v10 teaching source'); return result; }
  const assessment = assessManagementCapacityV10(world);
  if (!assessment.supported || !actualDimensionsFitV10(assessment)) {
    result.unknowns.push('Teaching source lacks supported actual complete-boundary capacity'); return result;
  }
  if (!hasTeachingV10(world)) { result.supported = true; return result; }
  result.unknowns.push(...roles(world));
  if (result.unknowns.length) return result;
  let current = world; let measured = assessment;
  const maximum = recoverableOwnerCount(world);
  for (let ordinal = 0; ordinal <= maximum; ordinal++) {
    const command = nextRecoveryCommand(current, ordinal);
    if (!command) break;
    if (ordinal === maximum) { result.unknowns.push('Recovery route did not remove a bounded cancellable owner'); return result; }
    const candidate = prepareUnregisteredCommandCandidateV10(current, command);
    if (candidate.world === current || candidate.result.status !== 'accepted') {
      result.unknowns.push(`Unreachable teaching recovery action ${command.kind}: ${JSON.stringify(candidate.result.rejection)}`); return result;
    }
    if (recoverableOwnerCount(candidate.world) >= recoverableOwnerCount(current)) {
      result.unknowns.push('Recovery action did not remove a bounded cancellable owner'); return result;
    }
    const next = assessManagementCapacityV10(candidate.world);
    if (!next.supported || !actualDimensionsFitV10(next) || !deficitDoesNotIncreaseV10(measured, next)) {
      result.unknowns.push('Teaching recovery candidate lacks funded complete-boundary capacity'); return result;
    }
    const release = inspectReservedDischargesV10(current, candidate.world);
    if (!release.supported || release.discharged.length === 0) {
      result.unknowns.push(...release.unknowns, 'Teaching recovery action lacks authenticated existing cancellation/death funding'); return result;
    }
    result.recoveryActions.push(command); current = candidate.world; measured = next;
  }
  if (current.activeProductionTransactionIds.length || v10WorkOwners(current).length
    || current.sectExpansion.construction.blueprints.some(bp => bp.status === 'planned' || bp.status === 'started')
    || current.cultivation.attempts.some(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase))
    || current.cultivation.pendingDeaths.length) {
    result.unknowns.push('Recovery route retains unrelated work, an attempt or unresolved death'); return result;
  }
  if (!measured.fits) { result.unknowns.push('No funded finite lesson horizon remains after available recovery actions'); return result; }
  // Positions and claims are not inferred from owner disappearance. Certify the
  // actual first no-optional reducer, including when no recovery was necessary.
  // Paused boundaries retain all funding; this function never clears a pause.
  if (!isPaused(current.clock)) {
    try {
      const candidate = prepareNoOptionalGrowthTickCandidateV10(current); const next = assessManagementCapacityV10(candidate);
      if (candidate.clock.simulationTick !== current.clock.simulationTick + 1
        || candidate.clock.calendarTick !== current.clock.calendarTick + 1
        || !next.supported || !actualDimensionsFitV10(next) || !next.fits) {
        result.unknowns.push('Recovered source cannot take its first real no-optional continuation tick'); return result;
      }
    } catch { result.unknowns.push('Recovered positions/claims cannot take a real no-optional tick'); return result; }
  }
  result.supported = true; return result;
}
/** Authenticate every teaching-bearing transition, even if the after query fits.
 * Complete real preparations bind stable lesson IDs, participants, knowledge,
 * progress, deadlines, taught provenance and real death cleanup together. A
 * forged counter delta, fabricated terminal row or owner disappearance is not a
 * witness. Conservative idle carries never enter this function. */
export function authenticTeachingTransitionV10(before: WorldStateV10, after: WorldStateV10): boolean {
  if (!hasTeachingV10(before) && !hasTeachingV10(after)) return true;
  if (same(before, after)) return true;
  if (after.clock.simulationTick === before.clock.simulationTick + 1 && after.clock.calendarTick === before.clock.calendarTick + 1) {
    for (const prepare of [prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10]) {
      try { if (same(prepare(before), after)) return true; } catch { /* No witness from a failing preparation. */ }
    }
    return false;
  }
  if (after.clock.simulationTick !== before.clock.simulationTick || after.clock.calendarTick !== before.clock.calendarTick) return false;
  const candidates: CommandV10[] = [];
  for (const receipt of [...iterateArchivedCommandReceipts(after.history), ...Object.values(after.commandReceipts)]) {
    if (lookupCommandReceipt(before, receipt.commandId)) continue;
    try { candidates.push({ ...JSON.parse(receipt.fingerprint), commandId: receipt.commandId, sequence: 0, issuedTick: before.clock.simulationTick } as CommandV10); }
    catch { return false; }
  }
  for (const domain of ['construction', 'production', 'research', 'care', 'upgrade'] as const) {
    for (const receipt of after.sectExpansion[domain].receipts) {
      if (before.sectExpansion[domain].receipts.some(old => old.command.commandId === receipt.command.commandId)) continue;
      candidates.push({ kind: 'sect.command', commandId: receipt.command.commandId, sequence: 0, issuedTick: before.clock.simulationTick,
        payload: { domain, command: receipt.command } } as CommandV10);
    }
  }
  for (const command of candidates) {
    try { const candidate = prepareUnregisteredCommandCandidateV10(before, command); if (candidate.world !== before && same(candidate.world, after)) return true; }
    catch { /* No replay authority from malformed receipts. */ }
  }
  return false;
}
