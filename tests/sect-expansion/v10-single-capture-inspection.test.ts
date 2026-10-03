import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as history from '../../src/core/history';
import * as kernel from '../../src/core/kernel';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import * as validation from '../../src/core/kernel/validation';
import { captureV10RecordInspection, inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { measureWorldSaveBytes } from '../../src/core/save-budget/envelope';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 } from '../../src/core/world/management-capacity-v10';
import * as captures from '../../src/core/world/v10-frozen-record-capture';
import * as lifecycle from '../../src/core/world/v10-lifecycle-records';
import * as sectRecords from '../../src/core/world/v10-sect-records';

// The runtime surface assertion below cannot detect an erased type export.
// @ts-expect-error The new handle type must remain absent from the kernel barrel.
type UnexportedInspectionHandle = import('../../src/core/kernel').V10RecordInspection;

function allFrozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(allFrozen);
}
let origin: WorldStateV10;
beforeAll(() => { origin = createUnregisteredWorldV10('v10-single-capture'); });
const fresh = (): WorldStateV10 => cloneJson(origin);
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const candidate = prepareUnregisteredCommandCandidateV10(world, command);
  expect(candidate.result.status).toBe('accepted'); return candidate.world;
}
/** Test-only reproduction of the former capacity composition: one immutable
 * capture for measurement, then the standalone root's SECOND complete capture.
 * Both paths retain every real validator and capacity calculation. */
function doubleCaptureAssessment(world: WorldStateV10): ReturnType<typeof assessManagementCapacityV10> {
  const factory = vi.spyOn(validation, 'captureV10RecordInspection').mockImplementationOnce(input => {
    const data = captures.captureFrozenV10RecordData(input);
    return Object.freeze({ data, inspect: () => inspectUnregisteredWorldV10Records(data) });
  });
  try {
    const result = assessManagementCapacityV10(world);
    expect(factory).toHaveBeenCalledTimes(1); return result;
  }
  finally { factory.mockRestore(); }
}

