import { describe, expect, test } from 'vitest';
import { appendArchivedEvent, createHistoryArchive } from '../../src/core/history';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { canonicalUtf8ByteLength } from '../../src/core/save-budget/canonical-bytes';
import { createCanonicalRecordCounter, measureCanonicalRecord } from '../../src/core/save-budget/canonical-records';
import { measureProgressionRecord } from '../../src/core/save-budget/progression-bounds';
import { createWorld } from '../../src/core/world/create-world';

/** Frozen previous implementation; an independent oracle for ordinary JSON fixtures. */
function measureProgressionRecordBeforeCounter(value: unknown): { bytes: number; decodedCharacters: number; decodedNodes: number } {
  const bytes = canonicalUtf8ByteLength(value);
  let decodedNodes = 0;
  const visit = (entry: unknown): void => {
    decodedNodes += 1;
    if (entry !== null && typeof entry === 'object') for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return { bytes, decodedCharacters: canonicalStringify(value).length, decodedNodes };
}

/** Both the new leaf and existing public helper must match the frozen old oracle. */
function expectEquivalent(value: unknown): void {
  const observed = measureCanonicalRecord(value);
  const canonical = canonicalStringify(value);
  const previous = measureProgressionRecordBeforeCounter(value);
  expect(observed).toEqual(previous);
  expect(measureProgressionRecord(value)).toEqual(previous);
  expect(observed.bytes).toBe(new TextEncoder().encode(canonical).byteLength);
  expect(observed.decodedCharacters).toBe(canonical.length);
}

describe('canonical record accounting', () => {
  test.each([
    [null, { bytes: 4, decodedCharacters: 4, decodedNodes: 1 }],
    [true, { bytes: 4, decodedCharacters: 4, decodedNodes: 1 }],
    [false, { bytes: 5, decodedCharacters: 5, decodedNodes: 1 }],
    [0, { bytes: 1, decodedCharacters: 1, decodedNodes: 1 }],
    [-0, { bytes: 1, decodedCharacters: 1, decodedNodes: 1 }],
    ['', { bytes: 2, decodedCharacters: 2, decodedNodes: 1 }],
    [[], { bytes: 2, decodedCharacters: 2, decodedNodes: 1 }],
    [{}, { bytes: 2, decodedCharacters: 2, decodedNodes: 1 }],
    [[[], {}], { bytes: 7, decodedCharacters: 7, decodedNodes: 3 }],
    [{ a: 1 }, { bytes: 7, decodedCharacters: 7, decodedNodes: 2 }],
    [{ 中: '🎋' }, { bytes: 14, decodedCharacters: 10, decodedNodes: 2 }],
  ] as const)('counts punctuation and value nodes for %j', (value, expected) => {
    expect(measureCanonicalRecord(value)).toEqual(expected);
    expectEquivalent(value);
  });

  test.each([
    '', 'ASCII', '山门长明', '🎋🧙', '\u0000\u0001\b\t\n\f\r\u001f', '"\\/', '\u2028\u2029',
    '\ud800', '\udfff', '\ud800x\udfff', '\ud800\ud800\udfff', '\udfff\ud800', '\udfff\udfff',
    '\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff',
  ])('matches exact JSON escaping for values and keys %j', (value) => {
    expectEquivalent(value);
    expectEquivalent({ [value]: value });
  });

  test('every UTF-16 code unit and all high/low surrogate ranges agree with the old helper', () => {
    const units = Array.from({ length: 65_536 }, (_, index) => String.fromCharCode(index)).join('');
    const pairs = Array.from({ length: 1024 }, (_, index) => String.fromCharCode(0xd800 + index, 0xdc00 + index)).join('');
    for (const text of [units, pairs, `${units}${pairs}\udfff\ud800`]) {
      expectEquivalent(text);
      expectEquivalent({ [text]: [text, null] });
    }
  });

  test.each([
    0, -0, 1, -1, 0.1, -0.1, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e-7, 1e-6, 1e-5,
    1e20, 1e21, 1e22, -1e-7, -1e-6, -1e20, -1e21, 1.2345678901234567, 1000000000000000100,
  ])('uses the finite JSON number spelling for %s', (value) => { expectEquivalent(value); });

  test('nested objects, numeric keys, escaped keys, and insertion order have identical accounting', () => {
    const child = { 中文: ['\ud800', 0, -0, Number.MAX_SAFE_INTEGER, 1e-8, 1e21, Number.MIN_VALUE, true, false, null] };
    const value = { z: child, '\u0000"\\': child, '10': 'ten', '2': 'two', a: [[], {}, '\ud83c\udf8b'] };
    expectEquivalent(value);
    expectEquivalent(JSON.parse('{"__proto__":{"constructor":"data"},"toString":"ordinary"}'));
    expect(measureCanonicalRecord({ b: 1, a: 2 })).toEqual(measureCanonicalRecord({ a: 2, b: 1 }));
  });

  test('shared subtrees contribute every value occurrence, never just unique identities', () => {
    const child = Object.freeze({ leaf: true });
    const array = Object.freeze([child, child]);
    const value = Object.freeze({ a: array, b: array });
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(value)).toEqual(measureProgressionRecordBeforeCounter(value));
    expect(counter.measure(value).decodedNodes).toBe(11);
    expect(counter.stats().cacheHits).toBeGreaterThan(0);
    expectEquivalent({ a: child, b: child });
    expect(measureCanonicalRecord({ a: child, b: child }).decodedNodes).toBe(5);
  });

  test('representative World and history records remain exactly equivalent', () => {
    expectEquivalent(createWorld('canonical-records-中文🌲\ud800'));
    let history = createHistoryArchive();
    for (let index = 1; index <= 257; index += 1) history = appendArchivedEvent(history, {
      eventId: `event:${index}`, tick: index, rootActionId: 'action:1', parentEventId: null,
      kind: 'production.blocked', payload: { transactionId: 'instance:1', reason: 'PATH_BLOCKED' },
    });
    expectEquivalent(history);
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(history)).toEqual(measureProgressionRecordBeforeCounter(history));
    const first = counter.stats();
    const next = appendArchivedEvent(history, {
      eventId: 'event:258', tick: 258, rootActionId: 'action:1', parentEventId: null,
      kind: 'production.blocked', payload: { transactionId: 'instance:1', reason: 'PATH_BLOCKED' },
    });
    expect(counter.measure(next)).toEqual(measureProgressionRecordBeforeCounter(next));
    expect(counter.stats().visitedObjects - first.visitedObjects).toBeLessThan(20);
    const imported = cloneJson(history);
    expect(counter.measure(imported)).toEqual(measureProgressionRecordBeforeCounter(imported));
    (imported.strings as string[]).push('new中文\ud800');
    expect(counter.measure(imported)).toEqual(measureProgressionRecordBeforeCounter(imported));
  });

  test('does not serialize containers or call toJSON', () => {
    let calls = 0;
    const value = { toJSON: () => { calls += 1; return 'forged'; } };
    expect(() => measureCanonicalRecord(value)).toThrow(TypeError);
    expect(calls).toBe(0);
  });
});

