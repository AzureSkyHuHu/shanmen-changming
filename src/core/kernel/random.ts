import { hashText } from './serialization';

export const RANDOM_ALGORITHM = 'xorshift32-v1' as const;
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

/** Inclusive bounds; rejection sampling prevents modulo bias. */
export function drawInteger(streams: RandomStreams, name: RandomStreamName, min: number, max: number): { value: number; streams: RandomStreams } {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError('Invalid random bounds');
  const span = max - min + 1;
  if (span > 0x100000000 || !Number.isSafeInteger(span)) throw new RangeError('Random range too large');
  const limit = Math.floor(0x100000000 / span) * span;
  let result = nextUint32(streams[name]);
  while (result.value >= limit) result = nextUint32(result.stream);
  return { value: min + result.value % span, streams: { ...streams, [name]: result.stream } };
}
