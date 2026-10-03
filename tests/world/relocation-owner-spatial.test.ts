import { beforeAll, describe, expect, it } from 'vitest';
import { isWalkable } from '../../src/core/agents/navigation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand, tickConstruction } from '../../src/core/sect-expansion/construction';
import { inspectConstructionProvenanceForRelocationOwner, validateConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import type { ConstructionContext, ConstructionFrame, ConstructionReceipt } from '../../src/core/sect-expansion/construction-types';
import { applySectRelocationCommand, createSectRelocationRuntime, tickSectRelocation } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectRelocationResult, SectRelocationRuntimeFrame } from '../../src/core/sect-expansion/relocation-runtime-types';
import type { SectRelocationRecordFrame } from '../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState, inspectRelocationProvenanceForOwner } from '../../src/core/sect-expansion/relocation-validation';
import { inspectRelocationOwnerSpatialRecords, relocationOwnerCurrentSpatialContext, relocationOwnerEffectiveMap,
  relocationOwnerPlacementAt } from '../../src/core/world/relocation-owner/spatial-records';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import { fixturePlace, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture } from '../sect-expansion/fixtures/v9-runtime';

let original: ConstructionFrame;
let begun: SectRelocationRuntimeFrame;
let half: SectRelocationRuntimeFrame;
let almost: SectRelocationRuntimeFrame;
let waiting: SectRelocationRuntimeFrame;
let moved: SectRelocationRuntimeFrame;
let returned: SectRelocationRuntimeFrame;
let selfOverlap: SectRelocationRuntimeFrame;
let builtElsewhere: SectRelocationRecordFrame;
const request = (x: number) => ({ definitionId: 'library.v9' as const, anchor: { x, y: 1 }, rotation: 0 as const });
function unwrap(result: SectRelocationResult): SectRelocationRuntimeFrame {
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function context(frame: ConstructionFrame): ConstructionContext {
  return { simulationTick: frame.lastSimulationTick, calendarTick: frame.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [] };
}
function start(frame: SectRelocationRuntimeFrame, x = 4): SectRelocationRuntimeFrame {
  return unwrap(applySectRelocationCommand(frame, context(frame.records.construction), { kind: 'relocation.start',
    commandId: `move.${frame.records.relocation.nextId}`, expectedRevision: frame.records.relocation.revision,
    buildingId: original.buildings[0]!.buildingId, workerId: original.jobs[0]!.workerId, target: request(x) }));
}
function step(frame: SectRelocationRuntimeFrame): SectRelocationRuntimeFrame {
  const c = context(frame.records.construction);
  const next = { ...c, simulationTick: c.simulationTick + 1, calendarTick: c.calendarTick + 1 };
  return unwrap(tickSectRelocation(frame, next, createWorkPathBudget(next.simulationTick)));
}
function until(frame: SectRelocationRuntimeFrame, done: (f: SectRelocationRuntimeFrame) => boolean): SectRelocationRuntimeFrame {
  let next = frame;
  for (let n = 0; n < 1800 && !done(next); n++) next = step(next);
  if (!done(next)) throw new Error('Relocation fixture did not finish'); return next;
}
function cancel(frame: SectRelocationRuntimeFrame): SectRelocationRuntimeFrame {
  return unwrap(applySectRelocationCommand(frame, context(frame.records.construction), { kind: 'relocation.cancel',
    commandId: `cancel.${frame.records.relocation.nextId}`, expectedRevision: frame.records.relocation.revision,
    jobId: frame.records.relocation.jobs.at(-1)!.jobId }));
}
function seed(): SectRelocationRuntimeFrame { return createSectRelocationRuntime({ construction: cloneJson(original), relocation: createSectRelocationState() }); }
function map(frame: SectRelocationRecordFrame) {
  const result = relocationOwnerEffectiveMap(frame); if (!result.ok) throw new Error(JSON.stringify(result.issues)); return result.map;
}
function issue(frame: unknown): string | null {
  const result = inspectRelocationOwnerSpatialRecords(frame); return result.ok ? null : result.issues[0]!.code;
}
/** Hand-authored RECORD-ONLY placement/cancellation boundary. This does not claim
 * that the frozen construction runtime can place or build on a vacated origin. */
function appendBlueprint(input: SectRelocationRecordFrame, x: number, placedTick: number, endedTick: number | null = null): SectRelocationRecordFrame {
  const f = cloneJson(input); const c = f.construction; const id = `sect-blueprint:${c.nextId}`;
  const receipts: ConstructionReceipt[] = [...c.receipts, { command: { kind: 'blueprint.place',
    commandId: `place.${id}`, expectedRevision: c.revision, placement: request(x) }, revision: c.revision + 1, relatedId: id }];
  if (endedTick !== null) receipts.push({ command: { kind: 'construction.cancel', commandId: `cancel.${id}`,
    expectedRevision: c.revision + 1, blueprintId: id }, revision: c.revision + 2, relatedId: id });
  return cloneJson({ ...f, construction: { ...c, nextId: c.nextId + 1, revision: c.revision + (endedTick === null ? 1 : 2),
    blueprints: [...c.blueprints, { ...request(x), blueprintId: id, placedTick,
      placedCalendarTick: placedTick - (c.lastSimulationTick - c.lastCalendarTick), status: endedTick === null ? 'planned' : 'cancelled', jobId: null, endedTick }],
    receipts } });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
/** Genuine local construction at x10, where old/new placements do not collide.
 * This is detached domain evidence, not integrated relocation-owner execution. */
function constructElsewhere(frame: SectRelocationRecordFrame, finish: boolean): SectRelocationRecordFrame {
  let c = cloneJson(frame.construction);
  const placed = applyConstructionCommand(c, context(c), { kind: 'blueprint.place', commandId: 'second.place', expectedRevision: c.revision, placement: request(10) });
  if (!placed.ok) throw new Error(placed.code); c = placed.frame;
  const started = applyConstructionCommand(c, context(c), { kind: 'construction.start', commandId: 'second.start', expectedRevision: c.revision,
    blueprintId: c.blueprints.at(-1)!.blueprintId, workerId: original.jobs[0]!.workerId });
  if (!started.ok) throw new Error(started.code); c = started.frame;
  for (let n = 0; finish && !c.jobs.at(-1)!.terminal && n < 1800; n++) {
    const next = { ...context(c), simulationTick: c.lastSimulationTick + 1, calendarTick: c.lastCalendarTick + 1 };
    const result = tickConstruction(c, next, createWorkPathBudget(next.simulationTick));
    if (!result.ok) throw new Error(result.code); c = result.frame;
  }
  if (finish && !c.jobs.at(-1)!.terminal) throw new Error('Second construction did not finish');
  return { construction: c, relocation: cloneJson(frame.relocation) };
}
beforeAll(() => {
  // Main fixture is real catalog-backed library (1,1), real travel and paid work,
  // followed by detached runtime relocation to (4,1), with wood 1+1 and 200 work.
  const world = fixtureUntil(fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1)),
    w => w.sectExpansion.construction.jobs.at(-1)!.terminal?.kind === 'completed');
  original = cloneJson(projectV9SectFrame(world).construction);
  begun = start(seed());
  half = until(begun, f => f.records.relocation.jobs[0]!.activeTicks === 100);
  almost = until(half, f => f.records.relocation.jobs[0]!.activeTicks === 199);
  const workerId = original.jobs[0]!.workerId;
  const blocker = almost.records.construction.people.find(p => p.id !== workerId)!;
  const blocked = cloneJson({ ...almost, records: { ...almost.records, construction: { ...almost.records.construction,
    people: almost.records.construction.people.map(p => p.id === blocker.id ? { ...p, position: { x: 4, y: 1 }, away: false } : p) } } });
  waiting = step(blocked);
  moved = step(almost);
  returned = until(start(moved, 1), f => f.records.relocation.jobs[1]!.terminal?.kind === 'completed');
  selfOverlap = until(start(seed(), 2), f => f.records.relocation.jobs[0]!.terminal?.kind === 'completed');
  builtElsewhere = constructElsewhere(moved.records, true);
}, 120_000);

