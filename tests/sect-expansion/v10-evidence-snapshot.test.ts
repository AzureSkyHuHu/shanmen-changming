import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { canonicalUtf8ByteLength, createCanonicalByteCounter } from '../../src/core/save-budget/canonical-bytes';
import { createV10EvidenceSnapshotReader, readV10EvidenceSnapshot } from '../../src/core/world/v10-evidence-snapshot';
import { captureFrozenV10RecordData } from '../../src/core/world/v10-frozen-record-capture';

const ENTRY_LIMIT = 4096;
const TEXT_LIMIT = 8 * 1024 * 1024;
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(value: unknown, reader = createV10EvidenceSnapshotReader()): void {
  const expected = canonicalStringify(value);
  expect(reader.read(value)).toEqual({ canonical: expected, bytes: new TextEncoder().encode(expected).byteLength });
  expect(reader.read(value).bytes).toBe(canonicalUtf8ByteLength(value));
}

describe('descriptor-based v10 canonical evidence snapshots', () => {
  it.each(['', 'ASCII', '山门长明', '🎋🧙', '\u0000\u0001\b\t\n\f\r\u001f', '"\\/', '\u2028\u2029',
    '\ud800', '\udfff', '\ud800x\udfff', '\ud800\ud800\udfff'])('matches canonical text and UTF-8 for %j', value => {
    exact(value);
  });
  it('matches all UTF-16 units, valid pairs, escaped keys, finite numbers and code-unit key ordering', () => {
    const allUnits = Array.from({ length: 65_536 }, (_, index) => String.fromCharCode(index)).join('');
    const pairs = Array.from({ length: 1024 }, (_, index) => String.fromCharCode(0xd800 + index, 0xdc00 + index)).join('');
    exact({ z: `${allUnits}${pairs}\udfff\ud800`, 2: 'two', 10: 'ten', A: false, a: null,
      '\u0000"\\中\ud800': [-0, 0, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 1e-8, 1e21, true] });
    expect(readV10EvidenceSnapshot({ z: 0, 2: 2, 10: 10, a: 1 }).canonical).toBe('{"10":10,"2":2,"a":1,"z":0}');
  });
  it('retains repeated-reference semantics and dense non-enumerable array indices', () => {
    const child = Object.freeze({ text: 'shared' });
    exact(Object.freeze({ first: child, second: child, list: Object.freeze([child, child]) }));
    const array = [1, 2]; Object.defineProperty(array, '0', { enumerable: false });
    exact(Object.freeze(array));
    exact(JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}'));
  });
  it('authenticates the complete frozen tree before identity reuse', () => {
    const reader = createV10EvidenceSnapshotReader();
    const value = deepFreeze({ child: { text: 'safe' }, list: [{ amount: 2 }] });
    const first = reader.read(value); const before = reader.stats();
    expect(before.visitedObjects).toBe(4); expect(before.cachedEntries).toBe(4);
    expect(reader.read(value)).toEqual(first);
    expect(reader.stats().visitedObjects).toBe(before.visitedObjects);
    expect(reader.stats().cacheHits).toBe(before.cacheHits + 1);
  });
  it('returns isolated frozen result records that cannot poison cached text or bytes', () => {
    const reader = createV10EvidenceSnapshotReader(); const input = Object.freeze({ value: 3 });
    const result = reader.read(input); const expected = { ...result };
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'canonical', 'forged')).toBe(false);
    expect(Reflect.set(result, 'bytes', 0)).toBe(false);
    expect(Reflect.set(result, 'immutable', true)).toBe(false);
    const again = reader.read(input);
    expect(again).toEqual(expected); expect(again).not.toBe(result);
    const stats = reader.stats(); stats.cacheHits = -1; stats.retainedTextBytes = 0;
    expect(reader.stats().cacheHits).toBe(1); expect(reader.stats().retainedTextBytes).toBeGreaterThan(0);
  });
  it('rechecks mutable inputs and shallow-frozen parents without freezing callers', () => {
    const reader = createV10EvidenceSnapshotReader(); const child = { text: 'one' }; const shallow = Object.freeze({ child });
    const before = reader.read(shallow);
    child.text = 'longer中文\ud800'; const after = reader.read(shallow);
    expect(after.canonical).not.toBe(before.canonical); exact(shallow, reader);
    expect(reader.stats().cacheHits).toBe(0); expect(Object.isFrozen(child)).toBe(false);
    const mutable = { value: 1, savedBytes: 0, trusted: true }; exact(mutable, reader);
    mutable.value = 99; mutable.savedBytes = 1; mutable.trusted = false; exact(mutable, reader);
    expect(Object.isFrozen(mutable)).toBe(false);
  });
  it('reuses frozen descendants while re-reading and comparing mutable wrappers', () => {
    const reader = createV10EvidenceSnapshotReader();
    const fixed = deepFreeze({ rows: [{ amount: 1 }, { amount: 2 }] });
    const input = { fixed, revision: 0 }; reader.read(input); const before = reader.stats();
    input.revision = 1;
    expect(reader.read(input).canonical).toBe(canonicalStringify(input));
    expect(reader.stats().visitedObjects - before.visitedObjects).toBe(1);
    expect(reader.stats().cacheHits - before.cacheHits).toBe(1);
    input.fixed = deepFreeze({ rows: [{ amount: 9 }, { amount: 10 }] }); exact(input, reader);
  });
  it('rejects getters introduced after a read, including below a shallow-frozen parent', () => {
    for (const shallow of [false, true]) {
      const reader = createV10EvidenceSnapshotReader(); const child = { value: 1 };
      const parent = shallow ? Object.freeze({ child }) : { child };
      reader.read(parent); let reads = 0;
      Object.defineProperty(child, 'value', { enumerable: true, get: () => { reads++; return 1; } });
      expect(() => reader.read(parent)).toThrow(); expect(reads).toBe(0);
      Object.defineProperty(child, 'value', { enumerable: true, value: 2, writable: true });
      exact(parent, reader); expect(Object.isFrozen(child)).toBe(false);
    }
  });
  it('rejects frozen accessors and custom serialization without calling them', () => {
    let reads = 0;
    const getter = Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get: () => { reads++; return 1; } }));
    const arrayGetter = Object.freeze(Object.defineProperty([1], '0', { enumerable: true, get: () => { reads++; return 1; } }));
    const customMap = Object.freeze(Object.defineProperty([1], 'map', { value: () => { reads++; return ['forged']; } }));
    const customJson = Object.freeze({ toJSON: () => { reads++; return {}; } });
    for (const input of [getter, arrayGetter, customMap, customJson]) expect(() => readV10EvidenceSnapshot(input)).toThrow();
    expect(reads).toBe(0);
  });
  it('rejects unsupported shapes and cycles even after a valid descendant was cached', () => {
    const reader = createV10EvidenceSnapshotReader(); const safe = Object.freeze({ value: 1 }); reader.read(safe);
    const cycle: { safe: typeof safe; self?: unknown } = { safe }; cycle.self = cycle;
    const symbol = { [Symbol('hidden')]: 1 };
    const hidden = Object.freeze(Object.defineProperty({}, 'hidden', { value: 1 }));
    const customArray = [1]; Object.setPrototypeOf(customArray, null);
    for (const input of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, new Map(), new Date(0),
      new Array(1), Object.create(null), Object.create({ inherited: 1 }), symbol, hidden, customArray, cycle]) {
      expect(() => reader.read(input)).toThrow();
    }
    expect(reader.read(safe).canonical).toBe('{"value":1}');
  });
  it('documents nested revoked Proxy reflection limits and detached capture isolation', () => {
    const child = Proxy.revocable(Object.freeze({ amount: 1 }), {});
    const parent = Object.freeze({ child: child.proxy });
    const reader = createV10EvidenceSnapshotReader(); const counter = createCanonicalByteCounter();
    const before = reader.read(parent); expect(counter.measure(parent)).toBe(before.bytes);
    const detached = captureFrozenV10RecordData(parent);
    child.revoke();
    // Frozen-parent cache hits do not revisit child Proxy traps. The old byte
    // counter also skips them; the former live text traversal still throws.
    expect(reader.read(parent)).toEqual(before);
    expect(counter.measure(parent)).toBe(before.bytes);
    expect(() => canonicalStringify(parent)).toThrow();
    expect(() => createV10EvidenceSnapshotReader().read(parent)).toThrow();
    expect(() => reader.read(child.proxy)).toThrow();
    // Full descriptor capture retained ordinary private data, not the Proxy.
    expect(createV10EvidenceSnapshotReader().read(detached)).toEqual(before);
    expect(canonicalStringify(detached)).toBe(before.canonical);
  });
});

