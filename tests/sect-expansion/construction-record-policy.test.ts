import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import type { InventoryEntry, ResourceId } from '../../src/core/economy/types';
import { cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand, createConstructionFrame, tickConstruction } from '../../src/core/sect-expansion/construction';
import { inspectConstructionProvenanceForRelocationOwner, validateConstructionRecords, validateUngatedConstructionRecords, validateWorldConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import type { ConstructionContext, ConstructionFrame, ConstructionResult, ConstructionValidationIssue } from '../../src/core/sect-expansion/construction-types';
import { validateConstructionFrame } from '../../src/core/sect-expansion/construction-validation';
import { captureSectHistoricalIdentitiesV8, type SectHistoricalIdentitySource } from '../../src/core/sect-expansion/history-identity';
import { applySectRelocationCommand, createSectRelocationRuntime, tickSectRelocation, validateSectRelocationRuntime } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectRelocationResult, SectRelocationRuntimeFrame } from '../../src/core/sect-expansion/relocation-runtime-types';
import type { SectRelocationRecordFrame } from '../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState, inspectRelocationProvenanceForOwner, validateSectRelocationRecords } from '../../src/core/sect-expansion/relocation-validation';
import { LEGACY_SECT_STATION_IDS } from '../../src/core/sect-expansion/types';
import { createWorldV8 } from '../../src/core/world/create-world-v8';

let historicalIdentities: SectHistoricalIdentitySource;
const oldConstructionInspectors = [validateConstructionFrame, validateUngatedConstructionRecords, validateConstructionRecords,
  (input: unknown) => validateWorldConstructionRecords(input, historicalIdentities)];
const constructionInspectors = [...oldConstructionInspectors, inspectConstructionProvenanceForRelocationOwner];
const relocationInspectors = [validateSectRelocationRecords, inspectRelocationProvenanceForOwner];
function issue(code: string, path: string): readonly ConstructionValidationIssue[] { return [{ code, path }]; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function context(frame: ConstructionFrame): ConstructionContext {
  return { simulationTick: frame.lastSimulationTick, calendarTick: frame.lastCalendarTick, mode: 'management', paused: false,
    expeditionActive: false, externalActiveJobs: 0, externalClaims: [] };
}
function accepted(result: ConstructionResult): ConstructionFrame {
  if (!result.ok) throw new Error(`Construction fixture: ${result.code}`); return result.frame;
}
function moved(result: SectRelocationResult): SectRelocationRuntimeFrame {
  if (!result.ok) throw new Error(`Relocation fixture: ${result.code}`); return result.frame;
}
function place(frame: ConstructionFrame, x: number): ConstructionFrame {
  return accepted(applyConstructionCommand(frame, context(frame), { kind: 'blueprint.place', commandId: `place.${frame.nextId}`,
    expectedRevision: frame.revision, placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } }));
}
function cancel(frame: ConstructionFrame): ConstructionFrame {
  return accepted(applyConstructionCommand(frame, context(frame), { kind: 'construction.cancel', commandId: 'cancel',
    expectedRevision: frame.revision, blueprintId: frame.blueprints[0]!.blueprintId }));
}
/** Same small local contract as construction-runtime.test, with two spare relocation payments.
 * Starting inventory is explicit fixture funding, not claimed earned World income. All visits,
 * work, payments, terminals and receipts below are produced by the real detached runtimes.
 * One construction and one relocation journey are shared; no full World/research chain runs.
 */
