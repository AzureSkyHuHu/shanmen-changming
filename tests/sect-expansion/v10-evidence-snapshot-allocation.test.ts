import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { jsonStringByteLength } from '../../src/core/save-budget/canonical-bytes';
import { createV10EvidenceSnapshotReader } from '../../src/core/world/v10-evidence-snapshot';

// Frozen pre-allocation implementation from producer 5b8a396ff6d9851ead146a2395397786700e95e1.
// Source SHA-256: 2a3803552ea51d774c059263d0f8d9fd387a55c4c7e19308d5e1103ed6701a66.
// Keep the old traversal/cache independent of the production reader. Only its
// export/function name changes; ordinary JSON also has a separate serializer /
// TextEncoder oracle below, independent of this reader's byte calculation.
interface V10EvidenceSnapshot { readonly canonical: string; readonly bytes: number }
interface V10EvidenceSnapshotReader {
  read(value: unknown): V10EvidenceSnapshot;
  /** Ephemeral diagnostics only. Never accepted as evidence or admission input. */
  stats(): { visitedObjects: number; cacheHits: number; cachedEntries: number; retainedTextBytes: number; evictions: number };
}

const MAX_CACHE_ENTRIES = 4096;
// Conservative UTF-16 payload accounting (two bytes per code unit), not a heap/RSS
// promise. Both limits govern retention only, never the accepted JSON domain.
const MAX_RETAINED_TEXT_BYTES = 8 * 1024 * 1024;
interface SnapshotNode extends V10EvidenceSnapshot { readonly immutable: boolean }

// BEGIN FROZEN PREVIOUS READER
function createPreviousReader(): V10EvidenceSnapshotReader {
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
    const children: { key: string; value: unknown }[] = [];
    // Capture every descriptor at this node before descending. Never use property
    // reads, array.map from the input, toJSON, or caller-defined serialization.
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0
        || keys.length !== length.value + 1) throw new TypeError('Expected a plain dense JSON array');
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected a dense data-only JSON array');
        children.push({ key: String(index), value: descriptor.value });
      }
    } else {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable) throw new TypeError('Expected ordinary enumerable JSON properties');
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors cannot be snapshotted or cached');
        children.push({ key, value: descriptor.value });
      }
    }
    let bytes = 2 + Math.max(0, children.length - 1);
    const parts: { key: string; text: string }[] = [];
    for (const child of children) {
      const result = visit(child.value, active);
      bytes += result.bytes; immutable = immutable && result.immutable;
      if (array) parts.push({ key: child.key, text: result.canonical });
      else {
        bytes += jsonStringByteLength(child.key) + 1;
        parts.push({ key: child.key, text: `${JSON.stringify(child.key)}:${result.canonical}` });
      }
    }
    active.delete(value);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Encoded JSON byte count exceeds safe integer range');
    // Visit in descriptor order as the existing byte preflight does; sort only
    // the resulting object fields to match canonicalStringify's code-unit order.
    if (!array) parts.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const body = parts.map(part => part.text).join(',');
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
// END FROZEN PREVIOUS READER

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function pairedReaders() {
  const previous = createPreviousReader(); const current = createV10EvidenceSnapshotReader();
  return {
    previous, current,
    read(value: unknown, useTextOracle = true): V10EvidenceSnapshot {
      const oldResult = previous.read(value); const result = current.read(value);
      expect(result).toEqual(oldResult);
      expect(current.stats()).toEqual(previous.stats());
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toBe(oldResult);
      if (useTextOracle) {
        const canonical = canonicalStringify(value);
        expect(result).toEqual({ canonical, bytes: new TextEncoder().encode(canonical).byteLength });
      }
      return result;
    },
  };
}

function thrown(read: () => unknown): unknown {
  try { read(); } catch (error) { return error; }
  throw new Error('Expected reader rejection');
}

