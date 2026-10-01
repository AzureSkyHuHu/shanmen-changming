import type { Command } from '../kernel/contracts';
import { canonicalStringify } from '../kernel/serialization';
import { automaticJobByteBudget, pendingCommandByteBudget, type SaveBudgetMap } from './bounds';
import { measureWorldSaveBytes, WORST_SAVE_METADATA, type SaveByteOptions } from './envelope';
import { assessHistoryExpansion, assessHistorySlots, manualProductionByteObligations, type HistoryExpansionAssessment, type HistorySlotAssessment } from './retention';

export const SAVE_FILE_LIMIT_BYTES = 4_194_304;
/** Safety margin for other domain transitions, not a proof of unlimited campaign growth. */
export const NON_AUTOMATIC_HEADROOM_BYTES = 1_048_576;

export interface AutomaticSaveBudgetInput {
  /** Already validated complete boundary. Mutable inputs are measured again on every call. */
  world: unknown;
  map: SaveBudgetMap;
  liveAutomaticJobCount: number;
  /** Already validated external queue, including an in-flight due batch if necessary. */
  pendingCommands: readonly Command[];
  /** Available worker/seat limit supplied by World; this module caps the shared total at two. */
  maximumNewStarts: number;
  /** Derived now from the actual journal, never a field trusted from an imported save. */
  journalBytes?: number;
  save?: Omit<SaveByteOptions, 'metadata'>;
}
export type SaveBudgetReason = 'ready' | 'save-cap' | 'headroom' | 'unsupported-pending';
export interface AutomaticSaveBudgetAssessment {
  encodedBytes: number;
  limitBytes: number;
  reservedBytes: number;
  /** May be negative. It includes all present live/pending future obligations. */
  availableBytes: number;
  autoStartAllowance: 0 | 1 | 2;
  actualFits: boolean;
  obligationsFit: boolean;
  reason: SaveBudgetReason;
  generalHeadroomBytes: number;
  journalReserveBytes: number;
  liveObligationBytes: number;
  manualObligationBytes: number;
  pendingObligationBytes: number;
  perLiveJobBytes: number;
  /** Future reserve plus maximum live representation, since current live state is counted twice. */
  perNewJobBytes: number;
  unsupportedPendingKinds: string[];
  archiveSlots: HistorySlotAssessment;
  archiveSlotsFit: boolean;
  archiveExpansion: HistoryExpansionAssessment;
  archiveExpansionFit: boolean;
}

