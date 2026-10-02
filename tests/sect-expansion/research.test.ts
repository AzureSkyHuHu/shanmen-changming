import { beforeAll, describe, expect, it } from 'vitest';
import { getSectResearchDefinition } from '../../src/content/sect-v9/catalog';
import type { SectRecipeId, SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget, type WorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionCommand, ConstructionPerson } from '../../src/core/sect-expansion/construction-types';
import { reserveSectResources } from '../../src/core/sect-expansion/ledger';
import { applySectProductionCommand, createSectProductionFrame, tickSectProduction } from '../../src/core/sect-expansion/production';
import type { SectProductionCommand, SectProductionFrame } from '../../src/core/sect-expansion/production-types';
import { validateSectProductionFrame } from '../../src/core/sect-expansion/production-validation';
import { applySectResearchCommand, applySectResearchConstructionCommand, applySectResearchProductionCommand, createSectResearchFrame,
  sectResearchCompletion, tickSectResearch } from '../../src/core/sect-expansion/research';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchContext, type SectResearchFrame, type SectResearchResult } from '../../src/core/sect-expansion/research-types';
import { SECT_RESEARCH_DESCRIPTOR_NODE_BOUND, sectAllLocalClaims, sectResearchClaims, validateSectResearchFrame } from '../../src/core/sect-expansion/research-validation';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldState } from '../../src/core/world/types';

