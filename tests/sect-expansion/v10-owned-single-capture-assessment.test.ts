import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CULTIVATION_RULES, PERMANENT_TALENT_RULES, REALM_RULES } from '../../src/core/cultivation/rules';
import * as history from '../../src/core/history';
import * as kernel from '../../src/core/kernel';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import * as validation from '../../src/core/kernel/validation';
import * as budget from '../../src/core/save-budget/admission';
import { canonicalUtf8ByteLength } from '../../src/core/save-budget/canonical-bytes';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { restoreWorldHistory } from '../../src/core/world/history-access';
import { assessManagementCapacityV10, captureAndAssessOwnedV10 } from '../../src/core/world/management-capacity-v10';
import * as capacity from '../../src/core/world/management-capacity-v10';
import * as discharge from '../../src/core/world/reserved-discharges-v10';
import { createOwnedTickPipelineV10 } from '../../src/core/world/runtime-owned-ticks-v10';
import * as lifecycle from '../../src/core/world/v10-lifecycle-records';
import * as headroom from '../../src/core/world/v10-record-headroom';
import * as records from '../../src/core/world/v10-sect-records';

// @ts-expect-error The new internal result type must not become kernel API.
type UnexportedOwnedAssessment = import('../../src/core/kernel').CapturedOwnedAssessmentV10;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function allFrozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(allFrozen);
}
/** The former owned leaf's complete capture/restore/freeze/assessment sequence. */
function former(input: unknown) {
  const world = freeze(restoreWorldHistory(records.captureV10RecordData(input) as WorldStateV10));
  return { world, assessment: assessManagementCapacityV10(world) };
}
let origin: WorldStateV10;
beforeAll(() => { origin = createUnregisteredWorldV10('owned-single-capture'); });
const fresh = (): WorldStateV10 => cloneJson(origin);
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(result.result.status).toBe('accepted'); return result.world;
}
function compare(input: WorldStateV10): void {
  const before = canonicalStringify(input); const expected = former(input); const actual = captureAndAssessOwnedV10(input);
  expect(actual.world).toEqual(expected.world); expect(actual.assessment).toEqual(expected.assessment);
  expect(actual.assessment).toEqual(assessManagementCapacityV10(input)); expect(allFrozen(actual)).toBe(true);
  expect(canonicalStringify(input)).toBe(before);
}

