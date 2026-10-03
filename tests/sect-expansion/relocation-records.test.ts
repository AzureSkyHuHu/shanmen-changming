import { beforeAll, describe, expect, it } from 'vitest';
import { getSectBuildingDefinition } from '../../src/content/sect-v9/catalog';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../../src/core/agents/navigation';
import type { SectCell } from '../../src/content/sect-v9/types';
import { applyConstructionCommand } from '../../src/core/sect-expansion/construction';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { validateConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import type { ConstructionCommand, ConstructionContext, ConstructionFrame } from '../../src/core/sect-expansion/construction-types';
import { deriveSectFootprint } from '../../src/core/sect-expansion/layout';
import { commitSectReservation, consumeSectConstructionCheckpoint, releaseSectReservation, reserveSectResources,
  type SectLedgerContext, type SectLedgerResult } from '../../src/core/sect-expansion/ledger';
import { sectBuildingPlacementAt } from '../../src/core/sect-expansion/relocation-position-records';
import { createSectRelocationState, isSectRelocationCommand, validateSectRelocationRecords } from '../../src/core/sect-expansion/relocation-validation';
import type { SectRelocationCheckpoint, SectRelocationJob, SectRelocationRecordFrame, SectRelocationReceipt,
  SectRelocationTerminal } from '../../src/core/sect-expansion/relocation-types';
import type { SectPlacementRequest } from '../../src/core/sect-expansion/types';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import { fixturePlace, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture } from './fixtures/v9-runtime';

let construction: ConstructionFrame;
beforeAll(() => {
  // Genuine registered-catalog construction, command/ledger/work history and World
  // projection. Extra inventory is the existing explicit capacity fixture, not income.
  const started = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
  const completed = fixtureUntil(started, w => w.sectExpansion.construction.jobs.at(-1)!.terminal?.kind === 'completed');
  construction = cloneJson(projectV9SectFrame(completed).construction);
  expect(validateConstructionRecords(construction)).toEqual([]);
}, 120_000);
function ledger(result: SectLedgerResult): SectLedgerContext {
  if (!result.ok) throw new Error(result.rejection.code); return result.context;
}
function empty(): SectRelocationRecordFrame { return { construction: cloneJson(construction), relocation: createSectRelocationState() }; }
function entrance(placement: SectPlacementRequest) {
  const geometry = deriveSectFootprint(placement); if (!geometry.ok) throw new Error(geometry.code); return geometry.footprint.entrance;
}
/** Hand-authored relocation RECORD fixture, not an implemented relocation runtime. Actual
 * paired-ledger primitives settle the authored local history against real construction. */
function append(input: SectRelocationRecordFrame, options: { kind?: 'completed' | 'cancelled' | 'live'; work?: number; delay?: number; x?: number } = {}): SectRelocationRecordFrame {
  const frame = cloneJson(input); const state = frame.relocation; const building = frame.construction.buildings[0]!;
  const predecessor = state.jobs.filter(j => j.terminal?.kind === 'completed').at(-1);
  const last = state.jobs.at(-1);
  const from = cloneJson(predecessor?.to ?? { definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
  const to: SectPlacementRequest = { definitionId: building.definitionId, anchor: { x: options.x ?? 6, y: 1 }, rotation: 0 };
  const origin = last?.terminal?.position ?? entrance(from);
  const startedTick = frame.construction.lastSimulationTick + (last ? cardinalDistance(origin, last.terminal!.position) * MOVEMENT_TICKS_PER_CELL : 0);
  const startedCalendarTick = frame.construction.lastCalendarTick;
  const oldTick = startedTick + Math.max(1, cardinalDistance(origin, entrance(from)) * MOVEMENT_TICKS_PER_CELL);
  const newTick = oldTick + Math.max(1, cardinalDistance(entrance(from), entrance(to)) * MOVEMENT_TICKS_PER_CELL);
  const offset = startedTick - startedCalendarTick;
  const oldEntranceVisit = { tick: oldTick, calendarTick: oldTick - offset, position: entrance(from) };
  const newVisit = { tick: newTick, calendarTick: newTick - offset, position: entrance(to) };
  const kind = options.kind ?? 'completed'; const work = options.work ?? 200;
  const end = newTick + work + (options.delay ?? 0);
  const jobId = `sect-relocation:${state.nextId}`; const reservationId = `sect-relocation-reservation:${state.nextId + 1}`;
  const identity = { reservationId, ownerTransactionId: jobId };
  let book = ledger(reserveSectResources(frame.construction.ledger, identity, [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], 'construction-checkpoints'));
  const checkpoints: SectRelocationCheckpoint[] = [];
  if (work >= 100) {
    book = ledger(consumeSectConstructionCheckpoint(book, identity, 'half'));
    checkpoints.push({ checkpointId: 'construction.half', activeTicks: 100, tick: newTick + 100,
      calendarTick: newTick + 100 - offset, position: entrance(to) });
  }
  const startRevision = state.revision + 1; const terminalRevision = startRevision + 1;
  const previousPhase = work === 200 ? 'waiting-completion' : 'working';
  let terminal: SectRelocationTerminal | null = null;
  if (kind === 'completed') {
    book = ledger(consumeSectConstructionCheckpoint(book, identity, 'remainder'));
    book = ledger(commitSectReservation(book, identity, `complete:${jobId}`, []));
    checkpoints.push({ checkpointId: 'construction.remainder', activeTicks: 200, tick: end, calendarTick: end - offset, position: entrance(to) });
    terminal = { kind, previousPhase, revision: terminalRevision, tick: end, calendarTick: end - offset, position: entrance(to),
      consumed: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], released: [] };
  } else if (kind === 'cancelled') {
    book = ledger(releaseSectReservation(book, identity, `cancel:${jobId}`));
    terminal = { kind, previousPhase, revision: terminalRevision, tick: end, calendarTick: end - offset, position: entrance(to),
      consumed: work >= 100 ? [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] : [],
      released: [{ ledger: 'base', resourceId: 'wood', quantity: work >= 100 ? 1 : 2 }] };
  }
  const job: SectRelocationJob = { jobId, reservationId, buildingId: building.buildingId, sourceJobId: building.sourceJobId,
    workerId: frame.construction.jobs[0]!.workerId, previousRelocationJobId: predecessor?.jobId ?? null,
    from, to, startedTick, startedCalendarTick, origin, requiredTicks: 200, phase: kind === 'live' ? previousPhase : kind,
    oldEntranceVisit, newEntranceVisits: [newVisit], workSpans: work ? [{ firstTick: newTick + 1, lastTick: newTick + work,
      firstCalendarTick: newTick + 1 - offset, lastCalendarTick: newTick + work - offset, visitIndex: 0 }] : [], checkpoints, activeTicks: work, terminal };
  const receipts: SectRelocationReceipt[] = [...state.receipts, { jobId, revision: startRevision, command: { kind: 'relocation.start',
    commandId: `start.${jobId}`, expectedRevision: state.revision, buildingId: building.buildingId, workerId: job.workerId, target: to } }];
  if (kind === 'cancelled') receipts.push({ jobId, revision: terminalRevision,
    command: { kind: 'relocation.cancel', commandId: `cancel.${jobId}`, expectedRevision: startRevision, jobId } });
  return cloneJson({ construction: { ...frame.construction, ledger: book, lastSimulationTick: end, lastCalendarTick: end - offset },
    relocation: { ...state, jobs: [...state.jobs, job], receipts, revision: terminal ? terminalRevision : startRevision, nextId: state.nextId + 2 } });
}
/** Generate the later construction through real public command admission. Its origin
 * comes from the observed worker position, never hand-authored construction history.
 * The isolated construction domain cannot see relocation; the combined record root
 * must reject impossible movement between these otherwise individually valid records. */
function laterConstruction(input: SectRelocationRecordFrame, calendarGap: number, simulationGap = calendarGap,
  position: SectCell = construction.jobs[0]!.terminal!.position): SectRelocationRecordFrame {
  let source: ConstructionFrame = cloneJson({ ...input.construction,
    lastSimulationTick: input.construction.lastSimulationTick + simulationGap,
    lastCalendarTick: input.construction.lastCalendarTick + calendarGap,
    people: input.construction.people.map(p => p.id === input.relocation.jobs.at(-1)!.workerId ? { ...p, position } : p) });
  const apply = (command: ConstructionCommand): void => {
    const context: ConstructionContext = { simulationTick: source.lastSimulationTick, calendarTick: source.lastCalendarTick,
      mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [] };
    const result = applyConstructionCommand(source, context, command);
    if (!result.ok) throw new Error(`Later construction rejected: ${result.code}`);
    source = result.frame;
  };
  apply({ kind: 'blueprint.place', commandId: 'handoff.place', expectedRevision: source.revision,
    placement: { definitionId: 'library.v9', anchor: { x: 10, y: 1 }, rotation: 0 } });
  apply({ kind: 'construction.start', commandId: 'handoff.start', expectedRevision: source.revision,
    blueprintId: source.blueprints.at(-1)!.blueprintId, workerId: input.relocation.jobs.at(-1)!.workerId });
  expect(validateConstructionRecords(source)).toEqual([]);
  return cloneJson({ construction: source, relocation: input.relocation });
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value;
}

describe('isolated relocation records', () => {
  it('uses actual library/alchemy catalog relocation prices without allocating a public protocol', () => {
    for (const id of ['library.v9', 'alchemy.v9'] as const) expect(getSectBuildingDefinition(id)!.relocation)
      .toEqual({ costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], workTicks: 200 });
    const frame = empty(); expect(validateSectRelocationRecords(frame)).toEqual([]);
    expect(isSectRelocationCommand({ kind: 'relocation.start', commandId: 's', expectedRevision: 0,
      buildingId: construction.buildings[0]!.buildingId, workerId: construction.people[0]!.id,
      target: { definitionId: 'library.v9', anchor: { x: 6, y: 1 }, rotation: 0 } })).toBe(true);
  });
  it('round trips repeated relocation, including returning to the original anchor', () => {
    const original = canonicalStringify(construction.buildings);
    const once = append(empty()); const first = once.relocation.jobs[0]!;
    const twice = append(once, { x: 1 }); const second = twice.relocation.jobs[1]!;
    expect(validateSectRelocationRecords(twice)).toEqual([]);
    const restored = JSON.parse(JSON.stringify(twice)) as SectRelocationRecordFrame;
    expect(validateSectRelocationRecords(restored)).toEqual([]);
    expect(restored).toEqual(twice);
    expect(canonicalStringify(restored.construction.buildings)).toBe(original);
    const id = construction.buildings[0]!.buildingId;
    expect(sectBuildingPlacementAt(restored, id, first.terminal!.tick, 'before-relocation')!.anchor).toEqual({ x: 1, y: 1 });
    expect(sectBuildingPlacementAt(restored, id, first.terminal!.tick)!.anchor).toEqual({ x: 6, y: 1 });
    expect(sectBuildingPlacementAt(restored, id, second.terminal!.tick)!.anchor).toEqual({ x: 1, y: 1 });
    expect(sectBuildingPlacementAt(restored, id, second.terminal!.tick)!.firstMaintenanceCalendarTick).toBe(construction.buildings[0]!.firstMaintenanceCalendarTick);
    expect(restored.construction.buildings).toHaveLength(1);
    expect(second.previousRelocationJobId).toBe(first.jobId);
  });
  it.each([0, 99, 100, 199, 200])('cancellation at %i active ticks retains only consumed material and keeps old placement', work => {
    const result = append(empty(), { kind: 'cancelled', work });
    expect(validateSectRelocationRecords(result)).toEqual([]);
    const job = result.relocation.jobs[0]!;
    expect(job.terminal!.consumed).toEqual(work >= 100 ? [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] : []);
    expect(job.terminal!.released).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: work >= 100 ? 1 : 2 }]);
    expect(sectBuildingPlacementAt(result, job.buildingId, job.terminal!.tick)!.anchor).toEqual({ x: 1, y: 1 });
    const retry = append(result); expect(validateSectRelocationRecords(retry)).toEqual([]);
    expect(retry.relocation.jobs[1]!.previousRelocationJobId).toBeNull();
  });
  it('retains wood1 reservation at 200 work while waiting; delayed completion consumes the remainder once', () => {
    const waiting = append(empty(), { kind: 'live', delay: 50 });
    expect(validateSectRelocationRecords(waiting)).toEqual([]);
    const claim = waiting.construction.ledger.reservations.at(-1)!;
    expect(claim.base.consumed).toEqual([{ resourceId: 'wood', quantity: 1 }]);
    expect(claim.base.remainingReservation).toEqual([{ resourceId: 'wood', quantity: 1 }]);
    const completed = append(empty(), { delay: 50 }); expect(validateSectRelocationRecords(completed)).toEqual([]);
    expect(completed.relocation.jobs[0]!.checkpoints[1]!.tick).toBe(completed.relocation.jobs[0]!.terminal!.tick);
  });
  it('accepts a real calendar pause before relocation without counting it as work', () => {
    const base = empty();
    const paused = { ...base, construction: { ...base.construction, lastSimulationTick: base.construction.lastSimulationTick + 40 } };
    const frame = append(paused); expect(validateSectRelocationRecords(frame)).toEqual([]);
    expect(frame.relocation.jobs[0]!.activeTicks).toBe(200);
    expect(frame.relocation.jobs[0]!.startedTick - frame.relocation.jobs[0]!.startedCalendarTick).toBe(40);
  });
  it.each(['completed', 'cancelled'] as const)('checks %s relocation → later construction handoffs in both clocks', kind => {
    const moved = append(empty(), { kind }); const terminal = moved.relocation.jobs[0]!.terminal!;
    const nextOrigin = construction.jobs[0]!.terminal!.position;
    const travelTicks = cardinalDistance(terminal.position, nextOrigin) * MOVEMENT_TICKS_PER_CELL;
    expect(travelTicks).toBeGreaterThan(1);
    for (const gap of [0, 1, travelTicks - 1]) {
      const impossible = frozen(laterConstruction(moved, gap)); const before = canonicalStringify(impossible);
      expect(impossible.construction.jobs.at(-1)!.startedTick).toBe(terminal.tick + gap);
      expect(validateSectRelocationRecords(impossible)).toEqual([{ code: 'INVALID_RELOCATION_TO_CONSTRUCTION_CONTINUITY', path: moved.relocation.jobs[0]!.jobId }]);
      expect(sectBuildingPlacementAt(impossible, moved.relocation.jobs[0]!.buildingId, terminal.tick)).toBeNull();
      expect(canonicalStringify(impossible)).toBe(before);
    }
    // A simulation-only gap cannot supply management movement time.
    const paused = laterConstruction(moved, 0, travelTicks);
    expect(validateSectRelocationRecords(paused)).toEqual([{ code: 'INVALID_RELOCATION_TO_CONSTRUCTION_CONTINUITY', path: moved.relocation.jobs[0]!.jobId }]);
    const enough = laterConstruction(moved, travelTicks);
    expect(validateSectRelocationRecords(enough)).toEqual([]);
    expect(validateSectRelocationRecords(JSON.parse(JSON.stringify(enough)))).toEqual([]);
    // No movement is needed when both real records meet at the same position.
    expect(validateSectRelocationRecords(laterConstruction(moved, 0, 0, terminal.position))).toEqual([]);
  });
  it('returns detached results and does not mutate a frozen valid source', () => {
    const frame = frozen(append(empty())); const before = canonicalStringify(frame);
    const answer = sectBuildingPlacementAt(frame, frame.construction.buildings[0]!.buildingId, frame.construction.lastSimulationTick)!;
    (answer.anchor as { x: number }).x = 99;
    expect(validateSectRelocationRecords(frame)).toEqual([]); expect(canonicalStringify(frame)).toBe(before);
  });
  it.each([
    ['unknown field', (f: any) => { f.relocation.trusted = true; }],
    ['rewritten construction origin', (f: any) => { f.construction.buildings[0].anchor.x = 6; }],
    ['lost construction provenance', (f: any) => { f.relocation.jobs[0].sourceJobId = 'fake'; }],
    ['legacy relocation', (f: any) => { f.relocation.jobs[0].buildingId = 'legacy:storage'; }],
    ['wrong predecessor', (f: any) => { f.relocation.jobs[1].previousRelocationJobId = null; }],
    ['stale from anchor', (f: any) => { f.relocation.jobs[1].from.anchor.x = 1; }],
    ['impossible rotation', (f: any) => { f.relocation.jobs[0].to.rotation = 45; }],
    ['out of bounds', (f: any) => { f.relocation.jobs[0].to.anchor.x = 255; }],
    ['teleported start', (f: any) => { f.relocation.jobs[1].origin.x++; }],
    ['wrong old entrance', (f: any) => { f.relocation.jobs[0].oldEntranceVisit.position.x++; }],
    ['missing old visit', (f: any) => { f.relocation.jobs[0].oldEntranceVisit = null; }],
    ['unearned work', (f: any) => { f.relocation.jobs[0].activeTicks--; }],
    ['calendar work gap', (f: any) => { f.relocation.jobs[0].workSpans[0].lastCalendarTick--; }],
    ['half payment too early', (f: any) => { f.relocation.jobs[0].checkpoints[0].tick--; }],
    ['missing receipt', (f: any) => { f.relocation.receipts.pop(); }],
    ['duplicate command', (f: any) => { f.relocation.receipts[1].command.commandId = f.relocation.receipts[0].command.commandId; }],
    ['revision gap', (f: any) => { f.relocation.revision++; }],
    ['future terminal', (f: any) => { f.relocation.jobs[1].terminal.tick++; }],
    ['altered price', (f: any) => { f.construction.ledger.reservations.at(-1).base.lines[0].quantity = 3; }],
    ['over-capacity visits', (f: any) => { f.relocation.jobs[0].newEntranceVisits = Array.from({ length: 202 }, () => cloneJson(f.relocation.jobs[0].newEntranceVisits[0])); }],
    ['over-capacity spans', (f: any) => { f.relocation.jobs[0].workSpans = Array.from({ length: 201 }, () => cloneJson(f.relocation.jobs[0].workSpans[0])); }],
    ['injected maintenance reset', (f: any) => { f.relocation.jobs[0].firstMaintenanceCalendarTick = 9999; }],
    ['injected level', (f: any) => { f.relocation.jobs[0].level = 2; }],
  ] as const)('rejects %s without mutating source or exposing a placement', (_name, tamper) => {
    const frame = cloneJson(append(append(empty()), { x: 1 })); tamper(frame);
    frozen(frame); const bytes = canonicalStringify(frame);
    expect(validateSectRelocationRecords(frame).length).toBeGreaterThan(0);
    expect(sectBuildingPlacementAt(frame, construction.buildings[0]!.buildingId, frame.construction.lastSimulationTick)).toBeNull();
    expect(canonicalStringify(frame)).toBe(bytes);
  });
  it('rejects accessors without invoking them, cycles, aliases and forged validation flags', () => {
    let calls = 0; const accessor = empty();
    Object.defineProperty(accessor.relocation, 'jobs', { enumerable: true, get() { calls++; return []; } });
    expect(validateSectRelocationRecords(accessor).length).toBeGreaterThan(0); expect(calls).toBe(0);
    const cyclic: any = empty(); cyclic.relocation.jobs = [cyclic];
    expect(validateSectRelocationRecords(cyclic).length).toBeGreaterThan(0);
    const aliased: any = append(empty()); aliased.relocation.jobs[0].origin = aliased.relocation.jobs[0].to.anchor;
    expect(validateSectRelocationRecords(aliased).length).toBeGreaterThan(0);
    expect(isSectRelocationCommand({ kind: 'relocation.cancel', commandId: 'system/death/fake', expectedRevision: 0, jobId: 'sect-relocation:1' })).toBe(false);
  });
  it('rejects orphan relocation reservations and refuses out-of-range historical queries', () => {
    const frame = empty(); const book = ledger(reserveSectResources(frame.construction.ledger,
      { reservationId: 'sect-relocation-reservation:2', ownerTransactionId: 'sect-relocation:1' },
      [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], 'construction-checkpoints'));
    expect(validateSectRelocationRecords({ ...frame, construction: { ...frame.construction, ledger: book } }).length).toBeGreaterThan(0);
    expect(sectBuildingPlacementAt(frame, construction.buildings[0]!.buildingId, construction.lastSimulationTick + 1)).toBeNull();
    expect(sectBuildingPlacementAt(frame, construction.buildings[0]!.buildingId, construction.buildings[0]!.completedTick - 1)).toBeNull();
  });
});