const context = (frame: SectResearchFrame, patch: Partial<SectResearchContext> = {}): SectResearchContext => ({
  simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
  mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch,
});
function accept(result: SectResearchResult): SectResearchFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectResearchFrame(result.frame))}`);
  return result.frame;
}
const command = (frame: SectResearchFrame, researchId: SectResearchId = 'basic-medicine.v9', workerId = 'entity:2'): SectResearchCommand => ({
  kind: 'research.start', commandId: `research.command:${frame.research.revision}`, expectedRevision: frame.research.revision, researchId, workerId,
});
const cancelCommand = (frame: SectResearchFrame): SectResearchCommand => ({ kind: 'research.cancel', commandId: `research.command:${frame.research.revision}`,
  expectedRevision: frame.research.revision, jobId: frame.research.jobs.at(-1)!.jobId });
const start = (frame: SectResearchFrame, researchId: SectResearchId = 'basic-medicine.v9', workerId = 'entity:2'): SectResearchFrame => accept(applySectResearchCommand(frame, context(frame), command(frame, researchId, workerId)));
const cancel = (frame: SectResearchFrame): SectResearchFrame => accept(applySectResearchCommand(frame, context(frame), cancelCommand(frame)));
function step(frame: SectResearchFrame, patch: Partial<SectResearchContext> = {}): SectResearchFrame {
  const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1, ...patch });
  return accept(tickSectResearch(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectResearchFrame, predicate: (frame: SectResearchFrame) => boolean, maximum = 1500): SectResearchFrame {
  let current = frame; for (let i = 0; i < maximum && !predicate(current); i++) current = step(current);
  expect(predicate(current)).toBe(true); return current;
}
const finish = (frame: SectResearchFrame): SectResearchFrame => until(frame, value => value.research.jobs.at(-1)!.terminal?.kind === 'completed');
const prodCommand = (frame: SectResearchFrame, recipeId: SectRecipeId = 'gather.stone.v9', workerId = 'entity:2'): SectProductionCommand => ({
  kind: 'production.start', commandId: `production.command:${frame.production.revision}`, expectedRevision: frame.production.revision, recipeId, workerId,
});
const startProductionLocal = (frame: SectResearchFrame, recipeId: SectRecipeId = 'gather.stone.v9', workerId = 'entity:2'): SectResearchFrame => accept(applySectResearchProductionCommand(frame, context(frame), prodCommand(frame, recipeId, workerId)));
const produce = (frame: SectResearchFrame, recipeId: SectRecipeId): SectResearchFrame => until(startProductionLocal(frame, recipeId), value => value.production.jobs.at(-1)!.terminal?.kind === 'completed');
function construct(frame: SectResearchFrame, command: ConstructionCommand): SectResearchFrame { return accept(applySectResearchConstructionCommand(frame, context(frame), command)); }
function place(frame: SectResearchFrame, x = 1, y = 1): SectResearchFrame {
  return construct(frame, { kind: 'blueprint.place', commandId: `place:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    placement: { definitionId: 'library.v9', anchor: { x, y }, rotation: 0 } });
}
function beginBuilding(frame: SectResearchFrame, workerId = 'entity:2'): SectResearchFrame {
  return construct(frame, { kind: 'construction.start', commandId: `build:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId });
}
function build(frame: SectResearchFrame): SectResearchFrame { const count = frame.construction.buildings.length; return until(beginBuilding(place(frame)), value => value.construction.buildings.length === count + 1); }
function legacyProduce(world: WorldState, recipe = 'craft.plank'): WorldState {
  const begun = startProduction(world, `legacy:${world.clock.simulationTick}`, recipe, 'entity:4'); if (!begun.ok) throw new Error(begun.rejection.code);
  let current = begun.world;
  for (let n = 0; n < 1000 && current.activeProductionTransactionIds.includes(begun.transactionId); n++) current = tickProduction({ ...current, clock: tickClock(current.clock) });
  expect(current.activeProductionTransactionIds).not.toContain(begun.transactionId); return current;
}
function project(world: WorldState): SectResearchFrame {
  return createSectResearchFrame(createSectProductionFrame(createConstructionFrame({
    map: world.map, legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork, away: false,
      productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
  })));
}
function actor(frame: SectResearchFrame, patch: Partial<ConstructionPerson>, workerId = 'entity:2'): SectResearchFrame {
  return { ...frame, construction: { ...frame.construction, people: frame.construction.people.map(person => person.id === workerId ? { ...person, ...patch } : person) } };
}
function rejection(frame: SectResearchFrame, cmd: SectResearchCommand, code: string, ctx = context(frame)): void {
  const before = canonicalStringify(frame); const result = applySectResearchCommand(frame, ctx, cmd);
  expect(result).toMatchObject({ ok: false, code }); expect(result.frame).toBe(frame); expect(canonicalStringify(frame)).toBe(before);
}
let empty: SectResearchFrame; let beforeLibrary: SectResearchFrame; let library: SectResearchFrame; let ready: SectResearchFrame;
let travelling: SectResearchFrame; let arrived: SectResearchFrame; let complete: SectResearchFrame;
beforeAll(() => {
  let world = createWorld('research-zero-stock');
  for (let i = 0; i < 3; i++) world = legacyProduce(world);
  expect(world.inventory.plank.owned).toBe(6); empty = project(world);
  beforeLibrary = produce(produce(empty, 'extract.spirit-stone.v9'), 'extract.spirit-stone.v9');
  library = build(beforeLibrary);
  ready = produce(produce(library, 'study.basic-insight.v9'), 'study.basic-insight.v9');
  travelling = start(ready); arrived = until(travelling, value => value.research.jobs[0]!.phase === 'working'); complete = finish(arrived);
});

describe('isolated paid three-domain research coordinator', () => {
  it('earns basic medicine from zero sect stock and real legacy work in exactly 851 library-calendar ticks', () => {
    expect(empty.construction.ledger.stock).toEqual(createEmptySectStock()); expect(empty.construction.ledger.inventory.plank.owned).toBe(6);
    expect(beforeLibrary.production.jobs.map(job => job.recipeId)).toEqual(['extract.spirit-stone.v9', 'extract.spirit-stone.v9']);
    expect(library.construction.jobs[0]!.activeTicks).toBe(320); expect(library.construction.buildings[0]!.anchor).toEqual({ x: 1, y: 1 });
    const job = complete.research.jobs[0]!; expect(job.activeTicks).toBe(240); expect(job.requiredTicks).toBe(240);
    expect(job.terminal!.calendarTick - library.construction.buildings[0]!.completedCalendarTick).toBe(851);
    expect(job.terminal!.calendarTick).toBeLessThan(job.site.firstMaintenanceCalendarTick);
    expect(job.terminal!.position).toEqual({ x: 1, y: 3 }); expect(job.terminal!.tick).toBe(job.workSpans.at(-1)!.lastTick);
    expect(job.terminal!.consumed).toEqual([{ ledger: 'sect', resourceId: 'spirit-stone', quantity: 2 }, { ledger: 'sect', resourceId: 'basic-insight', quantity: 2 }]);
    expect(complete.construction.ledger.stock).toEqual(createEmptySectStock());
    expect(sectAllLocalClaims(complete)).toEqual([]); expect(validateSectResearchFrame(complete)).toEqual([]);
    expect(sectResearchCompletion(complete, 'basic-medicine.v9')).toEqual(job);
    expect(complete.construction.people.every(person => person.productionTransactionId === null)).toBe(true);
  });
  it('pays once on the final real on-site work tick, never on arrival or via a warehouse delivery', () => {
    expect(arrived.research.jobs[0]!.activeTicks).toBe(0); expect(arrived.research.jobs[0]!.visits).toHaveLength(1);
    expect(travelling.construction.ledger.stock['basic-insight']).toMatchObject({ owned: 2, reserved: 2 });
    let frame = until(arrived, value => value.research.jobs[0]!.activeTicks === 239);
    expect(frame.research.jobs[0]!.terminal).toBeNull(); expect(frame.construction.ledger.stock['spirit-stone'].owned).toBe(2);
    frame = step(frame); expect(frame.research.jobs[0]!.terminal?.kind).toBe('completed'); expect(frame.construction.ledger.stock['spirit-stone'].owned).toBe(0);
    expect(frame.construction.people.find(person => person.id === 'entity:2')!.position).toEqual({ x: 1, y: 3 });
  });
  it('retains completion past expiry, admitting alchemy while requiring its real productive site', () => {
    const expired = until(complete, value => value.construction.lastCalendarTick === value.construction.buildings[0]!.firstMaintenanceCalendarTick);
    expect(sectResearchCompletion(expired, 'basic-medicine.v9')?.terminal?.kind).toBe('completed');
    rejection(expired, command(expired), 'RESEARCH_COMPLETED'); rejection(expired, cancelCommand(expired), 'TRANSACTION_FINISHED');
    expect(applySectResearchProductionCommand(expired, context(expired), prodCommand(expired, 'craft.wound-powder.v9'))).toMatchObject({ ok: false, code: 'WORKSTATION_UNAVAILABLE' });
    expect(applySectResearchProductionCommand(expired, context(expired), prodCommand(expired, 'craft.wound-powder-alt.v9'))).toMatchObject({ ok: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
    expect(applySectResearchConstructionCommand(expired, context(expired), { kind: 'blueprint.place', commandId: 'alchemy', expectedRevision: expired.construction.revision,
      placement: { definitionId: 'alchemy.v9', anchor: { x: 9, y: 1 }, rotation: 90 } })).toMatchObject({ ok: true });
  });
  it('rejects missing prerequisites, duplicate active/completed research, empty inventory and fake libraries', () => {
    rejection(ready, command(ready, 'herbal-compatibility.v9'), 'PREREQUISITE_REQUIRED'); rejection(travelling, command(travelling), 'RESEARCH_ACTIVE');
    rejection(complete, command(complete), 'RESEARCH_COMPLETED'); rejection(library, command(library), 'INSUFFICIENT_INVENTORY');
    rejection(beforeLibrary, command(beforeLibrary), 'WORKSTATION_UNAVAILABLE');
    const fake = { ...beforeLibrary, construction: { ...beforeLibrary.construction, buildings: library.construction.buildings } };
    rejection(fake, command(fake), 'INVALID_FRAME');
  });
  it.each(['to-site', 'working'] as const)('cancels %s once, preserves position/history and genuinely restarts', phase => {
    const frame = phase === 'to-site' ? travelling : arrived; const cmd = cancelCommand(frame); const source = cloneJson(frame);
    const cancelled = accept(applySectResearchCommand(frame, context(frame), cmd));
    expect(cancelled.construction.people).toEqual(frame.construction.people); expect(cancelled.construction.ledger.stock).toEqual(ready.construction.ledger.stock);
    expect(cancelled.research.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', previousPhase: phase, consumed: [] });
    expect(sectResearchClaims(cancelled)).toEqual([]); expect(frame).toEqual(source);
    expect(applySectResearchCommand(cancelled, context(cancelled), cmd)).toMatchObject({ ok: true, repeated: true, frame: cancelled });
    rejection(cancelled, cancelCommand(cancelled), 'TRANSACTION_FINISHED');
    const restarted = finish(start(cancelled)); expect(restarted.research.jobs.map(job => job.terminal?.kind)).toEqual(['cancelled', 'completed']);
    expect(restarted.construction.ledger.stock).toEqual(createEmptySectStock());
  });
  it('exact retries preserve IDs, receipts and payment across completion', () => {
    const cmd = command(ready); expect(applySectResearchCommand(travelling, context(travelling), cmd)).toMatchObject({ ok: true, repeated: true, frame: travelling });
    expect(applySectResearchCommand(complete, context(complete), cmd)).toMatchObject({ ok: true, repeated: true, frame: complete });
    rejection(travelling, { ...cmd, expectedRevision: travelling.research.revision }, 'IDENTITY_CONFLICT');
    rejection(ready, { ...cmd, expectedRevision: 0 }, 'STALE_REVISION');
  });
  it.each(['travelling', 'arrived', 'working'] as const)('continues JSON from %s with identical IDs, receipts and payment', phase => {
    const source = phase === 'travelling' ? travelling : phase === 'arrived' ? arrived : step(arrived);
    const sourceText = canonicalStringify(source); const restored = JSON.parse(JSON.stringify(source)) as SectResearchFrame;
    expect(validateSectResearchFrame(restored)).toEqual([]);
    // All three genuine checkpoints belong to the exact journey completed in beforeAll.
    // Reuse that validated final frame rather than executing the unchanged source again.
    const resumed = finish(restored); expect(resumed).toEqual(complete);
    expect(validateSectResearchFrame(resumed)).toEqual([]); expect(canonicalStringify(source)).toBe(sourceText);
  });
  it('replays research receipts after external takeover and capacity pressure, while still validating the complete boundary', () => {
    const cmd = command(ready); const sourceText = canonicalStringify(travelling);
    const pressure = context(travelling, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:2', ownerId: 'away:1' }] });
    const repeated = applySectResearchCommand(travelling, pressure, cmd);
    expect(repeated).toMatchObject({ ok: true, repeated: true, jobId: travelling.research.jobs[0]!.jobId });
    expect(repeated.frame).toBe(travelling); expect(canonicalStringify(travelling)).toBe(sourceText);
    rejection(travelling, { ...cmd, expectedRevision: travelling.research.revision }, 'IDENTITY_CONFLICT', pressure);
    rejection(travelling, cmd, 'INVALID_CONTEXT', { ...pressure, externalActiveJobs: 37 });
    rejection(travelling, cmd, 'STALE_CLOCK', { ...pressure, simulationTick: pressure.simulationTick + 1 });
    const invalid = { ...travelling, research: { ...travelling.research, nextId: 1 } };
    rejection(invalid, cmd, 'INVALID_FRAME', pressure);
  });
  it('keeps frozen source frames unchanged across successful start, movement and cancellation', () => {
    const freeze = <T,>(value: T): T => {
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const source = freeze(cloneJson(ready)); const sourceText = canonicalStringify(source);
    const begun = freeze(start(source)); const begunText = canonicalStringify(begun);
    const moved = freeze(step(begun)); const movedText = canonicalStringify(moved);
    const cancelled = cancel(moved);
    expect(canonicalStringify(source)).toBe(sourceText); expect(canonicalStringify(begun)).toBe(begunText);
    expect(canonicalStringify(moved)).toBe(movedText); expect(cancelled.construction.people).toEqual(moved.construction.people);
    expect(cancelled.construction.ledger.stock).toEqual(ready.construction.ledger.stock);
  });
  it('preserves work gaps and never works during pause, combat, expedition, clock gaps or arrival', () => {
    let frame = step(arrived); const progress = frame.research.jobs[0]!.activeTicks; const paused = context(frame, { paused: true });
    expect(tickSectResearch(frame, paused, createWorkPathBudget(paused.simulationTick))).toMatchObject({ ok: true, repeated: true, frame });
    frame = step(frame, { mode: 'combat', calendarTick: frame.construction.lastCalendarTick }); frame = step(frame, { expeditionActive: true });
    expect(frame.research.jobs[0]!.activeTicks).toBe(progress); frame = step(frame); expect(frame.research.jobs[0]!.workSpans).toHaveLength(2);
    const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    expect(tickSectResearch(frame, { ...ctx, paused: true }, createWorkPathBudget(ctx.simulationTick))).toMatchObject({ ok: false, code: 'STALE_CLOCK' });
    expect(tickSectResearch(frame, { ...ctx, simulationTick: ctx.simulationTick + 1 }, createWorkPathBudget(ctx.simulationTick + 1))).toMatchObject({ ok: false, code: 'CLOCK_GAP' });
  });
  it.each([{ away: true }, { canWork: false }, { lifeState: 'dead' as const }, { lifeState: 'pendingDeath' as const },
    { cultivationOwnerId: 'retreat:1' }, { productionTransactionId: 'legacy:1' }, { otherOwnerId: 'care:1' }])('preserves cancellation after projected worker loss %s', patch => {
    rejection(actor(ready, patch), command(ready), 'WORKER_UNAVAILABLE');
    const blocked = step(actor(arrived, patch)); expect(blocked.research.jobs[0]!.activeTicks).toBe(0); expect(blocked.research.jobs[0]!.blocked).toBe('WORKER_UNAVAILABLE');
    const next = cancel(blocked); expect(next.construction.people).toEqual(blocked.construction.people); expect(next.construction.ledger.stock).toEqual(ready.construction.ledger.stock);
  });
  it.each(['to-site', 'working'] as const)('expiry during %s retains unpaid reservations and permits cancellation', phase => {
    // Clock-only pressure projection; no completion, work, visit or paid period is fabricated.
    const source = phase === 'to-site' ? travelling : arrived;
    const shift = source.construction.buildings[0]!.firstMaintenanceCalendarTick - source.construction.lastCalendarTick - 1;
    let frame = { ...source, construction: { ...source.construction, lastSimulationTick: source.construction.lastSimulationTick + shift,
      lastCalendarTick: source.construction.lastCalendarTick + shift } };
    expect(validateSectResearchFrame(frame)).toEqual([]); frame = step(frame);
    expect(frame.research.jobs[0]!.blocked).toBe('WORKSTATION_UNAVAILABLE'); expect(frame.research.jobs[0]!.activeTicks).toBe(0);
    expect(cancel(frame).construction.ledger.stock).toEqual(ready.construction.ledger.stock);
  });
  it('rejects start at expiry and blocks an otherwise final work tick on the exact unpaid boundary', () => {
    const shift = ready.construction.buildings[0]!.firstMaintenanceCalendarTick - ready.construction.lastCalendarTick;
    const expired = { ...ready, construction: { ...ready.construction, lastSimulationTick: ready.construction.lastSimulationTick + shift, lastCalendarTick: ready.construction.lastCalendarTick + shift } };
    rejection(expired, command(expired), 'WORKSTATION_UNAVAILABLE');
    const near = until(arrived, frame => frame.research.jobs[0]!.activeTicks === 239);
    const gap = near.construction.buildings[0]!.firstMaintenanceCalendarTick - near.construction.lastCalendarTick - 1;
    const blocked = step({ ...near, construction: { ...near.construction, lastSimulationTick: near.construction.lastSimulationTick + gap, lastCalendarTick: near.construction.lastCalendarTick + gap } });
    expect(blocked.research.jobs[0]!.activeTicks).toBe(239); expect(blocked.research.jobs[0]!.terminal).toBeNull();
    expect(cancel(blocked).construction.ledger.stock['basic-insight'].owned).toBe(2);
  });
  it('keeps the public two-domain APIs fail-closed with all research reservations still in the shared book', () => {
    const two: SectProductionFrame = { schemaVersion: 1, construction: travelling.construction, production: travelling.production };
    expect(validateSectProductionFrame(two)).toEqual([{ code: 'ORPHAN_RESERVATION', path: travelling.research.jobs[0]!.reservationId }]);
    expect(applySectProductionCommand(two, context(travelling), prodCommand(travelling))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(tickSectProduction(two, context(travelling), createWorkPathBudget(travelling.construction.lastSimulationTick))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(validateSectResearchFrame(travelling)).toEqual([]);
  });
  it('rejects production/research seat and worker contention and releases claims after real cancellation', () => {
    expect(applySectResearchProductionCommand(travelling, context(travelling), prodCommand(travelling, 'gather.stone.v9'))).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT' });
    expect(applySectResearchProductionCommand(travelling, context(travelling), prodCommand(travelling, 'study.basic-insight.v9', 'entity:4'))).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT' });
    // Source has consumed its two spare planks; explicit base-stock pressure only supplies the next paid recipe.
    const supplied = { ...ready, construction: { ...ready.construction, ledger: { ...ready.construction.ledger,
      inventory: { ...ready.construction.ledger.inventory, plank: { ...ready.construction.ledger.inventory.plank, owned: 1 }, herbs: { ...ready.construction.ledger.inventory.herbs, owned: 2 } } } } };
    let frame = step(startProductionLocal(supplied, 'study.basic-insight.v9', 'entity:4'));
    rejection(frame, command(frame), 'CLAIM_CONFLICT');
    frame = accept(applySectResearchProductionCommand(frame, context(frame), { kind: 'production.cancel', commandId: 'free.library', expectedRevision: frame.production.revision, jobId: frame.production.jobs.at(-1)!.transactionId }));
    expect(start(frame).research.jobs).toHaveLength(1);
  });
  it('rejects duplicate external entrance claims rather than overwriting maps, yet permits cancellation after external worker takeover', () => {
    const claims = sectResearchClaims(travelling);
    const ctx = context(travelling, { simulationTick: travelling.construction.lastSimulationTick + 1, calendarTick: travelling.construction.lastCalendarTick + 1,
      externalClaims: [{ ...claims[2]!, ownerId: 'outsider:1' }] });
    expect(tickSectResearch(travelling, ctx, createWorkPathBudget(ctx.simulationTick))).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT', frame: travelling });
    const cancelled = accept(applySectResearchCommand(travelling, context(travelling, { externalClaims: [{ ...claims[0]!, ownerId: 'away:1' }] }), cancelCommand(travelling)));
    expect(sectResearchClaims(cancelled)).toEqual([]);
  });
  it('uses one real budget in construction→production→research order and reads the current candidate', () => {
    // Base-material pressure is explicit; the second building must still travel and earn all work.
    let frame = { ...ready, construction: { ...ready.construction, ledger: { ...ready.construction.ledger,
      inventory: { ...ready.construction.ledger.inventory, wood: { ...ready.construction.ledger.inventory.wood, owned: 30 },
        stone: { ...ready.construction.ledger.inventory.stone, owned: 20 }, plank: { ...ready.construction.ledger.inventory.plank, owned: 8 } } } } };
    frame = step(beginBuilding(place(frame, 9, 1), 'entity:4')); frame = startProductionLocal(frame, 'gather.stone.v9', 'entity:3'); frame = start(frame);
    const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    const budget = createWorkPathBudget(ctx.simulationTick);
    for (let i = 0; i < 2; i++) advanceWorkNavigationWithBudget({ map: frame.construction.map, position: { x: 0, y: 0 }, target: { x: 13, y: 9 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    const next = accept(tickSectResearch(frame, ctx, budget)); expect(budget.remaining).toBe(0);
    expect(next.construction.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0); expect(next.production.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0);
    expect(next.research.jobs[0]!.blocked).toBe('PATH_BUDGET'); expect(next.research.jobs[0]!.activeTicks).toBe(0);
    expect(next.construction.lastSimulationTick).toBe(ctx.simulationTick); expect(next.research.revision).toBe(frame.research.revision + 1);
    expect(next.production.revision).toBe(frame.production.revision + 1); expect(next.construction.revision).toBe(frame.construction.revision + 1);
    const repeated = tickSectResearch(next, ctx, budget);
    expect(repeated).toMatchObject({ ok: true, repeated: true }); expect(repeated.frame).toBe(next); expect(budget.remaining).toBe(0);
    expect(tickSectResearch(frame, ctx, { simulationTick: ctx.simulationTick, remaining: 4 } as WorkPathBudget)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT' });
  });
  describe('second node after a genuinely completed second library', () => {
    let secondLibrary: SectResearchFrame;
    beforeAll(() => {
      // Explicit resource-pressure fixture tests the second registered transition, not a sustainable
      // bootstrap. The prerequisite and both library buildings still require genuine completed jobs.
      // Six insights plus both research nodes need 2080 library seat ticks before any travel.
      let frame = { ...complete, construction: { ...complete.construction, ledger: { ...complete.construction.ledger,
        inventory: { ...complete.construction.ledger.inventory, wood: { ...complete.construction.ledger.inventory.wood, owned: 8 },
          stone: { ...complete.construction.ledger.inventory.stone, owned: 4 }, plank: { ...complete.construction.ledger.inventory.plank, owned: 4 } },
        stock: { ...complete.construction.ledger.stock, 'basic-insight': { owned: 4, reserved: 0, capacity: 99 as const }, 'spirit-stone': { owned: 4, reserved: 0, capacity: 99 as const } } } } };
      frame = until(beginBuilding(place(frame, 9, 1)), value => value.construction.buildings.length === 2);
      secondLibrary = frame; expect(validateSectResearchFrame(secondLibrary)).toEqual([]);
      expect(secondLibrary.construction.jobs.at(-1)).toMatchObject({ activeTicks: 320, terminal: { kind: 'completed' } });
    });
    it('supports the second node with the same 400 real work ticks and the exact durable prerequisite reference', () => {
      const source = secondLibrary; const sourceText = canonicalStringify(source); let frame = source;
      frame = start(frame, 'herbal-compatibility.v9');
      expect(frame.research.jobs[1]!.site.buildingId).toBe(frame.construction.buildings[1]!.buildingId);
      expect(frame.research.jobs[1]!.prerequisites).toEqual([{ researchId: 'basic-medicine.v9', completionJobId: frame.research.jobs[0]!.jobId }]);
      frame = finish(frame); const job = frame.research.jobs[1]!;
      expect(job.activeTicks).toBe(400); expect(job.terminal!.consumed).toEqual([
        { ledger: 'sect', resourceId: 'spirit-stone', quantity: 4 }, { ledger: 'sect', resourceId: 'basic-insight', quantity: 4 },
      ]);
      expect(frame.construction.ledger.stock).toEqual(createEmptySectStock()); expect(validateSectResearchFrame(frame)).toEqual([]);
      expect(sectResearchCompletion(frame, 'basic-medicine.v9')?.jobId).toBe(source.research.jobs[0]!.jobId);
      rejection(frame, command(frame, 'herbal-compatibility.v9'), 'RESEARCH_COMPLETED');
      for (const recipe of ['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'] as const) {
        expect(applySectResearchProductionCommand(frame, context(frame), prodCommand(frame, recipe))).toMatchObject({ ok: false,
          code: recipe === 'craft.wound-powder.v9' ? 'WORKSTATION_UNAVAILABLE' : 'RESEARCH_AUTHORITY_REQUIRED', frame });
      }
      const forged = cloneJson(frame) as any; forged.research.jobs[1].prerequisites[0].completionJobId = forged.research.jobs[1].jobId;
      expect(validateSectResearchFrame(forged).length).toBeGreaterThan(0);
      const chronological = cloneJson(frame) as any; chronological.research.jobs[1].startedTick = chronological.research.jobs[0].startedTick;
      expect(validateSectResearchFrame(chronological).length).toBeGreaterThan(0);
      expect(canonicalStringify(source)).toBe(sourceText);
    });
  });
  it('keeps two real builders at distinct sites compatible and allows a concurrent producer to finish', () => {
    // Only balances are a capacity fixture; all three job histories are executed normally.
    let frame = { ...empty, construction: { ...empty.construction, ledger: { ...empty.construction.ledger,
      inventory: { ...empty.construction.ledger.inventory, wood: { ...empty.construction.ledger.inventory.wood, owned: 30 },
        stone: { ...empty.construction.ledger.inventory.stone, owned: 20 }, plank: { ...empty.construction.ledger.inventory.plank, owned: 8 } } } } };
    frame = beginBuilding(place(frame), 'entity:3'); frame = beginBuilding(place(frame, 9, 1), 'entity:4');
    frame = startProductionLocal(frame, 'gather.stone.v9', 'entity:2');
    frame = until(frame, value => value.construction.buildings.length === 2 && value.production.jobs[0]!.terminal?.kind === 'completed');
    expect(frame.construction.jobs.map(job => job.activeTicks)).toEqual([320, 320]); expect(sectAllLocalClaims(frame)).toEqual([]);
  });
  it('serializes actual competing storage deliveries and resumes the waiting producer after release', () => {
    let frame = startProductionLocal(beforeLibrary, 'extract.spirit-stone.v9', 'entity:4');
    for (let n = 0; n < 96; n++) frame = step(frame);
    frame = startProductionLocal(frame, 'gather.stone.v9', 'entity:2');
    frame = until(frame, value => value.production.jobs.at(-1)!.blockedReason === 'STORAGE_UNAVAILABLE');
    expect(sectAllLocalClaims(frame).filter(claim => claim.kind === 'entrance' && claim.key === '7,5')).toHaveLength(1);
    const count = frame.production.jobs.length;
    frame = until(frame, value => value.production.jobs.slice(-2).every(job => job.terminal?.kind === 'completed'));
    expect(frame.production.jobs).toHaveLength(count); expect(sectAllLocalClaims(frame)).toEqual([]);
  });
  it('replays production and construction receipts before newly changed external ownership or capacity', () => {
    const pCommand = prodCommand(beforeLibrary, 'gather.stone.v9');
    const production = accept(applySectResearchProductionCommand(beforeLibrary, context(beforeLibrary), pCommand));
    const pContext = context(production, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:2', ownerId: 'away:1' }] });
    expect(applySectResearchProductionCommand(production, pContext, pCommand)).toMatchObject({ ok: true, repeated: true, frame: production });
    expect(applySectResearchProductionCommand(production, pContext, { ...pCommand, expectedRevision: production.production.revision })).toMatchObject({ ok: false, code: 'IDENTITY_CONFLICT' });
    expect(applySectResearchProductionCommand(production, { ...pContext, externalActiveJobs: 37 }, pCommand)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT' });
    expect(applySectResearchProductionCommand(production, { ...pContext, simulationTick: pContext.simulationTick + 1 }, pCommand)).toMatchObject({ ok: false, code: 'STALE_CLOCK' });
    expect(applySectResearchProductionCommand({ ...production, research: { ...production.research, nextId: 0 } }, pContext, pCommand)).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    const planned = place(beforeLibrary);
    const cCommand: ConstructionCommand = { kind: 'construction.start', commandId: 'repeat.builder', expectedRevision: planned.construction.revision,
      blueprintId: planned.construction.blueprints[0]!.blueprintId, workerId: 'entity:2' };
    const construction = construct(planned, cCommand);
    const cContext = context(construction, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:2', ownerId: 'away:1' }] });
    expect(applySectResearchConstructionCommand(construction, cContext, cCommand)).toMatchObject({ ok: true, repeated: true, frame: construction });
    expect(applySectResearchConstructionCommand(construction, cContext, { ...cCommand, expectedRevision: construction.construction.revision })).toMatchObject({ ok: false, code: 'IDENTITY_CONFLICT' });
    expect(applySectResearchConstructionCommand(construction, { ...cContext, externalActiveJobs: 37 }, cCommand)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT' });
    expect(applySectResearchConstructionCommand(construction, { ...cContext, simulationTick: cContext.simulationTick + 1 }, cCommand)).toMatchObject({ ok: false, code: 'STALE_CLOCK' });
    expect(applySectResearchConstructionCommand({ ...construction, research: { ...construction.research, nextId: 0 } }, cContext, cCommand)).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
  });
  it('rejects reordered same-clock cancelled receipts that imply two historically live research jobs', () => {
    const frame = cancel(start(cancel(start(ready))));
    expect(validateSectResearchFrame(frame)).toEqual([]);
    const forged = cloneJson(frame) as any;
    const first = forged.research.receipts[0].revision;
    const reordered = [forged.research.receipts[0], forged.research.receipts[2], forged.research.receipts[1], forged.research.receipts[3]];
    forged.research.receipts = reordered.map((receipt: any, index: number) => ({ ...receipt, revision: first + index, command: { ...receipt.command, expectedRevision: first + index - 1 } }));
    expect(validateSectResearchFrame(forged)).toEqual([{ code: 'INVALID_RECEIPT_CHRONOLOGY', path: frame.research.jobs[1]!.jobId }]);
  });
  it('binds start-receipt order to the retained job order even for independent same-clock cancellations', () => {
    const frame = cancel(start(cancel(start(ready)))); const receipts = frame.research.receipts;
    const firstRevision = receipts[0]!.revision;
    const reordered = [receipts[2]!, receipts[3]!, receipts[0]!, receipts[1]!];
    const forged: SectResearchFrame = { ...frame, research: { ...frame.research,
      receipts: reordered.map((receipt, index) => ({ ...receipt, revision: firstRevision + index,
        command: { ...receipt.command, expectedRevision: firstRevision + index - 1 } })) } };
    expect(validateSectResearchFrame(forged)).toEqual([{ code: 'INVALID_RECEIPT_CHRONOLOGY', path: frame.research.jobs[1]!.jobId }]);
  });
  it.each(['costs', 'outputs', 'effects', 'completed', 'requiredTicks', 'prerequisites'] as const)('rejects caller-supplied %s before allocating', name => {
    rejection(ready, { ...command(ready), [name]: [] } as SectResearchCommand, 'INVALID_COMMAND');
  });
  it('rejects accessors, sparse arrays, cycles, unknown fields and malformed descriptors without invoking getters', () => {
    let reads = 0; const getter = Object.defineProperty({}, 'jobs', { enumerable: true, get: () => { reads++; return []; } });
    expect(validateSectResearchFrame({ ...ready, research: getter }).length).toBeGreaterThan(0); expect(reads).toBe(0);
    expect(validateSectResearchFrame({ ...ready, research: { ...ready.research, jobs: Array(1) } }).length).toBeGreaterThan(0);
    const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
    expect(validateSectResearchFrame({ ...ready, research: cyclic }).length).toBeGreaterThan(0);
    expect(validateSectResearchFrame({ ...ready, unlocks: ['basic-medicine.v9'] }).length).toBeGreaterThan(0);
    expect(validateSectResearchFrame({ ...travelling, research: { ...travelling.research, completed: [] } }).length).toBeGreaterThan(0);
  });
  it('preserves exact ID/revision cancellation headroom and rejects one-short starts', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const source = { ...ready, research: { ...ready.research, revision: MAX - 2, nextId: MAX - 2 } };
    const started = start(source); expect(started.research.nextId).toBe(MAX);
    const cancelled = cancel(started); expect(cancelled.research.revision).toBe(MAX); expect(cancelled.research.nextId).toBe(MAX);
    expect(validateSectResearchFrame(cancelled)).toEqual([]);
    const noRevision = { ...ready, research: { ...ready.research, revision: MAX - 1 } }; rejection(noRevision, command(noRevision), 'CAPACITY_EXCEEDED');
    const noId = { ...ready, research: { ...ready.research, nextId: MAX - 1 } }; rejection(noId, command(noId), 'CAPACITY_EXCEEDED');
  });
  it.each(['job-id', 'reservation-id', 'receipt', 'span', 'visit', 'site', 'cost', 'settlement', 'orphan', 'prerequisite', 'completion-time'] as const)('rejects forged %s with source immutability', kind => {
    const frame = cloneJson(complete) as any; const job = frame.research.jobs[0];
    if (kind === 'job-id') job.jobId = 'sect-research:01';
    if (kind === 'reservation-id') job.reservationId = 'sect-research-reservation:1';
    if (kind === 'receipt') frame.research.receipts = [];
    if (kind === 'span') job.workSpans[0].lastTick--;
    if (kind === 'visit') job.visits[0].position = { x: 7, y: 5 };
    if (kind === 'site') job.site.sourceJobId = 'sect-construction:999';
    if (kind === 'cost') frame.construction.ledger.reservations.at(-1).sect.lines[0].quantity++;
    if (kind === 'settlement') frame.construction.ledger.reservations.at(-1).sect.settlement.outputs = [{ resourceId: 'wound-powder', quantity: 1 }];
    if (kind === 'orphan') { const reserved = reserveSectResources(frame.construction.ledger, { reservationId: 'alien:1', ownerTransactionId: 'alien:2' }, [], 'on-completion'); if (!reserved.ok) throw new Error(reserved.rejection.code); frame.construction.ledger = reserved.context; }
    if (kind === 'prerequisite') job.prerequisites = [{ researchId: 'basic-medicine.v9', completionJobId: job.jobId }];
    if (kind === 'completion-time') job.terminal.tick--;
    expect(validateSectResearchFrame(frame).length).toBeGreaterThan(0); rejection(frame, cancelCommand(frame), 'INVALID_FRAME');
  });
  it('preserves the last real cancellation at exact record/receipt limits after a replay-equivalent pressure prefix', () => {
    const seed = ready; const one = cancel(start(seed));
    // Explicit terminal-history pressure projection, not 128 replayed gameplay cycles.
    // Same-clock zero-work start/cancel pairs change only IDs, reservations, receipts and
    // research counters. Verify three actual reducer pairs before building the prefix linearly.
    function pressure(count: number): SectResearchFrame {
      const jobs = Array.from({ length: count }, (_, index) => ({ ...cloneJson(one.research.jobs[0]!),
        jobId: `sect-research:${seed.research.nextId + index * 2}`,
        reservationId: `sect-research-reservation:${seed.research.nextId + index * 2 + 1}` }));
      const reservations = jobs.map(job => {
        const claim = cloneJson(one.construction.ledger.reservations.at(-1)!);
        const identity = { reservationId: job.reservationId, ownerTransactionId: job.jobId };
        const settlement = { kind: 'released' as const, operationId: `cancel:${job.jobId}` };
        return { ...claim, ...identity, base: { ...claim.base, ...identity, settlement }, sect: { ...claim.sect, ...identity, settlement } };
      });
      const receipts = jobs.flatMap((job, index) => {
        const revision = seed.research.revision + index * 2;
        return [
          { command: { kind: 'research.start' as const, commandId: `research.command:${revision}`, expectedRevision: revision,
            researchId: job.researchId, workerId: job.workerId }, revision: revision + 1, jobId: job.jobId },
          { command: { kind: 'research.cancel' as const, commandId: `research.command:${revision + 1}`, expectedRevision: revision + 1,
            jobId: job.jobId }, revision: revision + 2, jobId: job.jobId },
        ];
      });
      return { ...seed, construction: { ...seed.construction, ledger: { ...seed.construction.ledger,
        reservations: [...seed.construction.ledger.reservations, ...reservations] } },
        research: { revision: seed.research.revision + count * 2, nextId: seed.research.nextId + count * 2, jobs, receipts } };
    }
    let replay = seed;
    for (let n = 0; n < 3; n++) replay = cancel(start(replay));
    expect(pressure(3)).toEqual(replay);
    let frame = pressure(SECT_RESEARCH_LIMITS.records - 1); expect(validateSectResearchFrame(frame)).toEqual([]);
    const pressureSource = frame; const pressureText = canonicalStringify(pressureSource);
    frame = start(frame); expect(frame.research.jobs).toHaveLength(128); expect(frame.research.receipts).toHaveLength(255);
    const restored = JSON.parse(JSON.stringify(frame)) as SectResearchFrame; const restoredText = canonicalStringify(restored); frame = cancel(restored);
    expect(canonicalStringify(pressureSource)).toBe(pressureText); expect(canonicalStringify(restored)).toBe(restoredText);
    expect(frame.research.receipts).toHaveLength(256); expect(frame.research.jobs.every(job => job.terminal?.kind === 'cancelled')).toBe(true);
    expect(frame.construction.ledger.stock).toEqual(ready.construction.ledger.stock); expect(validateSectResearchFrame(frame)).toEqual([]);
    rejection(frame, command(frame), 'CAPACITY_EXCEEDED');
    const nodes = (value: unknown): number => value !== null && typeof value === 'object' ? 1 + Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0) : 1;
    expect(nodes(frame)).toBeLessThan(SECT_RESEARCH_DESCRIPTOR_NODE_BOUND);
    expect(getSectResearchDefinition('basic-medicine.v9')!.workTicks + getSectResearchDefinition('herbal-compatibility.v9')!.workTicks + 6 * 240).toBe(2080);
  });
});
