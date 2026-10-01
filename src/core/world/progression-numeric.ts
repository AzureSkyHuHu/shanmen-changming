import { nextUint32, mapNonZeroWordToBucket, RANDOM_ALGORITHM, RANDOM_WORD_DOMAIN_SIZE } from '../kernel/random';
import type { ProgressionReservationAssessment } from '../save-budget/progression-bounds';
import type { WorldStateV8 } from './v8-types';

export type RejectionDrawBound =
  | { supported: true; algorithm: typeof RANDOM_ALGORITHM; span: number; rejectedWords: number; maximumConsecutiveRejections: number; maximumRawDraws: number; witnessRejectedWord: number | null }
  | { supported: false; reason: 'rejection-set-too-large' | 'rejection-cycle'; span: number; rejectedWords: number };
const MAX_REJECTION_STATES_TO_INSPECT = 100_000;
const proved = new Map<number, RejectionDrawBound>();
/** Finite structural proof under the actual RNG recurrence. Enumerates only the
 * incomplete rejection bucket, not the 2^32-state cycle or a current RNG prefix.
 * A detected closed rejection cycle fails closed. No World stream is consumed. */
export function integerRejectionDrawBound(span: number): RejectionDrawBound {
  if (!Number.isSafeInteger(span) || span < 1 || span > RANDOM_WORD_DOMAIN_SIZE) throw new TypeError('Invalid integer span');
  const cached = proved.get(span); if (cached) return cached;
  const rejectedWords = RANDOM_WORD_DOMAIN_SIZE % span;
  if (rejectedWords > MAX_REJECTION_STATES_TO_INSPECT) return Object.freeze({ supported: false, reason: 'rejection-set-too-large', span, rejectedWords });
  const firstRejectedWord = RANDOM_WORD_DOMAIN_SIZE - rejectedWords + 1;
  const successors: number[] = [];
  for (let word = firstRejectedWord; word <= RANDOM_WORD_DOMAIN_SIZE; word += 1) {
    if (mapNonZeroWordToBucket(word, span) !== null) throw new TypeError('Rejected graph differs from current integer mapping');
    const next = nextUint32({ algorithm: RANDOM_ALGORITHM, state: word, draws: 0 }).value;
    if ((next >= firstRejectedWord) !== (mapNonZeroWordToBucket(next, span) === null)) throw new TypeError('Successor differs from current integer mapping');
    successors.push(next);
  }
  const graph = inspectRejectedSubgraph({ firstRejectedWord, domainSize: RANDOM_WORD_DOMAIN_SIZE, successors });
  if (!graph.supported) return Object.freeze({ supported: false, reason: 'rejection-cycle', span, rejectedWords });
  const { maximumConsecutiveRejections, witnessRejectedWord } = graph;
  const result: RejectionDrawBound = Object.freeze({ supported: true, algorithm: RANDOM_ALGORITHM, span, rejectedWords,
    maximumConsecutiveRejections, maximumRawDraws: maximumConsecutiveRejections + 1, witnessRejectedWord });
  proved.set(span, result); return result;
}

/** Bounded data-only graph analysis, also used by reduced-domain/cycle tests.
 * Successors describe only the contiguous rejected suffix; an edge outside it
 * reaches an accepted value. This helper does not authenticate an RNG algorithm. */
export function inspectRejectedSubgraph(input: { firstRejectedWord: number; domainSize: number; successors: readonly number[] }):
  { supported: true; maximumConsecutiveRejections: number; witnessRejectedWord: number | null } | { supported: false } {
  const { firstRejectedWord, domainSize, successors } = input;
  if (!Number.isSafeInteger(domainSize) || domainSize < 1 || domainSize > RANDOM_WORD_DOMAIN_SIZE
    || !Number.isSafeInteger(firstRejectedWord) || firstRejectedWord < 1 || firstRejectedWord > domainSize + 1
    || successors.length !== domainSize - firstRejectedWord + 1 || successors.length > MAX_REJECTION_STATES_TO_INSPECT
    || successors.some(word => !Number.isSafeInteger(word) || word < 1 || word > domainSize)) throw new TypeError('Invalid bounded rejection graph');
  const lengths = new Map<number, number>(); let maximumConsecutiveRejections = 0; let witnessRejectedWord: number | null = null;
  for (let word = firstRejectedWord; word <= domainSize; word += 1) {
    if (lengths.has(word)) continue;
    const path: number[] = []; const active = new Set<number>(); let cursor = word;
    while (cursor >= firstRejectedWord && !lengths.has(cursor)) {
      if (active.has(cursor)) return { supported: false };
      active.add(cursor); path.push(cursor); cursor = successors[cursor - firstRejectedWord]!;
    }
    let count = lengths.get(cursor) ?? 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      count += 1; const state = path[index]!; lengths.set(state, count);
      if (count > maximumConsecutiveRejections) { maximumConsecutiveRejections = count; witnessRejectedWord = state; }
    }
  }
  return { supported: true, maximumConsecutiveRejections, witnessRejectedWord };
}

export interface ProgressionNumericAssessment {
  supported: boolean; fits: boolean; rawEventDrawsRequired: number;
  drawBound: RejectionDrawBound; diagnostics: string[]; uncovered: string[];
}
/** V3 breakthrough success/death samples are both drawInteger(1, 10000).
 * Retain this potential across unrelated event-stream consumers and re-assess
 * every complete candidate. Newly introduced RNG consumers need their own bound. */
export function assessProgressionNumeric(world: WorldStateV8, records: ProgressionReservationAssessment): ProgressionNumericAssessment {
  const drawBound = integerRejectionDrawBound(10_000); const samples = records.totals.counterReserve.eventsSamples;
  const diagnostics = [...records.numeric.diagnostics];
  let rawEventDrawsRequired = 0;
  if (!records.supported || !drawBound.supported || !Number.isSafeInteger(samples) || samples < 0) diagnostics.push('No complete finite terminal RNG reservation');
  else {
    rawEventDrawsRequired = samples * drawBound.maximumRawDraws;
    if (!Number.isSafeInteger(rawEventDrawsRequired) || world.randomStreams.events.algorithm !== drawBound.algorithm
      || !Number.isSafeInteger(world.randomStreams.events.draws) || world.randomStreams.events.draws < 0
      || world.randomStreams.events.draws > Number.MAX_SAFE_INTEGER - rawEventDrawsRequired) diagnostics.push('Insufficient terminal raw events RNG draw headroom');
  }
  const supported = records.supported && drawBound.supported && Number.isSafeInteger(rawEventDrawsRequired);
  return { supported, fits: supported && records.numeric.fits && diagnostics.length === 0, rawEventDrawsRequired, drawBound, diagnostics,
    uncovered: records.numeric.uncovered.filter(reason => !drawBound.supported || !reason.startsWith('Raw events RNG draws for accepted breakthrough samples')) };
}