function seed(): ConstructionFrame {
  const entry = (resourceId: ResourceId, owned = 0): InventoryEntry => ({ resourceId, owned, reserved: 0, capacity: 99 });
  return createConstructionFrame({
    map: { width: 10, height: 6, seed: 'construction-record-policy', generationVersion: 1, navVersion: 0,
      tiles: Array.from({ length: 60 }, (_, n) => ({ x: n % 10, y: Math.floor(n / 10), terrain: 'grass', walkable: true })) },
    legacyStations: LEGACY_SECT_STATION_IDS.map((blueprintId, i) => ({ id: `legacy:${blueprintId}`, blueprintId,
      x: blueprintId === 'storage' ? 1 : i, y: blueprintId === 'storage' ? 4 : 5, operational: true })),
    people: [{ id: 'worker', position: { x: 0, y: 4 }, lifeState: 'alive', canWork: true, away: false,
      productionTransactionId: null, cultivationOwnerId: null, otherOwnerId: null },
    { id: 'mover', position: { x: 9, y: 4 }, lifeState: 'alive', canWork: true, away: false,
      productionTransactionId: null, cultivationOwnerId: null, otherOwnerId: null }],
    ledger: { inventory: { wood: entry('wood', 12), stone: entry('stone', 4), plank: entry('plank', 4),
      herbs: entry('herbs'), grain: entry('grain'), meal: entry('meal') }, stock: createEmptySectStock(), reservations: [] },
    simulationTick: 0, calendarTick: 0,
  });
}

