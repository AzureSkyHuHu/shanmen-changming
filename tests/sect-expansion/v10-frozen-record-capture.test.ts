import { beforeAll, describe, expect, it } from 'vitest';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { createCanonicalByteCounter } from '../../src/core/save-budget/canonical-bytes';
import { createCanonicalRecordCounter } from '../../src/core/save-budget/canonical-records';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { lookupProduction } from '../../src/core/world/history-access';
import { assessManagementCapacityV10 } from '../../src/core/world/management-capacity-v10';
import { captureFrozenV10RecordData } from '../../src/core/world/v10-frozen-record-capture';
import { historicalDeathsOfV10LifecycleEvidence, inspectV10LifecycleRecords } from '../../src/core/world/v10-lifecycle-records';
import { captureV10RecordData } from '../../src/core/world/v10-sect-records';

function allFrozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(allFrozen);
}
function frozenWorld(world: WorldStateV10): WorldStateV10 { return captureFrozenV10RecordData(world) as WorldStateV10; }

describe('fresh internal immutable v10 descriptor captures', () => {
  it('preserves canonical data while freezing only the complete detached copy', () => {
    const input = { text: '药🙂\ud800\u0000', number: -0, nested: { rows: [{ amount: 3 }, null, true] } };
    const captured = captureFrozenV10RecordData(input) as typeof input;
    expect(canonicalStringify(captured)).toBe(canonicalStringify(captureV10RecordData(input)));
    expect(allFrozen(captured)).toBe(true); expect(captured).not.toBe(input);
    expect(captured.nested).not.toBe(input.nested); expect(captured.nested.rows).not.toBe(input.nested.rows);
    expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(input.nested)).toBe(false);
    input.text = 'still mutable'; expect(captured.text).not.toBe(input.text);
    expect(() => { captured.nested.rows.push(false); }).toThrow();
  });
  it('leaves the general capture contract mutable and returns a fresh tree every call', () => {
    const input = { nested: { quantity: 2 } };
    const mutable = captureV10RecordData(input) as typeof input;
    mutable.nested.quantity = 4; expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.nested)).toBe(false); expect(input.nested.quantity).toBe(2);
    const first = captureFrozenV10RecordData(input) as typeof input;
    input.nested.quantity = 5;
    const second = captureFrozenV10RecordData(input) as typeof input;
    expect(first.nested.quantity).toBe(2); expect(second.nested.quantity).toBe(5);
    expect(first).not.toBe(second); expect(first.nested).not.toBe(second.nested);
    const third = captureFrozenV10RecordData(first) as typeof input;
    expect(third).toEqual(first); expect(third).not.toBe(first); expect(third.nested).not.toBe(first.nested);
  });
  it('recaptures shallow-frozen parents without freezing or caching their mutable children', () => {
    const child = { text: 'one' }; const input = Object.freeze({ child });
    const first = captureFrozenV10RecordData(input) as typeof input;
    expect(Object.isFrozen(child)).toBe(false); child.text = 'different';
    const second = captureFrozenV10RecordData(input) as typeof input;
    expect(first.child.text).toBe('one'); expect(second.child.text).toBe('different');
    expect(Object.isFrozen(child)).toBe(false);
  });
  it('lets existing counters independently authenticate and then reuse frozen descendants', () => {
    const input = { root: { rows: [{ text: '药🙂\ud800' }, { value: 2 }] } };
    const captured = captureFrozenV10RecordData(input);
    const bytes = createCanonicalByteCounter(); const records = createCanonicalRecordCounter();
    expect(bytes.stats()).toEqual({ visitedObjects: 0, cacheHits: 0 });
    expect(records.stats()).toEqual({ visitedObjects: 0, cacheHits: 0 });
    const size = bytes.measure(captured); const recordSize = records.measure(captured);
    const firstBytes = bytes.stats(); const firstRecords = records.stats();
    expect(firstBytes.visitedObjects).toBeGreaterThan(0); expect(firstRecords.visitedObjects).toBeGreaterThan(0);
    expect(size).toBe(new TextEncoder().encode(canonicalStringify(input)).length);
    expect(recordSize.bytes).toBe(size);
    expect(bytes.measure(captured)).toBe(size); expect(records.measure(captured)).toEqual(recordSize);
    expect(bytes.stats()).toEqual({ visitedObjects: firstBytes.visitedObjects, cacheHits: firstBytes.cacheHits + 1 });
    expect(records.stats()).toEqual({ visitedObjects: firstRecords.visitedObjects, cacheHits: firstRecords.cacheHits + 1 });
  });
  it('rejects ordinary accessors before reading them, even on an externally frozen object', () => {
    let reads = 0;
    const input = Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 1; } }));
    expect(() => captureFrozenV10RecordData(input)).toThrow(); expect(reads).toBe(0);
  });
  const invalid: [string, () => unknown][] = [
    ['sparse array', () => new Array(2)],
    ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { value: 1 })],
    ['null prototype', () => Object.create(null)],
    ['hidden field', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['symbol field', () => ({ [Symbol('invalid')]: 1 })],
    ['cycle', () => { const value: { self?: unknown } = {}; value.self = value; return value; }],
    ['alias', () => { const child = Object.freeze({ value: 1 }); return { first: child, second: child }; }],
    ['nonfinite number', () => ({ value: Infinity })],
  ];
  it.each(invalid)('preserves general bounded capture rejection for %s', (_name, make) => {
    const input = make(); expect(() => captureV10RecordData(input)).toThrow();
    expect(() => captureFrozenV10RecordData(input)).toThrow();
  });
});