describe('owned capture, archive authentication and complete assessment share one data tree', () => {
  it('uses one fresh descriptor capture and measures/inspects that same restored data', () => {
    const source = fresh(); const capture = vi.spyOn(records, 'captureV10RecordData');
    const restored = vi.spyOn(history, 'restoreHistoryArchive');
    const inspect = vi.spyOn(lifecycle, 'inspectV10LifecycleRecords');
    const automatic = vi.spyOn(budget, 'assessAutomaticWorkBudget');
    const reserves = vi.spyOn(headroom, 'deriveV10RecordReservations');
    const standalone = vi.spyOn(validation, 'captureV10RecordInspection');
    try {
      const result = captureAndAssessOwnedV10(source);
      expect(result.assessment.fits).toBe(true); expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(source); expect(standalone).not.toHaveBeenCalled();
      expect(automatic).toHaveBeenCalledTimes(1); expect(automatic.mock.calls[0]![0].world).toBe(result.world);
      expect(inspect).toHaveBeenCalledTimes(1);
      // The validator retains its existing exact-source lifecycle wrapper. Its
      // archive and every actual captured branch are the assessment's branches.
      const inspected = inspect.mock.calls[0]![0];
      expect(inspected.history).toBe(result.world.history); expect(inspected.cultivation).toBe(result.world.cultivation);
      expect(inspected.sectExpansion).toBe(result.world.sectExpansion);
      expect(reserves).toHaveBeenCalledTimes(1); expect(reserves.mock.calls[0]![0]).toBe(result.world);
      expect(reserves.mock.calls.every(([world]) => world.history === result.world.history)).toBe(true);
      // The first restore authenticates the detached foreign archive. Subsequent
      // restores get exactly that authenticated object, rather than another copy.
      expect(restored.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(restored.mock.calls.filter(([value]) => value !== result.world.history)).toHaveLength(1);
      expect(restored.mock.results.every(value => value.type === 'return' && value.value === result.world.history)).toBe(true);
      expect(history.restoreHistoryArchive(result.world.history)).toBe(result.world.history);
      expect(history.restoreHistoryArchive(source.history)).not.toBe(source.history);
    } finally {
      capture.mockRestore(); restored.mockRestore(); inspect.mockRestore(); automatic.mockRestore(); reserves.mockRestore(); standalone.mockRestore();
    }
  });
  it('keeps fresh immutable pairs isolated from callers and from earlier captures', () => {
    const source = fresh(); const first = captureAndAssessOwnedV10(source); const second = captureAndAssessOwnedV10(first.world);
    expect(first).not.toBe(second); expect(first.world.map).not.toBe(second.world.map);
    expect(first.world.history).not.toBe(second.world.history); expect(first.assessment).not.toBe(second.assessment);
    expect(first.world).toEqual(second.world); expect(first.assessment).toEqual(second.assessment);
    expect(allFrozen(first)).toBe(true); expect(allFrozen(second)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.history)).toBe(false);
    source.clock.calendarTick = 1;
    expect(first.world.clock.calendarTick).toBe(0); expect(first.assessment.supported).toBe(true);
    expect(captureAndAssessOwnedV10(source).assessment.sourceRecordIssues).toEqual(['Invalid clock']);
    expect(() => { first.world.inventory.wood.owned++; }).toThrow();
    expect(() => { first.assessment.current.wireBytes = 0; }).toThrow();
    expect(() => { first.assessment.sourceRecordIssues.push('forged'); }).toThrow();
  });
  it('rechecks every restored inspection and never accepts arguments or a foreign handle as authority', () => {
    const source = fresh(); const inspection = validation.captureRestoredV10RecordInspection(source);
    expect(Object.keys(inspection).sort()).toEqual(['data', 'inspect']); expect(allFrozen(inspection.data)).toBe(true);
    const check = vi.spyOn(lifecycle, 'inspectV10LifecycleRecords');
    try {
      expect(inspection.inspect()).toEqual([]);
      expect(Reflect.apply(inspection.inspect, { data: null }, [{ data: null }, () => []])).toEqual([]);
      expect(check).toHaveBeenCalledTimes(2);
    } finally { check.mockRestore(); }
    const malformed = fresh(); malformed.clock.calendarTick = 1;
    const failed = validation.captureRestoredV10RecordInspection(malformed); const issues = failed.inspect(); issues[0] = 'forged';
    expect(failed.inspect()).toEqual(['Invalid clock']);
    expect(() => captureAndAssessOwnedV10({ world: inspection.data, assessment: { fits: true } })).toThrow();
    for (const name of ['captureRestoredV10RecordInspection', 'captureAndAssessOwnedV10', 'CapturedOwnedAssessmentV10']) {
      expect(Object.hasOwn(kernel, name)).toBe(false);
    }
    for (const name of ['assessInspection', 'frozenDiagnosticCopy', 'createAssessmentResult']) expect(Object.hasOwn(capacity, name)).toBe(false);
  });
  it('does not freeze mutable rule registries or borrowed diagnostic arrays', () => {
    const values = [CULTIVATION_RULES, CULTIVATION_RULES.success, REALM_RULES, REALM_RULES.mortal, REALM_RULES.mortal.costs,
      PERMANENT_TALENT_RULES, PERMANENT_TALENT_RULES['cultivation.steady-breath']];
    const frozenBefore = values.map(Object.isFrozen); const borrowed = ['borrowed fixed diagnostic'];
    const actual = headroom.deriveV10RecordReservations;
    const derive = vi.spyOn(headroom, 'deriveV10RecordReservations').mockImplementation(world => {
      const result = actual(world); return { ...result, progression: { ...result.progression, excluded: borrowed } };
    });
    try {
      const source = fresh(); const result = captureAndAssessOwnedV10(source);
      expect(result.assessment.progression!.excluded).toEqual(borrowed);
      expect(result.assessment.progression!.excluded).not.toBe(borrowed);
      expect(Object.isFrozen(borrowed)).toBe(false); borrowed.push('later');
      expect(result.assessment.progression!.excluded).toEqual(['borrowed fixed diagnostic']);
      expect(values.map(Object.isFrozen)).toEqual(frozenBefore);
    } finally { derive.mockRestore(); }
  });
  it('preserves intentional nonfinite diagnostic sums without treating them as admitted World values', () => {
    const source = fresh(); const baseline = assessManagementCapacityV10(source); const actual = budget.assessAutomaticWorkBudget;
    const additionalReserve = baseline.reserved.wireBytes! - baseline.base!.reservedBytes;
    expect(Number.isSafeInteger(additionalReserve)).toBe(true); expect(additionalReserve).toBeGreaterThanOrEqual(0);
    // Each dimension operand must stay safe. Overflow belongs only to the final
    // current + reserved cost, not to the separately checked reserve operand.
    const query = vi.spyOn(budget, 'assessAutomaticWorkBudget').mockImplementation(input => ({ ...actual(input),
      reservedBytes: Number.MAX_SAFE_INTEGER - additionalReserve }));
    try {
      const expected = assessManagementCapacityV10(source); const result = captureAndAssessOwnedV10(source);
      expect(expected.reserved.wireBytes).toBe(Number.MAX_SAFE_INTEGER);
      expect(expected.costs.wireBytes).toBe(Infinity); expect(result.assessment).toEqual(expected);
      expect(result.assessment.fits).toBe(false); expect(allFrozen(result.assessment)).toBe(true);
    } finally { query.mockRestore(); }
  });
});