let planned: ConstructionFrame;
let twoPlans: ConstructionFrame;
let halfPaid: ConstructionFrame;
let completed: ConstructionFrame;
let relocated: SectRelocationRuntimeFrame;
beforeAll(() => {
  // Genuine version-authenticated empty history, not a forged brand or claimed retired
  // construction actor. This matrix covers the World wrapper's fixed record policy;
  // retired-worker exceptions remain in world-authority-projection.test.
  historicalIdentities = captureSectHistoricalIdentitiesV8(createWorldV8('construction-record-policy-identities'));
  planned = freeze(place(seed(), 3)); twoPlans = freeze(place(planned, 7));
  let frame = accepted(applyConstructionCommand(planned, context(planned), { kind: 'construction.start', commandId: 'start',
    expectedRevision: planned.revision, blueprintId: planned.blueprints[0]!.blueprintId, workerId: 'worker' }));
  for (let n = 0; n < 400 && !frame.jobs[0]!.terminal; n++) {
    const ctx = { ...context(frame), simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1 };
    frame = accepted(tickConstruction(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
    if (frame.jobs[0]!.activeTicks === 160) halfPaid = freeze(cloneJson(frame));
  }
  expect(frame.jobs[0]!.terminal?.kind).toBe('completed'); completed = freeze(frame);
  let runtime = createSectRelocationRuntime({ construction: cloneJson(completed), relocation: createSectRelocationState() });
  runtime = moved(applySectRelocationCommand(runtime, context(runtime.records.construction), { kind: 'relocation.start',
    commandId: 'move', expectedRevision: 0, buildingId: completed.buildings[0]!.buildingId, workerId: 'worker',
    target: { definitionId: 'library.v9', anchor: { x: 6, y: 1 }, rotation: 0 } }));
  for (let n = 0; n < 400 && !runtime.records.relocation.jobs[0]!.terminal; n++) {
    const source = runtime.records.construction;
    const ctx = { ...context(source), simulationTick: source.lastSimulationTick + 1, calendarTick: source.lastCalendarTick + 1 };
    runtime = moved(tickSectRelocation(runtime, ctx, createWorkPathBudget(ctx.simulationTick)));
  }
  expect(runtime.records.relocation.jobs[0]!.terminal?.kind).toBe('completed'); relocated = freeze(runtime);
}, 30_000);

/** Deliberate record mutation: place an ordinary plan elsewhere through the old API, then
 * change only that plan and its matching placement receipt to the historical origin.
 * This is a partial-inspection specimen, NEVER evidence of a successful original-site
 * placement/rebuild command, historical occupancy admission, or a completed second building.
 */
function overlappingOrigin(source: ConstructionFrame): ConstructionFrame {
  const frame = place(source, 0); const bp = frame.blueprints.at(-1)!;
  const placement = { definitionId: bp.definitionId, anchor: completed.buildings[0]!.anchor, rotation: bp.rotation };
  return cloneJson({ ...frame, blueprints: frame.blueprints.map(p => p.blueprintId === bp.blueprintId ? { ...p, ...placement } : p),
    receipts: frame.receipts.map(r => r.relatedId === bp.blueprintId && r.command.kind === 'blueprint.place'
      ? { ...r, command: { ...r.command, placement } } : r) });
}
function overlapRecords(): SectRelocationRecordFrame {
  return cloneJson({ construction: overlappingOrigin(relocated.records.construction), relocation: relocated.records.relocation });
}

describe('frozen construction record policy', () => {
  const orderCases: readonly [string, (f: ConstructionFrame) => unknown, string, string][] = [
    ['fields before state and geometry', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, extra: true, status: 'started', anchor: { x: 9, y: 1 } }] }), 'INVALID_BLUEPRINT', 'blueprints'],
    ['state before geometry', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, status: 'started', anchor: { x: 9, y: 1 } }] }), 'INVALID_BLUEPRINT_STATE', 'sect-blueprint:1'],
    ['geometry before legacy overlap', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, anchor: { x: 0, y: 5 } }] }), 'INVALID_GEOMETRY', 'sect-blueprint:1'],
    ['first overlap before later fields', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, anchor: { x: 1, y: 2 } }, { ...f.blueprints[1]!, extra: true }] }), 'OVERLAPPING_CLAIMS', 'sect-blueprint:1'],
    ['first geometry before later fields', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, anchor: { x: 9, y: 1 } }, { ...f.blueprints[1]!, extra: true }] }), 'INVALID_GEOMETRY', 'sect-blueprint:1'],
    ['second fields before its state', f => ({ ...f, blueprints: [f.blueprints[0]!, { ...f.blueprints[1]!, extra: true, status: 'started' }] }), 'INVALID_BLUEPRINT', 'blueprints'],
    ['second overlap before later jobs', f => ({ ...f, blueprints: [f.blueprints[0]!, { ...f.blueprints[1]!, anchor: f.blueprints[0]!.anchor }], jobs: [null] }), 'OVERLAPPING_CLAIMS', 'sect-blueprint:2'],
  ];
  it.each(orderCases)('retains exact loop order: %s', (_label, change, code, path) => {
    const input = cloneJson(change(twoPlans));
    for (const inspect of oldConstructionInspectors) expect(inspect(input)).toEqual(issue(code, path));
    expect(validateSectRelocationRecords({ construction: input, relocation: createSectRelocationState() })).toEqual(issue(code, path));
  });
  it('cancelled unstarted plans release the old claim and allow an actual fresh plan at that place', () => {
    const cancelled = cancel(planned); const replacement = place(cancelled, 3);
    expect(replacement.blueprints.map(bp => bp.status)).toEqual(['cancelled', 'planned']);
    expect(replacement.jobs).toEqual([]); expect(replacement.buildings).toEqual([]);
    for (const inspect of constructionInspectors) expect(inspect(replacement)).toEqual([]);
  });
  it.each([
    ['missing end', { endedTick: null }, 'INVALID_BLUEPRINT_STATE'],
    ['out-of-map geometry', { anchor: { x: 9, y: 1 } }, 'INVALID_GEOMETRY'],
    ['unknown field', { extra: true }, 'INVALID_BLUEPRINT'],
  ] as const)('cancelled plans still reject %s', (_label, patch, code) => {
    const frame = cancel(planned); const input = { ...frame, blueprints: [{ ...frame.blueprints[0]!, ...patch }] };
    for (const inspect of constructionInspectors) expect(inspect(input)).toEqual(issue(code, code === 'INVALID_BLUEPRINT' ? 'blueprints' : 'sect-blueprint:1'));
  });
  it('retains half-payment cancellation, unpaid release, and real terminal position', () => {
    const frame = cancel(halfPaid); const job = frame.jobs[0]!;
    expect(frame.people).toEqual(halfPaid.people);
    expect(job.terminal?.position).toEqual(halfPaid.people.find(person => person.id === job.workerId)!.position);
    expect(job.terminal?.consumed).toEqual([
      { ledger: 'base', resourceId: 'wood', quantity: 4 }, { ledger: 'base', resourceId: 'stone', quantity: 2 }, { ledger: 'base', resourceId: 'plank', quantity: 2 },
    ]);
    expect(job.terminal?.released).toEqual(job.terminal?.consumed);
    for (const inspect of constructionInspectors) expect(inspect(frame)).toEqual([]);
    const forged = { ...frame, jobs: [{ ...job, terminal: { ...job.terminal!, released: [] } }] };
    for (const inspect of constructionInspectors) expect(inspect(forged)).toEqual(issue('INVALID_CANCELLATION', job.jobId));
  });
  it('keeps alchemy consumer references shape-only while ungated entry points still reject them', () => {
    // Authored local reference shape deliberately has no research completion behind it.
    const placement = { definitionId: 'alchemy.v9' as const, anchor: { x: 3, y: 1 }, rotation: 0 as const };
    const input = cloneJson({ ...planned, blueprints: [{ ...planned.blueprints[0]!, ...placement,
      researchGate: { researchId: 'basic-medicine.v9', completionJobId: 'sect-research:1' } }],
    receipts: planned.receipts.map(r => ({ ...r, command: { ...r.command, placement } })) });
    expect(validateConstructionRecords(input)).toEqual([]);
    expect(validateWorldConstructionRecords(input, historicalIdentities)).toEqual([]);
    expect(inspectConstructionProvenanceForRelocationOwner(input)).toEqual([]);
    expect(validateConstructionFrame(input)).toEqual(issue('INVALID_BLUEPRINT', 'blueprints'));
    expect(validateUngatedConstructionRecords(input)).toEqual(issue('INVALID_BLUEPRINT', 'blueprints'));
  });
  it.each([
    ['missing alchemy gate', { definitionId: 'alchemy.v9' }],
    ['malformed alchemy gate', { definitionId: 'alchemy.v9', researchGate: { researchId: 'basic-medicine.v9', completionJobId: 'invented' } }],
    ['unrequested library gate', { researchGate: { researchId: 'basic-medicine.v9', completionJobId: 'sect-research:1' } }],
  ] as const)('rejects %s in every construction entry point', (_label, patch) => {
    const input = { ...planned, blueprints: [{ ...planned.blueprints[0]!, ...patch }] };
    for (const inspect of constructionInspectors) expect(inspect(input)).toEqual(issue('INVALID_BLUEPRINT', 'blueprints'));
  });
});

