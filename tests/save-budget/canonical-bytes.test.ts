import { describe, expect, test } from 'vitest';
import { appendArchivedEvent, createHistoryArchive } from '../../src/core/history';
import { createSaveEnvelope, serializeSave, SAVE_VERSION } from '../../src/core/kernel/save';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createWorld } from '../../src/core/world/create-world';
import { canonicalUtf8ByteLength, createCanonicalByteCounter, jsonStringByteLength, measureWorldSaveBytes, utf8ByteLength, WORST_SAVE_METADATA } from '../../src/core/save-budget';

const encoded = (value: unknown): number => new TextEncoder().encode(canonicalStringify(value)).byteLength;

describe('canonical UTF-8 byte accounting', () => {
  test.each(['', 'ASCII', '山门长明', '🎋🧙', '\u0000\u0001\b\t\n\f\r\u001f', '"\\/', '\u2028\u2029', '\ud800', '\udfff', '\ud800x\udfff', '\ud800\ud800\udfff'])('matches platform encoding for %j', (value) => {
    expect(jsonStringByteLength(value)).toBe(encoded(value));
    expect(canonicalUtf8ByteLength(value)).toBe(encoded(value));
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
  });

  test('every UTF-16 code unit, valid pairs, and mixed adjacent surrogates match JSON encoding', () => {
    const allUnits = Array.from({ length: 65_536 }, (_, index) => String.fromCharCode(index)).join('');
    const pairs = Array.from({ length: 1024 }, (_, index) => String.fromCharCode(0xd800 + index, 0xdc00 + index)).join('');
    for (const value of [allUnits, pairs, `${allUnits}${pairs}\udfff\ud800`]) {
      expect(jsonStringByteLength(value)).toBe(encoded(value));
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
  });

  test('nested data, escaped keys, numbers, shared references, and ordering agree exactly', () => {
    const child = { 中文: ['\ud800', 0, -0, Number.MAX_SAFE_INTEGER, 1e-8, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, true, false, null] };
    const value = { z: child, '\u0000"\\': child, a: [[], {}, '\ud83c\udf8b'] };
    expect(canonicalUtf8ByteLength(value)).toBe(encoded(value));
    expect(canonicalUtf8ByteLength({ b: 1, a: 2 })).toBe(canonicalUtf8ByteLength({ a: 2, b: 1 }));
  });

  test('rejects unsupported, cyclic, sparse, and accessor data without executing accessors', () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    let reads = 0;
    const accessor = Object.freeze(Object.defineProperty({}, 'changing', { enumerable: true, get: () => { reads += 1; return reads; } }));
    const customArray = Object.freeze(Object.defineProperty([1], 'map', { value: () => ['forged'] }));
    const hiddenMutable = Object.freeze(Object.defineProperty({}, 'hidden', { value: { mutable: true } }));
    for (const value of [undefined, NaN, Infinity, () => 1, new Map(), cyclic, new Array(1), accessor, customArray, hiddenMutable]) {
      expect(() => canonicalUtf8ByteLength(value)).toThrow();
    }
    expect(reads).toBe(0);
  });

  test('never caches mutable input or a shallow-frozen mutable descendant', () => {
    const counter = createCanonicalByteCounter();
    const child = { text: 'short' };
    const shallow = Object.freeze({ child });
    expect(counter.measure(shallow)).toBe(encoded(shallow));
    child.text = 'longer中文\ud800';
    expect(counter.measure(shallow)).toBe(encoded(shallow));
    expect(counter.stats().cacheHits).toBe(0);
    const mutable = { value: 1 }; counter.measure(mutable); mutable.value = 100_000;
    expect(counter.measure(mutable)).toBe(encoded(mutable));
  });

  test('authenticates all descendants before frozen identity reuse', () => {
    const child = Object.freeze({ text: 'safe' });
    const parent = Object.freeze({ child, values: Object.freeze([child, '\ud800']) });
    const counter = createCanonicalByteCounter();
    expect(counter.measure(parent)).toBe(encoded(parent));
    const first = counter.stats();
    expect(counter.measure(parent)).toBe(encoded(parent));
    expect(counter.stats().visitedObjects).toBe(first.visitedObjects);
    expect(counter.stats().cacheHits).toBe(first.cacheHits + 1);
  });

  test('reuses owned frozen history pages, but not a mutable imported copy', () => {
    let history = createHistoryArchive();
    for (let index = 1; index <= 257; index += 1) history = appendArchivedEvent(history, {
      eventId: `event:${index}`, tick: index, rootActionId: 'action:1', parentEventId: null,
      kind: 'production.blocked', payload: { transactionId: 'instance:1', reason: 'PATH_BLOCKED' },
    });
    const counter = createCanonicalByteCounter();
    expect(counter.measure(history)).toBe(encoded(history));
    const first = counter.stats();
    const next = appendArchivedEvent(history, { eventId: 'event:258', tick: 258, rootActionId: 'action:1', parentEventId: null,
      kind: 'production.blocked', payload: { transactionId: 'instance:1', reason: 'PATH_BLOCKED' } });
    expect(counter.measure(next)).toBe(encoded(next));
    expect(counter.stats().visitedObjects - first.visitedObjects).toBeLessThan(20);
    const imported = cloneJson(history);
    expect(counter.measure(imported)).toBe(encoded(imported));
    (imported.strings as string[]).push('different中文');
    expect(counter.measure(imported)).toBe(encoded(imported));
  });
});

