import { describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_IDENTITY, MANAGEMENT_V10_CONTENT_VERSION } from '../../src/content/sect-v10/world-content';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import { cloneJson } from '../../src/core/kernel/serialization';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { inspectV9LifecycleRecords } from '../../src/core/world/v9-lifecycle-records';
import { historicalDeathsOfV10LifecycleEvidence, inspectV10LifecycleRecords, type V10LifecycleRecordEvidence } from '../../src/core/world/v10-lifecycle-records';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { captureSectHistoricalIdentitiesV10, isArchivedSectWorkerReference } from '../../src/core/sect-expansion/history-identity';
import { composeV10SectFrame, ownedV10SectRecords, projectV10SectFrame, v10SectContext, v10WorkOwners } from '../../src/core/world/v10-sect-frame';

/** Record-only fixture, NOT a migration or whole-v10 admission implementation. */
function records(source = createUnregisteredWorldV9('v10-lifecycle-records')): WorldStateV10 {
  if (source.sectExpansion.production.jobs.length) throw new Error('This record-only fixture requires no sect production history');
  return { ...cloneJson(source), simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...cloneJson(source.sectExpansion), schemaVersion: 2,
      production: { ...cloneJson(source.sectExpansion.production), jobs: [] },
      construction: { ...cloneJson(source.sectExpansion.construction), buildings: source.sectExpansion.construction.buildings.map(value => ({ ...value, level: 1 })) },
      upgrade: { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY),
        revision: 0, nextId: 1, jobs: [], receipts: [] } } };
}

describe('source-bound v10 completed lifecycle record evidence', () => {
  it('projects and composes one actual map, clock and ledger without persisting projections', () => {
    const world = records(); const before = cloneJson(world);
    const frame = projectV10SectFrame(world);
    expect(frame.construction.map).toBe(world.map);
    expect(frame.construction.ledger.inventory).toBe(world.inventory);
    expect(frame.upgrade).toBe(world.sectExpansion.upgrade);
    expect(v10SectContext(world).simulationTick).toBe(world.clock.simulationTick);
    expect(v10WorkOwners(world)).toEqual([]);
    expect(ownedV10SectRecords(frame)).toEqual(world.sectExpansion);
    expect(composeV10SectFrame(world, frame)).toEqual(world);
    expect(world).toEqual(before);
    expect(Object.hasOwn(ownedV10SectRecords(frame).construction, 'people')).toBe(false);
    expect(Object.hasOwn(ownedV10SectRecords(frame).construction, 'map')).toBe(false);
  });
  it('rejects forged, v9, foreign-source and mutated-source evidence', () => {
    const world = records(); const token = inspectV10LifecycleRecords(world);
    expect(historicalDeathsOfV10LifecycleEvidence(token, world)).toEqual([]);
    for (const forged of [{}, { ...token }, JSON.parse(JSON.stringify(token)), inspectV9LifecycleRecords(createUnregisteredWorldV9())]) {
      expect(() => historicalDeathsOfV10LifecycleEvidence(forged as V10LifecycleRecordEvidence, world)).toThrow();
    }
    expect(() => historicalDeathsOfV10LifecycleEvidence(token, cloneJson(world))).toThrow();
    world.seed += '.changed';
    expect(() => historicalDeathsOfV10LifecycleEvidence(token, world)).toThrow('Changed v10 lifecycle evidence source');
  });
  it('rechecks mutable descendants of a shallow-frozen source on every evidence read', () => {
    const world = Object.freeze(records()); const token = inspectV10LifecycleRecords(world);
    expect(historicalDeathsOfV10LifecycleEvidence(token, world)).toEqual([]);
    expect(historicalDeathsOfV10LifecycleEvidence(token, world)).toEqual([]);
    expect(Object.isFrozen(world.clock)).toBe(false);
    world.clock.speed = 3;
    expect(() => historicalDeathsOfV10LifecycleEvidence(token, world)).toThrow('Changed v10 lifecycle evidence source');
    expect(Object.isFrozen(world.clock)).toBe(false);
  });
  it('rejects a getter introduced after evidence creation without executing it', () => {
    const world = Object.freeze(records()); const token = inspectV10LifecycleRecords(world);
    expect(historicalDeathsOfV10LifecycleEvidence(token, world)).toEqual([]);
    let reads = 0;
    Object.defineProperty(world.clock, 'speed', { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => historicalDeathsOfV10LifecycleEvidence(token, world)).toThrow();
    expect(reads).toBe(0);
  });
  it('retains exact pending-expiry and finalized-death anchors from genuine reducers', () => {
    const initial: WorldStateV9 = createUnregisteredWorldV9('v10-real-expiry-fixture');
    // Explicit near-expiry initial birthday fixture, not a claim of simulating a lifetime.
    const actor = initial.disciples.find(value => value.id === 'entity:4')!;
    const profile = initial.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    const expired = advanceUnregisteredTicksV9(initial, 1).world;
    const death = expired.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    expect(death).toBeDefined();
    const pendingWorld = records(expired);
    const pending = historicalDeathsOfV10LifecycleEvidence(inspectV10LifecycleRecords(pendingWorld), pendingWorld);
    const pendingRefs = captureSectHistoricalIdentitiesV10(inspectV10LifecycleRecords(pendingWorld), pendingWorld);
    expect(isArchivedSectWorkerReference(pendingRefs, actor.id, { tick: 1, calendarTick: 1 })).toBe(false);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ deathId: death.deathId, discipleId: actor.id, unavailableKind: 'cultivation.expiryPending',
      unavailableTick: 1, unavailableCalendarTick: 1, diedEventId: null, diedTick: null, archived: false });
    const commandId = 'finalize.for.v10.record.test';
    const settled = dispatchUnregisteredCommandV9(expired, { kind: 'cultivation.command', commandId, issuedTick: 1, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId, expectedRevision: expired.cultivation.revision,
        discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(settled.result.status).toBe('accepted');
    const finalWorld = records(settled.world);
    const final = historicalDeathsOfV10LifecycleEvidence(inspectV10LifecycleRecords(finalWorld), finalWorld);
    expect(final[0]).toMatchObject({ deathId: death.deathId, unavailableEventId: pending[0]!.unavailableEventId,
      unavailableTick: 1, diedTick: 1, archived: true });
    expect(final[0]!.diedEventId).not.toBeNull();
    expect(final[0]!.diedEventId).not.toBe(final[0]!.unavailableEventId);
    const finalRefs = captureSectHistoricalIdentitiesV10(inspectV10LifecycleRecords(finalWorld), finalWorld);
    expect(isArchivedSectWorkerReference(finalRefs, actor.id, { tick: 1, calendarTick: 1 })).toBe(true);
    expect(isArchivedSectWorkerReference(finalRefs, actor.id, { tick: 2, calendarTick: 2 })).toBe(false);
    expect(isArchivedSectWorkerReference(finalRefs, 'entity:1', { tick: 1, calendarTick: 1 })).toBe(false);
  });
});