describe('authenticated canonical record reuse', () => {
  test('fresh mutable input and shallow-frozen descendants are always remeasured', () => {
    const counter = createCanonicalRecordCounter();
    const child = { text: 'short', bytes: 0, decodedCharacters: 0, decodedNodes: 0, immutable: true };
    const shallow = Object.freeze({ children: Object.freeze([child]) });
    expect(counter.measure(shallow)).toEqual(measureProgressionRecordBeforeCounter(shallow));
    child.text = 'longer中文\ud800'; child.bytes = 1;
    expect(counter.measure(shallow)).toEqual(measureProgressionRecordBeforeCounter(shallow));
    expect(counter.stats().cacheHits).toBe(0);
    expect(Object.isFrozen(child)).toBe(false);
    const mutable = { value: 1 }; counter.measure(mutable); mutable.value = 100_000;
    expect(counter.measure(mutable)).toEqual(measureProgressionRecordBeforeCounter(mutable));
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  test('authenticates every frozen descendant and returns detached size and stats records', () => {
    const child = Object.freeze({ text: 'safe' });
    const parent = Object.freeze({ child, values: Object.freeze([child, '\ud800']) });
    const counter = createCanonicalRecordCounter();
    const expected = measureProgressionRecordBeforeCounter(parent);
    const returned = counter.measure(parent);
    expect(returned).toEqual(expected);
    const first = counter.stats();
    returned.bytes = 0; returned.decodedCharacters = 0; returned.decodedNodes = 0;
    counter.stats().visitedObjects = 0;
    expect(counter.measure(parent)).toEqual(expected);
    expect(counter.stats().visitedObjects).toBe(first.visitedObjects);
    expect(counter.stats().cacheHits).toBe(first.cacheHits + 1);
    expect(Object.keys(parent)).toEqual(['child', 'values']);
    const independent = createCanonicalRecordCounter();
    independent.measure(parent);
    expect(independent.stats().visitedObjects).toBe(first.visitedObjects);
  });

  test('freezing the final mutable descendant permits reuse only after a fresh inspection', () => {
    const child = { value: 'small' }; const parent = Object.freeze({ child });
    const counter = createCanonicalRecordCounter();
    counter.measure(parent);
    child.value = 'larger中文'; Object.freeze(child);
    expect(counter.measure(parent)).toEqual(measureProgressionRecordBeforeCounter(parent));
    const inspected = counter.stats();
    expect(inspected.visitedObjects).toBe(4);
    expect(counter.measure(parent)).toEqual(measureProgressionRecordBeforeCounter(parent));
    expect(counter.stats()).toEqual({ visitedObjects: 4, cacheHits: inspected.cacheHits + 1 });
  });

  test('does not cache an extensible snapshot when a descriptor trap adds a fixed key and then closes the object', () => {
    const target = Object.defineProperty({}, 'a', { value: 1, enumerable: true, configurable: false, writable: false });
    let gets = 0;
    const proxy = new Proxy(target, {
      get: () => { gets += 1; throw new Error('ordinary property read'); },
      getOwnPropertyDescriptor: (value, key) => {
        if (key === 'a' && Object.isExtensible(value)) {
          Object.defineProperty(value, 'b', { value: 'new', enumerable: true, configurable: false, writable: false });
          Object.preventExtensions(value);
        }
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(proxy)).toEqual(measureProgressionRecordBeforeCounter({ a: 1 }));
    expect(Object.isFrozen(target)).toBe(true);
    expect(counter.stats()).toEqual({ visitedObjects: 1, cacheHits: 0 });
    expect(counter.measure(proxy)).toEqual(measureProgressionRecordBeforeCounter({ a: 1, b: 'new' }));
    expect(counter.stats()).toEqual({ visitedObjects: 2, cacheHits: 0 });
    expect(counter.measure(proxy)).toEqual(measureProgressionRecordBeforeCounter({ a: 1, b: 'new' }));
    expect(counter.stats()).toEqual({ visitedObjects: 2, cacheHits: 1 });
    expect(gets).toBe(0);
  });

  test('keeps the caller descriptors, values and extensibility unchanged', () => {
    const child = { x: 1 }; const array = [child, '中文']; const value = { array, child };
    Object.preventExtensions(child);
    const before = canonicalStringify(value);
    const descriptors = [Object.getOwnPropertyDescriptors(value), Object.getOwnPropertyDescriptors(array), Object.getOwnPropertyDescriptors(child)];
    const counter = createCanonicalRecordCounter();
    counter.measure(value); counter.measure(value);
    expect(canonicalStringify(value)).toBe(before);
    expect([Object.getOwnPropertyDescriptors(value), Object.getOwnPropertyDescriptors(array), Object.getOwnPropertyDescriptors(child)]).toEqual(descriptors);
    expect(Object.isExtensible(value)).toBe(true);
    expect(Object.isExtensible(array)).toBe(true);
    expect(Object.isFrozen(child)).toBe(false);
    expect(counter.stats().cacheHits).toBe(0);
  });

  test('handles exact safe-integer totals and rejects compressed DAG overflow without giant allocation', () => {
    let shared: unknown = 0;
    for (let depth = 0; depth < 51; depth += 1) shared = Object.freeze([shared, shared]);
    const counter = createCanonicalRecordCounter();
    // Binary DAG B(n) = 2 * B(n - 1) + 3; N(n) = 2 * N(n - 1) + 1.
    expect(counter.measure(shared)).toEqual({
      bytes: Number.MAX_SAFE_INTEGER - 2, decodedCharacters: Number.MAX_SAFE_INTEGER - 2, decodedNodes: 2 ** 52 - 1,
    });
    const limit = Object.freeze([shared]);
    expect(counter.measure(limit)).toEqual({
      bytes: Number.MAX_SAFE_INTEGER, decodedCharacters: Number.MAX_SAFE_INTEGER, decodedNodes: 2 ** 52,
    });
    expect(() => counter.measure(Object.freeze([limit]))).toThrow(RangeError);
    expect(() => counter.measure(Object.freeze({ x: shared }))).toThrow(RangeError);
    expect(() => counter.measure(Object.freeze([shared, shared]))).toThrow(RangeError);
    expect(counter.stats().visitedObjects).toBeLessThan(60);
    expect(counter.measure(limit).bytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('descriptor-only input boundary', () => {
  test('rejects non-JSON values and exotic prototypes', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1, new Date(0), new Map(), new Set(),
      /x/, new Number(1), new String('x'), new Boolean(false), new Uint8Array([1]), Object.create(null),
      Object.create({ inherited: 1 }), Object.setPrototypeOf([], {})]) {
      expect(() => measureCanonicalRecord(value)).toThrow(TypeError);
    }
  });

  test('rejects accessors, hidden and symbol properties without executing getters', () => {
    let reads = 0;
    const getter = () => { reads += 1; throw new Error('getter must not run'); };
    const accessor = Object.freeze(Object.defineProperty({}, 'changing', { enumerable: true, get: getter }));
    const arrayAccessor = Object.defineProperty([1], '0', { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
    const hiddenArrayIndex = Object.defineProperty([1], '0', { enumerable: false, value: 1 });
    const symbolObject = { [Symbol('private')]: 1 };
    const symbolArray = Object.defineProperty([], Symbol('private'), { value: 1 });
    const customArray = Object.defineProperty([1], 'map', { get: getter });
    const inherited = Object.create(Object.defineProperty({}, 'inherited', { get: getter }));
    for (const value of [accessor, { nested: accessor }, arrayAccessor, hidden, hiddenArrayIndex, symbolObject, symbolArray, customArray, inherited]) {
      expect(() => measureCanonicalRecord(value)).toThrow(TypeError);
    }
    expect(reads).toBe(0);
  });

  test('rejects non-enumerable array elements rather than preserving the old inconsistent node total', () => {
    // JSON parsing and ordinary domain construction cannot produce this descriptor
    // shape. The old helper serialized the element but Object.values omitted it.
    const hidden = Object.defineProperty(['hidden'], '0', { enumerable: false });
    expect(measureProgressionRecordBeforeCounter(hidden)).toEqual({ bytes: 10, decodedCharacters: 10, decodedNodes: 1 });
    expect(() => measureCanonicalRecord(hidden)).toThrow(TypeError);
    expect(() => measureProgressionRecord(hidden)).toThrow(TypeError);
    const ordinary: unknown = JSON.parse(canonicalStringify(hidden));
    expectEquivalent(ordinary);
    expect(measureCanonicalRecord(ordinary).decodedNodes).toBe(2);
  });

  test('rejects sparse and custom arrays, including hostile oversized length descriptors', () => {
    const deleted = [0, 1]; delete deleted[0];
    for (const value of [new Array(1), new Array(0xffff_ffff), deleted,
      Object.assign([], { extra: 1 }), Object.assign([1], { '01': 1 }), Object.assign([1], { '-0': 1 }),
      Object.assign([1], { '4294967295': 1 }),
      new Proxy([], { getOwnPropertyDescriptor: (target, key) => key === 'length'
        ? { value: Number.MAX_SAFE_INTEGER, writable: true, enumerable: false, configurable: false }
        : Reflect.getOwnPropertyDescriptor(target, key) })]) {
      expect(() => measureCanonicalRecord(value)).toThrow(TypeError);
    }
  });

  test('rejects direct, indirect, array and frozen cycles without poisoning future measurements', () => {
    const object: { self?: unknown } = {}; object.self = object;
    const array: unknown[] = []; array.push(array);
    const indirect: { child?: unknown } = {}; indirect.child = { parent: indirect };
    const frozen: { self?: unknown } = {}; frozen.self = frozen; Object.freeze(frozen);
    const counter = createCanonicalRecordCounter();
    for (const value of [object, array, indirect, frozen]) expect(() => counter.measure(value)).toThrow(/Cyclic/);
    delete object.self;
    expect(counter.measure(object)).toEqual({ bytes: 2, decodedCharacters: 2, decodedNodes: 1 });
  });

  test('does not invoke ordinary get traps, including array length or traversal methods', () => {
    let gets = 0;
    const handler = { get: () => { gets += 1; throw new Error('ordinary property read'); } };
    const child = new Proxy({ text: '中文\ud800' }, handler);
    const array = new Proxy([child, 1], handler);
    const root = new Proxy({ array, child }, handler);
    const plainChild = { text: '中文\ud800' };
    expect(measureCanonicalRecord(root)).toEqual(measureProgressionRecordBeforeCounter({ array: [plainChild, 1], child: plainChild }));
    expect(gets).toBe(0);
    const fixed = new Proxy(Object.freeze([Object.freeze({ value: 1 })]), handler);
    const counter = createCanonicalRecordCounter();
    counter.measure(fixed); const before = counter.stats(); counter.measure(fixed);
    expect(counter.stats()).toEqual({ visitedObjects: before.visitedObjects, cacheHits: before.cacheHits + 1 });
    expect(gets).toBe(0);
  });

  test('reflection failures propagate; proxy accessors and revoked proxies fail without ordinary reads', () => {
    let gets = 0;
    const getter = () => { gets += 1; return 1; };
    const accessor = new Proxy({ value: 1 }, {
      get: getter,
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, get: getter }),
    });
    const failure = new Error('reflection failed');
    const broken = new Proxy({}, { ownKeys: () => { throw failure; } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(() => measureCanonicalRecord(accessor)).toThrow(TypeError);
    expect(() => measureCanonicalRecord(broken)).toThrow(failure);
    expect(() => measureCanonicalRecord(revoked.proxy)).toThrow(TypeError);
    expect(gets).toBe(0);
  });

  test('rejects directly revoked proxies even on cache hits, without claiming recursive live validation', () => {
    const direct = Proxy.revocable(Object.freeze({ value: 1 }), {});
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(direct.proxy)).toEqual(measureProgressionRecordBeforeCounter({ value: 1 }));
    direct.revoke();
    expect(() => counter.measure(direct.proxy)).toThrow(TypeError);
    expect(() => createCanonicalRecordCounter().measure(direct.proxy)).toThrow(TypeError);
    expect(() => measureProgressionRecordBeforeCounter(direct.proxy)).toThrow(TypeError);

    const nested = Proxy.revocable(Object.freeze({ value: 1 }), {});
    const root = Object.freeze({ nested: nested.proxy });
    const expected = measureProgressionRecordBeforeCounter(root);
    expect(counter.measure(root)).toEqual(expected);
    nested.revoke();
    // The ordinary root's authenticated count remains a sizing snapshot. Looking
    // through it again (a fresh counter or the old live second walk) must reject.
    expect(counter.measure(root)).toEqual(expected);
    expect(() => createCanonicalRecordCounter().measure(root)).toThrow(TypeError);
    expect(() => measureProgressionRecordBeforeCounter(root)).toThrow(TypeError);
  });

  test.each(['object', 'array'] as const)('captures %s siblings before descending into a reentrant proxy', (kind) => {
    let gets = 0;
    let root: object;
    const key = kind === 'array' ? '1' : 'later';
    const probe = new Proxy({}, { ownKeys: (target) => {
      Object.defineProperty(root, key, { enumerable: true, configurable: true, get: () => { gets += 1; return 'forged'; } });
      return Reflect.ownKeys(target);
    } });
    root = kind === 'array' ? [probe, 'snapshot'] : { first: probe, later: 'snapshot' };
    const expected = kind === 'array' ? [{}, 'snapshot'] : { first: {}, later: 'snapshot' };
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(root)).toEqual(measureProgressionRecordBeforeCounter(expected));
    expect(() => counter.measure(root)).toThrow(TypeError);
    expect(gets).toBe(0);
    expect(counter.stats().cacheHits).toBe(0);
  });

  test.each(['object', 'array'] as const)('rejects a %s descriptor replaced by an accessor before capture', (kind) => {
    let gets = 0;
    const target = kind === 'array' ? [1, 2] : { first: 1, later: 2 };
    const first = kind === 'array' ? '0' : 'first';
    const later = kind === 'array' ? '1' : 'later';
    const proxy = new Proxy(target, { getOwnPropertyDescriptor: (value, key) => {
      if (key === first) Object.defineProperty(value, later, {
        enumerable: true, configurable: true, get: () => { gets += 1; return 2; },
      });
      return Reflect.getOwnPropertyDescriptor(value, key);
    } });
    expect(() => measureCanonicalRecord(proxy)).toThrow(TypeError);
    expect(gets).toBe(0);
  });

  test('never retroactively authenticates a mutable child frozen by a later reflection trap', () => {
    const child = { text: 'before' };
    const probe = new Proxy(Object.freeze({}), { ownKeys: (target) => {
      child.text = 'after-and-larger中文'; Object.freeze(child);
      return Reflect.ownKeys(target);
    } });
    const root = Object.freeze({ child, probe });
    const counter = createCanonicalRecordCounter();
    expect(counter.measure(root)).toEqual(measureProgressionRecordBeforeCounter({ child: { text: 'before' }, probe: {} }));
    const first = counter.stats();
    expect(counter.measure(root)).toEqual(measureProgressionRecordBeforeCounter({ child: { text: 'after-and-larger中文' }, probe: {} }));
    expect(counter.stats().visitedObjects - first.visitedObjects).toBe(2);
    const authenticated = counter.stats();
    counter.measure(root);
    expect(counter.stats().visitedObjects).toBe(authenticated.visitedObjects);
  });
});
