import { jsonStringByteLength } from '../save-budget/canonical-bytes';

export interface V10EvidenceSnapshot { readonly canonical: string; readonly bytes: number }
export interface V10EvidenceSnapshotReader {
  read(value: unknown): V10EvidenceSnapshot;
  /** Ephemeral diagnostics only. Never accepted as evidence or admission input. */
  stats(): { visitedObjects: number; cacheHits: number; cachedEntries: number; retainedTextBytes: number; evictions: number };
}

const MAX_CACHE_ENTRIES = 4096;
// Conservative UTF-16 payload accounting (two bytes per code unit), not a heap/RSS
// promise. Both limits govern retention only, never the accepted JSON domain.
const MAX_RETAINED_TEXT_BYTES = 8 * 1024 * 1024;
interface SnapshotNode extends V10EvidenceSnapshot { readonly immutable: boolean }

/** INTERNAL v10 evidence serialization, not a World validator or capture port.
 * One descriptor traversal authenticates finite ordinary JSON, writes its exact
 * canonical text and measures UTF-8 bytes. A cache hit requires this reader's own
 * prior proof that EVERY reachable object was frozen and data-only. Mutable
 * wrappers are always read again, even when their frozen children can be reused.
 * No input is frozen, copied into a World, or accepted as a supplied certificate.
 * Repeated references retain serialization semantics; cycles are rejected.
 * As with existing record capture/counters, Proxy reflection can execute traps
 * and is not an atomic snapshot guarantee for hostile proxies.
 */
export function createV10EvidenceSnapshotReader(): V10EvidenceSnapshotReader {
  let cache = new WeakMap<object, SnapshotNode>();
  let visitedObjects = 0; let cacheHits = 0; let cachedEntries = 0; let retainedTextBytes = 0; let evictions = 0;
  function retain(value: object, result: SnapshotNode): void {
    const cost = result.canonical.length * 2;
    if (cost > MAX_RETAINED_TEXT_BYTES) return;
    if (cachedEntries >= MAX_CACHE_ENTRIES || retainedTextBytes + cost > MAX_RETAINED_TEXT_BYTES) {
      // WeakMap cannot report reclaimed keys. Rotate rather than permanently
      // disabling reuse when cumulative insertions (including dead keys) fill it.
      cache = new WeakMap(); cachedEntries = 0; retainedTextBytes = 0; evictions++;
    }
    cache.set(value, result); cachedEntries++; retainedTextBytes += cost;
  }
  function visit(value: unknown, active: WeakSet<object>): SnapshotNode {
    if (value === null) return { canonical: 'null', bytes: 4, immutable: true };
    if (typeof value === 'boolean') return { canonical: value ? 'true' : 'false', bytes: value ? 4 : 5, immutable: true };
    if (typeof value === 'string') return { canonical: JSON.stringify(value), bytes: jsonStringByteLength(value), immutable: true };
    if (typeof value === 'number' && Number.isFinite(value)) {
      const canonical = JSON.stringify(value); return { canonical, bytes: canonical.length, immutable: true };
    }
    if (typeof value !== 'object' || value === null) throw new TypeError('Expected finite data-only JSON');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new TypeError('Expected finite data-only JSON');
    const cached = cache.get(value);
    if (cached !== undefined) { cacheHits++; return cached; }
    if (active.has(value)) throw new TypeError('Cyclic JSON cannot be snapshotted');
    active.add(value); visitedObjects++;
    let immutable = Object.isFrozen(value);
    const keys = Reflect.ownKeys(value);
    let bytes: number; let body: string;
    // Capture every descriptor at this node before descending. Never use property
    // reads, array.map from the input, toJSON, or caller-defined serialization.
    if (array) {
      const children: unknown[] = [];
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0
        || keys.length !== length.value + 1) throw new TypeError('Expected a plain dense JSON array');
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected a dense data-only JSON array');
        children.push(descriptor.value);
      }
      bytes = 2 + Math.max(0, children.length - 1);
      const parts: string[] = [];
      for (const child of children) {
        const result = visit(child, active);
        bytes += result.bytes; immutable = immutable && result.immutable;
        parts.push(result.canonical);
      }
      active.delete(value);
      if (!Number.isSafeInteger(bytes)) throw new RangeError('Encoded JSON byte count exceeds safe integer range');
      body = parts.join(',');
    } else {
      const fields: { key: string; value: unknown; text: string }[] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable) throw new TypeError('Expected ordinary enumerable JSON properties');
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors cannot be snapshotted or cached');
        fields.push({ key, value: descriptor.value, text: '' });
      }
      bytes = 2 + Math.max(0, fields.length - 1);
      for (const field of fields) {
        const result = visit(field.value, active);
        bytes += result.bytes; immutable = immutable && result.immutable;
        bytes += jsonStringByteLength(field.key) + 1;
        field.text = `${JSON.stringify(field.key)}:${result.canonical}`;
      }
      active.delete(value);
      if (!Number.isSafeInteger(bytes)) throw new RangeError('Encoded JSON byte count exceeds safe integer range');
      // Visit in descriptor order as the existing byte preflight does; sort only
      // the resulting object fields to match canonicalStringify's code-unit order.
      fields.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      body = fields.map(field => field.text).join(',');
    }
    const result: SnapshotNode = { canonical: array ? `[${body}]` : `{${body}}`, bytes, immutable };
    if (immutable) retain(value, result);
    return result;
  }
  return Object.freeze({
    read(value: unknown): V10EvidenceSnapshot {
      const result = visit(value, new WeakSet());
      // Do not expose the private immutable proof or mutable cache entries.
      return Object.freeze({ canonical: result.canonical, bytes: result.bytes });
    },
    stats: () => ({ visitedObjects, cacheHits, cachedEntries, retainedTextBytes, evictions }),
  });
}

const evidenceSnapshots = createV10EvidenceSnapshotReader();
export const readV10EvidenceSnapshot = (value: unknown): V10EvidenceSnapshot => evidenceSnapshots.read(value);