describe('fixed v10 captured-record inspection lifetime', () => {
  it('preserves every prior validation barrel export without exposing the new factory', () => {
    const existing = ['validateWorldState', 'validateLegacyWorldStateV1', 'validateLegacyWorldStateV2',
      'validateLegacyWorldStateV3', 'validateLegacyWorldStateV4', 'validateLegacyWorldStateV5',
      'validateLegacyWorldStateV6', 'validateLegacyWorldStateV7', 'validateWorldStateV8',
      'inspectUnregisteredWorldV9Records', 'inspectUnregisteredWorldV10Records', 'isWorldState'] as const;
    expect(Object.keys(validation).filter(name => name !== 'captureV10RecordInspection').sort()).toEqual([...existing].sort());
    for (const name of existing) expect(kernel[name]).toBe(validation[name]);
    expect(Object.hasOwn(kernel, 'captureV10RecordInspection')).toBe(false);
    expect(Object.hasOwn(kernel, 'V10RecordInspection')).toBe(false);
  });
  it('exposes only a deeply frozen detached data tree and a frozen handle', () => {
    const source = fresh(); const before = canonicalStringify(source);
    const inspection = captureV10RecordInspection(source); const data = inspection.data as WorldStateV10;
    expect(Object.keys(inspection).sort()).toEqual(['data', 'inspect']);
    expect(Object.isFrozen(inspection)).toBe(true); expect(allFrozen(data)).toBe(true);
    expect(data).toEqual(source); expect(data).not.toBe(source);
    expect(data.clock).not.toBe(source.clock); expect(data.disciples[0]!.position).not.toBe(source.disciples[0]!.position);
    expect(() => { data.clock.speed = 3; }).toThrow();
    expect(() => { data.disciples[0]!.position.x++; }).toThrow();
    expect(() => Object.defineProperty(inspection, 'data', { value: source })).toThrow();
    expect(() => Object.defineProperty(inspection, 'inspect', { value: () => [] })).toThrow();
    expect(inspection.inspect()).toEqual([]); expect(canonicalStringify(source)).toBe(before);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.clock)).toBe(false);
  });
  it('binds inspection lexically, ignoring foreign this, arguments and forged handles', () => {
    const source = fresh(); source.clock.calendarTick = 1;
    const inspection = captureV10RecordInspection(source);
    const forged = { data: origin, inspect: () => [] };
    const detachedInspect = inspection.inspect;
    expect(detachedInspect()).toEqual(['Invalid clock']);
    expect(Reflect.apply(detachedInspect, forged, [origin, true, () => []])).toEqual(['Invalid clock']);
    expect(inspectUnregisteredWorldV10Records(forged)).toEqual(['Invalid internal v10 records']);
    expect(assessManagementCapacityV10(forged as unknown as WorldStateV10)).toMatchObject({ supported: false, fits: false });
  });
  it('keeps the captured boundary stable while fresh captures observe later mutations', () => {
    const source = Object.freeze(fresh()); const inspection = captureV10RecordInspection(source);
    expect(Object.isFrozen(source.clock)).toBe(false);
    source.clock.calendarTick = 1;
    expect(inspection.inspect()).toEqual([]);
    expect(captureV10RecordInspection(source).inspect()).toEqual(['Invalid clock']);
    expect(inspectUnregisteredWorldV10Records(source)).toEqual(['Invalid clock']);
    expect(Object.isFrozen(source.clock)).toBe(false);
  });
  it('never revisits a caller getter introduced after capture', () => {
    const source = fresh(); const inspection = captureV10RecordInspection(source); let reads = 0;
    Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } });
    expect(inspection.inspect()).toEqual([]);
    expect(() => captureV10RecordInspection(source)).toThrow();
    expect(inspectUnregisteredWorldV10Records(source)).toEqual(['Invalid internal v10 records']);
    expect(reads).toBe(0);
  });
  it('retains no external Proxy after full descriptor capture', () => {
    const source = fresh(); const proxy = Proxy.revocable(source.clock, {});
    const inspection = captureV10RecordInspection({ ...source, clock: proxy.proxy }); proxy.revoke();
    expect(inspection.inspect()).toEqual([]);
    expect(inspectUnregisteredWorldV10Records({ ...source, clock: proxy.proxy })).toEqual(['Invalid internal v10 records']);
  });
  it('reruns archive, lifecycle and owner validation with exact same-source evidence each time', () => {
    const inspection = captureV10RecordInspection(fresh());
    // These spies forward the real implementations, without substituting results.
    const capture = vi.spyOn(captures, 'captureFrozenV10RecordData');
    const restore = vi.spyOn(history, 'restoreHistoryArchive');
    const life = vi.spyOn(lifecycle, 'inspectV10LifecycleRecords');
    const closure = vi.spyOn(sectRecords, 'inspectV10SectOwnerClosure');
    const first = inspection.inspect(); first.push('caller changed diagnostics');
    const second = inspection.inspect();
    expect(second).toEqual([]); expect(second).not.toBe(first); expect(capture).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(2); expect(life).toHaveBeenCalledTimes(2); expect(closure).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(closure.mock.calls[index]![0]).toBe(life.mock.calls[index]![0]);
      expect(closure.mock.calls[index]![2]).toBe(life.mock.results[index]!.value);
    }
    const invalid = captureV10RecordInspection(null); const issues = invalid.inspect(); issues[0] = 'forged';
    expect(invalid.inspect()).toEqual(['Invalid internal v10 root fields']);
  });
  it('always recaptures standalone inputs, including a prior deeply frozen capture', () => {
    const input = captures.captureFrozenV10RecordData(fresh());
    const capture = vi.spyOn(captures, 'captureFrozenV10RecordData');
    expect(inspectUnregisteredWorldV10Records(input)).toEqual([]);
    expect(inspectUnregisteredWorldV10Records(input)).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(2);
    const first = capture.mock.results[0]!.value as WorldStateV10;
    const second = capture.mock.results[1]!.value as WorldStateV10;
    expect(first).not.toBe(input); expect(second).not.toBe(input); expect(first).not.toBe(second);
    expect(first.map).not.toBe(second.map); expect(first).toEqual(second);
    const mutable = sectRecords.captureV10RecordData(input) as WorldStateV10;
    mutable.clock.speed = 3; expect(Object.isFrozen(mutable.clock)).toBe(false);
    expect((input as WorldStateV10).clock.speed).toBe(1);
  });
});

