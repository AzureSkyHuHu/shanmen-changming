import { beforeAll, describe, expect, it } from 'vitest';
import { emptyNavigation, isWalkable } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand } from '../../src/core/sect-expansion/construction';
import { validateConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import type { ConstructionCommand, ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import { applySectRelocationCommand, createSectRelocationRuntime, tickSectRelocation,
  tickConstructionRelocationDomain, validateConstructionRelocationDomainRuntime, validateSectRelocationRuntime } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectRelocationRuntimeFrame } from '../../src/core/sect-expansion/relocation-runtime-types';
import type { SectRelocationCommand } from '../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState } from '../../src/core/sect-expansion/relocation-validation';
import { prepareConstructionRelocationCommandCandidate as commandCandidate, prepareConstructionRelocationTickCandidate as tickCandidate,
  type ConstructionRelocationDomainCandidate } from '../../src/core/world/relocation-owner/domain-composition';
import { inspectRelocationOwnerSpatialRecords, relocationOwnerCurrentSpatialContext, relocationOwnerEffectiveMap } from '../../src/core/world/relocation-owner/spatial-records';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import { fundedRuntimeFixture } from '../sect-expansion/fixtures/v9-runtime';

type Frame = SectRelocationRuntimeFrame;
function context(f: Frame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  return { simulationTick: f.records.construction.lastSimulationTick, calendarTick: f.records.construction.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch };
}
function nextContext(f: Frame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  const productive = patch.mode !== 'combat' && !patch.paused && !patch.expeditionActive;
  return context(f, { simulationTick: f.records.construction.lastSimulationTick + 1,
    calendarTick: f.records.construction.lastCalendarTick + (productive ? 1 : 0), ...patch });
}
function unwrap(result: ConstructionRelocationDomainCandidate): Frame {
  if (!result.ok) throw new Error(`${result.code}: ${result.issues.join(', ')}`);
  expect(result.scope).toBe('construction-relocation-domain-candidate'); return result.frame;
}
function apply(f: Frame, command: ConstructionCommand | SectRelocationCommand): Frame { return unwrap(commandCandidate(f, context(f), command)); }
function placeCommand(f: Frame, x: number): ConstructionCommand {
  return { kind: 'blueprint.place', commandId: `place.${f.records.construction.nextId}`, expectedRevision: f.records.construction.revision,
    placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } };
}
function place(f: Frame, x: number): Frame { return apply(f, placeCommand(f, x)); }
function build(f: Frame, workerId = 'entity:2'): Frame {
  return apply(f, { kind: 'construction.start', commandId: `build.${f.records.construction.nextId}`,
    expectedRevision: f.records.construction.revision, blueprintId: f.records.construction.blueprints.at(-1)!.blueprintId, workerId });
}
function moveCommand(f: Frame, x = 4, workerId = 'entity:2'): SectRelocationCommand {
  return { kind: 'relocation.start', commandId: `move.${f.records.relocation.nextId}`, expectedRevision: f.records.relocation.revision,
    buildingId: f.records.construction.buildings[0]!.buildingId, workerId, target: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } };
}
function move(f: Frame, x = 4, workerId = 'entity:2'): Frame { return apply(f, moveCommand(f, x, workerId)); }
function step(f: Frame, patch: Partial<ConstructionContext> = {}): Frame {
  const ctx = nextContext(f, patch); const result = tickCandidate(f, ctx, createWorkPathBudget(ctx.simulationTick));
  if (!result.ok) throw new Error(JSON.stringify({ code: result.code, issues: result.issues, nextTick: ctx.simulationTick,
    sourceIssues: validateConstructionRelocationDomainRuntime(f),
    construction: f.records.construction.jobs.map(job => ({ id: job.jobId, phase: job.phase, work: job.activeTicks })),
    relocation: f.records.relocation.jobs.map(job => ({ id: job.jobId, phase: job.phase, work: job.activeTicks })) }));
  return unwrap(result);
}
function until(f: Frame, predicate: (frame: Frame) => boolean): Frame {
  for (let i = 0; i < 1800 && !predicate(f); i++) f = step(f);
  if (!predicate(f)) throw new Error('Real two-domain fixture did not reach its boundary'); return f;
}
function cancelMove(f: Frame): Frame {
  return apply(f, { kind: 'relocation.cancel', commandId: `cancel.move.${f.records.relocation.nextId}`,
    expectedRevision: f.records.relocation.revision, jobId: f.records.relocation.jobs.at(-1)!.jobId });
}
function cancelBuild(f: Frame): Frame {
  return apply(f, { kind: 'construction.cancel', commandId: `cancel.build.${f.records.construction.nextId}`,
    expectedRevision: f.records.construction.revision, blueprintId: f.records.construction.blueprints.at(-1)!.blueprintId });
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}
function rejectedUnchanged(f: Frame, result: ConstructionRelocationDomainCandidate, code?: string): void {
  expect(result.ok).toBe(false); expect(result.frame).toBe(f);
  if (!result.ok && code) expect(result.code).toBe(code);
}
let seed: Frame; let builtA: Frame; let move99: Frame; let move100: Frame; let move199: Frame; let movedA: Frame;
let replacement: Frame; let builtB: Frame; let movedAgain: Frame; let bothReady: Frame; let bothPath: Frame;
beforeAll(() => {
  // Funding is an explicit seed-capacity fixture. Every blueprint, construction, relocation,
  // payment, visit and work span below is produced by the new APIs, with no appended history,
  // projected anchors, synthetic World, fake away actor or post-start grant.
  seed = createSectRelocationRuntime({ construction: cloneJson(projectV9SectFrame(fundedRuntimeFixture()).construction), relocation: createSectRelocationState() });
  builtA = until(build(place(seed, 1)), f => !!f.records.construction.jobs[0]!.terminal);
  move99 = until(move(builtA), f => f.records.relocation.jobs[0]!.activeTicks === 99);
  move100 = step(move99);
  move199 = until(move100, f => f.records.relocation.jobs[0]!.activeTicks === 199);
  movedA = step(move199);
  // Actual external commands at the relocation-completion tick reuse the vacated origin.
  replacement = build(place(movedA, 1));
  builtB = until(replacement, f => !!f.records.construction.jobs[1]!.terminal);
  movedAgain = until(move(builtB, 10), f => !!f.records.relocation.jobs[1]!.terminal);
  // Construction is already at 76 work ticks. The independent relocation worker has
  // 32+12 real travel ticks, then 199 work ticks, joining construction's 319 boundary.
  const second = until(build(place(builtA, 10)), f => f.records.construction.jobs[1]!.activeTicks === 76);
  bothReady = until(move(second, 4, 'entity:3'), f => f.records.relocation.jobs[0]!.activeTicks === 199);
  // The original builder is still standing at A's old entrance. Let that actual
  // worker begin the move and consume its old-door arrival boundary before starting B.
  // B's real start then invalidates both routes; both workers need a path next tick.
  const leavingOldDoor = step(move(builtA));
  expect(leavingOldDoor.records.relocation.jobs[0]!.phase).toBe('to-new-entrance');
  expect(leavingOldDoor.records.relocation.jobs[0]!.activeTicks).toBe(0);
  bothPath = build(place(leavingOldDoor, 10), 'entity:4');
  expect(bothPath.records.construction.jobs[1]!.phase).toBe('to-storage');
  expect(bothPath.records.relocation.jobs[0]!.phase).toBe('to-new-entrance');
  expect(bothPath.live[0]!.navigation).toEqual(emptyNavigation());
  [seed, builtA, move99, move100, move199, movedA, replacement, builtB, movedAgain, bothReady, bothPath].forEach(frozen);
}, 180_000);

