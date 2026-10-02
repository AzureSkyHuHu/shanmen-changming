import { describe, expect, it } from 'vitest';
import { resolveContentIdentity } from '../../src/content/registry';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { MAX_CULTIVATION_HISTORY } from '../../src/core/cultivation/rules';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import type { SectCommandV9 } from '../../src/core/kernel/contracts-v9';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createSaveEnvelope, serializeSave } from '../../src/core/kernel/save';
import { createSaveEnvelopeV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { inspectUnregisteredWorldV9Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { measureWorldSaveBytes, WORST_SAVE_METADATA } from '../../src/core/save-budget/envelope';
import { CONSTRUCTION_LIMITS } from '../../src/core/sect-expansion/construction-types';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { advanceV9CultivationClock } from '../../src/core/world/v9-cultivation-clock-bridge';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import { measureProgressionRecord } from '../../src/core/save-budget/progression-bounds';
import { deriveV9BuildObligationFacts, inspectV9KnownRecordHeadroom } from '../../src/core/world/v9-record-headroom';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { parseVersionedSave } from '../../src/platform/save-codec';

function sect(world: WorldStateV9, payload: SectCommandV9): WorldStateV9 {
  const result = dispatchUnregisteredCommandV9(world, { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function planned(): WorldStateV9 {
  const source = createUnregisteredWorldV9('capacity-planned');
  return sect(source, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'capacity.place', expectedRevision: 0,
    placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } });
}
function production(): WorldStateV9 {
  const source = createUnregisteredWorldV9('capacity-production');
  return sect(source, { domain: 'production', command: { kind: 'production.start', commandId: 'capacity.produce', expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2' } });
}
function numericBoundary(source: WorldStateV9, revision: number, nextId: number, navVersion: number): WorldStateV9 {
  return { ...source, map: { ...source.map, navVersion }, sectExpansion: { ...source.sectExpansion,
    construction: { ...source.sectExpansion.construction, revision, nextId } } };
}
describe('read-only unregistered v9 management capacity query', () => {
  it('reports the exact UTF-8 whole envelope with worst legal escaped metadata and no authority', () => {
    const world = createUnregisteredWorldV9('药🙂\\\u0000');
    world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '药🙂\ud800\u0000\\"' });
    const before = canonicalStringify(world); const assessment = assessManagementCapacityV9(world);
    const envelope = { saveVersion: 9, simulationVersion: world.simulationVersion, contentVersion: world.contentVersion, seed: world.seed,
      ...WORST_SAVE_METADATA, checksum: '00000000', payload: world };
    expect(assessment.measuredEnvelopeBytes).toBe(new TextEncoder().encode(canonicalStringify(envelope)).length);
    expect(assessment.measuredEnvelopeBytes).toBe(measureWorldSaveBytes(world, { saveVersion: 9 }));
    expect(assessment).toMatchObject({ scope: 'unregistered-v9-immediate-recovery-and-record-peaks', supported: true, fits: true,
      admitted: false, importAuthorized: false, eventualCompletionSupported: false });
    expect(assessment.excludedProofs.join(' ')).toMatch(/historical injury replay/);
    expect(canonicalStringify(world)).toBe(before);
  });
  it('adds base, progression and sect once and never re-adds the build subtotal', () => {
    const assessment = assessManagementCapacityV9(planned());
    expect(assessment.supported, assessment.unknowns.join('; ')).toBe(true);
    expect(assessment.costs.wireBytes).toBe(assessment.measuredEnvelopeBytes! + assessment.base!.reservedBytes + assessment.progression!.totals.bytes + assessment.sect!.totals.bytes + assessment.clock!.bytes);
    expect(assessment.reserved.buildCommands).toBe(assessment.progression!.totals.buildRows);
    expect(assessment.reserved['sect.constructionReceipts']).toBe(2);
    expect(assessment.reserved.archiveReceiptRows).toBe(assessment.base!.archiveSlots.reserved.commandReceipts + assessment.progression!.totals.archiveRows.commandReceipts);
    expect(assessment.sect!.owners[0]!.kind).toBe('planned-blueprint');
    expect(inspectV9KnownRecordHeadroom(planned())).toEqual([]);
    expect(deriveV9BuildObligationFacts(planned()).activeRun).toBeNull();
  });
  it('distinguishes wire equality, one byte over and future reserve exhaustion', () => {
    const world = createUnregisteredWorldV9('capacity-wire'); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    world.diagnostics[0]!.message = 'a'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(world, { saveVersion: 9 }));
    const equal = assessManagementCapacityV9(world);
    expect(equal.measuredEnvelopeBytes).toBe(SAVE_FILE_LIMIT_BYTES); expect(equal.actualFits).toBe(true); expect(equal.fits).toBe(false);
    expect(equal.deficits.some(deficit => deficit.dimension === 'wireBytes')).toBe(true);
    world.diagnostics[0]!.message += 'a'; const over = assessManagementCapacityV9(world);
    expect(over.measuredEnvelopeBytes).toBe(SAVE_FILE_LIMIT_BYTES + 1); expect(over.actualFits).toBe(false); expect(over.reason).toBe('wire-cap');
  });
  it('keeps exact safe-integer revision, allocation and navigation ceilings independent of bytes', () => {
    const max = Number.MAX_SAFE_INTEGER; const source = planned();
    const equal = assessManagementCapacityV9(numericBoundary(source, max - 2, max - 3, max - 2));
    expect(equal.actualFits).toBe(true);
    for (const key of ['sect.constructionRevision', 'sect.constructionNextId', 'navVersion']) expect(equal.costs[key]).toBe(max);
    const short = assessManagementCapacityV9(numericBoundary(source, max - 1, max - 2, max - 1));
    expect(short.actualFits).toBe(true); expect(short.fits).toBe(false);
    for (const key of ['sect.constructionRevision', 'sect.constructionNextId', 'navVersion']) expect(short.deficits.some(deficit => deficit.dimension === key)).toBe(true);
  });
  it('reports local receipt row pressure without miscounting it as World history', () => {
    // Duplicate receipt rows are deliberately invalid reader-pressure data. They
    // test diagnostics, never create a provenance or admission fixture.
    const source = planned(); const receipt = source.sectExpansion.construction.receipts[0]!;
    source.sectExpansion = { ...source.sectExpansion, construction: { ...source.sectExpansion.construction,
      receipts: Array.from({ length: CONSTRUCTION_LIMITS.receipts - 1 }, () => cloneJson(receipt)) } };
    const assessment = assessManagementCapacityV9(source);
    expect(assessment.actualFits).toBe(true); expect(assessment.supported).toBe(false);
    expect(assessment.deficits.find(deficit => deficit.dimension === 'sect.constructionReceipts')?.excess).toBe(1);
    expect(assessment.current.archiveReceiptRows).toBe(0);
  });
  it('reports a descriptor reader ceiling even when the whole envelope fits', () => {
    // Unknown extension is hostile data, not an accepted build. Retain the useful
    // independent size diagnosis while source validation still rejects it.
    const source = createUnregisteredWorldV9('reader-pressure');
    (source.builds as unknown as Record<string, unknown>).pressure = Array.from({ length: 31 }, () => Array(10_000).fill(0));
    const assessment = assessManagementCapacityV9(source);
    expect(assessment.actualFits).toBe(true); expect(assessment.supported).toBe(false);
    expect(assessment.deficits.some(deficit => deficit.dimension === 'buildReaderNodes')).toBe(true);
  });
  for (const count of [MAX_CULTIVATION_HISTORY - 1, MAX_CULTIVATION_HISTORY]) it(`reserves the independent sect relic destination at ${count} current rows`, () => {
    const source = createUnregisteredWorldV9('relic-destination');
    source.cultivation.sectRelicIds = Array.from({ length: count }, (_, index) => `r${index}`);
    source.cultivation.disciples[1]!.relicIds = ['terminal-relic'];
    source.cultivation.disciples[1]!.heirId = source.cultivation.disciples[2]!.discipleId;
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    const assessment = assessManagementCapacityV9(source);
    expect(assessment.supported).toBe(true); expect(assessment.actualFits).toBe(true);
    expect(assessment.current['cultivation.sectRelicIds']).toBe(count); expect(assessment.reserved['cultivation.sectRelicIds']).toBe(1);
    expect(assessment.costs['cultivation.sectRelicIds']).toBe(count + 1);
    expect(assessment.deficits.some(deficit => deficit.dimension === 'cultivation.sectRelicIds')).toBe(count === MAX_CULTIVATION_HISTORY);
    expect(assessment.fits).toBe(count < MAX_CULTIVATION_HISTORY);
  });
  it('combines active production and lifecycle cancellation owners and measures the genuine recovery', () => {
    const source = production(); const profile = source.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!;
    const actor = source.disciples.find(actor => actor.id === profile.discipleId)!;
    actor.birthCalendarTick = source.clock.calendarTick + 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((source.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    const before = assessManagementCapacityV9(source); expect(before.supported).toBe(true);
    expect(before.sect!.owners.some(owner => owner.workerId === actor.id)).toBe(true);
    expect(before.progression!.owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === actor.id)).toBe(true);
    const next = advanceUnregisteredTicksV9(source, 1); expect(next.stopped).toBeNull();
    const after = assessManagementCapacityV9(next.world); expect(after.supported).toBe(true);
    expect(after.measuredEnvelopeBytes).toBeLessThanOrEqual(before.costs.wireBytes!);
    expect(after.sect!.owners).toEqual([]); expect(after.progression!.owners.some(owner => owner.id === actor.id)).toBe(true);
    const localId = next.world.sectExpansion.production.receipts.at(-1)!.command.commandId;
    expect(localId).toMatch(/^system\/v9\/death\//); expect(next.world.commandReceipts[localId]).toBeUndefined();
    expect(after.current['sect.productionReceipts']).toBe(before.current['sect.productionReceipts']! + 1);
  });
  it('treats maintenance renewal as optional and exposes no endless paid-time promise', () => {
    const assessment = assessManagementCapacityV9(createUnregisteredWorldV9('optional-maintenance'));
    expect(assessment.reserved['sect.maintenancePayments']).toBe(0); expect(assessment.reserved['sect.maintenanceNextId']).toBe(0);
    expect(assessment.eventualCompletionSupported).toBe(false); expect(assessment.excludedProofs.join(' ')).toMatch(/indefinitely blocked/);
  });
  it('remeasures mutable input on every call without changing source data', () => {
    const world = createUnregisteredWorldV9('remeasure-capacity'); const before = assessManagementCapacityV9(world);
    world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '药'.repeat(100) });
    const source = canonicalStringify(world); const after = assessManagementCapacityV9(world);
    expect(after.measuredEnvelopeBytes).toBeGreaterThan(before.measuredEnvelopeBytes! + 300);
    expect(canonicalStringify(world)).toBe(source);
  });
  it('rejects hostile getters, cycles and sparse arrays before reads and returns no partial certificate', () => {
    let reads = 0; const getter = createUnregisteredWorldV9('hostile-getter');
    Object.defineProperty(getter.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } });
    const result = assessManagementCapacityV9(getter); expect(reads).toBe(0); expect(result.supported).toBe(false); expect(result.measuredEnvelopeBytes).toBeNull();
    const cyclic = createUnregisteredWorldV9('hostile-cycle'); (cyclic as unknown as Record<string, unknown>).cycle = cyclic;
    expect(assessManagementCapacityV9(cyclic).supported).toBe(false);
    const sparse = createUnregisteredWorldV9('hostile-sparse'); delete sparse.disciples[0];
    expect(assessManagementCapacityV9(sparse).supported).toBe(false);
  });
  it('reserves terminal clock rows but no arbitrary future month stream at a fresh boundary', () => {
    const world = createUnregisteredWorldV9('clock-no-optional-time'); const result = assessManagementCapacityV9(world);
    expect(result.supported).toBe(true); expect(result.clock).toMatchObject({ currentRows: 0, calendarTicks: 0, monthRows: 0, ageSyncRows: 0,
      lifecycleTriggerRows: world.disciples.length, reservedRows: world.disciples.length, additionalActions: 0, additionalCultivationRevisions: 0 });
    expect(result.reserved['cultivationClockTransitions']).toBe(world.disciples.length);
    expect(result.clock!.decodedNodes).toBe(world.disciples.length * result.clock!.perTransition.decodedNodes);
    expect(result.clock!.structuralNodeLimit).toBe(2 + V9_CULTIVATION_CLOCK_LIMIT * result.clock!.perTransition.decodedNodes);
    const old = { ...world, runtimeProtocol: 'fresh-management-v9-unregistered.2' } as unknown as WorldStateV9;
    expect(assessManagementCapacityV9(old).supported).toBe(false);
  });
  it('funds finite teaching months and grouped off-month birthdays without charging the existing month actions twice', () => {
    let source = createUnregisteredWorldV9('clock-teaching-horizon');
    // Explicit zero-history chronology fixture, before any clock evidence exists.
    for (const id of ['entity:1', 'entity:2']) {
      const actor = source.disciples.find(actor => actor.id === id)!; const profile = source.cultivation.disciples.find(profile => profile.discipleId === id)!;
      actor.birthCalendarTick += 7; actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    }
    // Explicit authored-origin fixture through the real schema-3 constructor,
    // before any revision/clock history. This is not a campaign grant claim.
    source.cultivation = createCultivationStateV3(source.cultivation.disciples.map(profile => profile.discipleId === 'entity:2'
      ? { ...profile, knowledge: [{ knowledgeId: 'knowledge.capacity', teacherId: null, teachingId: null }] } : profile));
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    const commandId = 'clock.teach';
    const started = dispatchUnregisteredCommandV9(source, { kind: 'cultivation.command', commandId, issuedTick: 0, sequence: 0,
      payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: source.cultivation.revision,
        discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.capacity' } } });
    expect(started.result.status).toBe('accepted'); source = started.world;
    const before = assessManagementCapacityV9(source); expect(before.supported, before.sourceRecordIssues.join('; ')).toBe(true);
    expect(before.clock).toMatchObject({ calendarTicks: 2 * CALENDAR_TICKS_PER_MONTH, monthRows: 2, ageSyncRows: 2,
      lifecycleTriggerRows: source.disciples.length, additionalActions: 2, additionalCultivationRevisions: 2 });
    expect(before.reserved['sequence.nextAction']).toBe(before.progression!.totals.sequenceReserve.nextAction + 2);
    expect(before.reserved.cultivationRevision).toBe(before.progression!.totals.counterReserve.cultivationRevisions + 2);
    let next = source;
    // Execute every revision-producing boundary through the real .3 bridge. The
    // skipped intervals are explicitly idle, not a simulated work/tick journey.
    for (const tick of [7, CALENDAR_TICKS_PER_MONTH, CALENDAR_TICKS_PER_MONTH + 7, 2 * CALENDAR_TICKS_PER_MONTH]) {
      next = advanceV9CultivationClock({ ...next, clock: { ...next.clock, simulationTick: tick, calendarTick: tick } });
      expect(inspectUnregisteredWorldV9Records(next)).toEqual([]);
    }
    expect(next.cultivationClock.transitions.map(row => row.kind)).toEqual(['age-sync', 'month', 'age-sync', 'month']);
    expect(next.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!.teaching).toBeNull();
    const delta = measureProgressionRecord(next.cultivationClock).bytes - measureProgressionRecord(source.cultivationClock).bytes;
    expect(before.clock!.bytes).toBeGreaterThanOrEqual(delta);
    const after = assessManagementCapacityV9(next); expect(after.supported).toBe(true);
    expect(after.clock!.monthRows).toBe(0); expect(after.clock!.ageSyncRows).toBe(0);
    expect(after.current.cultivationClockTransitions).toBe(4);
  });
  for (const spare of [4, 3]) it(`keeps .3 clock row and structural-node ceilings independent of bytes with ${spare} rows spare`, () => {
    // Shape-correct row-pressure diagnostic, deliberately not invented historical
    // provenance. The query may expose costs but supported must stay false.
    const source = createUnregisteredWorldV9('clock-row-pressure');
    source.cultivationClock.transitions = Array.from({ length: V9_CULTIVATION_CLOCK_LIMIT - spare }, (_, index) => ({
      kind: 'month', tick: (index + 1) * CALENDAR_TICKS_PER_MONTH, beforeRevision: index, rootActionId: `action:${index + 1}`,
    }));
    const result = assessManagementCapacityV9(source);
    expect(result.actualFits).toBe(true); expect(result.supported).toBe(false);
    expect(result.costs.cultivationClockTransitions).toBe(V9_CULTIVATION_CLOCK_LIMIT + 4 - spare);
    expect(result.deficits.some(deficit => deficit.dimension === 'cultivationClockTransitions')).toBe(spare === 3);
    expect(result.deficits.some(deficit => deficit.dimension === 'cultivationClockStructuralNodes')).toBe(spare === 3);
    expect(result.measuredEnvelopeBytes).toBe(measureWorldSaveBytes(source, { saveVersion: 9 }));
  });
  it('keeps v7/v8 codecs unchanged and v9 entirely unregistered despite a fitting query', () => {
    const legacy = createWorld('old-codec'); const candidate = createWorldV8('candidate-codec');
    const metadata = { buildId: 'test', savedAt: '2026-10-02' };
    const seven = serializeSave(createSaveEnvelope(legacy, metadata)); const eight = serializeSaveV8(createSaveEnvelopeV8(candidate, metadata));
    expect(parseVersionedSave(seven).ok).toBe(true); expect(parseVersionedSave(eight).ok).toBe(true);
    const world = createUnregisteredWorldV9('unregistered-fit'); expect(assessManagementCapacityV9(world).fits).toBe(true);
    expect(resolveContentIdentity(world.contentIdentity, { allowCandidate: true })).toBeNull();
    expect(parseVersionedSave(canonicalStringify({ saveVersion: 9, simulationVersion: world.simulationVersion, contentVersion: world.contentVersion,
      seed: world.seed, ...metadata, checksum: '00000000', payload: world }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    for (const old of [legacy, candidate]) expect(assessManagementCapacityV9(old as unknown as WorldStateV9).supported).toBe(false);
    expect(serializeSave(createSaveEnvelope(legacy, metadata))).toBe(seven); expect(serializeSaveV8(createSaveEnvelopeV8(candidate, metadata))).toBe(eight);
  });
});