describe('unchanged bounded descriptor and error boundaries', () => {
  const malformed: [string, () => unknown][] = [
    ['accessor', () => Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('Must not run'); } }))],
    ['toJSON', () => ({ toJSON() { return {}; } })],
    ['alias', () => { const child = Object.freeze({ value: 1 }); return { a: child, b: child }; }],
    ['cycle', () => { const data: Record<string, unknown> = {}; data.self = data; return data; }],
    ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { value: 1 })],
    ['null prototype', () => Object.create(null)],
    ['symbol', () => ({ [Symbol('hidden')]: 1 })],
    ['hidden field', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['hidden array index', () => Object.defineProperty([1], '0', { value: 1, enumerable: false })],
    ['sparse array', () => new Array(2)],
    ['oversized array declaration', () => new Array(SAVE_FILE_LIMIT_BYTES + 1)],
    ['excessive depth', () => JSON.parse(`${'['.repeat(130)}0${']'.repeat(130)}`) as unknown],
    ['excessive bytes', () => ({ text: 'x'.repeat(SAVE_FILE_LIMIT_BYTES) })],
    ['nonfinite value', () => ({ value: Infinity })],
  ];
  it.each(malformed)('retains the complete capture rejection for %s', (_name, make) => {
    const input = make();
    expect(() => captures.captureFrozenV10RecordData(input)).toThrow();
    expect(() => captureV10RecordInspection(input)).toThrow();
    expect(inspectUnregisteredWorldV10Records(input)).toEqual(['Invalid internal v10 records']);
  });
  it('does not read a hostile thrown value or execute input getters', () => {
    let reads = 0; const getter = (): never => { reads++; throw new Error('Do not read'); };
    const thrown = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const proxy = new Proxy({}, { ownKeys() { throw thrown; } });
    const accessor = Object.defineProperty(fresh(), 'seed', { enumerable: true, get: getter });
    for (const source of [proxy, accessor]) {
      // Do not ask the assertion library to format/inspect the hostile thrown object.
      let refused = false; try { captureV10RecordInspection(source); } catch { refused = true; }
      expect(refused).toBe(true); expect(inspectUnregisteredWorldV10Records(source)).toEqual(['Invalid internal v10 records']);
      expect(assessManagementCapacityV10(source as WorldStateV10)).toMatchObject({ supported: false, fits: false });
    }
    expect(reads).toBe(0);
  });
  it('preserves root, identity and first-domain diagnostics for multiply-invalid data', () => {
    const source = fresh(); source.clock.calendarTick = 1; source.map.width = 0;
    for (const [input, expected] of [
      [null, ['Invalid internal v10 root fields']],
      [{ ...source, extra: true }, ['Invalid internal v10 root fields']],
      [{ ...source, simulationVersion: '0.9.0' }, ['Unsupported world identity/version']],
      [source, ['Invalid clock']],
    ] as const) {
      expect(captureV10RecordInspection(input).inspect()).toEqual(expected);
      expect(inspectUnregisteredWorldV10Records(input)).toEqual(expected);
    }
  });
});