function sameRejection(input: unknown, pair = pairedReaders()): void {
  const previous = thrown(() => pair.previous.read(input));
  const current = thrown(() => pair.current.read(input));
  // These fixtures use ordinary built-in errors. Poison thrown values get their
  // own identity-only test below and are never passed through this helper.
  expect(previous).toBeInstanceOf(Error); expect(current).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(current)).toBe(Object.getPrototypeOf(previous));
  expect((current as Error).message).toBe((previous as Error).message);
  expect(pair.current.stats()).toEqual(pair.previous.stats());
}

function changingSiblingFixture(array: boolean) {
  const trace: string[] = [];
  let root: Record<string, unknown> | unknown[];
  const child = new Proxy(Object.freeze({ item: 'child' }), {
    getPrototypeOf(target) {
      trace.push('child:prototype');
      if (Array.isArray(root)) root[1] = 'changed'; else root.last = 'changed';
      return Reflect.getPrototypeOf(target);
    },
    isExtensible(target) { trace.push('child:extensible'); return Reflect.isExtensible(target); },
    ownKeys(target) { trace.push('child:keys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      trace.push(`child:descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get() { throw new Error('Must not read child properties'); },
  });
  root = array ? [child, 'captured'] : { first: child, last: 'captured' };
  const input = new Proxy(root, {
    getPrototypeOf(target) { trace.push('root:prototype'); return Reflect.getPrototypeOf(target); },
    isExtensible(target) { trace.push('root:extensible'); return Reflect.isExtensible(target); },
    ownKeys(target) { trace.push('root:keys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      trace.push(`root:descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get() { throw new Error('Must not read root properties'); },
  });
  return { input, root, trace };
}

describe('allocation-only evidence traversal matches the frozen previous reader', () => {
  it('matches independent canonical text and UTF-8 for deterministic mixed, wide and deep JSON', () => {
    const pair = pairedReaders();
    const units = Array.from({ length: 65_536 }, (_, index) => String.fromCharCode(index)).join('');
    const surrogates = Array.from({ length: 1024 }, (_, index) => String.fromCharCode(0xd800 + index, 0xdc00 + index)).join('');
    const numbers = [-0, 0, -1, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER, 1e-8, 1e21, 1.2345678901234567];
    pair.read({ z: units + surrogates + '\udfff\ud800', '"\\\u0000\u2028': numbers, 2: false, 10: null, A: true, a: [] });
    let state = 0x13579bdf;
    for (let round = 0; round < 48; round++) {
      const fields: Record<string, unknown> = {};
      for (let index = 0; index < 64; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        fields[`${index % 2 ? '中' : '\ud800'}-${state}-${index}`] = [state, null, state % 2 === 0,
          `value\n${String.fromCharCode(state & 0xffff)}`, { amount: numbers[index % numbers.length] }];
      }
      pair.read(round % 2 ? frozen(fields) : fields);
      pair.read(fields);
    }
    pair.read(Array.from({ length: 2048 }, (_, index) => ({ index, values: [index, -index, '🎋'] })));
    let nested: unknown = { end: true };
    for (let index = 0; index < 160; index++) nested = index % 2 ? [nested] : { nested };
    // Retention limits are not World admission limits, including its depth cap.
    pair.read(nested);
  });

  it('preserves numeric/escaped key ordering, special keys, aliases and non-enumerable dense indices', () => {
    const pair = pairedReaders(); const shared = Object.freeze({ text: 'shared' });
    const mutable = { first: shared, second: shared, list: [shared, shared] };
    pair.read(mutable); pair.read(frozen(mutable));
    const array = [shared, 2]; Object.defineProperty(array, '0', { enumerable: false });
    pair.read(Object.freeze(array));
    const special = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3,"2":2,"10":10,"a":0,"A":1}');
    expect(pair.read(special).canonical).toBe('{"10":10,"2":2,"A":1,"__proto__":1,"a":0,"constructor":2,"prototype":3}');
    pair.read({ '\udfff': 1, '\ud800': 2, '\u0000': 3, '\\': 4, '"': 5, '🎋': 6 });
  });

  it.each([false, true])('captures all sibling descriptors before descent (array=%s)', array => {
    const oldFixture = changingSiblingFixture(array); const fixture = changingSiblingFixture(array);
    const previous = createPreviousReader(); const current = createV10EvidenceSnapshotReader();
    const oldResult = previous.read(oldFixture.input); const result = current.read(fixture.input);
    expect(result).toEqual(oldResult); expect(fixture.trace).toEqual(oldFixture.trace);
    expect(current.stats()).toEqual(previous.stats());
    expect(result.canonical).toBe(array ? '[{"item":"child"},"captured"]' : '{"first":{"item":"child"},"last":"captured"}');
    const lastDescriptor = fixture.trace.indexOf(`root:descriptor:${array ? '1' : 'last'}`);
    expect(lastDescriptor).toBeGreaterThan(-1);
    expect(lastDescriptor).toBeLessThan(fixture.trace.indexOf('child:prototype'));
    expect(Array.isArray(fixture.root) ? fixture.root[1] : fixture.root.last).toBe('changed');
    // Second reads capture the new value; the frozen child may be reused.
    expect(current.read(fixture.input)).toEqual(previous.read(oldFixture.input));
    expect(fixture.trace).toEqual(oldFixture.trace); expect(current.stats()).toEqual(previous.stats());
  });

  it('retains descriptor-order error selection before canonical output sorting', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 1; } });
    const hidden = Object.defineProperty({}, 'value', { value: 1 });
    const pair = pairedReaders();
    for (const input of [{ z: accessor, a: hidden }, { z: hidden, a: accessor }]) sameRejection(input, pair);
    const first = thrown(() => pair.current.read({ z: accessor, a: hidden })) as Error;
    const second = thrown(() => pair.current.read({ z: hidden, a: accessor })) as Error;
    expect(first.message).toBe('JSON accessors cannot be snapshotted or cached');
    expect(second.message).toBe('Expected ordinary enumerable JSON properties');
    // A root descriptor error is discovered before descending into an earlier child.
    const parent = Object.defineProperty({ first: accessor }, 'hidden', { value: 0 });
    sameRejection(parent);
    expect((thrown(() => createV10EvidenceSnapshotReader().read(parent)) as Error).message)
      .toBe('Expected ordinary enumerable JSON properties');
    expect(reads).toBe(0);
  });

  it('matches unsupported primitive, prototype, descriptor and dense-array rejections', () => {
    let calls = 0;
    const getter = Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } }));
    const arrayGetter = Object.freeze(Object.defineProperty([1], '0', { get() { calls++; return 1; } }));
    const customMap = Object.defineProperty([1], 'map', { value: () => { calls++; return []; } });
    const customJson = { toJSON: () => { calls++; return {}; } };
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
    const arrayExtra = Object.assign([1], { extra: 2 });
    const customArray = [1]; Object.setPrototypeOf(customArray, null);
    const symbolArray = Object.defineProperty([1], Symbol('extra'), { value: 2 });
    for (const input of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => 1,
      new Map(), new Date(0), Object.create(null), Object.create({ inherited: 1 }),
      getter, arrayGetter, customMap, customJson, hidden, { [Symbol('field')]: 1 },
      new Array(1), [, 1], arrayExtra, customArray, symbolArray]) sameRejection(input);
    expect(calls).toBe(0);
  });

  it('keeps cache behavior after partial traversal failures and rejects active cycles', () => {
    const pair = pairedReaders(); const shared = frozen({ nested: { value: 1 } });
    const cycle: { good: typeof shared; self?: unknown } = { good: shared }; cycle.self = cycle;
    sameRejection(cycle, pair); pair.read(shared);
    const array: unknown[] = [shared]; array.push(array);
    sameRejection(array, pair); pair.read(shared);
    sameRejection({ good: shared, bad: NaN }, pair); pair.read({ good: shared });
    const frozenCycle: { self?: unknown } = {}; frozenCycle.self = frozenCycle; Object.freeze(frozenCycle);
    sameRejection(frozenCycle, pair);
  });

  it('continues re-reading mutable aliases and shallow-frozen children without freezing caller data', () => {
    const pair = pairedReaders(); const child = { value: 'before' };
    const shallow = Object.freeze({ left: child, right: child });
    pair.read(shallow); child.value = 'after中\ud800'; pair.read(shallow);
    expect(pair.current.stats().cacheHits).toBe(0); expect(Object.isFrozen(child)).toBe(false);
    let reads = 0;
    Object.defineProperty(child, 'value', { enumerable: true, get() { reads++; return 'forged'; } });
    sameRejection(shallow, pair); expect(reads).toBe(0);
    Object.defineProperty(child, 'value', { enumerable: true, value: 'restored', writable: true });
    pair.read(shallow); pair.read(frozen(shallow));
    const before = pair.current.stats(); pair.read(shallow);
    expect(pair.current.stats().visitedObjects).toBe(before.visitedObjects);
    expect(pair.current.stats().cacheHits).toBe(before.cacheHits + 1);
  });

  it('does not inspect or format a poison value thrown by reflection', () => {
    for (const create of [createPreviousReader, createV10EvidenceSnapshotReader]) {
      const traps: string[] = [];
      const poison = new Proxy({}, {
        get() { traps.push('get'); throw new Error('Do not inspect the thrown value'); },
        getPrototypeOf() { traps.push('prototype'); throw new Error('Do not inspect the thrown value'); },
        ownKeys() { traps.push('keys'); throw new Error('Do not inspect the thrown value'); },
      });
      const reader = create(); const input = new Proxy({}, { ownKeys() { throw poison; } });
      const error = thrown(() => reader.read(input));
      expect(error === poison).toBe(true); expect(traps).toEqual([]);
      expect(reader.stats()).toEqual({ visitedObjects: 1, cacheHits: 0, cachedEntries: 0, retainedTextBytes: 0, evictions: 0 });
    }
  });

  it('preserves directly revoked rejection and the existing frozen-parent cached revocation limit', () => {
    const pair = pairedReaders(); const child = Proxy.revocable(Object.freeze({ value: 1 }), {});
    const parent = Object.freeze({ child: child.proxy }); const first = pair.read(parent);
    child.revoke(); expect(pair.read(parent, false)).toEqual(first);
    sameRejection(child.proxy, pair);
    sameRejection(parent);
    const mutable = { child: child.proxy }; sameRejection(mutable, pair);
  });

  it('keeps returned text/byte records fresh and frozen and diagnostic mutations non-authoritative', () => {
    const pair = pairedReaders(); const input = frozen({ child: { value: 1 } });
    const first = pair.read(input);
    expect(Reflect.set(first, 'canonical', 'forged')).toBe(false);
    expect(Reflect.set(first, 'bytes', 0)).toBe(false);
    expect(Reflect.set(first, 'immutable', true)).toBe(false);
    const stats = pair.current.stats(); stats.cachedEntries = 0; stats.cacheHits = -100;
    expect(pair.current.stats()).toEqual(pair.previous.stats());
    const again = pair.read(input); expect(again).not.toBe(first);
    pair.read({ ...first, immutable: true, trusted: true });
    expect(Object.keys(again)).toEqual(['canonical', 'bytes']);
  });
});

