import { beforeAll, describe, expect, it } from 'vitest';
import { emptyNavigation, isWalkable } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { cloneJson } from '../../src/core/kernel/serialization';
import type { ConstructionContext, ConstructionFrame } from '../../src/core/sect-expansion/construction-types';
import { deriveSectFootprint } from '../../src/core/sect-expansion/layout';
import { sectBuildingPlacementAt } from '../../src/core/sect-expansion/relocation-position-records';
import { sectBuildingAvailableDuringRelocation, sectRelocationClaims, sectRelocationEffectiveMap, sectRelocationTargetAvailable } from '../../src/core/sect-expansion/relocation-queries';
import { applySectRelocationCommand, createSectRelocationRuntime, tickSectRelocation, validateSectRelocationRuntime } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectRelocationResult, SectRelocationRuntimeFrame } from '../../src/core/sect-expansion/relocation-runtime-types';
import { createSectRelocationState, validateSectRelocationRecords } from '../../src/core/sect-expansion/relocation-validation';
import type { SectRelocationCommand } from '../../src/core/sect-expansion/relocation-types';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import { fixturePlace, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture } from './fixtures/v9-runtime';

let construction: ConstructionFrame;
let twoConstruction: ConstructionFrame;
beforeAll(() => {
  // Catalog-backed construction setup only; relocation is exercised solely via the new
  // detached runtime. This fixture is not integrated World/save relocation evidence.
  const start = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
  const world = fixtureUntil(start, w => !!w.sectExpansion.construction.jobs.at(-1)!.terminal);
  construction = cloneJson(projectV9SectFrame(world).construction);
  const second = fixtureStartConstruction(fixturePlace(world, 'library.v9', 10));
  twoConstruction = cloneJson(projectV9SectFrame(fixtureUntil(second, w => !!w.sectExpansion.construction.jobs.at(-1)!.terminal)).construction);
}, 120_000);
function unwrap(r: SectRelocationResult): SectRelocationRuntimeFrame {
  if (!r.ok) throw new Error(r.code); return r.frame;
}
function seed(): SectRelocationRuntimeFrame { return createSectRelocationRuntime({ construction: cloneJson(construction), relocation: createSectRelocationState() }); }
function context(f: SectRelocationRuntimeFrame, changes: Partial<ConstructionContext> = {}): ConstructionContext {
  return { simulationTick: f.records.construction.lastSimulationTick, calendarTick: f.records.construction.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...changes };
}
function command(f: SectRelocationRuntimeFrame, x = 4): SectRelocationCommand {
  return { kind: 'relocation.start', commandId: `move.${f.records.relocation.nextId}`, expectedRevision: f.records.relocation.revision,
    buildingId: construction.buildings[0]!.buildingId, workerId: construction.jobs[0]!.workerId,
    target: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } };
}
function start(f = seed(), x = 4): SectRelocationRuntimeFrame { return unwrap(applySectRelocationCommand(f, context(f), command(f, x))); }
function step(f: SectRelocationRuntimeFrame, changes: Partial<ConstructionContext> = {}): SectRelocationRuntimeFrame {
  const active = changes.mode !== 'combat' && !changes.paused && !changes.expeditionActive;
  const c = context(f, { simulationTick: f.records.construction.lastSimulationTick + 1,
    calendarTick: f.records.construction.lastCalendarTick + (active ? 1 : 0), ...changes });
  return unwrap(tickSectRelocation(f, c, createWorkPathBudget(c.simulationTick)));
}
function until(f: SectRelocationRuntimeFrame, done: (v: SectRelocationRuntimeFrame) => boolean): SectRelocationRuntimeFrame {
  for (let n = 0; n < 1800 && !done(f); n++) f = step(f);
  expect(done(f)).toBe(true); return f;
}
function cancel(f: SectRelocationRuntimeFrame): SectRelocationRuntimeFrame {
  return unwrap(applySectRelocationCommand(f, context(f), { kind: 'relocation.cancel', commandId: `cancel.${f.records.relocation.nextId}`,
    expectedRevision: f.records.relocation.revision, jobId: f.records.relocation.jobs.at(-1)!.jobId }));
}
function freeze<T>(x: T): T { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }

