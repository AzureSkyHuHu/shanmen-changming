import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { canonicalUtf8ByteLength, createCanonicalByteCounter } from '../../src/core/save-budget/canonical-bytes';
import { deriveSectReservationsV10 } from '../../src/core/save-budget/sect-obligations-v10';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { assessManagementCapacityV10 } from '../../src/core/world/management-capacity-v10';
import { captureFrozenV10RecordData } from '../../src/core/world/v10-frozen-record-capture';
import { deriveV10RecordReservations, inspectV10KnownRecordHeadroom } from '../../src/core/world/v10-record-headroom';

const UNSUPPORTED_SECT_SOURCE = ['Unsupported v10 sect sizing source; complete v10 validation is required'];
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

describe('v10 byte preflights reuse only independently authenticated frozen data', () => {
  let origin: WorldStateV10;
  beforeAll(() => { origin = createUnregisteredWorldV10('v10-preflight-cache-reuse'); });
  const fresh = () => cloneJson(origin);

  it('preserves complete derivations for mutable, shallow-frozen and deeply frozen ordinary Worlds', () => {
    const mutable = fresh(); const shallow = Object.freeze(fresh()); const deep = freezeData(fresh());
    const before = canonicalStringify(mutable);
    const expected = deriveV10RecordReservations(mutable); const sect = deriveSectReservationsV10(mutable);
    expect(sect.supported).toBe(true); expect(expected.progression.supported).toBe(true);
    for (const world of [mutable, shallow, deep]) {
      for (let index = 0; index < 3; index++) {
        expect(deriveV10RecordReservations(world)).toEqual(expected);
        expect(deriveSectReservationsV10(world)).toEqual(sect);
        expect(inspectV10KnownRecordHeadroom(world)).toEqual([]);
      }
      expect(canonicalStringify(world)).toBe(before);
    }
    expect(Object.isFrozen(mutable)).toBe(false); expect(Object.isFrozen(mutable.clock)).toBe(false);
    expect(Object.isFrozen(shallow.clock)).toBe(false);
  });

  it('still derives fresh results and cannot be poisoned through returned diagnostics', () => {
    const source = freezeData(fresh());
    const records = deriveV10RecordReservations(source); const expected = cloneJson(records);
    const sect = deriveSectReservationsV10(source); const expectedSect = cloneJson(sect);
    expect(Reflect.set(records, 'sect', null)).toBe(true);
    expect(Reflect.set(sect.totals, 'bytes', 0)).toBe(true);
    const nextRecords = deriveV10RecordReservations(source); const nextSect = deriveSectReservationsV10(source);
    expect(nextRecords).toEqual(expected); expect(nextSect).toEqual(expectedSect);
    expect(nextRecords).not.toBe(records); expect(nextSect).not.toBe(sect);
    expect(nextSect.totals).not.toBe(sect.totals);
  });

  for (const shallow of [false, true]) {
    it(`rechecks nested non-finite corruption after warming a ${shallow ? 'shallow-frozen' : 'mutable'} source`, () => {
      const source = shallow ? Object.freeze(fresh()) : fresh();
      const before = deriveV10RecordReservations(source); expect(deriveSectReservationsV10(source).supported).toBe(true);
      source.clock.calendarTick = NaN;
      expect(() => deriveV10RecordReservations(source)).toThrow('Expected finite data-only JSON');
      expect(deriveSectReservationsV10(source)).toMatchObject({ supported: false, unknowns: UNSUPPORTED_SECT_SOURCE });
      expect(inspectV10KnownRecordHeadroom(source)).toEqual(['Unsupported v10 known-record headroom source']);
      source.clock.calendarTick = 0;
      expect(deriveV10RecordReservations(source)).toEqual(before);
      expect(deriveV10RecordReservations(source)).toEqual(deriveV10RecordReservations(cloneJson(source)));
      expect(Object.isFrozen(source.clock)).toBe(false);
    });

    it(`rejects a new nested getter without invoking it after warming a ${shallow ? 'shallow-frozen' : 'mutable'} source`, () => {
      const source = shallow ? Object.freeze(fresh()) : fresh();
      const before = deriveV10RecordReservations(source); const sect = deriveSectReservationsV10(source); let reads = 0;
      Object.defineProperty(source.clock, 'speed', { enumerable: true, configurable: true, get: () => { reads++; return 1; } });
      expect(() => deriveV10RecordReservations(source)).toThrow('JSON accessors cannot be measured or cached');
      expect(deriveSectReservationsV10(source)).toMatchObject({ supported: false, unknowns: UNSUPPORTED_SECT_SOURCE });
      expect(reads).toBe(0);
      Object.defineProperty(source.clock, 'speed', { enumerable: true, configurable: true, writable: true, value: 1 });
      expect(deriveV10RecordReservations(source)).toEqual(before); expect(deriveSectReservationsV10(source)).toEqual(sect);
      expect(Object.isFrozen(source.clock)).toBe(false);
    });
  }

  it('retains descriptor rejection before identity checks, even after another shared-counter caller warmed the source', () => {
    const source = fresh(); canonicalUtf8ByteLength(source); let reads = 0;
    Object.defineProperty(source, 'runtimeProtocol', { value: 'wrong', enumerable: true, writable: true, configurable: true });
    Object.defineProperty(source.clock, 'speed', { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => deriveV10RecordReservations(source)).toThrow('JSON accessors cannot be measured or cached');
    expect(deriveSectReservationsV10(source)).toMatchObject({ supported: false, unknowns: UNSUPPORTED_SECT_SOURCE });
    expect(reads).toBe(0);
  });

  it.each(['simulationVersion', 'runtimeProtocol', 'contentVersion'] as const)('does not turn cached bytes into identity authority for %s', key => {
    const source = fresh();
    Object.defineProperty(source, key, { value: 'wrong', enumerable: true, writable: true, configurable: true });
    const frozen = captureFrozenV10RecordData(source) as WorldStateV10;
    canonicalUtf8ByteLength(frozen); canonicalUtf8ByteLength(frozen);
    expect(() => deriveV10RecordReservations(frozen)).toThrow('Unsupported v10 record identity');
    expect(deriveSectReservationsV10(frozen)).toMatchObject({ supported: false, unknowns: ['Unsupported internal v10 record identity'] });
    expect(assessManagementCapacityV10(frozen).supported).toBe(false);
  });

  it('does not treat a frozen malformed descriptor tree as an authenticated byte source', () => {
    const source = fresh(); let reads = 0;
    Object.defineProperty(source.clock, 'speed', { enumerable: true, get: () => { reads++; return 1; } });
    Object.freeze(source.clock); Object.freeze(source);
    expect(() => deriveV10RecordReservations(source)).toThrow();
    expect(deriveSectReservationsV10(source)).toMatchObject({ supported: false, unknowns: UNSUPPORTED_SECT_SOURCE });
    expect(reads).toBe(0);
  });

  it('keeps detached capture independent from later caller changes', () => {
    const caller = fresh(); const detached = captureFrozenV10RecordData(caller) as WorldStateV10;
    const records = deriveV10RecordReservations(detached); const sect = deriveSectReservationsV10(detached);
    caller.clock.calendarTick = Infinity;
    expect(() => deriveV10RecordReservations(caller)).toThrow();
    expect(deriveSectReservationsV10(caller).supported).toBe(false);
    expect(deriveV10RecordReservations(detached)).toEqual(records); expect(deriveSectReservationsV10(detached)).toEqual(sect);
    expect(Object.isFrozen(caller)).toBe(false); expect(Object.isFrozen(caller.clock)).toBe(false);
  });

  it('characterizes cached nested-Proxy revocation while full capture/admission still rejects the revoked caller', () => {
    const entry = Proxy.revocable(Object.freeze({ code: 'INVARIANT_FAILURE' as const, tick: 0, message: 'Proxy characterization only' }), {});
    const source = fresh(); source.diagnostics.push(entry.proxy); freezeData(source);
    const bytes = canonicalUtf8ByteLength(source);
    const records = deriveV10RecordReservations(source); const sect = deriveSectReservationsV10(source);
    const detached = captureFrozenV10RecordData(source) as WorldStateV10;
    entry.revoke();
    // These internal structural queries do not revisit nested Proxy traps behind
    // a cached frozen parent. A newly created preflight counter would throw.
    expect(() => createCanonicalByteCounter().measure(source)).toThrow();
    expect(canonicalUtf8ByteLength(source)).toBe(bytes);
    expect(deriveV10RecordReservations(source)).toEqual(records); expect(deriveSectReservationsV10(source)).toEqual(sect);
    expect(() => captureFrozenV10RecordData(source)).toThrow();
    expect(inspectUnregisteredWorldV10Records(source)).toEqual(['Invalid internal v10 records']);
    expect(assessManagementCapacityV10(source)).toMatchObject({ supported: false, fits: false });
    expect(deriveV10RecordReservations(detached)).toEqual(records); expect(deriveSectReservationsV10(detached)).toEqual(sect);
    expect(inspectUnregisteredWorldV10Records(detached)).toEqual([]);
  });
});

describe('existing shared byte-counter retention behavior', () => {
  it('has no permanent saturation after many new frozen inputs and keeps exact identity reuse', () => {
    const counter = createCanonicalByteCounter(); let exact = true;
    for (let index = 0; index < 9000; index++) {
      const value = Object.freeze({ index }); const expected = JSON.stringify(value).length;
      if (counter.measure(value) !== expected || canonicalUtf8ByteLength(value) !== expected) exact = false;
    }
    expect(exact).toBe(true);
    const next = Object.freeze({ text: 'still reusable' });
    const bytes = counter.measure(next); const before = counter.stats();
    expect(counter.measure(next)).toBe(bytes); expect(canonicalUtf8ByteLength(next)).toBe(bytes);
    expect(counter.stats().visitedObjects).toBe(before.visitedObjects);
    expect(counter.stats().cacheHits).toBe(before.cacheHits + 1);
  });
});