describe('unchanged standalone diagnostics and fresh descriptor boundaries', () => {
  it('keeps external assessment mutable and preserves clock-before-archive error order', () => {
    const source = fresh(); source.clock.calendarTick = 1;
    source.history = { ...source.history, events: { ...source.history.events, count: 1 } };
    const external = assessManagementCapacityV10(source);
    expect(external.sourceRecordIssues).toEqual(['Invalid clock']); expect(Object.isFrozen(external)).toBe(false);
    external.sourceRecordIssues[0] = 'changed'; expect(assessManagementCapacityV10(source).sourceRecordIssues).toEqual(['Invalid clock']);
    // Owned entry already restored before assessment in the former composition.
    expect(() => former(source)).toThrow(); expect(() => captureAndAssessOwnedV10(source)).toThrow();
    expect(createOwnedTickPipelineV10().capture(source)).toBeNull();
  });
  it('preserves measured over-cap diagnostics before the standalone capture fails', () => {
    const source = fresh(); source.diagnostics = [{ code: 'INVARIANT_FAILURE', tick: 0, message: 'x'.repeat(budget.SAVE_FILE_LIMIT_BYTES) }];
    const result = assessManagementCapacityV10(source);
    expect(result.measuredEnvelopeBytes).toBeGreaterThan(budget.SAVE_FILE_LIMIT_BYTES);
    expect(result).toMatchObject({ supported: false, fits: false, actualFits: false, reason: 'wire-cap', sourceRecordIssues: [] });
    expect(result.unknowns).toEqual(['Unsupported bounded v10 capacity source']);
    expect(() => former(source)).toThrow(); expect(() => captureAndAssessOwnedV10(source)).toThrow();
  });
  it('keeps the exact whole-capture byte and depth edges before record-shape inspection', () => {
    const archive = fresh().history;
    const bytes = { history: archive, padding: '' };
    bytes.padding = 'x'.repeat(budget.SAVE_FILE_LIMIT_BYTES - canonicalUtf8ByteLength(bytes));
    expect(canonicalUtf8ByteLength(bytes)).toBe(budget.SAVE_FILE_LIMIT_BYTES);
    expect(validation.captureRestoredV10RecordInspection(bytes).inspect()).toEqual(['Invalid internal v10 root fields']);
    expect(() => validation.captureRestoredV10RecordInspection({ ...bytes, padding: `${bytes.padding}x` })).toThrow();
    const nested = (levels: number): unknown => JSON.parse(`${'['.repeat(levels)}0${']'.repeat(levels)}`);
    expect(validation.captureRestoredV10RecordInspection({ history: archive, payload: nested(127) }).inspect())
      .toEqual(['Invalid internal v10 root fields']);
    expect(() => validation.captureRestoredV10RecordInspection({ history: archive, payload: nested(128) })).toThrow();
  });
  it.each([
    ['shared object', () => { const child = { x: 1 }; return { a: child, b: child }; }],
    ['cycle', () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
    ['prototype', () => Object.create({ inherited: 1 }) as unknown],
    ['hidden property', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['sparse array', () => new Array(3)],
    ['symbol', () => ({ [Symbol('hidden')]: 1 })],
    ['depth', () => JSON.parse(`${'['.repeat(130)}0${']'.repeat(130)}`) as unknown],
    ['declared nodes', () => new Array(budget.SAVE_FILE_LIMIT_BYTES + 1)],
    ['nonfinite', () => ({ value: Infinity })],
  ] as const)('retains descriptor rejection for %s', (_name, make) => {
    const input = make(); expect(() => former(input)).toThrow(); expect(() => captureAndAssessOwnedV10(input)).toThrow();
  });
  it('does not invoke getters, read hostile thrown values or retain a revocable caller Proxy', () => {
    let reads = 0; const get = (): never => { reads++; throw null; };
    const thrown = new Proxy({}, { get, getPrototypeOf: get });
    const hostile = new Proxy({}, { ownKeys() { throw thrown; } });
    const accessor = Object.freeze(Object.defineProperty(fresh(), 'seed', { enumerable: true, get }));
    for (const input of [hostile, accessor]) {
      let refused = false; try { captureAndAssessOwnedV10(input); } catch { refused = true; }
      expect(refused).toBe(true); expect(createOwnedTickPipelineV10().capture(input)).toBeNull();
    }
    const source = fresh(); const proxy = Proxy.revocable(source.clock, {});
    const inspection = validation.captureRestoredV10RecordInspection({ ...source, clock: proxy.proxy }); proxy.revoke();
    expect(inspection.inspect()).toEqual([]); expect(reads).toBe(0);
  });
  it('compares exact issue arrays for multiply-invalid ordinary and externally frozen sources', () => {
    const source = fresh(); source.clock.calendarTick = 1;
    source.sectExpansion = { ...source.sectExpansion, stock: { ...source.sectExpansion.stock,
      'wound-powder': { ...source.sectExpansion.stock['wound-powder'], owned: 1 } } };
    compare(source); expect(captureAndAssessOwnedV10(source).assessment.sourceRecordIssues).toEqual(['Invalid clock']);
    source.clock.calendarTick = 0; compare(source);
    expect(captureAndAssessOwnedV10(source).assessment.sourceRecordIssues).toEqual(['V10 zero-genesis stock provenance differs']);
    compare(freeze(source));
  });
});

describe('real owned publication still follows complete checks', () => {
  it('matches active work, cancellation archives and subsequent immutable boundaries', () => {
    let source = apply(fresh(), { kind: 'production.start', commandId: 'capture.start', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    compare(source); const pipeline = createOwnedTickPipelineV10(); const initial = pipeline.capture(source)!;
    for (let index = 0; index < 3; index++) {
      const expected = prepareNormalTickCandidateV10(source); const next = pipeline.advanceNormal()!;
      expect(next.world).toEqual(expected); expect(next.assessment).toEqual(assessManagementCapacityV10(expected));
      expect(history.restoreHistoryArchive(next.world.history)).toBe(next.world.history); source = next.world;
    }
    expect(initial.world.clock.simulationTick).toBe(0);
    source = apply(source, { kind: 'production.cancel', commandId: 'capture.cancel', sequence: 1,
      issuedTick: source.clock.simulationTick, payload: { transactionId: source.activeProductionTransactionIds[0]! } });
    expect(source.history.production.count).toBe(1); compare(source);
    const captured = captureAndAssessOwnedV10(freeze(cloneJson(source)));
    expect(history.restoreHistoryArchive(captured.world.history)).toBe(captured.world.history);
    const damaged = cloneJson(source); damaged.history = { ...damaged.history,
      production: { ...damaged.history.production, count: damaged.history.production.count + 1 } };
    expect(() => former(damaged)).toThrow(); expect(() => captureAndAssessOwnedV10(freeze(damaged))).toThrow();
  });
  it('retains genuine birthday expiry and decision-pause records', () => {
    const source = fresh(); const actor = source.disciples.find(value => value.id === 'entity:4')!;
    const profile = source.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    compare(source); const next = prepareNormalTickCandidateV10(source);
    expect(next.cultivation.pendingDeaths[0]!.discipleId).toBe(actor.id); expect(next.clock.pauseReasons).toContain('cultivation'); compare(next);
  });
  it('reruns candidate semantics and residual checks before publishing, preserving the retained source on failure', () => {
    const source = fresh(); const pipeline = createOwnedTickPipelineV10(); const before = pipeline.capture(source)!;
    const expected = prepareNoOptionalGrowthTickCandidateV10(source); const actualInspect = lifecycle.inspectV10LifecycleRecords;
    let reads = 0; const thrown = Object.defineProperty({}, 'message', { get() { reads++; return 'must not read'; } });
    const inspect = vi.spyOn(lifecycle, 'inspectV10LifecycleRecords').mockImplementation(world => {
      if (world.clock.simulationTick === 1) throw thrown; return actualInspect(world);
    });
    try { expect(pipeline.advanceNormal()).toBeNull(); expect(inspect.mock.calls.some(([world]) => world.clock.simulationTick === 1)).toBe(true); }
    finally { inspect.mockRestore(); }
    expect(before.world.clock.simulationTick).toBe(0); expect(reads).toBe(0);
    const actualRecords = discharge.inspectReservedDischargeRecordsV10;
    const residual = vi.spyOn(discharge, 'inspectReservedDischargeRecordsV10').mockImplementationOnce((a, b) => ({ ...actualRecords(a, b), issues: ['injected residual failure'] }));
    try { expect(pipeline.advanceNormal()).toBeNull(); expect(residual).toHaveBeenCalledTimes(1); }
    finally { residual.mockRestore(); }
    const next = pipeline.advanceNoOptional()!;
    expect(next.world).toEqual(expected); expect(before.world.randomStreams).toEqual(source.randomStreams);
    expect(allFrozen(next)).toBe(true);
  });
});