describe('fixed bounded evidence snapshot retention', () => {
  it('rotates after repeated entry exhaustion and keeps admitting useful new cache entries', () => {
    const reader = createV10EvidenceSnapshotReader(); const child = { value: 'before' };
    const shallow = Object.freeze({ child }); reader.read(shallow);
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index <= ENTRY_LIMIT; index++) reader.read(Object.freeze({ value: round * ENTRY_LIMIT + index }));
      const next = Object.freeze({ value: `round-${round}` }); exact(next, reader);
      const before = reader.stats(); reader.read(next);
      expect(reader.stats().cacheHits).toBe(before.cacheHits + 1);
      expect(reader.stats().visitedObjects).toBe(before.visitedObjects);
      expect(before.cachedEntries).toBeLessThanOrEqual(ENTRY_LIMIT);
      expect(before.retainedTextBytes).toBeLessThanOrEqual(TEXT_LIMIT);
      child.value = `changed-${round}`; exact(shallow, reader);
    }
    expect(reader.stats().evictions).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(child)).toBe(false);
  });
  it('rotates on retained text pressure and still returns exact new and old snapshots', () => {
    const reader = createV10EvidenceSnapshotReader(); const text = '中'.repeat(256 * 1024);
    const first = Object.freeze({ text, index: 0 }); const original = reader.read(first);
    for (let index = 1; index <= 40; index++) {
      const input = Object.freeze({ text, index }); const result = reader.read(input);
      expect(result.canonical).toBe(canonicalStringify(input));
      expect(result.bytes).toBe(canonicalUtf8ByteLength(input));
      const before = reader.stats(); reader.read(input);
      expect(reader.stats().cacheHits).toBe(before.cacheHits + 1);
      expect(reader.stats().retainedTextBytes).toBeLessThanOrEqual(TEXT_LIMIT);
      expect(reader.stats().cachedEntries).toBeLessThanOrEqual(ENTRY_LIMIT);
    }
    expect(reader.stats().evictions).toBeGreaterThanOrEqual(2);
    expect(reader.read(first)).toEqual(original);
  });
  it('skips oversized cache entries without rejecting data or disabling later reuse', () => {
    const reader = createV10EvidenceSnapshotReader(); const input = Object.freeze({ text: 'x'.repeat(TEXT_LIMIT / 2) });
    const result = reader.read(input);
    expect(result.canonical).toBe(canonicalStringify(input)); expect(result.bytes).toBe(canonicalUtf8ByteLength(input));
    expect(reader.stats().cachedEntries).toBe(0); expect(reader.read(input)).toEqual(result);
    const smaller = Object.freeze({ text: 'still useful' }); reader.read(smaller); const before = reader.stats();
    expect(reader.read(smaller).canonical).toBe(canonicalStringify(smaller));
    expect(reader.stats().cacheHits).toBe(before.cacheHits + 1);
    expect(reader.stats().visitedObjects).toBe(before.visitedObjects);
  });
});
