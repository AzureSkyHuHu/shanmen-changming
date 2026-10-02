/** Canonical JSON UTF-8 bytes, UTF-16 code units, and value occurrences (not keys). */
export interface CanonicalRecordSize {
  bytes: number;
  decodedCharacters: number;
  decodedNodes: number;
}

export interface CanonicalRecordCounter {
  /** Counts finite data-only JSON without constructing its serialized document. */
  measure(value: unknown): CanonicalRecordSize;
  /** Cumulative, ephemeral instrumentation, never saved state or admission authority. */
  stats(): { visitedObjects: number; cacheHits: number };
}

interface MeasuredRecord {
  size: CanonicalRecordSize;
  immutable: boolean;
}

interface RecordSnapshot {
  size: CanonicalRecordSize;
  children: unknown[];
  immutable: boolean;
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError('Canonical JSON size exceeds safe integer range');
  return total;
}

/** Well-formed JSON.stringify escaping, including paired and lone surrogates. */
function stringSize(text: string): { bytes: number; decodedCharacters: number } {
  let bytes = 2;
  let decodedCharacters = 2;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) {
      bytes += 2; decodedCharacters += 2;
    } else if (unit < 0x20) {
      bytes += 6; decodedCharacters += 6;
    } else if (unit < 0x80) {
      bytes += 1; decodedCharacters += 1;
    } else if (unit < 0x800) {
      bytes += 2; decodedCharacters += 1;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; decodedCharacters += 2; index += 1;
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      bytes += 6; decodedCharacters += 6;
    } else {
      bytes += 3; decodedCharacters += 1;
    }
  }
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(decodedCharacters)) {
    throw new RangeError('Canonical JSON string size exceeds safe integer range');
  }
  return { bytes, decodedCharacters };
}

function dataDescriptor(value: object, key: string, enumerable: boolean): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== enumerable) {
    throw new TypeError('Expected enumerable data-only JSON properties');
  }
  return descriptor;
}

function fixedDescriptor(descriptor: PropertyDescriptor): boolean {
  return descriptor.configurable === false && descriptor.writable === false;
}

function checkShape(value: object): boolean {
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    throw new TypeError('Expected ordinary data-only JSON objects or arrays');
  }
  return array;
}

/**
 * Capture every own data value before descending. In particular, do not validate
 * a descriptor and subsequently read value[key], map, or an external array.length.
 * Keys need not be sorted: canonical ordering does not change any of these totals.
 */
function snapshot(value: object): RecordSnapshot {
  // Observe non-extensibility BEFORE descriptors. A proxy that freezes its target
  // during later reflection must not authenticate earlier, still-mutable values.
  const extensible = Object.isExtensible(value);
  const array = checkShape(value);
  const keys = Reflect.ownKeys(value);
  let immutable = !extensible;
  let members = keys.length;
  let length = 0;
  if (array) {
    const descriptor = dataDescriptor(value, 'length', false);
    const candidate: unknown = descriptor.value;
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0
      || candidate > 0xffff_ffff || descriptor.configurable !== false || keys.length !== candidate + 1) {
      throw new TypeError('Expected a plain dense JSON array');
    }
    length = candidate;
    members = length;
    immutable = immutable && fixedDescriptor(descriptor);
  }
  const punctuation = 2 + Math.max(0, members - 1);
  const size: CanonicalRecordSize = { bytes: punctuation, decodedCharacters: punctuation, decodedNodes: 1 };
  const children: unknown[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError('JSON symbol properties cannot be measured');
    if (array && key === 'length') continue;
    if (array) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
        throw new TypeError('Expected a plain dense JSON array');
      }
    }
    const descriptor = dataDescriptor(value, key, true);
    children.push(descriptor.value);
    immutable = immutable && fixedDescriptor(descriptor);
    if (!array) {
      const encodedKey = stringSize(key);
      size.bytes = checkedAdd(size.bytes, checkedAdd(encodedKey.bytes, 1));
      size.decodedCharacters = checkedAdd(size.decodedCharacters, checkedAdd(encodedKey.decodedCharacters, 1));
    }
  }
  return { size, children, immutable };
}

/**
 * Reuses only recursively inspected, fully frozen data subtrees, authenticated by
 * this counter's private identity map. Nothing is frozen or written on the caller.
 * A shared subtree contributes its full size at every occurrence, even on a hit.
 *
 * Portable JavaScript cannot identify every Proxy or prevent reflection traps.
 * Ordinary property getters/get traps are never used. For mutable objects, each
 * occurrence uses its own captured descriptors before visiting any child; hostile
 * reentrant mutation can change later snapshots, but cannot replace captured data
 * with an accessor read or authenticate mutable data for later identity reuse.
 * This is measurement of those snapshots, not ongoing validation of live state.
 * A hit still checks the current object's shape, rejecting a directly revoked
 * Proxy. Descendants behind a cached root are not revisited: revoking a nested
 * Proxy does not invalidate that previously authenticated root's size snapshot.
 */
export function createCanonicalRecordCounter(): CanonicalRecordCounter {
  const ownedSizes = new WeakMap<object, CanonicalRecordSize>();
  let visitedObjects = 0;
  let cacheHits = 0;
  function visit(value: unknown, active: WeakSet<object>): MeasuredRecord {
    if (typeof value === 'string') return { size: { ...stringSize(value), decodedNodes: 1 }, immutable: true };
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      // A finite number's spelling is at most a few dozen characters. This never
      // serializes a container, calls toJSON, or constructs the full JSON string.
      const length = JSON.stringify(value).length;
      return { size: { bytes: length, decodedCharacters: length, decodedNodes: 1 }, immutable: true };
    }
    if (typeof value !== 'object' || value === null) throw new TypeError('Expected finite data-only JSON');
    const cached = ownedSizes.get(value);
    if (cached !== undefined) { checkShape(value); cacheHits += 1; return { size: cached, immutable: true }; }
    if (active.has(value)) throw new TypeError('Cyclic JSON cannot be measured');
    active.add(value);
    visitedObjects += 1;
    const captured = snapshot(value);
    for (const value of captured.children) {
      const child = visit(value, active);
      captured.size.bytes = checkedAdd(captured.size.bytes, child.size.bytes);
      captured.size.decodedCharacters = checkedAdd(captured.size.decodedCharacters, child.size.decodedCharacters);
      captured.size.decodedNodes = checkedAdd(captured.size.decodedNodes, child.size.decodedNodes);
      captured.immutable = captured.immutable && child.immutable;
    }
    active.delete(value);
    if (captured.immutable) ownedSizes.set(value, captured.size);
    return { size: captured.size, immutable: captured.immutable };
  }
  return {
    // Never expose a cached record for the caller to mutate and poison later hits.
    measure: (value) => ({ ...visit(value, new WeakSet()).size }),
    stats: () => ({ visitedObjects, cacheHits }),
  };
}

const defaultCounter = createCanonicalRecordCounter();
export const measureCanonicalRecord = (value: unknown): CanonicalRecordSize => defaultCounter.measure(value);