describe('World save envelope accounting', () => {
  test('exact bytes equal the real serializer with ordinary and maximum escaping metadata', () => {
    const world = createWorld('预算🌲\ud800');
    for (const metadata of [{ buildId: 'build-1', savedAt: '2026-10-01T00:00:00Z' }, WORST_SAVE_METADATA,
      { buildId: '\ud800'.repeat(128), savedAt: '\u0001'.repeat(64) }]) {
      const text = serializeSave(createSaveEnvelope(world, metadata));
      expect(measureWorldSaveBytes(world, { saveVersion: SAVE_VERSION, metadata })).toBe(new TextEncoder().encode(text).byteLength);
    }
  });

  test('default metadata reserve dominates Unicode, quotes, slash and all legal controls', () => {
    const world = createWorld('metadata-bound');
    const maximum = measureWorldSaveBytes(world);
    for (const unit of ['a', '中', '"', '\\', '\u0000', '\u0001', '\b', '\ud800', '\udfff']) {
      expect(measureWorldSaveBytes(world, { metadata: { buildId: unit.repeat(128), savedAt: unit.repeat(64) } })).toBeLessThanOrEqual(maximum);
    }
    expect(maximum).toBe(measureWorldSaveBytes(world, { saveVersion: 7, metadata: WORST_SAVE_METADATA }));
    expect(measureWorldSaveBytes(world, { saveVersion: 10 })).toBe(maximum + 1);
  });

  test('mutable World changes are not cached and size fields have no special trust', () => {
    const world = { seed: 'test', simulationVersion: '0.7.0', contentVersion: 'starter-0.1.0', savedBytes: 0, custom: 'a' };
    const first = measureWorldSaveBytes(world);
    world.custom += '中'; world.savedBytes = 1;
    expect(measureWorldSaveBytes(world)).toBe(first + 3);
  });

  test('rejects missing identity and invalid metadata, without needing a World validator', () => {
    expect(() => measureWorldSaveBytes({})).toThrow();
    const world = { seed: 'x', simulationVersion: '0.7.0', contentVersion: 'starter-0.1.0' };
    expect(() => measureWorldSaveBytes(world, { metadata: { buildId: '', savedAt: 'x' } })).toThrow();
    expect(() => measureWorldSaveBytes(world, { metadata: { buildId: 'x', savedAt: 'x'.repeat(65) } })).toThrow();
    expect(() => measureWorldSaveBytes(world, { saveVersion: 0 })).toThrow();
  });
});