describe('internal relocation spatial records (not complete owner admission)', () => {
  it('certifies only bounded historical occupancy/static geometry and current layout', () => {
    expect(inspectRelocationOwnerSpatialRecords(moved.records)).toEqual({ ok: true, scope: 'relocation-spatial-records' });
    expect(moved.records.relocation.jobs[0]!.activeTicks).toBe(200);
    expect(moved.records.relocation.jobs[0]!.checkpoints.map(c => c.activeTicks)).toEqual([100, 200]);
    expect(moved.records.relocation.jobs[0]!.terminal!.consumed).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }]);
    expect(moved.records.construction.blueprints).toEqual(original.blueprints);
    expect(moved.records.construction.jobs).toEqual(original.jobs);
    expect(moved.records.construction.buildings).toEqual(original.buildings);
  });
  it('releases old ground only at successful commit and distinguishes exact relocation phase', () => {
    const j = moved.records.relocation.jobs[0]!; const tick = j.terminal!.tick;
    const before = relocationOwnerPlacementAt(moved.records, j.buildingId, { tick, phase: 'relocation', side: 'before' });
    const after = relocationOwnerPlacementAt(moved.records, j.buildingId, { tick, phase: 'relocation', side: 'after' });
    expect(before.ok && before.placement?.anchor).toEqual({ x: 1, y: 1 });
    expect(after.ok && after.placement?.anchor).toEqual({ x: 4, y: 1 });
    expect(after.ok && after.placement?.sourceJobId).toBe(original.buildings[0]!.sourceJobId);
    expect(after.ok && after.placement?.firstMaintenanceCalendarTick).toBe(original.buildings[0]!.firstMaintenanceCalendarTick);
    expect(isWalkable(map(moved.records), { x: 1, y: 1 })).toBe(true);
    expect(isWalkable(map(moved.records), { x: 4, y: 1 })).toBe(false);
  });
  it('makes construction completion visible before relocation but not before construction', () => {
    const b = original.buildings[0]!;
    expect(relocationOwnerPlacementAt(moved.records, b.buildingId, { tick: b.completedTick, phase: 'construction', side: 'before' }))
      .toEqual({ ok: true, placement: null });
    const after = relocationOwnerPlacementAt(moved.records, b.buildingId, { tick: b.completedTick, phase: 'construction', side: 'after' });
    expect(after.ok && after.placement?.anchor).toEqual({ x: 1, y: 1 });
    const later = relocationOwnerPlacementAt(moved.records, b.buildingId, { tick: b.completedTick, phase: 'relocation', side: 'before' });
    expect(later).toEqual(after);
  });
  it.each([0, 100, 199, 200])('keeps original hard occupancy at %i uncommitted work and after cancellation', work => {
    const f = work === 0 ? begun : work === 100 ? half : work === 199 ? almost : waiting;
    for (const records of [f.records, cancel(f).records]) {
      expect(issue(records)).toBeNull();
      expect(isWalkable(map(records), { x: 1, y: 1 })).toBe(false);
      expect(isWalkable(map(records), { x: 4, y: 1 })).toBe(true);
    }
  });
  it('allows a person at the waiting target without turning the soft target into a wall', () => {
    expect(waiting.records.relocation.jobs[0]!.phase).toBe('waiting-completion');
    const view = relocationOwnerCurrentSpatialContext(waiting.records);
    expect(view.ok).toBe(true); if (!view.ok) return;
    expect(view.softTargets).toHaveLength(1);
    expect(view.context.blueprints).toEqual([]);
    expect(view.context.spaces.filter(s => s.kind === 'placed')).toHaveLength(1);
    expect(isWalkable(map(waiting.records), { x: 4, y: 1 })).toBe(true);
  });
  it('permits own partial overlap and repeated moves back to the immutable origin', () => {
    expect(issue(selfOverlap.records)).toBeNull(); expect(issue(returned.records)).toBeNull();
    expect(isWalkable(map(selfOverlap.records), { x: 1, y: 1 })).toBe(true);
    expect(isWalkable(map(selfOverlap.records), { x: 2, y: 1 })).toBe(false);
    expect(isWalkable(map(returned.records), { x: 1, y: 1 })).toBe(false);
    expect(isWalkable(map(returned.records), { x: 4, y: 1 })).toBe(true);
    expect(returned.records.construction.buildings).toEqual(original.buildings);
  });
  it('accepts a record-only blueprint command after the commit phase of the same tick', () => {
    const f = appendBlueprint(moved.records, 1, moved.records.relocation.jobs[0]!.terminal!.tick);
    expect(inspectConstructionProvenanceForRelocationOwner(f.construction)).toEqual([]);
    expect(validateConstructionRecords(f.construction)[0]!.code).toBe('OVERLAPPING_CLAIMS');
    expect(issue(f)).toBeNull(); expect(isWalkable(map(f), { x: 1, y: 1 })).toBe(true);
    const result = relocationOwnerCurrentSpatialContext(f);
    expect(result.ok && result.context.blueprints).toHaveLength(1);
  });
  it('rejects a forged earlier blueprint on old ground despite a valid current map', () => {
    const tick = moved.records.relocation.jobs[0]!.terminal!.tick;
    const f = appendBlueprint(moved.records, 1, tick - 1);
    expect(inspectRelocationProvenanceForOwner(f)).toEqual([]);
    expect(issue(f)).toBe('HISTORICAL_SPATIAL_CONFLICT');
  });
  it('does not allow cancellation to vacate the original building', () => {
    const f = cancel(almost).records;
    expect(issue(appendBlueprint(f, 1, f.construction.lastSimulationTick))).toBe('HISTORICAL_SPATIAL_CONFLICT');
  });
  it('checks ended soft targets against cancelled blueprint history', () => {
    const f = cancel(almost).records; const tick = f.relocation.jobs[0]!.startedTick;
    const forged = appendBlueprint(f, 4, tick + 1, tick + 2);
    expect(inspectRelocationProvenanceForOwner(forged)).toEqual([]);
    expect(issue(forged)).toBe('HISTORICAL_SPATIAL_CONFLICT');
  });
  it('rejects cross-domain cancel/reuse at the same tick as explicitly ambiguous', () => {
    const f = cancel(almost).records;
    const ambiguous = appendBlueprint(f, 4, f.construction.lastSimulationTick);
    expect(inspectRelocationProvenanceForOwner(ambiguous)).toEqual([]);
    expect(issue(ambiguous)).toBe('AMBIGUOUS_SPATIAL_BOUNDARY');
    // Revision magnitude cannot turn unrelated journals into one command order.
    const c = ambiguous.construction;
    const increased = cloneJson({ ...ambiguous, construction: { ...c, revision: c.revision + 1000,
      receipts: c.receipts.map(r => ({ ...r, revision: r.revision + 1000, command: { ...r.command, expectedRevision: r.command.expectedRevision + 1000 } })) } });
    expect(issue(increased)).toBe('AMBIGUOUS_SPATIAL_BOUNDARY');
  });
  it('also rejects blueprint cancellation at the relocation-start tick without shared order', () => {
    const tick = begun.records.relocation.jobs[0]!.startedTick;
    const f = appendBlueprint(begun.records, 4, tick - 1, tick);
    expect(inspectRelocationProvenanceForOwner(f)).toEqual([]);
    expect(issue(f)).toBe('AMBIGUOUS_SPATIAL_BOUNDARY');
  });
  it('checks simultaneous movers and retains their cancelled soft-target history', () => {
    const first = start(createSectRelocationRuntime(cloneJson(builtElsewhere)), 1);
    const secondBuilding = builtElsewhere.construction.buildings[1]!;
    const worker = builtElsewhere.construction.people.find(p => p.id !== original.jobs[0]!.workerId && p.canWork && p.lifeState === 'alive')!;
    const two = unwrap(applySectRelocationCommand(first, context(first.records.construction), { kind: 'relocation.start',
      commandId: 'second.move', expectedRevision: first.records.relocation.revision,
      buildingId: secondBuilding.buildingId, workerId: worker.id, target: request(12) }));
    expect(issue(two.records)).toBeNull();
    const view = relocationOwnerCurrentSpatialContext(two.records);
    expect(view.ok && view.softTargets).toHaveLength(2);
    const secondCancelled = cancel(two);
    const firstJob = two.records.relocation.jobs.at(-2)!;
    const bothCancelled = unwrap(applySectRelocationCommand(secondCancelled, context(secondCancelled.records.construction), {
      kind: 'relocation.cancel', commandId: 'first.cancel', expectedRevision: secondCancelled.records.relocation.revision, jobId: firstJob.jobId }));
    expect(issue(bothCancelled.records)).toBeNull();
    const secondJob = two.records.relocation.jobs.at(-1)!;
    for (const records of [two.records, bothCancelled.records]) {
      const forged = cloneJson({ ...records, relocation: { ...records.relocation,
        jobs: records.relocation.jobs.map(j => j.jobId === secondJob.jobId ? { ...j, to: request(1) } : j),
        receipts: records.relocation.receipts.map(r => r.jobId === secondJob.jobId && r.command.kind === 'relocation.start'
          ? { ...r, command: { ...r.command, target: request(1) } } : r) } });
      expect(inspectRelocationProvenanceForOwner(forged)).toEqual([]);
      expect(issue(forged)).toBe('HISTORICAL_SPATIAL_CONFLICT');
    }
  });
  it('requires same-domain receipt revisions to agree with fixed completion-before-command phases', () => {
    const returnedNow = until(start(createSectRelocationRuntime(cloneJson(builtElsewhere)), 1),
      f => f.records.relocation.jobs[1]!.terminal?.kind === 'completed');
    const secondBuilding = builtElsewhere.construction.buildings[1]!;
    const worker = builtElsewhere.construction.people.find(p => p.id !== original.jobs[0]!.workerId && p.canWork && p.lifeState === 'alive')!;
    const reused = unwrap(applySectRelocationCommand(returnedNow, context(returnedNow.records.construction), {
      kind: 'relocation.start', commandId: 'reuse.after.commit', expectedRevision: returnedNow.records.relocation.revision,
      buildingId: secondBuilding.buildingId, workerId: worker.id, target: request(4) }));
    const committed = reused.records.relocation.jobs[1]!; const started = reused.records.relocation.jobs[2]!;
    expect(committed.terminal!.tick).toBe(started.startedTick);
    expect(committed.terminal!.revision).toBe(4);
    expect(issue(reused.records)).toBeNull();
    // Keep real geometry, ticks, ledger and work intact. Swap ONLY the actual
    // journal revisions, making B's target claim precede A's vacancy in-domain.
    const forged = cloneJson({ ...reused.records, relocation: { ...reused.records.relocation,
      jobs: reused.records.relocation.jobs.map(j => j.jobId === committed.jobId ? { ...j, terminal: { ...j.terminal!, revision: 5 } } : j),
      receipts: reused.records.relocation.receipts.map(r => r.jobId === started.jobId && r.command.kind === 'relocation.start'
        ? { ...r, revision: 4, command: { ...r.command, expectedRevision: 3 } } : r) } });
    expect(inspectRelocationProvenanceForOwner(forged)).toEqual([]);
    expect(issue(forged)).toBe('INVALID_SPATIAL_CHRONOLOGY');
  });
  it('does not reject nonintersecting cross-domain same-tick cancellation/placement', () => {
    const f = cancel(almost).records;
    expect(issue(appendBlueprint(f, 10, f.construction.lastSimulationTick))).toBeNull();
  });
  it('does not erase same-tick place/cancel claims into an empty tick interval', () => {
    const f = cancel(almost).records; const tick = f.relocation.jobs[0]!.startedTick + 1;
    expect(issue(appendBlueprint(f, 4, tick, tick))).toBe('HISTORICAL_SPATIAL_CONFLICT');
  });
  it('uses same-domain receipt order for same-tick cancelled blueprint reuse', () => {
    const tick = moved.records.construction.lastSimulationTick;
    const first = appendBlueprint(moved.records, 10, tick, tick);
    const second = appendBlueprint(first, 10, tick);
    expect(issue(second)).toBeNull();
    const c = second.construction; const receipts = c.receipts.slice();
    const cancelIndex = receipts.length - 2; const placeIndex = receipts.length - 1;
    const cancelReceipt = receipts[cancelIndex]!; const placeReceipt = receipts[placeIndex]!;
    receipts[cancelIndex] = { ...cancelReceipt, revision: placeReceipt.revision, command: { ...cancelReceipt.command, expectedRevision: placeReceipt.command.expectedRevision } };
    receipts[placeIndex] = { ...placeReceipt, revision: cancelReceipt.revision, command: { ...placeReceipt.command, expectedRevision: cancelReceipt.command.expectedRevision } };
    expect(issue(cloneJson({ ...second, construction: { ...c, receipts } }))).toBe('HISTORICAL_SPATIAL_CONFLICT');
  });
  it('rejects own-domain reversed receipt chronology instead of trusting array order', () => {
    const tick = moved.records.construction.lastSimulationTick;
    const f = appendBlueprint(moved.records, 10, tick, tick);
    const c = f.construction; const receipts = c.receipts.slice(); const a = receipts.at(-2)!; const b = receipts.at(-1)!;
    receipts[receipts.length - 2] = { ...a, revision: b.revision, command: { ...a.command, expectedRevision: b.command.expectedRevision } };
    receipts[receipts.length - 1] = { ...b, revision: a.revision, command: { ...b.command, expectedRevision: a.command.expectedRevision } };
    expect(issue(cloneJson({ ...f, construction: { ...c, receipts } }))).toBe('INVALID_SPATIAL_CHRONOLOGY');
  });
  it('checks historic roads, terrain and legacy points even after cancellation', () => {
    const f = cancel(almost).records; const tick = f.construction.lastSimulationTick;
    expect(issue(appendBlueprint(f, 6, tick, tick))).toBe('ROAD_OCCUPIED');
    const target = appendBlueprint(f, 10, tick, tick);
    const water = cloneJson({ ...target, construction: { ...target.construction, map: { ...target.construction.map,
      tiles: target.construction.map.tiles.map(t => t.x === 10 && t.y === 1 ? { ...t, terrain: 'water', walkable: false } : t) } } });
    expect(issue(water)).toBe('TERRAIN_BLOCKED');
    const legacy = cloneJson({ ...target, construction: { ...target.construction,
      legacyStations: target.construction.legacyStations.map((s, i) => i === 0 ? { ...s, x: 10, y: 1 } : s) } });
    expect(issue(legacy)).toBe('BLUEPRINT_OVERLAP');
  });
  it('makes real started construction hard and preserves completed historical geometry', () => {
    const active = constructElsewhere(moved.records, false);
    expect(issue(active)).toBeNull(); expect(isWalkable(map(active), { x: 10, y: 1 })).toBe(false);
    expect(issue(builtElsewhere)).toBeNull(); expect(isWalkable(map(builtElsewhere), { x: 10, y: 1 })).toBe(false);
    expect(builtElsewhere.construction.buildings[0]).toEqual(original.buildings[0]);
  });
  it('accepts a clearly labelled record-only completed building on post-commit vacated ground', () => {
    // Authored spatial RECORD fixture derived from genuine paid x10 construction.
    // Changing its geometry here is NOT evidence that any integrated runtime built x1.
    const f = cloneJson(builtElsewhere); const c = f.construction;
    const bp = c.blueprints.at(-1)!; const job = c.jobs.at(-1)!; const building = c.buildings.at(-1)!;
    const entrance = { x: 1, y: 3 }; const extraTravel = 64;
    // Explicit authored idle/travel gap makes the farther old-origin entrance
    // satisfy all existing necessary-distance/calendar checks without claiming
    // the old runtime ever followed this alternative route.
    const recordOnly = cloneJson({ ...f, construction: { ...c,
      lastSimulationTick: c.lastSimulationTick + extraTravel, lastCalendarTick: c.lastCalendarTick + extraTravel,
      revision: c.revision + extraTravel,
      blueprints: c.blueprints.map(b => b.blueprintId === bp.blueprintId ? { ...b, anchor: { x: 1, y: 1 }, endedTick: b.endedTick! + extraTravel } : b),
      jobs: c.jobs.map(j => j.jobId === job.jobId ? { ...j, entranceToken: '1,3',
        siteVisit: { ...j.siteVisit!, tick: j.siteVisit!.tick + extraTravel, position: entrance },
        workSpans: j.workSpans.map(span => ({ firstTick: span.firstTick + extraTravel, lastTick: span.lastTick + extraTravel })),
        terminal: { ...j.terminal!, tick: j.terminal!.tick + extraTravel, calendarTick: j.terminal!.calendarTick + extraTravel, position: entrance } } : j),
      buildings: c.buildings.map(b => b.buildingId === building.buildingId ? { ...b, anchor: { x: 1, y: 1 },
        completedTick: b.completedTick + extraTravel, completedCalendarTick: b.completedCalendarTick + extraTravel,
        firstMaintenanceCalendarTick: b.firstMaintenanceCalendarTick + extraTravel } : b),
      people: c.people.map(p => p.id === job.workerId ? { ...p, position: entrance } : p),
      receipts: c.receipts.map(r => r.command.kind === 'blueprint.place' && r.relatedId === bp.blueprintId
        ? { ...r, command: { ...r.command, placement: request(1) } } : r) } });
    expect(inspectRelocationProvenanceForOwner(recordOnly)).toEqual([]);
    expect(issue(recordOnly)).toBeNull();
    expect(isWalkable(map(recordOnly), { x: 1, y: 1 })).toBe(false);
    expect(isWalkable(map(recordOnly), { x: 4, y: 1 })).toBe(false);
    expect(recordOnly.construction.buildings[0]).toEqual(original.buildings[0]);
  });
  it('scans more than 16 ended target intervals without treating them as live blueprints', () => {
    let f = seed();
    for (let n = 0; n < 18; n++) f = cancel(start(f));
    expect(f.records.relocation.jobs).toHaveLength(18); expect(issue(f.records)).toBeNull();
    const view = relocationOwnerCurrentSpatialContext(f.records);
    expect(view.ok && view.softTargets).toEqual([]);
  });
  it('checks complete current connectivity with effective placement', () => {
    const f = moved.records;
    const disconnected = cloneJson({ ...f, construction: { ...f.construction, map: { ...f.construction.map,
      tiles: f.construction.map.tiles.map(t => t.x === 7 && t.y >= 0 ? { ...t, terrain: 'water', walkable: false } : t) } } });
    expect(inspectRelocationOwnerSpatialRecords(disconnected).ok).toBe(false);
  });
  it('rejects future/unknown query boundaries and unknown building IDs explicitly', () => {
    const id = original.buildings[0]!.buildingId; const tick = moved.records.construction.lastSimulationTick;
    expect(relocationOwnerPlacementAt(moved.records, id, { tick: tick + 1, phase: 'relocation', side: 'after' }).ok).toBe(false);
    expect(relocationOwnerPlacementAt(moved.records, 'unknown', { tick, phase: 'relocation', side: 'after' }).ok).toBe(false);
    expect(relocationOwnerPlacementAt(moved.records, id, { tick, phase: 'fake', side: 'after' } as never).ok).toBe(false);
  });
  it('revalidates every public query and does not accept a success object as authorization', () => {
    const valid = inspectRelocationOwnerSpatialRecords(moved.records);
    const fake = cloneJson({ ...moved.records, relocation: { ...moved.records.relocation, nextId: 999 } });
    expect(issue(valid)).not.toBeNull(); expect(issue({ ...fake, validated: true })).not.toBeNull();
    expect(relocationOwnerCurrentSpatialContext(fake).ok).toBe(false); expect(relocationOwnerEffectiveMap(fake).ok).toBe(false);
    expect(relocationOwnerPlacementAt(fake, original.buildings[0]!.buildingId,
      { tick: fake.construction.lastSimulationTick, phase: 'relocation', side: 'after' }).ok).toBe(false);
  });
  it('rejects getters and aliases without executing the getter', () => {
    let reads = 0; const getter = { get construction() { reads++; return moved.records.construction; }, relocation: moved.records.relocation };
    expect(issue(getter)).not.toBeNull(); expect(reads).toBe(0);
    const f = cloneJson(moved.records); const aliased = { ...f, construction: { ...f.construction, people: [...f.construction.people, f.construction.people[0]!] } };
    expect(issue(aliased)).not.toBeNull();
  });
  it('returns detached query values and never rewrites frozen caller history', () => {
    const f = freeze(cloneJson(moved.records)); const before = JSON.stringify(f);
    const view = relocationOwnerCurrentSpatialContext(f); const resultMap = relocationOwnerEffectiveMap(f);
    const position = relocationOwnerPlacementAt(f, original.buildings[0]!.buildingId,
      { tick: f.construction.lastSimulationTick, phase: 'relocation', side: 'after' });
    if (!view.ok || !resultMap.ok || !position.ok || !position.placement) throw new Error('Expected spatial values');
    (view.context.people[0]!.position as { x: number }).x = 255;
    resultMap.map.tiles[0]!.walkable = !resultMap.map.tiles[0]!.walkable;
    (position.placement.anchor as { x: number }).x = 255;
    expect(JSON.stringify(f)).toBe(before); expect(issue(f)).toBeNull();
  });
  it('uses bounded record events rather than iterating through elapsed ticks', () => {
    const f = cloneJson(moved.records); const huge = Number.MAX_SAFE_INTEGER - 10000;
    const far = { ...f, construction: { ...f.construction, lastSimulationTick: huge,
      lastCalendarTick: huge - (f.construction.lastSimulationTick - f.construction.lastCalendarTick) } };
    expect(issue(far)).toBeNull();
  });
});