describe('bounded construction and relocation domain composition', () => {
  it('executes build A -> move A -> same-tick real place/start B at origin -> finish B -> move A again', () => {
    expect(replacement.records.construction.blueprints[1]!.placedTick).toBe(movedA.records.relocation.jobs[0]!.terminal!.tick);
    expect(replacement.records.construction.jobs[1]!.startedTick).toBe(movedA.records.construction.lastSimulationTick);
    expect(movedAgain.records.construction.buildings).toHaveLength(2);
    expect(movedAgain.records.relocation.jobs.map(job => job.terminal!.kind)).toEqual(['completed', 'completed']);
    expect(movedAgain.records.relocation.jobs[1]!.from.anchor).toEqual({ x: 4, y: 1 });
    expect(movedAgain.records.relocation.jobs[1]!.previousRelocationJobId).toBe(movedA.records.relocation.jobs[0]!.jobId);
    expect(validateConstructionRelocationDomainRuntime(movedAgain)).toEqual([]);
    expect(inspectRelocationOwnerSpatialRecords(movedAgain.records).ok).toBe(true);
    const spatial = relocationOwnerCurrentSpatialContext(movedAgain.records);
    expect(spatial.ok && spatial.context.spaces.filter(s => s.kind === 'placed').map(s => s.anchor)).toEqual([{ x: 10, y: 1 }, { x: 1, y: 1 }]);
  });
  it('retains every original construction origin, blueprint, job, receipt and settled reservation byte-for-byte', () => {
    const original = builtA.records.construction; const final = movedAgain.records.construction;
    expect(final.buildings[0]).toEqual(original.buildings[0]); expect(final.blueprints[0]).toEqual(original.blueprints[0]);
    expect(final.jobs[0]).toEqual(original.jobs[0]); expect(final.receipts.slice(0, original.receipts.length)).toEqual(original.receipts);
    expect(final.ledger.reservations[0]).toEqual(original.ledger.reservations[0]);
    expect(final.buildings[0]!.anchor).toEqual({ x: 1, y: 1 });
    expect(final.buildings[0]!.level).toBe(1);
  });
  it('commits one wood at 100, the remaining wood at 200 and a single atomic geometry/navigation change', () => {
    const before = move99.records.construction.ledger.inventory.wood;
    expect(move100.records.construction.ledger.inventory.wood).toMatchObject({ owned: before.owned - 1, reserved: before.reserved - 1 });
    expect(move199.records.relocation.jobs[0]!.checkpoints).toHaveLength(1);
    expect(movedA.records.construction.ledger.inventory.wood.owned).toBe(before.owned - 2);
    expect(movedA.records.relocation.jobs[0]!.checkpoints.map(value => value.activeTicks)).toEqual([100, 200]);
    expect(movedA.records.relocation.jobs[0]!.terminal!.consumed).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }]);
    expect(movedA.records.construction.map.navVersion).toBe(move199.records.construction.map.navVersion + 1);
    expect(movedA.live).toEqual([]);
    const beforeMap = relocationOwnerEffectiveMap(move199.records); const afterMap = relocationOwnerEffectiveMap(movedA.records);
    expect(beforeMap.ok && isWalkable(beforeMap.map, { x: 1, y: 1 })).toBe(false);
    expect(afterMap.ok && isWalkable(afterMap.map, { x: 1, y: 1 })).toBe(true);
  });
  it('reprepares the same source deterministically without duplicate charges, and repeats admitted commands/ticks idempotently', () => {
    const bytes = canonicalStringify(move99); expect(step(move99)).toEqual(move100); expect(canonicalStringify(move99)).toBe(bytes);
    const cmd = moveCommand(builtA); const started = apply(builtA, cmd);
    const repeated = commandCandidate(started, context(started), cmd);
    expect(repeated.ok && repeated.repeated).toBe(true); expect(repeated.frame).toEqual(started);
    const tick = tickCandidate(move100, context(move100), createWorkPathBudget(context(move100).simulationTick));
    expect(tick.ok && tick.repeated).toBe(true); expect(tick.frame).toEqual(move100);
  });
  it('rejects shared command IDs in both domain directions and same-domain altered bodies', () => {
    const a = { ...placeCommand(builtA, 10), commandId: builtA.records.construction.receipts[0]!.command.commandId };
    rejectedUnchanged(builtA, commandCandidate(builtA, context(builtA), a), 'IDENTITY_CONFLICT');
    const relocationId = movedA.records.relocation.receipts[0]!.command.commandId;
    rejectedUnchanged(movedA, commandCandidate(movedA, context(movedA), { ...placeCommand(movedA, 1), commandId: relocationId }), 'IDENTITY_CONFLICT');
    const constructionId = builtA.records.construction.receipts[0]!.command.commandId;
    rejectedUnchanged(builtA, commandCandidate(builtA, context(builtA), { ...moveCommand(builtA), commandId: constructionId }), 'IDENTITY_CONFLICT');
  });
  it('cancellation retains the old occupied footprint and never refunds the spent half', () => {
    const cancelled = cancelMove(move100); const job = cancelled.records.relocation.jobs[0]!;
    expect(job.terminal!.consumed).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 1 }]);
    expect(job.terminal!.released).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 1 }]);
    expect(cancelled.records.construction.people).toEqual(move100.records.construction.people);
    rejectedUnchanged(cancelled, commandCandidate(cancelled, context(cancelled), placeCommand(cancelled, 1)), 'PLACEMENT_CHANGED');
    expect(cancelled.records.construction.map.navVersion).toBe(move100.records.construction.map.navVersion);
  });
  it('waits at 200 while a nonworker occupies the soft target, without vacating, more work or second debit', () => {
    // Explicit changed external-person snapshot. No worker history, away flag or authority is fabricated.
    const blocked = cloneJson({ ...move199, records: { ...move199.records, construction: { ...move199.records.construction,
      people: move199.records.construction.people.map(person => person.id === 'entity:1' ? { ...person, position: { x: 4, y: 1 } } : person) } } });
    const wait = step(blocked); const again = step(wait);
    expect(again.records.relocation.jobs[0]!.phase).toBe('waiting-completion');
    expect(again.records.relocation.jobs[0]!.activeTicks).toBe(200); expect(again.records.relocation.jobs[0]!.checkpoints).toHaveLength(1);
    expect(again.records.construction.ledger).toEqual(wait.records.construction.ledger);
    expect(again.records.construction.map.navVersion).toBe(move199.records.construction.map.navVersion);
    rejectedUnchanged(again, commandCandidate(again, context(again), placeCommand(again, 1)), 'PLACEMENT_CHANGED');
    expect(cancelMove(again).records.relocation.jobs[0]!.terminal!.released[0]!.quantity).toBe(1);
  });
  it('refuses cross-domain same-tick cancel/reuse ambiguity, then admits the next-tick retry', () => {
    const cancelled = cancelMove(move100); const result = commandCandidate(cancelled, context(cancelled), placeCommand(cancelled, 5));
    rejectedUnchanged(cancelled, result, 'INVALID_FRAME');
    if (!result.ok) expect(result.issues).toContain('INVALID_LIVE_CAPACITY_OR_LAYOUT');
    expect(place(step(cancelled), 5).records.construction.blueprints.at(-1)!.status).toBe('planned');
  });
  it('also rejects construction-cancel then relocation reuse at an unprovable same-tick boundary', () => {
    const cancelled = cancelBuild(build(place(builtA, 10), 'entity:4'));
    rejectedUnchanged(cancelled, commandCandidate(cancelled, context(cancelled), moveCommand(cancelled, 10, 'entity:3')), 'INVALID_FRAME');
    expect(move(step(cancelled), 10, 'entity:3').records.relocation.jobs[0]!.terminal).toBeNull();
  });
  it('ticks both active domains once and combines same-tick completion nav obligations', () => {
    expect(bothReady.records.construction.jobs[1]!.activeTicks).toBe(319);
    const next = step(bothReady);
    expect(next.records.construction.lastSimulationTick).toBe(bothReady.records.construction.lastSimulationTick + 1);
    expect(next.records.construction.lastCalendarTick).toBe(bothReady.records.construction.lastCalendarTick + 1);
    expect(next.records.construction.jobs[1]!.activeTicks).toBe(320);
    expect(next.records.relocation.jobs[0]!.activeTicks).toBe(200);
    expect(next.records.construction.jobs[1]!.terminal!.tick).toBe(next.records.relocation.jobs[0]!.terminal!.tick);
    expect(next.records.construction.map.navVersion).toBe(bothReady.records.construction.map.navVersion + 2);
    const map = relocationOwnerEffectiveMap(next.records);
    expect(map.ok && isWalkable(map.map, { x: 10, y: 1 })).toBe(false);
    expect(map.ok && isWalkable(map.map, { x: 4, y: 1 })).toBe(false);
  });
  it('shares the last real path-budget request: construction spends it and relocation waits', () => {
    const ctx = nextContext(bothPath); const budget = createWorkPathBudget(ctx.simulationTick);
    for (let i = 0; i < 3; i++) advanceWorkNavigationWithBudget({ map: bothPath.records.construction.map,
      position: { x: 7, y: 5 }, target: { x: 8, y: 5 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    expect(budget.remaining).toBe(1);
    const next = unwrap(tickCandidate(bothPath, ctx, budget));
    expect(budget.remaining).toBe(0); expect(next.records.construction.jobs[1]!.navigation.path.length).toBeGreaterThan(0);
    expect(next.live[0]!.blocked).toBe('PATH_BUDGET');
    expect(next.records.relocation.jobs[0]!.activeTicks).toBe(0);
  });
  it('resets both domains routes when construction changes navigation and reserves summed counters', () => {
    const routing = step(bothPath); const cancelled = cancelBuild(routing);
    expect(cancelled.records.construction.map.navVersion).toBe(routing.records.construction.map.navVersion + 1);
    expect(cancelled.live[0]!.navigation).toEqual(emptyNavigation());
    const tight = cloneJson({ ...bothReady, records: { ...bothReady.records, construction: { ...bothReady.records.construction,
      map: { ...bothReady.records.construction.map, navVersion: Number.MAX_SAFE_INTEGER - 1 } } } });
    rejectedUnchanged(tight, tickCandidate(tight, nextContext(tight), createWorkPathBudget(nextContext(tight).simulationTick)), 'INVALID_FRAME');
    const exact = cloneJson({ ...bothReady, records: { ...bothReady.records, construction: { ...bothReady.records.construction,
      map: { ...bothReady.records.construction.map, navVersion: Number.MAX_SAFE_INTEGER - 2 } } } });
    expect(step(exact).records.construction.map.navVersion).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('counts external jobs, not claim tokens, and rejects cross-domain worker ownership in both command orders', () => {
    const ctx = nextContext(bothReady, { externalActiveJobs: 34 });
    expect(tickCandidate(bothReady, ctx, createWorkPathBudget(ctx.simulationTick)).ok).toBe(true);
    const tooMany = nextContext(bothReady, { externalActiveJobs: 35 });
    rejectedUnchanged(bothReady, tickCandidate(bothReady, tooMany, createWorkPathBudget(tooMany.simulationTick)), 'CAPACITY_EXCEEDED');
    const building = build(place(builtA, 10), 'entity:3');
    rejectedUnchanged(building, commandCandidate(building, context(building), moveCommand(building, 4, 'entity:3')), 'WORKER_UNAVAILABLE');
    const moving = place(move(builtA, 4, 'entity:3'), 10);
    const cmd: ConstructionCommand = { kind: 'construction.start', commandId: 'shared.worker', expectedRevision: moving.records.construction.revision,
      blueprintId: moving.records.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:3' };
    rejectedUnchanged(moving, commandCandidate(moving, context(moving), cmd), 'CLAIM_CONFLICT');
  });
  it.each([{ paused: true }, { mode: 'combat' as const }, { expeditionActive: true }])('advances only the clock without work for %j', patch => {
    const next = step(bothReady, patch);
    expect(next.records.construction.lastSimulationTick).toBe(bothReady.records.construction.lastSimulationTick + 1);
    expect(next.records.construction.lastCalendarTick).toBe(bothReady.records.construction.lastCalendarTick);
    expect(next.records.construction.jobs).toEqual(bothReady.records.construction.jobs);
    expect(next.records.relocation).toEqual(bothReady.records.relocation);
    expect(next.records.construction.people).toEqual(bothReady.records.construction.people);
  });
  it('rejects getters, aliases, mismatched live owners and forged paths without invoking getters or touching source', () => {
    let reads = 0; const getter = Object.defineProperty({}, 'records', { enumerable: true, get() { reads++; return builtA.records; } });
    const badGetter = commandCandidate(getter, context(builtA), moveCommand(builtA));
    expect(badGetter.ok).toBe(false); expect(badGetter.frame).toBe(getter); expect(reads).toBe(0);
    const alias = { ...builtA, records: { ...builtA.records, construction: { ...builtA.records.construction,
      people: builtA.records.construction.people.map((p, i) => i === 0 ? { ...p, position: builtA.records.construction.people[1]!.position } : p) } } };
    rejectedUnchanged(alias, commandCandidate(alias, context(builtA), moveCommand(builtA)), 'INVALID_FRAME');
    const missing = cloneJson({ ...move99, live: [] });
    rejectedUnchanged(missing, commandCandidate(missing, context(move99), moveCommand(move99)), 'INVALID_FRAME');
    const bogus = cloneJson({ ...bothPath, records: { ...bothPath.records, construction: { ...bothPath.records.construction,
      jobs: bothPath.records.construction.jobs.map(job => job.terminal ? job : { ...job,
        navigation: { path: [{ x: 8, y: 4 }], target: { x: 8, y: 4 }, routeVersion: bothPath.records.construction.map.navVersion, movementTicks: 0, retryAtTick: 0 } }) } } });
    expect(validateConstructionRecords(bogus.records.construction)).toEqual([]); // Old shape/adjacency is deliberately frozen.
    rejectedUnchanged(bogus, tickCandidate(bogus, nextContext(bogus), createWorkPathBudget(nextContext(bogus).simulationTick)), 'INVALID_FRAME');
  });
  it('rejects a false construction worker first step even when route target and adjacent path shape look valid', () => {
    const routing = step(bothPath); const job = routing.records.construction.jobs[1]!;
    const bad = cloneJson({ ...routing, records: { ...routing.records, construction: { ...routing.records.construction,
      jobs: routing.records.construction.jobs.map(j => j.jobId === job.jobId ? { ...j, navigation: { ...j.navigation,
        path: [{ x: 6, y: 5 }, { x: 7, y: 5 }], target: { x: 7, y: 5 } } } : j) } } });
    expect(validateConstructionRecords(bad.records.construction)).toEqual([]);
    rejectedUnchanged(bad, tickCandidate(bad, nextContext(bad), createWorkPathBudget(nextContext(bad).simulationTick)), 'INVALID_FRAME');
  });
  it('does not let paused simulation ticks pay for construction movement or its unfinished second leg', () => {
    let started = build(place(seed, 1));
    for (let i = 0; i < 4; i++) started = step(started, { paused: true });
    const forged = cloneJson({ ...started, records: { ...started.records, construction: { ...started.records.construction,
      people: started.records.construction.people.map(person => person.id === 'entity:2' ? { ...person, position: { x: 6, y: 4 } } : person) } } });
    expect(validateConstructionRecords(forged.records.construction)).toEqual([]);
    rejectedUnchanged(forged, tickCandidate(forged, nextContext(forged), createWorkPathBudget(nextContext(forged).simulationTick)), 'INVALID_FRAME');
    const falsePartial = cloneJson({ ...started, records: { ...started.records, construction: { ...started.records.construction,
      jobs: started.records.construction.jobs.map(job => ({ ...job, navigation: { path: [{ x: 7, y: 5 }], target: { x: 7, y: 5 },
        routeVersion: started.records.construction.map.navVersion, movementTicks: 1, retryAtTick: 0 } })) } } });
    expect(validateConstructionRecords(falsePartial.records.construction)).toEqual([]);
    rejectedUnchanged(falsePartial, tickCandidate(falsePartial, nextContext(falsePartial), createWorkPathBudget(nextContext(falsePartial).simulationTick)), 'INVALID_FRAME');
    const realTravel = until(started, f => f.records.construction.jobs[0]!.phase === 'to-site');
    expect(validateConstructionRelocationDomainRuntime(realTravel)).toEqual([]);
    let pausedSite = realTravel;
    for (let i = 0; i < 4; i++) pausedSite = step(pausedSite, { paused: true });
    const falseSecondLeg = cloneJson({ ...pausedSite, records: { ...pausedSite.records, construction: { ...pausedSite.records.construction,
      people: pausedSite.records.construction.people.map(person => person.id === 'entity:2' ? { ...person, position: { x: 6, y: 5 } } : person) } } });
    expect(validateConstructionRecords(falseSecondLeg.records.construction)).toEqual([]);
    rejectedUnchanged(falseSecondLeg, tickCandidate(falseSecondLeg, nextContext(falseSecondLeg), createWorkPathBudget(nextContext(falseSecondLeg).simulationTick)), 'INVALID_FRAME');
    expect(step(realTravel).records.construction.jobs[0]!.navigation.movementTicks).toBe(1);
  });
  it('the fixed lower-level combined wrapper also repeats an equal clock without fractional movement', () => {
    const ctx = nextContext(bothPath); const first = tickConstructionRelocationDomain(bothPath, ctx, createWorkPathBudget(ctx.simulationTick));
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.frame.live[0]!.navigation.movementTicks).toBe(1);
    const again = tickConstructionRelocationDomain(first.frame, ctx, createWorkPathBudget(ctx.simulationTick));
    expect(again.ok && again.repeated).toBe(true); expect(again.frame).toEqual(first.frame);
  });
  it('preflights new construction start against the active relocation navigation obligation', () => {
    const planned = place(move(builtA, 4, 'entity:3'), 10);
    const tight = cloneJson({ ...planned, records: { ...planned.records, construction: { ...planned.records.construction,
      map: { ...planned.records.construction.map, navVersion: Number.MAX_SAFE_INTEGER - 2 } } } });
    const cmd: ConstructionCommand = { kind: 'construction.start', commandId: 'tight.start', expectedRevision: tight.records.construction.revision,
      blueprintId: tight.records.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:4' };
    expect(validateConstructionRelocationDomainRuntime(tight)).toEqual([]);
    rejectedUnchanged(tight, commandCandidate(tight, context(tight), cmd), 'CAPACITY_EXCEEDED');
  });
  it('rejects fake budgets and stale clock without laundering a failed stage into a retry', () => {
    const ctx = nextContext(bothPath); const budget = createWorkPathBudget(ctx.simulationTick);
    // @ts-expect-error Deliberately forged caller budget has no private factory identity.
    rejectedUnchanged(bothPath, tickCandidate(bothPath, ctx, { simulationTick: ctx.simulationTick, remaining: 4 }), 'INVALID_CONTEXT');
    rejectedUnchanged(bothPath, tickCandidate(bothPath, { ...ctx, simulationTick: ctx.simulationTick + 1 }, budget), 'CLOCK_GAP');
    expect(budget.remaining).toBe(4);
  });
  it('preserves the caller budget remaining after prior consumption when a candidate fails, without replenishment', () => {
    // The source still has its one funded cancellation revision. A normal tick consumes
    // that last revision without discharging the job, so the fixed spatial/record query
    // rejects before travel. This case does not claim second-stage failure after first-stage work.
    const tight = frozen(cloneJson({ ...bothPath, records: { ...bothPath.records, construction: { ...bothPath.records.construction,
      revision: Number.MAX_SAFE_INTEGER - 1 } } }));
    expect(validateConstructionRelocationDomainRuntime(tight)).toEqual([]);
    const ctx = nextContext(tight); const budget = createWorkPathBudget(ctx.simulationTick); const before = canonicalStringify(tight);
    for (let i = 0; i < 3; i++) advanceWorkNavigationWithBudget({ map: tight.records.construction.map,
      position: { x: 7, y: 5 }, target: { x: 8, y: 5 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    expect(budget.remaining).toBe(1);
    rejectedUnchanged(tight, tickCandidate(tight, ctx, budget), 'INVALID_FRAME');
    expect(budget.remaining).toBe(1); expect(canonicalStringify(tight)).toBe(before);
  });
  it('never treats research booleans as authority for new gated construction', () => {
    const cmd = { ...placeCommand(builtA, 10), placement: { definitionId: 'alchemy.v9', anchor: { x: 10, y: 1 }, rotation: 0 } };
    rejectedUnchanged(builtA, commandCandidate(builtA, context(builtA), cmd), 'RESEARCH_AUTHORITY_REQUIRED');
    rejectedUnchanged(builtA, commandCandidate(builtA, { ...context(builtA), researchCompleted: true }, cmd), 'INVALID_CONTEXT');
  });
  it('keeps the old permanent-origin APIs strict and old equal-clock relocation replay work-free', () => {
    expect(validateSectRelocationRuntime(movedAgain).length).toBeGreaterThan(0);
    const old = applyConstructionCommand(movedAgain.records.construction, context(movedAgain), placeCommand(movedAgain, 4));
    expect(old).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(applySectRelocationCommand(movedAgain, context(movedAgain), moveCommand(movedAgain, 4))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    const repeated = tickSectRelocation(move99, context(move99), createWorkPathBudget(context(move99).simulationTick));
    expect(repeated.ok && repeated.repeated).toBe(true); expect(repeated.frame).toEqual(move99);
  });
});
