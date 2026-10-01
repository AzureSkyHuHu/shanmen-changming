import { describe, expect, it } from 'vitest';
import { createRandomStreams, drawInteger, nextUint32, RANDOM_ALGORITHM, RANDOM_WORD_DOMAIN_SIZE } from '../../src/core/kernel/random';
import { createWorld } from '../../src/core/world/create-world';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { cloneJson } from '../../src/core/kernel/serialization';
import { previewBreakthroughV3, applyCultivationCommandV3 } from '../../src/core/cultivation/v3';
import { deriveProgressionReservations } from '../../src/core/save-budget/progression-bounds';
import { worldBuildHistoryObligationFacts } from '../../src/core/world/progression-obligations';
import { assessProgressionNumeric, integerRejectionDrawBound, inspectRejectedSubgraph } from '../../src/core/world/progression-numeric';

/** Test-only inverse, independently checked against the real forward primitive. */
function predecessor(word: number): number {
  const undoLeft = (value: number, shift: number) => { let previous = value; for (let pass = 0; pass < Math.ceil(32 / shift); pass += 1) previous = (value ^ (previous << shift)) >>> 0; return previous; };
  const undoRight = (value: number, shift: number) => { let previous = value; for (let pass = 0; pass < Math.ceil(32 / shift); pass += 1) previous = (value ^ (previous >>> shift)) >>> 0; return previous; };
  return undoLeft(undoRight(undoLeft(word, 5), 17), 13);
}

describe('finite rejection-sampling headroom for accepted breakthroughs', () => {
  it('bounds every rejected first word for 1..10000 using real drawInteger, independently of the current stream', () => {
    const bound = integerRejectionDrawBound(10_000);
    expect(bound.supported).toBe(true); if (!bound.supported) throw new Error(bound.reason);
    expect(bound.rejectedWords).toBe(7295); let observedMaximum = 1;
    const seed = createRandomStreams('rejection-proof'); const before = cloneJson(seed);
    for (let word = RANDOM_WORD_DOMAIN_SIZE - bound.rejectedWords + 1; word <= RANDOM_WORD_DOMAIN_SIZE; word += 1) {
      const state = predecessor(word); expect(nextUint32({ algorithm: RANDOM_ALGORITHM, state, draws: 0 }).value).toBe(word);
      const result = drawInteger({ ...seed, events: { algorithm: RANDOM_ALGORITHM, state, draws: 0 } }, 'events', 1, 10000);
      expect(result.value).toBeGreaterThanOrEqual(1); expect(result.value).toBeLessThanOrEqual(10000);
      expect(result.streams.events.draws).toBeLessThanOrEqual(bound.maximumRawDraws);
      observedMaximum = Math.max(observedMaximum, result.streams.events.draws);
    }
    expect(observedMaximum).toBe(bound.maximumRawDraws); expect(seed).toEqual(before);
  });
  it.each([1, 3, RANDOM_WORD_DOMAIN_SIZE])('needs one raw word for exact bucket partition %s', span => {
    expect(integerRejectionDrawBound(span)).toMatchObject({ supported: true, rejectedWords: 0, maximumRawDraws: 1, witnessRejectedWord: null });
  });
  it('detects a closed rejection cycle and a finite escape in a reduced data-only graph', () => {
    expect(inspectRejectedSubgraph({ firstRejectedWord: 3, domainSize: 4, successors: [4, 3] })).toEqual({ supported: false });
    expect(inspectRejectedSubgraph({ firstRejectedWord: 3, domainSize: 4, successors: [4, 1] })).toEqual({ supported: true, maximumConsecutiveRejections: 2, witnessRejectedWord: 3 });
  });
  it('fails closed instead of enumerating an unbounded requested subset', () => {
    expect(integerRejectionDrawBound(0x80000000)).toMatchObject({ supported: false, reason: 'rejection-set-too-large' });
    for (const bad of [0, -1, NaN, Infinity, 1.5, RANDOM_WORD_DOMAIN_SIZE + 1]) expect(() => integerRejectionDrawBound(bad)).toThrow();
  });
  it('reserves the proved maximum at the real draw counter boundary without sampling or mutating a campaign', () => {
    let world = migrateWorldV7ToV8(createWorld('terminal-rng-headroom'));
    world.cultivation.disciples[1]!.cultivation = 120;
    const frame = { cultivation: world.cultivation, inventory: world.inventory, sequences: world.sequences, randomStreams: world.randomStreams };
    const preview = previewBreakthroughV3(frame, 'entity:2', { method: 'forced', arraySupport: 0 });
    const confirmed = applyCultivationCommandV3(frame, { kind: 'breakthrough.confirm', commandId: 'rng:confirm', expectedRevision: world.cultivation.revision, preview });
    expect(confirmed.ok).toBe(true); if (!confirmed.ok) throw new Error(confirmed.code);
    world = { ...world, ...confirmed.frame }; const before = cloneJson(world);
    const records = deriveProgressionReservations({ world, buildFacts: worldBuildHistoryObligationFacts(world) });
    const required = assessProgressionNumeric(world, records).rawEventDrawsRequired;
    expect(required).toBeGreaterThanOrEqual(2);
    const exact = { ...world, randomStreams: { ...world.randomStreams, events: { ...world.randomStreams.events, draws: Number.MAX_SAFE_INTEGER - required } } };
    expect(assessProgressionNumeric(exact, records).fits).toBe(true);
    const insufficient = { ...exact, randomStreams: { ...exact.randomStreams, events: { ...exact.randomStreams.events, draws: exact.randomStreams.events.draws + 1 } } };
    expect(assessProgressionNumeric(insufficient, records)).toMatchObject({ supported: true, fits: false });
    expect(world).toEqual(before);
  });
});