describe('complete v10 records and capacity with private frozen captures', () => {
  let origin: WorldStateV10;
  beforeAll(() => { origin = createUnregisteredWorldV10('v10-private-frozen-capture'); });
  const fresh = () => cloneJson(origin);
  function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
    const result = prepareUnregisteredCommandCandidateV10(world, command);
    expect(result.result.status).toBe('accepted'); return result.world;
  }
  function equivalent(world: WorldStateV10): void {
    const before = canonicalStringify(world); const captured = frozenWorld(world);
    expect(inspectUnregisteredWorldV10Records(world)).toEqual([]);
    expect(inspectUnregisteredWorldV10Records(captured)).toEqual([]);
    const assessment = assessManagementCapacityV10(world);
    expect(assessment.supported).toBe(true); expect(assessment.fits).toBe(true);
    expect(assessManagementCapacityV10(captured)).toEqual(assessment);
    expect(canonicalStringify(world)).toBe(before);
  }
  it('keeps every assessment field equal and leaves mutable callers and results mutable', () => {
    const world = fresh(); equivalent(world);
    expect(Object.isFrozen(world)).toBe(false); expect(Object.isFrozen(world.clock)).toBe(false);
    expect(Object.isFrozen(world.history)).toBe(false); expect(Object.isFrozen(world.sectExpansion.stock)).toBe(false);
    const assessment = assessManagementCapacityV10(world);
    expect(Object.isFrozen(assessment)).toBe(false); expect(Object.isFrozen(assessment.current)).toBe(false);
    const originalSeed = world.seed;
    world.seed += '.changed';
    expect(world.seed).toBe(`${originalSeed}.changed`);
    expect(inspectUnregisteredWorldV10Records(world)).toEqual(['Invalid world map']);
    const changedAssessment = assessManagementCapacityV10(world);
    expect(changedAssessment.supported).toBe(false);
    expect(changedAssessment.sourceRecordIssues).toEqual(['Invalid world map']);
  });
  it('fully rechecks a caller mutation through a shallow-frozen root and preserves first-issue order', () => {
    const source = fresh();
    const stockEntry = { ...source.sectExpansion.stock['wound-powder'] };
    source.sectExpansion = { ...source.sectExpansion,
      stock: { ...source.sectExpansion.stock, 'wound-powder': stockEntry } };
    const world = Object.freeze(source); const prior = assessManagementCapacityV10(world);
    expect(prior.supported).toBe(true); expect(Object.isFrozen(world.clock)).toBe(false);
    world.clock.calendarTick = 1;
    stockEntry.owned = 1;
    expect(inspectUnregisteredWorldV10Records(world)).toEqual(['Invalid clock']);
    const after = assessManagementCapacityV10(world);
    expect(after.supported).toBe(false); expect(after.sourceRecordIssues).toEqual(['Invalid clock']);
    expect(after).toEqual(assessManagementCapacityV10(cloneJson(world)));
    expect(prior.supported).toBe(true); expect(Object.isFrozen(world.clock)).toBe(false);
  });
  it('does not treat an externally deep-frozen malformed World as validated', () => {
    const world = fresh();
    world.sectExpansion = { ...world.sectExpansion, stock: { ...world.sectExpansion.stock,
      'wound-powder': { ...world.sectExpansion.stock['wound-powder'], owned: 1 } } };
    const frozen = frozenWorld(world);
    expect(inspectUnregisteredWorldV10Records(frozen)).toEqual(['V10 zero-genesis stock provenance differs']);
    const result = assessManagementCapacityV10(frozen);
    expect(result.supported).toBe(false); expect(result).toEqual(assessManagementCapacityV10(world));
  });
  it('preserves real production cancellation archives and still rejects damaged packed history', () => {
    let world = apply(fresh(), { kind: 'production.start', commandId: 'frozen.start', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    const transactionId = world.activeProductionTransactionIds[0]!;
    world = apply(world, { kind: 'production.cancel', commandId: 'frozen.cancel', sequence: 1, issuedTick: 0, payload: { transactionId } });
    expect(world.history.production.count).toBe(1); equivalent(world);
    expect(lookupProduction(frozenWorld(world), transactionId)?.state).toBe('Cancelled');
    const damaged = cloneJson(world);
    damaged.history = { ...damaged.history, production: { ...damaged.history.production, count: damaged.history.production.count + 1 } };
    expect(inspectUnregisteredWorldV10Records(damaged)).toEqual(['Invalid history archive']);
    expect(inspectUnregisteredWorldV10Records(frozenWorld(damaged))).toEqual(['Invalid history archive']);
    expect(assessManagementCapacityV10(damaged)).toEqual(assessManagementCapacityV10(frozenWorld(damaged)));
    expect(assessManagementCapacityV10(damaged).supported).toBe(false);
  });
  it('retains actual birthday expiry, decision pause, finalized death and historical identity checks', () => {
    const source = fresh();
    // Legal near-expiry initial condition only, not evidence of a simulated lifetime.
    const actor = source.disciples.find(member => member.id === 'entity:4')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    equivalent(source);
    const pending = prepareNormalTickCandidateV10(source); const death = pending.cultivation.pendingDeaths[0]!;
    expect(death.discipleId).toBe(actor.id); expect(pending.clock.pauseReasons).toContain('cultivation'); equivalent(pending);
    const settled = apply(pending, { kind: 'cultivation.command', commandId: 'frozen.finalize', sequence: 0, issuedTick: 1,
      payload: { command: { kind: 'death.finalize', commandId: 'frozen.finalize', expectedRevision: pending.cultivation.revision,
        discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    equivalent(settled);
    const captured = frozenWorld(settled); const token = inspectV10LifecycleRecords(captured);
    expect(historicalDeathsOfV10LifecycleEvidence(token, captured)).toContainEqual(expect.objectContaining({
      discipleId: actor.id, deathId: death.deathId, unavailableTick: 1, diedTick: 1, archived: true }));
    expect(() => historicalDeathsOfV10LifecycleEvidence(token, frozenWorld(settled))).toThrow('Unauthenticated');
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.cultivation)).toBe(false);
  });
});
