import { hashText } from './serialization';

/** v2 preserves the uint32 recurrence but corrects the nonzero-word integer bucket mapping. */
export const RANDOM_ALGORITHM = 'xorshift32-nonzero-v2' as const;
export const RANDOM_WORD_DOMAIN_SIZE = 0xffffffff;
export const RANDOM_STREAM_NAMES = ['generation', 'economy', 'combat', 'offers', 'events'] as const;
export type RandomStreamName = typeof RANDOM_STREAM_NAMES[number];
export interface RandomStream { algorithm: typeof RANDOM_ALGORITHM; state: number; draws: number }
export type RandomStreams = Record<RandomStreamName, RandomStream>;

export function createRandomStreams(seed: string): RandomStreams {
  return Object.fromEntries(RANDOM_STREAM_NAMES.map((name) => [name, {
    algorithm: RANDOM_ALGORITHM, state: hashText(`${seed}::${name}`) || 0x9e3779b9, draws: 0,
  }])) as RandomStreams;
}

/** Returns an unsigned 32-bit integer and a new stream state. Never mutates the input. */
export function nextUint32(stream: RandomStream): { value: number; stream: RandomStream } {
  if (stream.algorithm !== RANDOM_ALGORITHM || !Number.isInteger(stream.state) || stream.state <= 0 || stream.state > 0xffffffff) {
    throw new RangeError('Invalid random stream');
  }
  let value = stream.state;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value >>>= 0;
  const draws = stream.draws + 1;
  if (!Number.isSafeInteger(draws)) throw new RangeError('Random draw counter overflow');
  return { value, stream: { ...stream, state: value, draws } };
}

/**
 * Xorshift's nonzero state cycle produces words 1..domainSize, never zero.
 * Normalize to 0..domainSize-1, then reject the incomplete final bucket group.
 * domainSize is injectable for exhaustive reduced-width conformance tests.
 */
export function mapNonZeroWordToBucket(word: number, span: number, domainSize = RANDOM_WORD_DOMAIN_SIZE): number | null {
  if (!Number.isSafeInteger(domainSize) || domainSize < 1 || domainSize > RANDOM_WORD_DOMAIN_SIZE || !Number.isSafeInteger(word) || word < 1 || word > domainSize || !Number.isSafeInteger(span) || span < 1 || span > domainSize) throw new RangeError('Invalid nonzero random domain');
  const normalized = word - 1;
  const limit = Math.floor(domainSize / span) * span;
  return normalized < limit ? normalized % span : null;
}

/** Inclusive bounds. At most 2^32-1 distinct outcomes; the full 2^32-value range is unsupported. */
export function drawInteger(streams: RandomStreams, name: RandomStreamName, min: number, max: number): { value: number; streams: RandomStreams } {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError('Invalid random bounds');
  const span = max - min + 1;
  if (span > RANDOM_WORD_DOMAIN_SIZE || !Number.isSafeInteger(span)) throw new RangeError('Random range exceeds the nonzero word domain');
  let result = nextUint32(streams[name]);
  let bucket = mapNonZeroWordToBucket(result.value, span);
  while (bucket === null) {
    result = nextUint32(result.stream);
    bucket = mapNonZeroWordToBucket(result.value, span);
  }
  return { value: min + bucket, streams: { ...streams, [name]: result.stream } };
}