describe('single-capture full capacity composition', () => {
  it('captures once while retaining exact complete assessment parity with the former double capture', () => {
    const source = fresh(); const before = canonicalStringify(source);
    const capture = vi.spyOn(captures, 'captureFrozenV10RecordData');
    const result = assessManagementCapacityV10(source);
    expect(capture).toHaveBeenCalledTimes(1); capture.mockRestore();
    expect(result).toMatchObject({ supported: true, fits: true, actualFits: true, admitted: false, importAuthorized: false });
    expect(result).toEqual(doubleCaptureAssessment(source));
    expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source.clock)).toBe(false);
    result.current.wireBytes = 0; result.sourceRecordIssues.push('forged');
    expect(assessManagementCapacityV10(source)).toEqual(doubleCaptureAssessment(source));
  });
  it('retains invalid-source, identity-first and synthetic reader-pressure assessments', () => {
    const invalid = fresh(); invalid.clock.calendarTick = 1; invalid.map.width = 0;
    const wrongIdentity = { ...invalid, simulationVersion: '0.9.0' } as unknown as WorldStateV10;
    const unownedReservation = fresh(); unownedReservation.inventory.wood.reserved = 1;
    const unearnedStock = fresh();
    unearnedStock.sectExpansion = { ...unearnedStock.sectExpansion, stock: { ...unearnedStock.sectExpansion.stock,
      'wound-powder': { ...unearnedStock.sectExpansion.stock['wound-powder'], owned: 1 } } };
    const pressure = fresh();
    // Deliberately invalid extra build data tests diagnostics, never admitted gameplay.
    (pressure.builds as unknown as Record<string, unknown>).wide = Array(16_385).fill(0);
    for (const source of [invalid, wrongIdentity, unownedReservation, unearnedStock, pressure]) {
      const result = assessManagementCapacityV10(source);
      expect(result).toEqual(doubleCaptureAssessment(source)); expect(result.supported).toBe(false); expect(result.fits).toBe(false);
    }
    expect(assessManagementCapacityV10(invalid).sourceRecordIssues).toEqual(['Invalid clock']);
    expect(assessManagementCapacityV10(wrongIdentity).sourceRecordIssues).toEqual([]);
    expect(assessManagementCapacityV10(wrongIdentity).unknowns).toEqual(['Unsupported bounded v10 capacity source']);
    expect(captureV10RecordInspection(unownedReservation).inspect().length).toBeGreaterThan(0);
    expect(captureV10RecordInspection(unearnedStock).inspect()).toEqual(['V10 zero-genesis stock provenance differs']);
    expect(assessManagementCapacityV10(pressure).deficits.find(value => value.dimension === 'buildArray.builds.wide')?.excess).toBe(1);
  });
  it('preserves preliminary over-cap diagnostics when bounded capture refuses', () => {
    const source = fresh(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    // Synthetic pressure, not a normal gameplay record or save-acceptance claim.
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(source, { saveVersion: 10 }));
    expect(assessManagementCapacityV10(source)).toMatchObject({ measuredEnvelopeBytes: SAVE_FILE_LIMIT_BYTES, actualFits: true, fits: false });
    source.diagnostics[0]!.message += 'x';
    expect(assessManagementCapacityV10(source)).toMatchObject({ measuredEnvelopeBytes: SAVE_FILE_LIMIT_BYTES + 1, actualFits: false, reason: 'wire-cap' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES);
    expect(() => captureV10RecordInspection(source)).toThrow();
    const result = assessManagementCapacityV10(source);
    expect(result).toEqual(doubleCaptureAssessment(source));
    expect(result).toMatchObject({ measuredEnvelopeBytes: measureWorldSaveBytes(source, { saveVersion: 10 }), actualFits: false,
      supported: false, fits: false, reason: 'wire-cap', sourceRecordIssues: [], unknowns: ['Unsupported bounded v10 capacity source'] });
  }, 30000);
  it('still authenticates real cancellation archives and rejects packed-history damage', () => {
    let world = apply(fresh(), { kind: 'production.start', commandId: 'single.start', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    const transactionId = world.activeProductionTransactionIds[0]!;
    world = apply(world, { kind: 'production.cancel', commandId: 'single.cancel', sequence: 1, issuedTick: 0, payload: { transactionId } });
    expect(world.history.production.count).toBe(1); expect(captureV10RecordInspection(world).inspect()).toEqual([]);
    expect(assessManagementCapacityV10(world)).toEqual(doubleCaptureAssessment(world));
    const damaged = cloneJson(world);
    damaged.history = { ...damaged.history, production: { ...damaged.history.production, count: damaged.history.production.count + 1 } };
    expect(captureV10RecordInspection(damaged).inspect()).toEqual(['Invalid history archive']);
    expect(assessManagementCapacityV10(damaged)).toEqual(doubleCaptureAssessment(damaged));
    expect(assessManagementCapacityV10(damaged).supported).toBe(false);
  });
  it('keeps genuine expiry/death inspection and exact-object lifecycle evidence', () => {
    const source = fresh(); const actor = source.disciples.find(member => member.id === 'entity:4')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    // Legal near-expiry initial birthday; no claim of an entire simulated lifetime.
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    const pending = prepareNormalTickCandidateV10(source); const death = pending.cultivation.pendingDeaths[0]!;
    expect(pending.clock.pauseReasons).toContain('cultivation'); expect(captureV10RecordInspection(pending).inspect()).toEqual([]);
    const settled = apply(pending, { kind: 'cultivation.command', commandId: 'single.finalize', sequence: 0, issuedTick: 1,
      payload: { command: { kind: 'death.finalize', commandId: 'single.finalize', expectedRevision: pending.cultivation.revision,
        discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    const inspection = captureV10RecordInspection(settled); const data = inspection.data as WorldStateV10;
    expect(inspection.inspect()).toEqual([]); expect(assessManagementCapacityV10(settled)).toEqual(doubleCaptureAssessment(settled));
    const token = lifecycle.inspectV10LifecycleRecords(data);
    expect(lifecycle.historicalDeathsOfV10LifecycleEvidence(token, data)).toContainEqual(expect.objectContaining({
      discipleId: actor.id, deathId: death.deathId, unavailableTick: 1, diedTick: 1, archived: true }));
    expect(() => lifecycle.historicalDeathsOfV10LifecycleEvidence(token, captureV10RecordInspection(settled).data as WorldStateV10)).toThrow('Unauthenticated');
  });
  it('leaves legacy wrappers and wrong-version rejection unchanged', () => {
    const old = createUnregisteredWorldV9('v10-single-capture-old');
    expect(validation.inspectUnregisteredWorldV9Records(old)).toEqual([]);
    expect(captureV10RecordInspection(old).inspect()).toEqual(['Unsupported world identity/version']);
    expect(validation.validateWorldState(origin)).toEqual(['Legacy World contains reserved v9 fields']);
    expect(validation.validateWorldStateV8(origin)).toEqual(['Legacy World contains reserved v9 fields']);
  });
});