describe('isolated relocation runtime', () => {
  it('walks old then new entrance; arrivals grant no work, old hard footprint remains and target is soft', () => {
    let f = start(); const j = f.records.relocation.jobs[0]!;
    expect(sectBuildingAvailableDuringRelocation(f.records, j.buildingId)).toBe(false);
    expect(sectRelocationClaims(f.records)!.some(c => c.kind === 'seat' && c.key === j.buildingId)).toBe(true);
    expect(isWalkable(sectRelocationEffectiveMap(f.records)!, { x: 1, y: 1 })).toBe(false);
    expect(isWalkable(sectRelocationEffectiveMap(f.records)!, { x: 4, y: 1 })).toBe(true);
    f = until(f, v => !!v.records.relocation.jobs[0]!.oldEntranceVisit);
    expect(f.records.relocation.jobs[0]!.activeTicks).toBe(0);
    f = until(f, v => v.records.relocation.jobs[0]!.phase === 'working');
    expect(f.records.relocation.jobs[0]!.activeTicks).toBe(0);
    expect(f.records.relocation.jobs[0]!.newEntranceVisits[0]!.calendarTick).toBeGreaterThan(j.startedCalendarTick);
    expect(step(f).records.relocation.jobs[0]!.activeTicks).toBe(1);
  });
  it('finishes deterministically, charges wood 1+1, preserves immutable origin and changes navVersion exactly once', () => {
    const original = seed(); const moved = until(start(original), v => !!v.records.relocation.jobs[0]!.terminal);
    const job = moved.records.relocation.jobs[0]!;
    expect(job.terminal!.kind).toBe('completed'); expect(job.activeTicks).toBe(200);
    expect(job.checkpoints.map(c => c.activeTicks)).toEqual([100, 200]);
    expect(job.terminal!.consumed).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }]);
    expect(moved.records.construction.buildings).toEqual(original.records.construction.buildings);
    expect(moved.records.construction.jobs).toEqual(original.records.construction.jobs);
    expect(moved.records.construction.map.navVersion).toBe(original.records.construction.map.navVersion + 1);
    expect(sectBuildingPlacementAt(moved.records, job.buildingId, job.terminal!.tick)!.anchor).toEqual({ x: 4, y: 1 });
    expect(isWalkable(sectRelocationEffectiveMap(moved.records)!, { x: 1, y: 1 })).toBe(true);
    expect(isWalkable(sectRelocationEffectiveMap(moved.records)!, { x: 4, y: 1 })).toBe(false);
    expect(sectBuildingAvailableDuringRelocation(moved.records, job.buildingId)).toBe(true);
    expect(moved.live).toEqual([]); expect(validateSectRelocationRuntime(JSON.parse(JSON.stringify(moved)))).toEqual([]);
    expect(until(start(original), v => !!v.records.relocation.jobs[0]!.terminal)).toEqual(moved);
  });
  it.each([0, 99, 100, 199])('cancels at %i work without teleport or consumed refund', ticks => {
    let f = start(); if (ticks) f = until(f, v => v.records.relocation.jobs[0]!.activeTicks === ticks);
    const after = cancel(f); const job = after.records.relocation.jobs[0]!;
    expect(after.records.construction.people).toEqual(f.records.construction.people);
    expect(after.records.construction.map.navVersion).toBe(f.records.construction.map.navVersion);
    expect(job.terminal!.consumed).toEqual(ticks >= 100 ? [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] : []);
    expect(job.terminal!.released).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: ticks >= 100 ? 1 : 2 }]);
    expect(sectBuildingPlacementAt(after.records, job.buildingId, after.records.construction.lastSimulationTick)!.anchor).toEqual({ x: 1, y: 1 });
    expect(sectBuildingAvailableDuringRelocation(after.records, job.buildingId)).toBe(true);
  });
  it('waits at 200 when a person enters target footprint; cancellation releases wood1', () => {
    let f = until(start(), v => v.records.relocation.jobs[0]!.activeTicks === 199);
    const j = f.records.relocation.jobs[0]!; const other = f.records.construction.people.find(p => p.id !== j.workerId)!;
    f = cloneJson({ ...f, records: { ...f.records, construction: { ...f.records.construction,
      people: f.records.construction.people.map(p => p.id === other.id ? { ...p, position: { x: 4, y: 1 }, away: false } : p) } } });
    f = step(f); expect(f.records.relocation.jobs[0]!.phase).toBe('waiting-completion');
    const wait = step(f); expect(wait.records.relocation.jobs[0]!.activeTicks).toBe(200);
    expect(wait.records.relocation.jobs[0]!.checkpoints).toHaveLength(1);
    expect(wait.records.construction.map.navVersion).toBe(construction.map.navVersion);
    expect(cancel(wait).records.relocation.jobs[0]!.terminal!.released).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 1 }]);
    const free = cloneJson({ ...wait, records: { ...wait.records, construction: { ...wait.records.construction,
      people: wait.records.construction.people.map(p => p.id === other.id ? other : p) } } });
    const complete = step(free); expect(complete.records.relocation.jobs[0]!.terminal!.kind).toBe('completed');
    expect(complete.records.relocation.jobs[0]!.checkpoints).toHaveLength(2);
  });
  it.each([{ paused: true }, { mode: 'combat' as const }, { expeditionActive: true }])('does no movement or work during %j', mode => {
    const f = start(); const next = step(f, mode);
    expect(next.records.relocation).toEqual(f.records.relocation); expect(next.records.construction.people).toEqual(f.records.construction.people);
    const work = until(f, v => v.records.relocation.jobs[0]!.activeTicks === 99);
    const paused = step(work, mode); expect(paused.records.relocation.jobs[0]!.activeTicks).toBe(99);
    expect(step(paused).records.relocation.jobs[0]!.activeTicks).toBe(100);
  });
  it('replays commands and ticks without allocating IDs, but rejects identity collisions', () => {
    const f = seed(); const c = command(f); const moved = unwrap(applySectRelocationCommand(f, context(f), c));
    const replay = applySectRelocationCommand(moved, context(moved), c); expect(replay.ok && replay.repeated).toBe(true);
    expect(replay.frame).toEqual(moved);
    const conflict = applySectRelocationCommand(moved, context(moved), { ...c, workerId: 'missing' });
    expect(conflict.ok).toBe(false); if (!conflict.ok) expect(conflict.code).toBe('IDENTITY_CONFLICT');
    const duplicate = tickSectRelocation(moved, context(moved), createWorkPathBudget(context(moved).simulationTick));
    expect(duplicate.ok && duplicate.repeated).toBe(true); expect(duplicate.frame).toEqual(moved);
  });
  it('rejects stale context, busy worker/building and external claims without touching frozen source', () => {
    const f = freeze(seed()); const c = command(f);
    const contexts = [context(f, { simulationTick: context(f).simulationTick + 1 }),
      context(f, { externalClaims: [{ kind: 'worker' as const, key: construction.jobs[0]!.workerId, ownerId: 'external.owner' }] }),
      context(f, { externalClaims: [{ kind: 'seat' as const, key: construction.buildings[0]!.buildingId, ownerId: 'external.owner' }] })];
    for (const ctx of contexts) { const r = applySectRelocationCommand(f, ctx, c); expect(r.ok).toBe(false); expect(r.frame).toBe(f); }
    const busy = start(); const r = applySectRelocationCommand(busy, context(busy), command(busy, 10)); expect(r.ok).toBe(false); expect(r.frame).toBe(busy);
    expect(f.records.relocation.nextId).toBe(1);
  });
  it('rejects invalid targets and geometry, and runtime navigation/owner forgery', () => {
    const f = seed(); const c = command(f); expect(c.kind).toBe('relocation.start'); if (c.kind !== 'relocation.start') return;
    for (const target of [{ ...c.target, anchor: { x: 255, y: 255 } }, { ...c.target, anchor: { x: 1, y: 1 } }, { ...c.target, rotation: 45 }]) {
      const r = applySectRelocationCommand(f, context(f), { ...c, target }); expect(r.ok).toBe(false); expect(r.frame).toBe(f);
    }
    const live = start();
    expect(validateSectRelocationRuntime({ ...live, live: [] }).length).toBeGreaterThan(0);
    expect(validateSectRelocationRuntime({ ...live, live: [{ ...live.live[0]!, navigation: { ...emptyNavigation(), movementTicks: 4 } }] }).length).toBeGreaterThan(0);
    expect(validateSectRelocationRecords(live.records)).toEqual([]);
  });
  it('uses the shared budget and rejects wrong tick budgets atomically', () => {
    let f = start(); f = until(f, v => v.records.relocation.jobs[0]!.phase === 'to-new-entrance');
    const c = context(f, { simulationTick: context(f).simulationTick + 1, calendarTick: context(f).calendarTick + 1 });
    const wrong = tickSectRelocation(f, c, createWorkPathBudget(c.simulationTick - 1)); expect(wrong.ok).toBe(false); expect(wrong.frame).toBe(f);
    const budget = createWorkPathBudget(c.simulationTick); const after = unwrap(tickSectRelocation(f, c, budget));
    expect(budget.remaining).toBe(3); expect(after.records.relocation.jobs[0]!.activeTicks).toBe(0);
  });
  it('repeated relocation returns to original geometry without rewriting construction or maintenance origin', () => {
    const first = until(start(), v => !!v.records.relocation.jobs[0]!.terminal);
    const second = until(start(first, 1), v => !!v.records.relocation.jobs[1]!.terminal);
    const last = second.records.relocation.jobs[1]!;
    expect(last.previousRelocationJobId).toBe(first.records.relocation.jobs[0]!.jobId);
    expect(sectBuildingPlacementAt(second.records, last.buildingId, last.terminal!.tick)!.anchor).toEqual({ x: 1, y: 1 });
    expect(second.records.construction.buildings).toEqual(construction.buildings);
    expect(second.records.construction.map.navVersion).toBe(construction.map.navVersion + 2);
  });
  it('rejects missing funds without allocating identity or changing the paired ledger', () => {
    const original = seed(); const source = original.records.construction;
    const poor = cloneJson({ ...original, records: { ...original.records, construction: { ...source,
      ledger: { ...source.ledger, inventory: { ...source.ledger.inventory,
        wood: { ...source.ledger.inventory.wood, owned: source.ledger.inventory.wood.reserved + 1 } } } } } });
    expect(validateSectRelocationRuntime(poor)).toEqual([]);
    const result = applySectRelocationCommand(freeze(poor), context(poor), command(poor));
    expect(result.ok).toBe(false); if (!result.ok) expect(result.code).toBe('INSUFFICIENT_INVENTORY');
    expect(result.frame).toBe(poor); expect(poor.records.relocation.nextId).toBe(1);
  });
  it('permits a reachable overlapping old/new footprint instead of forbidding all overlap', () => {
    const f = until(start(seed(), 2), v => !!v.records.relocation.jobs[0]!.terminal);
    expect(f.records.relocation.jobs[0]!.terminal!.kind).toBe('completed');
    expect(f.records.construction.buildings[0]!.anchor).toEqual({ x: 1, y: 1 });
    expect(sectBuildingPlacementAt(f.records, f.records.construction.buildings[0]!.buildingId, f.records.construction.lastSimulationTick)!.anchor).toEqual({ x: 2, y: 1 });
  });
  it('waits for a genuinely exhausted shared path budget and resumes next tick', () => {
    const f = until(start(), v => v.records.relocation.jobs[0]!.phase === 'to-new-entrance');
    const c = context(f, { simulationTick: context(f).simulationTick + 1, calendarTick: context(f).calendarTick + 1 });
    const budget = createWorkPathBudget(c.simulationTick); const map = sectRelocationEffectiveMap(f.records)!;
    for (let n = 0; n < 4; n++) advanceWorkNavigationWithBudget({ map, position: { x: 1, y: 3 }, target: { x: 4, y: 3 },
      navigation: emptyNavigation(), simulationTick: c.simulationTick }, budget);
    expect(budget.remaining).toBe(0);
    const blocked = unwrap(tickSectRelocation(f, c, budget)); expect(blocked.live[0]!.blocked).toBe('PATH_BUDGET');
    expect(blocked.records.construction.people).toEqual(f.records.construction.people);
    expect(step(blocked).live[0]!.blocked).toBeNull();
  });
  it('recovers from a blocked new entrance after a real terrain revision', () => {
    const original = until(start(), v => v.records.relocation.jobs[0]!.phase === 'to-new-entrance');
    const terrain = (f: SectRelocationRuntimeFrame, walkable: boolean): SectRelocationRuntimeFrame => cloneJson({ ...f,
      records: { ...f.records, construction: { ...f.records.construction, map: { ...f.records.construction.map,
        navVersion: f.records.construction.map.navVersion + 1,
        tiles: f.records.construction.map.tiles.map(t => t.x === 4 && t.y === 3 ? { ...t, walkable } : t) } } } });
    const blocked = step(terrain(original, false)); expect(blocked.live[0]!.blocked).toBe('PATH_BLOCKED');
    expect(blocked.records.relocation.jobs[0]!.activeTicks).toBe(0);
    const restored = until(terrain(blocked, true), v => !!v.records.relocation.jobs[0]!.terminal);
    expect(restored.records.relocation.jobs[0]!.terminal!.kind).toBe('completed');
  });
  it('rejects sparse arrays, extra array properties and noninteger navigation counters', () => {
    const f = start(); const sparse = new Array(1);
    expect(validateSectRelocationRuntime({ ...f, live: sparse }).length).toBeGreaterThan(0);
    const extras = Object.assign([...f.live], { extra: 1 });
    expect(validateSectRelocationRuntime({ ...f, live: extras }).length).toBeGreaterThan(0);
    for (const invalid of ['1', null, false, 0.5, -1]) {
      expect(validateSectRelocationRuntime({ ...f, live: [{ ...f.live[0]!, navigation: { ...emptyNavigation(), movementTicks: invalid } }] }).length).toBeGreaterThan(0);
      expect(validateSectRelocationRuntime({ ...f, live: [{ ...f.live[0]!, navigation: { ...emptyNavigation(), retryAtTick: invalid } }] }).length).toBeGreaterThan(0);
    }
  });
  it('rejects overlapping live soft targets even when altered receipts and histories remain record-valid', () => {
    let f = createSectRelocationRuntime({ construction: cloneJson(twoConstruction), relocation: createSectRelocationState() });
    f = start(f);
    const second = twoConstruction.buildings[1]!;
    const worker = twoConstruction.people.find(p => p.id !== construction.jobs[0]!.workerId && p.lifeState === 'alive'
      && p.canWork && !p.away && !p.productionTransactionId && !p.cultivationOwnerId && !p.otherOwnerId)!;
    let candidate: SectRelocationRuntimeFrame | null = null;
    for (let y = 1; y < twoConstruction.map.height - 2 && !candidate; y++) for (let x = 1; x < twoConstruction.map.width - 2 && !candidate; x++) {
      const result = applySectRelocationCommand(f, context(f), { kind: 'relocation.start', commandId: 'second.move', expectedRevision: 1,
        buildingId: second.buildingId, workerId: worker.id, target: { definitionId: 'library.v9', anchor: { x, y }, rotation: 0 } });
      if (result.ok) candidate = result.frame;
    }
    expect(candidate).not.toBeNull(); if (!candidate) return;
    const target = { definitionId: 'library.v9' as const, anchor: { x: 4, y: 1 }, rotation: 180 as const };
    const changed = cloneJson({ ...candidate, records: { ...candidate.records, relocation: { ...candidate.records.relocation,
      jobs: candidate.records.relocation.jobs.map((j, i) => i === 1 ? { ...j, to: target } : j),
      receipts: candidate.records.relocation.receipts.map((r, i) => i === 1 && r.command.kind === 'relocation.start'
        ? { ...r, command: { ...r.command, target } } : r) } } });
    expect(validateSectRelocationRecords(changed.records)).toEqual([]);
    expect(validateSectRelocationRuntime(changed)).toEqual(['SOFT_TARGET_CONFLICT']);
    expect(tickSectRelocation(changed, context(changed), createWorkPathBudget(context(changed).simulationTick)).ok).toBe(false);
  });
  it('rejects the record-only x6 historical fixture as a live road-occupying target', () => {
    const f = seed(); const c = command(f); if (c.kind !== 'relocation.start') return;
    expect(f.records.construction.map.tiles.find(t => t.x === 7 && t.y === 1)!.terrain).toBe('path');
    const target = { ...c.target, anchor: { x: 6, y: 1 } };
    expect(sectRelocationTargetAvailable(f.records, c.buildingId, target, c.workerId)).toBe(false);
    const result = applySectRelocationCommand(f, context(f), { ...c, target });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.code).toBe('PLACEMENT_CHANGED');
    expect(result.frame).toBe(f); expect(f.records.relocation.nextId).toBe(1);
  });
  it('target query uses real catalog geometry and authenticates records', () => {
    const f = seed(); const c = command(f); if (c.kind !== 'relocation.start') return;
    expect(deriveSectFootprint(c.target).ok).toBe(true);
    expect(sectRelocationTargetAvailable(f.records, c.buildingId, c.target, c.workerId)).toBe(true);
    expect(sectRelocationEffectiveMap({ ...f.records, relocation: { ...f.records.relocation, nextId: 999 } })).toBeNull();
  });
});