describe('descriptor and exact-shape fences', () => {
  it.each(['root', 'nested', 'array-index'] as const)('rejects %s getters without invoking them', position => {
    const input = cloneJson(planned); let reads = 0;
    const target = position === 'root' ? input : position === 'nested' ? input.blueprints[0]! : input.blueprints;
    const key = position === 'root' ? 'jobs' : position === 'nested' ? 'anchor' : '0';
    Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { reads++; return null; } });
    for (const inspect of constructionInspectors) expect(inspect(input)).toEqual(issue('INVALID_SHAPE', 'frame'));
    for (const inspect of relocationInspectors) expect(inspect({ construction: input, relocation: createSectRelocationState() }))
      .toEqual(issue('INVALID_RELOCATION_SHAPE', 'relocation'));
    expect(reads).toBe(0);
  });
  it.each(['blueprints', 'jobs', 'receipts'] as const)('rejects sparse %s before record reads', key => {
    const input = { ...planned, [key]: Array(2) };
    for (const inspect of constructionInspectors) expect(inspect(input)).toEqual(issue('INVALID_SHAPE', 'frame'));
    for (const inspect of relocationInspectors) expect(inspect({ construction: input, relocation: createSectRelocationState() }))
      .toEqual(issue('INVALID_RELOCATION_SHAPE', 'relocation'));
  });
  it('rejects unknown root fields rather than treating them as exemption options', () => {
    const input = { ...planned, skipSpatialValidation: true };
    for (const inspect of constructionInspectors) expect(inspect(input)).toEqual(issue('INVALID_SHAPE', 'frame'));
    for (const inspect of relocationInspectors) expect(inspect({ construction: planned, relocation: createSectRelocationState(), skipSpatialValidation: true }))
      .toEqual(issue('INVALID_RELOCATION_SHAPE', 'relocation'));
  });
});

