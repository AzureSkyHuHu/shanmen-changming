/** UTF-8 length of already encoded text, including replacement of lone surrogates. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** Matches well-formed JSON.stringify strings, whose lone surrogates are six ASCII bytes. */
export function jsonStringByteLength(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

export interface CanonicalByteCounter {
  /** Data-only, finite JSON. Like canonicalStringify, object property order changes no bytes. */
  measure(value: unknown): number;
  /** Ephemeral instrumentation; never a saved authority or gameplay input. */
  stats(): { visitedObjects: number; cacheHits: number };
}

/**
 * Identity reuse is authenticated here: all visited properties must be data properties,
 * and every reachable object must be frozen. A merely shallow-frozen import is not cached.
 * No caller-supplied byte count, boolean trust flag, getter or prototype cache is accepted.
 */
export function createCanonicalByteCounter(): CanonicalByteCounter {
  const ownedSizes = new WeakMap<object, number>();
  let visitedObjects = 0;
  let cacheHits = 0;
  function visit(value: unknown, active: WeakSet<object>): { bytes: number; immutable: boolean } {
    if (value === null) return { bytes: 4, immutable: true };
    if (typeof value === 'boolean') return { bytes: value ? 4 : 5, immutable: true };
    if (typeof value === 'string') return { bytes: jsonStringByteLength(value), immutable: true };
    if (typeof value === 'number' && Number.isFinite(value)) return { bytes: JSON.stringify(value).length, immutable: true };
    if (typeof value !== 'object' || value === null || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new TypeError('Expected finite data-only JSON');
    }
    const cached = ownedSizes.get(value);
    if (cached !== undefined) { cacheHits += 1; return { bytes: cached, immutable: true }; }
    if (active.has(value)) throw new TypeError('Cyclic JSON cannot be measured');
    active.add(value);
    visitedObjects += 1;
    let immutable = Object.isFrozen(value);
    let bytes = 2;
    if (Array.isArray(value)) {
      // canonicalStringify calls the array's map method. Reject hidden/custom array
      // methods and exotic prototypes instead of caching an overridden traversal.
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError('Expected a plain dense JSON array');
      }
      bytes += Math.max(0, value.length - 1);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected a dense data-only JSON array');
        const child = visit(descriptor.value, active);
        bytes += child.bytes; immutable = immutable && child.immutable;
      }
    } else {
      const keys = Object.keys(value);
      if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError('Expected ordinary enumerable JSON properties');
      bytes += Math.max(0, keys.length - 1);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors cannot be measured or cached');
        const child = visit(descriptor.value, active);
        bytes += jsonStringByteLength(key) + 1 + child.bytes;
        immutable = immutable && child.immutable;
      }
    }
    active.delete(value);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Encoded JSON byte count exceeds safe integer range');
    if (immutable) ownedSizes.set(value, bytes);
    return { bytes, immutable };
  }
  return {
    measure: (value) => visit(value, new WeakSet()).bytes,
    stats: () => ({ visitedObjects, cacheHits }),
  };
}

const defaultCounter = createCanonicalByteCounter();
export const canonicalUtf8ByteLength = (value: unknown): number => defaultCounter.measure(value);
