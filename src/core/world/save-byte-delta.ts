import { canonicalUtf8ByteLength, WORST_SAVE_METADATA, type SaveByteOptions } from '../save-budget';
import type { WorldStateBase } from './types';

/** Exact delta for already data-only JSON boundaries in one synchronous pure transition.
 * Unchanged references are algebraic cancellation, not a persisted mutable-object cache. */
export function canonicalByteDelta(before: unknown, after: unknown): number {
  if (before === after) return 0;
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) !== Array.isArray(after)) return canonicalUtf8ByteLength(after) - canonicalUtf8ByteLength(before);
  const array = Array.isArray(before);
  if (Object.getPrototypeOf(before) !== (array ? Array.prototype : Object.prototype)
    || Object.getPrototypeOf(after) !== (array ? Array.prototype : Object.prototype)) throw new TypeError('Non-data byte delta');
  const left = Object.keys(before); const right = Object.keys(after);
  const leftSet = new Set(left); const rightSet = new Set(right);
  const read = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('Non-data byte delta');
    return descriptor.value;
  };
  let delta = Math.max(0, right.length - 1) - Math.max(0, left.length - 1);
  for (const key of left) {
    if (rightSet.has(key)) delta += canonicalByteDelta(read(before, key), read(after, key));
    else delta -= canonicalUtf8ByteLength(read(before, key)) + (array ? 0 : canonicalUtf8ByteLength(key) + 1);
  }
  for (const key of right) if (!leftSet.has(key)) delta += canonicalUtf8ByteLength(read(after, key)) + (array ? 0 : canonicalUtf8ByteLength(key) + 1);
  return delta;
}
/** Header identities occur a second time outside payload; checksum width is always eight. */
export function worldSaveByteDelta(before: WorldStateBase, after: WorldStateBase, beforeOptions: SaveByteOptions = {}, afterOptions: SaveByteOptions = beforeOptions): number {
  return canonicalByteDelta(before, after)
    + canonicalByteDelta(before.seed, after.seed) + canonicalByteDelta(before.simulationVersion, after.simulationVersion)
    + canonicalByteDelta(before.contentVersion, after.contentVersion)
    + canonicalByteDelta(beforeOptions.saveVersion ?? 1, afterOptions.saveVersion ?? 1)
    + canonicalByteDelta(beforeOptions.metadata ?? WORST_SAVE_METADATA, afterOptions.metadata ?? WORST_SAVE_METADATA);
}