describe('fixed partial provenance leaves are not owner admission', () => {
  it('accepts genuine unchanged local history and preserves immutable construction origin', () => {
    for (const inspect of constructionInspectors) expect(inspect(completed)).toEqual([]);
    for (const inspect of relocationInspectors) expect(inspect(relocated.records)).toEqual([]);
    expect(relocated.records.construction.buildings).toEqual(completed.buildings);
    expect(relocated.records.construction.jobs).toEqual(completed.jobs);
    expect(relocated.records.relocation.jobs[0]!.to.anchor).toEqual({ x: 6, y: 1 });
    expect(completed.buildings[0]!.anchor).toEqual({ x: 3, y: 1 });
  });
  it.each(['without a move', 'after a genuine move'] as const)('omits permanent-origin overlap %s without certifying space', stage => {
    const records = stage === 'without a move'
      ? { construction: overlappingOrigin(completed), relocation: createSectRelocationState() } : overlapRecords();
    const original = cloneJson(records); const bp = records.construction.blueprints.at(-1)!;
    for (const inspect of oldConstructionInspectors) expect(inspect(records.construction)).toEqual(issue('OVERLAPPING_CLAIMS', bp.blueprintId));
    expect(validateSectRelocationRecords(records)).toEqual(issue('OVERLAPPING_CLAIMS', bp.blueprintId));
    expect(inspectConstructionProvenanceForRelocationOwner(freeze(records.construction))).toEqual([]);
    expect(inspectRelocationProvenanceForOwner(freeze(records))).toEqual([]);
    // Even the no-move specimen passes partial inspection: temporal/current occupancy is
    // deliberately unproved. The unchanged complete detached runtime still rejects it.
    expect(validateSectRelocationRuntime({ records, live: [] })).toEqual(['INVALID_RECORDS']);
    expect(records).toEqual(original); expect(records.construction.buildings).toHaveLength(1);
    expect(bp.status).toBe('planned'); expect(bp.jobId).toBeNull();
  });
  const constructionFaults: readonly [string, (f: ConstructionFrame) => unknown, string, string][] = [
    ['identity', f => ({ ...f, schemaVersion: 2 }), 'INVALID_IDENTITY', 'frame'],
    ['map', f => ({ ...f, map: { ...f.map, tiles: [] } }), 'INVALID_MAP', 'map'],
    ['blueprint fields', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, extra: true }, f.blueprints[1]!] }), 'INVALID_BLUEPRINT', 'blueprints'],
    ['blueprint state', f => ({ ...f, blueprints: [{ ...f.blueprints[0]!, status: 'started' }, f.blueprints[1]!] }), 'INVALID_BLUEPRINT_STATE', 'sect-blueprint:1'],
    ['geometry', f => ({ ...f, blueprints: [f.blueprints[0]!, { ...f.blueprints[1]!, anchor: { x: 9, y: 1 } }] }), 'INVALID_GEOMETRY', 'sect-blueprint:5'],
    ['source job', f => ({ ...f, jobs: [{ ...f.jobs[0]!, entranceToken: '0,0' }] }), 'INVALID_JOB_SOURCE', 'sect-construction:2'],
    ['work evidence', f => ({ ...f, jobs: [{ ...f.jobs[0]!, activeTicks: 319 }] }), 'INVALID_WORK_EVIDENCE', 'sect-construction:2'],
    ['paid reservation', f => ({ ...f, ledger: { ...f.ledger, reservations: f.ledger.reservations.filter(r => r.ownerTransactionId !== f.jobs[0]!.jobId) } }), 'INVALID_COST_SOURCE', 'sect-construction:2'],
    ['immutable building source', f => ({ ...f, buildings: [{ ...f.buildings[0]!, anchor: { x: 6, y: 1 } }] }), 'INVALID_BUILDING_SOURCE', 'sect-building:4'],
    ['receipt', f => ({ ...f, receipts: f.receipts.slice(1) }), 'MISSING_RECEIPT', 'sect-blueprint:1'],
  ];
  it.each(constructionFaults)('still rejects construction %s after omitting overlap', (_label, change, code, path) => {
    const records = overlapRecords(); const input = cloneJson(change(records.construction));
    expect(inspectConstructionProvenanceForRelocationOwner(input)).toEqual(issue(code, path));
    expect(inspectRelocationProvenanceForOwner({ construction: input, relocation: records.relocation })).toEqual(issue(code, path));
  });
  it('checks relocation worker existence independently of the preserved construction worker', () => {
    const runtime = createSectRelocationRuntime({ construction: cloneJson(completed), relocation: createSectRelocationState() });
    const started = moved(applySectRelocationCommand(runtime, context(runtime.records.construction), { kind: 'relocation.start',
      commandId: 'independent-worker.move', expectedRevision: 0, buildingId: completed.buildings[0]!.buildingId, workerId: 'mover',
      target: { definitionId: 'library.v9', anchor: { x: 6, y: 1 }, rotation: 0 } }));
    expect(started.records.relocation.jobs[0]!.workerId).toBe('mover');
    const input = cloneJson({ ...started.records, construction: { ...started.records.construction,
      people: started.records.construction.people.filter(person => person.id !== 'mover') } });
    expect(input.construction.people.some(person => person.id === input.construction.jobs[0]!.workerId)).toBe(true);
    for (const inspect of constructionInspectors) expect(inspect(input.construction)).toEqual([]);
    for (const inspect of relocationInspectors) expect(inspect(input)).toEqual(issue('INVALID_RELOCATION_WORKER', 'sect-relocation:1'));
  });
  const relocationFaults: readonly [string, (f: SectRelocationRecordFrame) => unknown, string, string][] = [
    ['domain', f => ({ ...f, relocation: { ...f.relocation, nextId: 99 } }), 'INVALID_RELOCATION_DOMAIN', 'relocation'],
    ['receipt', f => ({ ...f, relocation: { ...f.relocation, receipts: [] } }), 'INVALID_RELOCATION_RECEIPT_COUNT', 'sect-relocation:1'],
    ['construction worker existence', f => ({ ...f, construction: { ...f.construction, people: [] } }), 'INVALID_JOB', 'jobs'],
    ['construction binding', f => ({ ...f, relocation: { ...f.relocation, jobs: [{ ...f.relocation.jobs[0]!, sourceJobId: 'missing' }] } }), 'INVALID_RELOCATION_CONSTRUCTION_SOURCE', 'sect-relocation:1'],
    ['position chain', f => ({ ...f, relocation: { ...f.relocation, jobs: [{ ...f.relocation.jobs[0]!, previousRelocationJobId: 'sect-relocation:99' }] } }), 'INVALID_RELOCATION_POSITION_CHAIN', 'sect-relocation:1'],
    ['work count', f => ({ ...f, relocation: { ...f.relocation, jobs: [{ ...f.relocation.jobs[0]!, activeTicks: 199 }] } }), 'INVALID_RELOCATION_WORK_COUNT', 'sect-relocation:1'],
    ['paired payment', f => ({ ...f, construction: { ...f.construction, ledger: { ...f.construction.ledger,
      reservations: f.construction.ledger.reservations.filter(r => r.ownerTransactionId !== f.relocation.jobs[0]!.jobId) } } }), 'INVALID_RELOCATION_COST_SOURCE', 'sect-relocation:1'],
    ['revision chronology', f => ({ ...f, relocation: { ...f.relocation, revision: f.relocation.revision + 1 } }), 'INVALID_RELOCATION_REVISION_CHRONOLOGY', 'relocation'],
  ];
  it.each(relocationFaults)('still rejects relocation %s after omitting overlap', (_label, change, code, path) => {
    const records = overlapRecords(); const input = cloneJson(change(records));
    expect(inspectRelocationProvenanceForOwner(input)).toEqual(issue(code, path));
  });
});
