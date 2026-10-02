import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { measureWorldSaveBytes, WORST_SAVE_METADATA } from '../../src/core/save-budget/envelope';
import { measureProgressionRecord } from '../../src/core/save-budget/progression-bounds';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { MANAGEMENT_V10_PROTOCOL, type SectProductionJobV10, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 } from '../../src/core/world/management-capacity-v10';
import { deriveV10BuildObligationFacts } from '../../src/core/world/v10-build-obligations';
import { inspectV10KnownRecordHeadroom } from '../../src/core/world/v10-record-headroom';
import { projectV10SectFrame } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Strict fresh/earned-history RECORD lift; not a migration or admitted save. */
function records(source: WorldStateV9 = createUnregisteredWorldV9('capacity-v10')): WorldStateV10 {
  recordChecked(source); const owned = cloneJson(source);
  const world: WorldStateV10 = { ...owned, simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...owned.sectExpansion, schemaVersion: 2,
      construction: { ...owned.sectExpansion.construction, buildings: owned.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...owned.sectExpansion.production, jobs: owned.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture cannot contain L2'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
  const prepared = prepareUnregisteredCommandCandidateV10(world, { kind: 'sect.command', commandId: payload.command.commandId,
    issuedTick: world.clock.simulationTick, sequence: 0, payload });
  expect(prepared.result.status, JSON.stringify(prepared.result)).toBe('accepted'); return prepared.world;
}
function until(source: WorldStateV10, predicate: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = source;
  for (let count = 0; count < limit && !predicate(next); count++) next = prepareNormalTickCandidateV10(next);
  if (!predicate(next)) throw new Error('Real v10 fixture did not complete'); return next;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function equation(world: WorldStateV10): ReturnType<typeof assessManagementCapacityV10> {
  const result = assessManagementCapacityV10(world);
  expect(result.costs.wireBytes).toBe(result.measuredEnvelopeBytes! + result.base!.reservedBytes
    + result.progression!.totals.bytes + result.sect!.totals.bytes + result.clock!.bytes);
  expect(result.reserved.buildCommands).toBe(result.progression!.totals.buildRows);
  return result;
}

describe('whole fixed-v10 structural capacity, never continuation or save authority', () => {
  it('measures the actual eight-field v10 envelope and charges each reserve once', () => {
    const world = records(createUnregisteredWorldV9('药🙂\\\u0000'));
    world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '药🙂\ud800\u0000\\"' });
    const before = canonicalStringify(world); const result = equation(world);
    const envelope = { saveVersion: 10, simulationVersion: world.simulationVersion, contentVersion: world.contentVersion,
      seed: world.seed, ...WORST_SAVE_METADATA, checksum: '00000000', payload: world };
    expect(result.measuredEnvelopeBytes).toBe(new TextEncoder().encode(canonicalStringify(envelope)).length);
    expect(result.measuredEnvelopeBytes).toBe(measureWorldSaveBytes(world, { saveVersion: 10 }));
    expect(result).toMatchObject({ supported: true, fits: true, actualFits: true, admitted: false, importAuthorized: false,
      eventualCompletionSupported: false, fullyFundedContinuation: false, terminalDischargeProved: false });
    expect(world.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(deriveV10BuildObligationFacts(world).activeRun).toBeNull();
    expect(inspectV10KnownRecordHeadroom(world)).toEqual([]);
    expect(canonicalStringify(world)).toBe(before); expect(Object.isFrozen(world)).toBe(false);
    expect(result.limits['legacy.estates']).toBe(world.disciples.length);
    expect(result.limits['legacy.archivedIdentities']).toBe(world.disciples.length);
    expect(result.current).not.toHaveProperty('productionReaderNodes');
    expect(result.current).not.toHaveProperty('researchReaderNodes');
    expect(result.current).not.toHaveProperty('maintenanceReaderNodes');
  });
  it('distinguishes current wire equality, one over, and unfunded reserves', () => {
    const source = records(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    // Synthetic sizing pressure; no claim that this diagnostic is a valid gameplay record.
    source.diagnostics[0]!.message = 'a'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(source, { saveVersion: 10 }));
    const equal = assessManagementCapacityV10(source);
    expect(equal.measuredEnvelopeBytes).toBe(SAVE_FILE_LIMIT_BYTES); expect(equal.actualFits).toBe(true); expect(equal.fits).toBe(false);
    expect(equal.deficits.some(value => value.dimension === 'wireBytes')).toBe(true);
    source.diagnostics[0]!.message += 'a';
    expect(assessManagementCapacityV10(source)).toMatchObject({ measuredEnvelopeBytes: SAVE_FILE_LIMIT_BYTES + 1, actualFits: false, reason: 'wire-cap' });
  });
  it('reports independent every-array and 300000-node build reader pressure on small wire input', () => {
    // Deliberately invalid extension: these are diagnostics, never root-valid saves.
    const source = records(); const object = source.builds as unknown as Record<string, unknown>;
    object.pressure = Array.from({ length: 31 }, () => Array(10_000).fill(0));
    object.wide = Array(16_385).fill(0);
    const result = assessManagementCapacityV10(source);
    expect(result.actualFits).toBe(true); expect(result.supported).toBe(false);
    expect(result.deficits.some(value => value.dimension === 'buildReaderNodes')).toBe(true);
    expect(result.deficits.find(value => value.dimension === 'buildArray.builds.wide')?.excess).toBe(1);
  });
  it('reports safe ID pressure independently of current bytes', () => {
    const source = records(); source.sequences.nextAction = Number.MAX_SAFE_INTEGER;
    const result = assessManagementCapacityV10(source);
    expect(result.actualFits).toBe(true); expect(result.fits).toBe(false);
    expect(result.deficits.some(value => value.dimension === 'sequence.nextAction')).toBe(true);
    expect(inspectV10KnownRecordHeadroom(source).some(value => value.includes('nextAction'))).toBe(true);
  });
  it('reports finite clock-row and cultivation-character pressure without accepting synthetic sources', () => {
    const clockPressure = records();
    clockPressure.cultivationClock = { transitions: Array.from({ length: 8192 }, () => ({
      kind: 'age-sync' as const, tick: 0, beforeRevision: 0, rootActionId: 'action:1',
    })) };
    const clock = assessManagementCapacityV10(clockPressure);
    expect(clock.actualFits).toBe(true); expect(clock.supported).toBe(false);
    expect(clock.deficits.find(value => value.dimension === 'cultivationClockTransitions')?.excess).toBe(clockPressure.disciples.length);
    // Synthetic unknown field: isolate the real UTF-16 reader dimension below
    // the 4 MiB wire ceiling without asserting this is an admissible save.
    const characters = records();
    (characters.cultivation as unknown as Record<string, unknown>).pressure = 'a'.repeat(4_000_000);
    const culture = assessManagementCapacityV10(characters);
    expect(culture.actualFits).toBe(true); expect(culture.fits).toBe(false);
    expect(culture.deficits.some(value => value.dimension === 'cultivationReaderCharacters')).toBe(true);
  });
  it('never accepts wrong identity, getters, aliases or caller-thrown error inspection', () => {
    const source = records(); let reads = 0;
    const getter = (): never => { reads++; throw new Error('Do not invoke'); };
    const root = Object.defineProperty(cloneJson(source), 'seed', { enumerable: true, get: getter });
    const nested = cloneJson(source); Object.defineProperty(nested.sectExpansion.upgrade, 'jobs', { enumerable: true, get: getter });
    const thrown = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const proxy = new Proxy({}, { ownKeys() { throw thrown; } });
    const alias = cloneJson(source); alias.disciples[1]!.position = alias.disciples[0]!.position;
    for (const value of [root, nested, proxy, alias, { ...source, simulationVersion: '0.9.0' },
      { ...source, contentIdentity: MANAGEMENT_V9_IDENTITY }, { ...source, contentVersion: 'unknown' }]) {
      expect(assessManagementCapacityV10(value as WorldStateV10)).toMatchObject({ supported: false, fits: false, admitted: false, importAuthorized: false });
    }
    expect(reads).toBe(0);
  });
  it('returns fresh diagnostics and does not freeze or mutate any caller data', () => {
    const source = records(); const before = canonicalStringify(source); const a = assessManagementCapacityV10(source);
    a.current.wireBytes = 0; a.unknowns.push('forged'); a.sourceRecordIssues.push('forged');
    const b = assessManagementCapacityV10(source);
    expect(b.current.wireBytes).toBe(measureWorldSaveBytes(source, { saveVersion: 10 })); expect(b.unknowns).toEqual([]);
    expect(b.sourceRecordIssues).toEqual([]); expect(canonicalStringify(source)).toBe(before);
    expect(Object.isFrozen(source.sectExpansion.upgrade)).toBe(false);
    expect(assessManagementCapacityV10(freeze(cloneJson(source)))).toEqual(b);
  });
  it('reserves finite phase-aware teaching H once and keeps the route proof explicitly missing', () => {
    const old = createUnregisteredWorldV9('v10-phase-aware');
    for (const id of ['entity:1', 'entity:2']) {
      const actor = old.disciples.find(value => value.id === id)!; const profile = old.cultivation.disciples.find(value => value.discipleId === id)!;
      actor.birthCalendarTick += 7; actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    }
    old.cultivation = createCultivationStateV3(old.cultivation.disciples.map(profile => profile.discipleId === 'entity:2'
      ? { ...profile, knowledge: [{ knowledgeId: 'knowledge.capacity', teacherId: null, teachingId: null }] } : profile));
    let world = records(old); for (let index = 0; index < 5; index++) world = prepareNormalTickCandidateV10(world);
    const prepared = prepareUnregisteredCommandCandidateV10(world, { kind: 'cultivation.command', commandId: 'capacity.teach',
      issuedTick: world.clock.simulationTick, sequence: 0, payload: { command: { kind: 'teaching.begin', commandId: 'capacity.teach',
        expectedRevision: world.cultivation.revision, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.capacity' } } });
    expect(prepared.result.status).toBe('accepted'); const result = equation(prepared.world);
    const horizon = 2 * CALENDAR_TICKS_PER_MONTH - 5;
    expect(result.clock).toMatchObject({ calendarTicks: horizon, monthRows: 2, ageSyncRows: 2 });
    expect(result.reserved['sect.constructionRevision']).toBe(horizon);
    expect(result.reserved['sect.productionRevision']).toBe(horizon);
    expect(result.reserved['sect.researchRevision']).toBe(horizon);
    expect(result.reserved['sequence.nextAction']).toBe(result.progression!.totals.sequenceReserve.nextAction + 2);
    expect(result.fullyFundedContinuation).toBe(false); expect(result.terminalDischargeProved).toBe(false);
  });
});

let old: WorldStateV9; let ready: WorldStateV10; let started: WorldStateV10; let complete: WorldStateV10;
describe('actual earned upgrade and L2 histories remain fully measured', () => {
  beforeAll(() => { old = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  }
  beforeAll(() => {
    const lifted = records(old);
    const research = sect(lifted, { domain: 'research', command: { kind: 'research.start', commandId: 'capacity.herbal',
      expectedRevision: lifted.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } });
    ready = until(research, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'capacity.upgrade',
      expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: ready.sectExpansion.construction.buildings.find(value => value.definitionId === 'alchemy.v9')!.buildingId } });
    complete = until(started, world => world.sectExpansion.upgrade.jobs[0]!.terminal !== null);
  }, 120000);
  it('funds one cancellation receipt/revision and complete evidence without inventing a 400-tick horizon', () => {
    const result = equation(started); expect(result.supported, result.sourceRecordIssues.join(';')).toBe(true);
    expect(result.fits).toBe(true);
    expect(result.reserved['sect.upgradeReceipts']).toBe(1); expect(result.reserved['sect.upgradeRevision']).toBe(1);
    expect(result.reserved['sect.upgradeNextId']).toBe(0); expect(result.clock!.calendarTicks).toBe(0);
    expect(result.costs['upgrade.sect-upgrade:1.siteVisits']).toBe(401);
    expect(result.costs['upgrade.sect-upgrade:1.workSpans']).toBe(400);
    expect(result.costs['upgrade.sect-upgrade:1.checkpoints']).toBe(2);
    const frame = projectV10SectFrame(started);
    expect(result.current.constructionReaderNodes).toBe(measureProgressionRecord(frame.construction).decodedNodes);
    expect(result.current.sectV10ReaderNodes).toBe(measureProgressionRecord(frame).decodedNodes);
    const constructionDelta = result.sect!.owners.reduce((sum, owner) => sum + Math.max(...owner.branches.map(branch =>
      branch.records.filter(record => record.label.startsWith('construction.') || record.label === 'paired-ledger' || record.label === 'World.worker.position+traveling')
        .reduce((nodes, record) => nodes + record.decodedNodes, 0))), 0);
    expect(result.reserved.constructionReaderNodes).toBe(constructionDelta);
    expect(result.reserved.constructionReaderNodes).toBeLessThan(result.reserved.sectV10ReaderNodes!);
  });
  it('retains immutable completion proof and counts each actual L2 maintenance candidate', () => {
    expect(complete.sectExpansion.construction.buildings).toEqual(ready.sectExpansion.construction.buildings);
    const result = equation(complete); expect(result.supported).toBe(true);
    expect(result.fits).toBe(true);
    expect(result.sect!.upgrade!.owners).toEqual([]); expect(result.reserved['sect.upgradeReceipts']).toBe(0);
    expect(result.measuredEnvelopeBytes).toBe(measureWorldSaveBytes(complete, { saveVersion: 10 }));
    // The next real paid period is optional candidate growth, never perpetual rent.
    const withL2 = until(complete, world => world.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2), 2400);
    const paid = equation(withL2); expect(paid.supported).toBe(true);
    expect(paid.fits).toBe(true);
    expect(paid.current['sect.maintenancePayments']).toBe(withL2.sectExpansion.maintenance.payments.length);
    expect(paid.reserved['sect.maintenancePayments']).toBe(0);
  }, 120000);
  it('removes only the real terminated owner reserve while retaining job, claim and receipt bytes', () => {
    const cancelled = sect(started, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'capacity.cancel',
      expectedRevision: started.sectExpansion.upgrade.revision, jobId: started.sectExpansion.upgrade.jobs[0]!.jobId } });
    const result = equation(cancelled); expect(result.supported).toBe(true);
    expect(result.fits).toBe(true);
    expect(result.current['sect.upgradeJobs']).toBe(1); expect(result.current['sect.upgradeReceipts']).toBe(2);
    expect(result.reserved['sect.upgradeReceipts']).toBe(0); expect(result.terminalDischargeProved).toBe(false);
    expect(result.measuredEnvelopeBytes).toBeLessThanOrEqual(equation(started).costs.wireBytes!);
  });
  it('keeps synthetic receipt/revision pressure separate from legal gameplay evidence', () => {
    const pressure = cloneJson(started); const receipt = pressure.sectExpansion.upgrade.receipts[0]!;
    pressure.sectExpansion = { ...pressure.sectExpansion, upgrade: { ...pressure.sectExpansion.upgrade,
      revision: Number.MAX_SAFE_INTEGER, receipts: Array.from({ length: 256 }, () => cloneJson(receipt)) } };
    const result = assessManagementCapacityV10(pressure);
    expect(result.actualFits).toBe(true); expect(result.supported).toBe(false);
    expect(result.deficits.find(value => value.dimension === 'sect.upgradeReceipts')?.excess).toBe(1);
    expect(result.deficits.find(value => value.dimension === 'sect.upgradeRevision')?.excess).toBe(1);
    expect(inspectV10KnownRecordHeadroom(pressure).some(value => value.includes('Upgrade terminal'))).toBe(true);
  });
});
