import { canonicalUtf8ByteLength, type CanonicalByteCounter } from './canonical-bytes';

export interface SaveByteMetadata { buildId: string; savedAt: string }
export interface SaveByteOptions {
  /** v1–v9 all have the same encoded width. Supply the real version when that changes. */
  saveVersion?: number;
  /** Omitted means the worst legal metadata, including maximum JSON escaping. */
  metadata?: SaveByteMetadata;
  counter?: CanonicalByteCounter;
}
export const MAX_BUILD_ID_CODE_UNITS = 128;
export const MAX_SAVED_AT_CODE_UNITS = 64;
export const WORST_SAVE_METADATA: Readonly<SaveByteMetadata> = Object.freeze({
  buildId: '\u0000'.repeat(MAX_BUILD_ID_CODE_UNITS), savedAt: '\u0000'.repeat(MAX_SAVED_AT_CODE_UNITS),
});

/** Exact envelope size without cloning, checksumming or revalidating the whole World. */
export function measureWorldSaveBytes(world: unknown, options: SaveByteOptions = {}): number {
  if (typeof world !== 'object' || world === null || Array.isArray(world) || Object.getPrototypeOf(world) !== Object.prototype) {
    throw new TypeError('Expected a validated World object');
  }
  function identity(key: string): string {
    const property = Object.getOwnPropertyDescriptor(world, key);
    if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'string') throw new TypeError(`Missing World ${key}`);
    return property.value;
  }
  const metadata = options.metadata ?? WORST_SAVE_METADATA;
  if (typeof metadata.buildId !== 'string' || metadata.buildId.length < 1 || metadata.buildId.length > MAX_BUILD_ID_CODE_UNITS
    || typeof metadata.savedAt !== 'string' || metadata.savedAt.length < 1 || metadata.savedAt.length > MAX_SAVED_AT_CODE_UNITS) {
    throw new TypeError('Invalid save metadata');
  }
  const saveVersion = options.saveVersion ?? 1;
  if (!Number.isSafeInteger(saveVersion) || saveVersion < 1) throw new RangeError('Invalid save version');
  const envelope = {
    saveVersion, simulationVersion: identity('simulationVersion'), contentVersion: identity('contentVersion'),
    seed: identity('seed'), buildId: metadata.buildId, savedAt: metadata.savedAt, checksum: '00000000', payload: world,
  };
  return options.counter ? options.counter.measure(envelope) : canonicalUtf8ByteLength(envelope);
}