describe('allocation-only traversal preserves exact retention boundaries', () => {
  it('rotates at the same entry, including nested child-before-parent retention', () => {
    const pair = pairedReaders(); const first = Object.freeze({ value: 0 }); pair.read(first);
    for (let index = 1; index < MAX_CACHE_ENTRIES; index++) pair.read(Object.freeze({ value: index }));
    expect(pair.current.stats().cachedEntries).toBe(MAX_CACHE_ENTRIES);
    expect(pair.current.stats().evictions).toBe(0);
    pair.read(first); expect(pair.current.stats().cachedEntries).toBe(MAX_CACHE_ENTRIES);
    const last = frozen({ child: { value: 'next' } }); pair.read(last);
    expect(pair.current.stats().cachedEntries).toBe(2); expect(pair.current.stats().evictions).toBe(1);
    pair.read(first); pair.read(last);
    for (let index = 0; index < MAX_CACHE_ENTRIES; index++) pair.read(Object.freeze([index]));
    expect(pair.current.stats().evictions).toBe(2);
  });

  it('retains exactly the text limit and rotates for the next eligible entry', () => {
    const pair = pairedReaders(); const overhead = canonicalStringify({ text: '' }).length;
    const exact = Object.freeze({ text: 'x'.repeat(MAX_RETAINED_TEXT_BYTES / 2 - overhead) });
    pair.read(exact); expect(pair.current.stats().retainedTextBytes).toBe(MAX_RETAINED_TEXT_BYTES);
    expect(pair.current.stats().cachedEntries).toBe(1); expect(pair.current.stats().evictions).toBe(0);
    pair.read(exact); expect(pair.current.stats().cacheHits).toBe(1);
    pair.read(Object.freeze({ next: true }));
    expect(pair.current.stats().cachedEntries).toBe(1); expect(pair.current.stats().evictions).toBe(1);
    pair.read(exact); expect(pair.current.stats().retainedTextBytes).toBe(MAX_RETAINED_TEXT_BYTES);
    expect(pair.current.stats().evictions).toBe(2);
  }, 20_000);

  it.each([-1, 1])('preserves the one-code-unit text retention edge (%s)', offset => {
    const pair = pairedReaders(); const overhead = canonicalStringify({ text: '' }).length;
    const input = Object.freeze({ text: 'x'.repeat(MAX_RETAINED_TEXT_BYTES / 2 - overhead + offset) });
    const first = pair.read(input); const retained = offset < 0;
    expect(first.canonical.length * 2).toBe(MAX_RETAINED_TEXT_BYTES + 2 * offset);
    expect(pair.current.stats().cachedEntries).toBe(retained ? 1 : 0);
    expect(pair.current.stats().retainedTextBytes).toBe(retained ? MAX_RETAINED_TEXT_BYTES - 2 : 0);
    expect(pair.read(input)).toEqual(first);
    expect(pair.current.stats().cacheHits).toBe(retained ? 1 : 0);
    expect(pair.current.stats().visitedObjects).toBe(retained ? 1 : 2);
    expect(pair.current.stats().evictions).toBe(0);
  }, 20_000);

  it('skips oversized parent retention while retaining eligible children and admitting full Unicode text', () => {
    const pair = pairedReaders(); const child = Object.freeze({ value: 1 });
    const input = Object.freeze({ child, text: '中'.repeat(MAX_RETAINED_TEXT_BYTES / 2) });
    const first = pair.read(input);
    expect(first.bytes).toBeGreaterThan(MAX_RETAINED_TEXT_BYTES);
    expect(pair.current.stats().cachedEntries).toBe(1); expect(pair.current.stats().evictions).toBe(0);
    const before = pair.current.stats(); expect(pair.read(input)).toEqual(first);
    expect(pair.current.stats().visitedObjects).toBe(before.visitedObjects + 1);
    expect(pair.current.stats().cacheHits).toBe(before.cacheHits + 1);
    expect(pair.current.stats().retainedTextBytes).toBe(canonicalStringify(child).length * 2);
    const next = Object.freeze([child, 'still useful']); pair.read(next); const later = pair.current.stats(); pair.read(next);
    expect(pair.current.stats().visitedObjects).toBe(later.visitedObjects);
    expect(pair.current.stats().cacheHits).toBe(later.cacheHits + 1);
  }, 20_000);
});