function integer(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid ${name}`);
}

export function assessAutomaticWorkBudget(input: AutomaticSaveBudgetInput): AutomaticSaveBudgetAssessment {
  integer(input.liveAutomaticJobCount, 'automatic live count', 36);
  integer(input.maximumNewStarts, 'new start limit');
  const bounds = automaticJobByteBudget(input.map);
  const journalBytes = input.journalBytes ?? 2;
  integer(journalBytes, 'derived journal bytes', bounds.fullJournalBytes);
  const encodedBytes = measureWorldSaveBytes(input.world, { ...input.save, metadata: WORST_SAVE_METADATA });
  const pending = pendingCommandByteBudget(input.pendingCommands, input.map);
  const manual = manualProductionByteObligations(input.world, input.map);
  integer(input.liveAutomaticJobCount + manual.count, 'combined production live count', 36);
  const archiveSlots = assessHistorySlots(input.world, input.liveAutomaticJobCount, manual.count, input.pendingCommands);
  const archiveExpansion = assessHistoryExpansion(input.world, input.map, input.liveAutomaticJobCount, manual.archiveBytes, pending.bytes, archiveSlots);
  const journalReserveBytes = Math.max(0, bounds.fullJournalBytes - journalBytes);
  const liveObligationBytes = input.liveAutomaticJobCount * bounds.totalBytes;
  const reservedBytes = NON_AUTOMATIC_HEADROOM_BYTES + journalReserveBytes + liveObligationBytes + manual.bytes + pending.bytes;
  if (!Number.isSafeInteger(reservedBytes)) throw new RangeError('Combined save obligations exceed safe byte range');
  const availableBytes = SAVE_FILE_LIMIT_BYTES - encodedBytes - reservedBytes;
  const actualFits = encodedBytes <= SAVE_FILE_LIMIT_BYTES;
  const obligationsFit = pending.supported && archiveSlots.fits && archiveExpansion.fits && availableBytes >= 0;
  // A newly live job may grow its route after this decision. Fund the largest current
  // representation as well as its deliberately double-counted future obligation.
  const perNewJobBytes = bounds.totalBytes + bounds.fixedLiveBytes + bounds.pathBytes + bounds.sideEffectsBytes;
  const allowance = obligationsFit
    ? Math.min(2, input.maximumNewStarts, 36 - input.liveAutomaticJobCount - manual.count, archiveSlots.automaticAllowance,
      archiveExpansion.automaticAllowance, Math.floor(availableBytes / perNewJobBytes)) : 0;
  const reason: SaveBudgetReason = !actualFits ? 'save-cap' : !pending.supported ? 'unsupported-pending'
    : !obligationsFit || (input.maximumNewStarts > 0 && allowance === 0) ? 'headroom' : 'ready';
  return {
    encodedBytes, limitBytes: SAVE_FILE_LIMIT_BYTES, reservedBytes, availableBytes,
    autoStartAllowance: allowance as 0 | 1 | 2, actualFits, obligationsFit, reason,
    generalHeadroomBytes: NON_AUTOMATIC_HEADROOM_BYTES, journalReserveBytes, liveObligationBytes,
    manualObligationBytes: manual.bytes, pendingObligationBytes: pending.bytes, perLiveJobBytes: bounds.totalBytes, perNewJobBytes,
    unsupportedPendingKinds: pending.unsupportedKinds, archiveSlots, archiveSlotsFit: archiveSlots.fits,
    archiveExpansion, archiveExpansionFit: archiveExpansion.fits,
  };
}

export type SaveCapacityRejectionCode = 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED';
export type SaveCapacityDecision = { ok: true; budget: AutomaticSaveBudgetAssessment }
  | { ok: false; transient: true; code: SaveCapacityRejectionCode; budget: AutomaticSaveBudgetAssessment };

/** No receipt, command identity, clock, RNG, diagnostic or input mutation occurs here. */
export function verifySaveCandidate(input: AutomaticSaveBudgetInput): SaveCapacityDecision {
  const budget = assessAutomaticWorkBudget(input);
  if (budget.actualFits && budget.obligationsFit) return { ok: true, budget };
  return { ok: false, transient: true,
    code: budget.reason === 'unsupported-pending' ? 'SAVE_OBLIGATION_UNBOUNDED' : 'SAVE_CAPACITY_EXCEEDED', budget };
}

/**
 * A previously reserved cancellation/release must not be locked out by a later
 * headroom warning. Accept its complete candidate only if it fits the real cap and
 * cannot increase the complete encoded-plus-reserved cost. The caller must identify
 * an actual reserved release; this is not permission to bypass a growing command.
 * Unknown imported pending effects remain unknown and may not be newly introduced.
 */
export function verifyReservedRelease(before: AutomaticSaveBudgetInput, candidate: AutomaticSaveBudgetInput): SaveCapacityDecision {
  const previous = assessAutomaticWorkBudget(before);
  const decision = verifySaveCandidate(candidate);
  if (decision.ok) return decision;
  const next = decision.budget;
  const sameUnknown = before.pendingCommands === candidate.pendingCommands
    || (next.unsupportedPendingKinds.length > 0 && canonicalStringify(before.pendingCommands) === canonicalStringify(candidate.pendingCommands));
  const slotCost = (budget: AutomaticSaveBudgetAssessment, key: 'production' | 'commandReceipts' | 'events') => budget.archiveSlots.current[key] + budget.archiveSlots.reserved[key];
  const slotsDoNotGrow = (['production', 'commandReceipts', 'events'] as const).every((key) => slotCost(next, key) <= slotCost(previous, key));
  const expansionDoesNotGrow = next.archiveExpansion.currentCharacters + next.archiveExpansion.reservedCharacters
    <= previous.archiveExpansion.currentCharacters + previous.archiveExpansion.reservedCharacters
    && next.archiveExpansion.currentNodes + next.archiveExpansion.reservedNodes <= previous.archiveExpansion.currentNodes + previous.archiveExpansion.reservedNodes;
  if (next.actualFits && slotsDoNotGrow && expansionDoesNotGrow && next.encodedBytes + next.reservedBytes <= previous.encodedBytes + previous.reservedBytes
    && (next.unsupportedPendingKinds.length === 0 || sameUnknown)) return { ok: true, budget: next };
  return decision;
}
