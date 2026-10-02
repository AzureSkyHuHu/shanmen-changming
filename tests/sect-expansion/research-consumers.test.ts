import { beforeAll, describe, expect, it } from 'vitest';
import type { SectBuildingId, SectRecipeId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand, createConstructionFrame, previewConstructionPlacement, tickConstruction } from '../../src/core/sect-expansion/construction';
import { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND, validateConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import type { ConstructionCommand } from '../../src/core/sect-expansion/construction-types';
import { validateConstructionFrame } from '../../src/core/sect-expansion/construction-validation';
import { reserveSectResources, sectReservationLines } from '../../src/core/sect-expansion/ledger';
import { applySectProductionCommand, createSectProductionFrame, tickSectProduction } from '../../src/core/sect-expansion/production';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionFrame } from '../../src/core/sect-expansion/production-types';
import { validateSectProductionFrame, SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND, SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND } from '../../src/core/sect-expansion/production-validation';
import { constructionResearchGate, productionResearchGate } from '../../src/core/sect-expansion/research-consumer-gates';
import { applySectResearchCommand, applySectResearchConstructionCommand, applySectResearchProductionCommand, createSectResearchFrame, sectResearchCompletion, tickSectResearch } from '../../src/core/sect-expansion/research';
import type { SectResearchContext, SectResearchFrame, SectResearchResult } from '../../src/core/sect-expansion/research-types';
import { SECT_RESEARCH_DESCRIPTOR_NODE_BOUND, sectAllLocalClaims, validateSectResearchFrame } from '../../src/core/sect-expansion/research-validation';
import { createWorld } from '../../src/core/world/create-world';
import { lookupProduction } from '../../src/core/world/history-access';
import type { WorldState } from '../../src/core/world/types';

const context = (frame: SectResearchFrame, patch: Partial<SectResearchContext> = {}): SectResearchContext => ({ simulationTick: frame.construction.lastSimulationTick,
  calendarTick: frame.construction.lastCalendarTick, mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch });
function accept(result: SectResearchResult): SectResearchFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectResearchFrame(result.frame))}`);
  return result.frame;
}
function step(frame: SectResearchFrame, patch: Partial<SectResearchContext> = {}): SectResearchFrame {
  const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1, ...patch });
  return accept(tickSectResearch(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectResearchFrame, predicate: (value: SectResearchFrame) => boolean, maximum = 1500): SectResearchFrame {
  for (let n = 0; n < maximum && !predicate(frame); n++) frame = step(frame);
  expect(predicate(frame)).toBe(true); return frame;
}
const placeCommand = (frame: SectResearchFrame, definitionId: SectBuildingId = 'alchemy.v9', x = 9, y = 1): ConstructionCommand => ({
  kind: 'blueprint.place', commandId: `consumer.place:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
  placement: { definitionId, anchor: { x, y }, rotation: definitionId === 'alchemy.v9' ? 90 : 0 },
});
const buildCommand = (frame: SectResearchFrame, workerId = 'entity:2'): ConstructionCommand => ({ kind: 'construction.start',
  commandId: `consumer.build:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
  blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId });
const cancelBuildCommand = (frame: SectResearchFrame): ConstructionCommand => ({ kind: 'construction.cancel',
  commandId: `consumer.cancel-build:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
  blueprintId: frame.construction.blueprints.at(-1)!.blueprintId });
const construct = (frame: SectResearchFrame, command: ConstructionCommand): SectResearchFrame => accept(applySectResearchConstructionCommand(frame, context(frame), command));
const prodCommand = (frame: SectResearchFrame, recipeId: SectRecipeId = 'craft.wound-powder.v9', workerId = 'entity:3'): SectProductionCommand => ({
  kind: 'production.start', commandId: `consumer.produce:${frame.production.revision}`, expectedRevision: frame.production.revision, recipeId, workerId,
});
const cancelCommand = (frame: SectResearchFrame): SectProductionCommand => ({ kind: 'production.cancel', commandId: `consumer.cancel:${frame.production.revision}`,
  expectedRevision: frame.production.revision, jobId: frame.production.jobs.at(-1)!.transactionId });
const produceStart = (frame: SectResearchFrame, recipeId: SectRecipeId = 'craft.wound-powder.v9', workerId = 'entity:3'): SectResearchFrame => accept(applySectResearchProductionCommand(frame, context(frame), prodCommand(frame, recipeId, workerId)));
const cancel = (frame: SectResearchFrame): SectResearchFrame => accept(applySectResearchProductionCommand(frame, context(frame), cancelCommand(frame)));
const finishProduction = (frame: SectResearchFrame): SectResearchFrame => until(frame, value => value.production.jobs.at(-1)!.terminal?.kind === 'completed');
const produce = (frame: SectResearchFrame, recipeId: SectRecipeId): SectResearchFrame => finishProduction(produceStart(frame, recipeId, 'entity:2'));
function legacyProduce(world: WorldState, recipe: string): WorldState {
  const started = startProduction(world, `consumer.legacy:${world.clock.simulationTick}`, recipe, 'entity:4');
  if (!started.ok) throw new Error(started.rejection.code);
  world = started.world;
  for (let n = 0; n < 1000 && world.activeProductionTransactionIds.includes(started.transactionId); n++) world = tickProduction({ ...world, clock: tickClock(world.clock) });
  const completed = lookupProduction(world, started.transactionId);
  expect(completed).toMatchObject({ state: 'Committed', phase: 'Done', recipeId: recipe });
  expect(completed!.activeTicks).toBe(completed!.requiredTicks); expect(world.activeProductionTransactionIds).not.toContain(started.transactionId); return world;
}
function project(world: WorldState): SectResearchFrame {
  return createSectResearchFrame(createSectProductionFrame(createConstructionFrame({ map: world.map,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork, away: false,
      productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
  })));
}
function failed(frame: SectResearchFrame, result: SectResearchResult, code: string): void {
  expect(result).toMatchObject({ ok: false, code }); expect(result.frame).toBe(frame);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// One earned journey, retained at real reducer boundaries. No completed research/building/output is seeded.
let empty: SectResearchFrame; let library: SectResearchFrame; let research239: SectResearchFrame; let earned: SectResearchFrame;
let planned: SectResearchFrame; let building: SectResearchFrame; let halfBefore: SectResearchFrame; let half: SectResearchFrame; let alchemy: SectResearchFrame;
let waiting: SectResearchFrame; let travelling: SectResearchFrame; let working: SectResearchFrame; let delivering: SectResearchFrame; let awaiting: SectResearchFrame; let powder: SectResearchFrame;
beforeAll(() => {
  let world = createWorld('research-zero-stock');
  for (let n = 0; n < 6; n++) world = legacyProduce(world, 'gather.wood');
  for (let n = 0; n < 2; n++) world = legacyProduce(world, 'gather.herbs');
  for (let n = 0; n < 7; n++) world = legacyProduce(world, 'craft.plank');
  empty = project(world);
  let frame = produce(produce(empty, 'extract.spirit-stone.v9'), 'extract.spirit-stone.v9');
  frame = construct(frame, placeCommand(frame, 'library.v9', 1, 1)); frame = construct(frame, buildCommand(frame));
  library = until(frame, value => value.construction.buildings.length === 1);
  frame = produce(produce(library, 'study.basic-insight.v9'), 'study.basic-insight.v9');
  frame = accept(applySectResearchCommand(frame, context(frame), { kind: 'research.start', commandId: 'consumer.research',
    expectedRevision: frame.research.revision, researchId: 'basic-medicine.v9', workerId: 'entity:2' }));
  research239 = until(frame, value => value.research.jobs[0]!.activeTicks === 239); earned = step(research239);
  planned = construct(earned, placeCommand(earned)); building = construct(planned, buildCommand(planned));
  halfBefore = until(building, value => value.construction.jobs.at(-1)!.activeTicks === 159); half = step(halfBefore);
  alchemy = until(half, value => value.construction.buildings.length === 2);
  waiting = produceStart(alchemy); travelling = step(waiting);
  working = until(travelling, value => value.production.jobs.at(-1)!.phase === 'Working');
  delivering = until(working, value => value.production.jobs.at(-1)!.phase === 'TravellingToStorage');
  awaiting = until(delivering, value => value.production.jobs.at(-1)!.phase === 'AwaitingDelivery'); powder = step(awaiting);
});

describe('authenticated alchemy and first medicine consumers', () => {
  it('earns the complete zero-stock → research → alchemy → warehouse powder journey with real old work and two paid checkpoints', () => {
    expect(empty.construction.ledger.stock).toEqual(createEmptySectStock()); expect(empty.construction.ledger.inventory.plank.owned).toBe(14);
    expect(earned.production.jobs.map(job => job.recipeId)).toEqual(['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9']);
    expect(earned.research.jobs[0]!.activeTicks).toBe(240); expect(earned.construction.ledger.stock).toEqual(createEmptySectStock());
    const reference = { researchId: 'basic-medicine.v9', completionJobId: earned.research.jobs[0]!.jobId };
    expect(planned.construction.blueprints.at(-1)!.researchGate).toEqual(reference); expect(waiting.production.jobs.at(-1)!.researchGate).toEqual(reference);
    expect(library.construction.blueprints[0]).not.toHaveProperty('researchGate'); expect(earned.production.jobs.every(job => !Object.hasOwn(job, 'researchGate'))).toBe(true);
    const beforeClaim = halfBefore.construction.ledger.reservations.find(claim => claim.ownerTransactionId === halfBefore.construction.jobs.at(-1)!.jobId)!;
    const halfClaim = half.construction.ledger.reservations.find(claim => claim.ownerTransactionId === half.construction.jobs.at(-1)!.jobId)!;
    const fullClaim = alchemy.construction.ledger.reservations.find(claim => claim.ownerTransactionId === alchemy.construction.jobs.at(-1)!.jobId)!;
    expect(beforeClaim.base.checkpoints).toHaveLength(0); expect(halfClaim.base.checkpoints).toHaveLength(1); expect(fullClaim.base.checkpoints).toHaveLength(2);
    expect(sectReservationLines(halfClaim, 'consumed')).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 4 }, { ledger: 'base', resourceId: 'stone', quantity: 2 }, { ledger: 'base', resourceId: 'plank', quantity: 2 }]);
    expect(alchemy.construction.jobs.at(-1)!.activeTicks).toBe(320); expect(fullClaim.base.settlement?.kind).toBe('committed');
    expect(powder.production.jobs.at(-1)!.activeTicks).toBe(160); expect(powder.production.jobs.at(-1)!.terminal).toMatchObject({ kind: 'completed', position: { x: 7, y: 5 }, outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }] });
    expect(powder.construction.ledger.stock['wound-powder'].owned).toBe(1); expect(sectAllLocalClaims(powder)).toEqual([]); expect(validateSectResearchFrame(powder)).toEqual([]);
  });
  it('checks gates before IDs or reservations, including one work tick before real completion', () => {
    for (const source of [empty, library, research239]) {
      const text = canonicalStringify(source);
      failed(source, applySectResearchConstructionCommand(source, context(source), placeCommand(source)), 'RESEARCH_AUTHORITY_REQUIRED');
      failed(source, applySectResearchProductionCommand(source, context(source), prodCommand(source)), 'RESEARCH_AUTHORITY_REQUIRED');
      expect(canonicalStringify(source)).toBe(text);
    }
    failed(earned, applySectResearchProductionCommand(earned, context(earned), prodCommand(earned)), 'WORKSTATION_UNAVAILABLE');
  });
  it('never accepts alternate recipes, L2 placement, or caller-supplied gate/effect authority', () => {
    failed(alchemy, applySectResearchProductionCommand(alchemy, context(alchemy), prodCommand(alchemy, 'craft.wound-powder-alt.v9')), 'RESEARCH_AUTHORITY_REQUIRED');
    expect(constructionResearchGate(earned, 'library.v9', earned.construction.lastSimulationTick, earned.construction.lastCalendarTick)).toBeNull();
    expect(productionResearchGate(earned, 'craft.wound-powder-alt.v9', earned.construction.lastSimulationTick, earned.construction.lastCalendarTick)).toBeNull();
    for (const field of ['researchGate', 'gateRef', 'unlocks', 'completedResearch', 'effects', 'researchAuthority', 'validate']) {
      const addition = field === 'validate' ? () => true : earned.research.jobs[0]!.jobId;
      failed(earned, applySectResearchConstructionCommand(earned, context(earned), { ...placeCommand(earned), [field]: addition } as ConstructionCommand), 'INVALID_COMMAND');
      failed(alchemy, applySectResearchProductionCommand(alchemy, context(alchemy), { ...prodCommand(alchemy), [field]: addition } as SectProductionCommand), 'INVALID_COMMAND');
    }
    const cmd = placeCommand(earned); if (cmd.kind !== 'blueprint.place') throw new Error('place');
    for (const addition of [{ level: 2 }, { researchGate: planned.construction.blueprints.at(-1)!.researchGate }])
      failed(earned, applySectResearchConstructionCommand(earned, context(earned), { ...cmd, placement: { ...cmd.placement, ...addition } } as ConstructionCommand), 'INVALID_COMMAND');
  });
  it.each(['missing', 'wrong-node', 'wrong-completion', 'unknown-field', 'future-simulation', 'future-calendar', 'lost-work', 'lost-payment', 'lost-research', 'fake-building'] as const)('rejects forged construction %s at the full root boundary', kind => {
    const frame = cloneJson(planned) as any; const bp = frame.construction.blueprints.at(-1);
    if (kind === 'missing') delete bp.researchGate;
    if (kind === 'wrong-node') bp.researchGate.researchId = 'herbal-compatibility.v9';
    if (kind === 'wrong-completion') bp.researchGate.completionJobId = 'sect-research:99';
    if (kind === 'unknown-field') bp.researchGate.unlocked = true;
    if (kind === 'future-simulation') bp.placedTick = frame.research.jobs[0].terminal.tick - 1;
    if (kind === 'future-calendar') bp.placedCalendarTick = frame.research.jobs[0].terminal.calendarTick - 1;
    if (kind === 'lost-work') frame.research.jobs[0].workSpans[0].lastTick--;
    if (kind === 'lost-payment') frame.construction.ledger.reservations.find((claim: any) => claim.ownerTransactionId === frame.research.jobs[0].jobId).sect.settlement = null;
    if (kind === 'lost-research') frame.research.jobs = [];
    if (kind === 'fake-building') frame.construction.buildings.push(alchemy.construction.buildings.at(-1));
    const text = canonicalStringify(frame); expect(validateSectResearchFrame(frame).length).toBeGreaterThan(0);
    failed(frame, applySectResearchConstructionCommand(frame, context(frame), buildCommand(frame)), 'INVALID_FRAME'); expect(canonicalStringify(frame)).toBe(text);
  });
  it.each(['missing', 'wrong-node', 'wrong-completion', 'bad-parent', 'future-simulation', 'future-calendar', 'upgraded'] as const)('rejects forged medicine %s before work or delivery', kind => {
    for (const source of [working, awaiting]) {
      const frame = cloneJson(source) as any; const job = frame.production.jobs.at(-1);
      if (kind === 'missing') delete job.researchGate;
      if (kind === 'wrong-node') job.researchGate.researchId = 'herbal-compatibility.v9';
      if (kind === 'wrong-completion') job.researchGate.completionJobId = 'sect-research:99';
      if (kind === 'bad-parent') job.productiveSite.sourceJobId = frame.construction.jobs[0].jobId;
      if (kind === 'future-simulation') job.startedTick = frame.research.jobs[0].terminal.tick - 1;
      if (kind === 'future-calendar') job.startedCalendarTick = frame.research.jobs[0].terminal.calendarTick - 1;
      if (kind === 'upgraded') frame.construction.buildings.at(-1).level = 2;
      const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
      expect(validateSectResearchFrame(frame).length).toBeGreaterThan(0); failed(frame, tickSectResearch(frame, ctx, createWorkPathBudget(ctx.simulationTick)), 'INVALID_FRAME');
    }
  });
  it('does not invoke hostile reference accessors and rejects references on ungated records', () => {
    let reads = 0; const bad = Object.defineProperty({}, 'completionJobId', { enumerable: true, get: () => { reads++; return earned.research.jobs[0]!.jobId; } });
    const frame = { ...planned, construction: { ...planned.construction, blueprints: planned.construction.blueprints.map((bp, index) => index ? { ...bp, researchGate: bad } : bp) } };
    expect(validateSectResearchFrame(frame).length).toBeGreaterThan(0); expect(reads).toBe(0);
    const ungated = cloneJson(earned) as any; ungated.construction.blueprints[0].researchGate = planned.construction.blueprints.at(-1)!.researchGate;
    expect(validateSectResearchFrame(ungated).length).toBeGreaterThan(0);
    delete ungated.construction.blueprints[0].researchGate; ungated.production.jobs[0].researchGate = waiting.production.jobs.at(-1)!.researchGate;
    expect(validateSectResearchFrame(ungated).length).toBeGreaterThan(0);
  });
  it('keeps public construction and two-domain production fail-closed even with real research present elsewhere', () => {
    expect(validateConstructionRecords(alchemy.construction)).toEqual([]); expect(validateConstructionFrame(alchemy.construction)).toEqual([{ code: 'INVALID_BLUEPRINT', path: 'blueprints' }]);
    expect(applyConstructionCommand(earned.construction, context(earned), placeCommand(earned))).toMatchObject({ ok: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
    const placement = placeCommand(earned); if (placement.kind !== 'blueprint.place') throw new Error('place');
    expect(previewConstructionPlacement(earned.construction, context(earned), placement.placement)).toMatchObject({ ok: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
    expect(applyConstructionCommand(planned.construction, context(planned), buildCommand(planned))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(tickConstruction(alchemy.construction, context(alchemy), createWorkPathBudget(alchemy.construction.lastSimulationTick))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    const two: SectProductionFrame = { schemaVersion: 1, construction: alchemy.construction, production: alchemy.production };
    expect(validateSectProductionFrame(two).length).toBeGreaterThan(0); expect(() => createSectProductionFrame(alchemy.construction)).toThrow();
    expect(applySectProductionCommand(two, context(alchemy), prodCommand(alchemy))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(tickSectProduction(two, context(alchemy), createWorkPathBudget(alchemy.construction.lastSimulationTick))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
  });
  it('keeps earned gates permanent past library expiry while the alchemy building retains its own paid interval', () => {
    expect(alchemy.construction.lastCalendarTick).toBeGreaterThanOrEqual(library.construction.buildings[0]!.firstMaintenanceCalendarTick);
    expect(sectResearchCompletion(powder, 'basic-medicine.v9')?.terminal?.kind).toBe('completed');
    expect(powder.production.jobs.at(-1)!.terminal!.calendarTick).toBeLessThan(alchemy.construction.buildings[1]!.firstMaintenanceCalendarTick);
    const again = produceStart(powder); expect(again.production.jobs.at(-1)!.researchGate).toEqual(waiting.production.jobs.at(-1)!.researchGate);
    expect(cancel(again).construction.ledger.stock['wound-powder'].owned).toBe(1);
  });
  it('commits one powder and both input debits only after real work, real storage arrival and its final boundary', () => {
    expect(working.production.jobs.at(-1)!.activeTicks).toBe(0); expect(delivering.production.jobs.at(-1)!.activeTicks).toBe(160);
    for (const frame of [waiting, working, delivering, awaiting]) {
      expect(frame.construction.ledger.stock['wound-powder'].owned).toBe(0);
      expect(frame.construction.ledger.inventory.herbs.owned).toBe(alchemy.construction.ledger.inventory.herbs.owned);
      expect(frame.construction.ledger.inventory.herbs.reserved).toBe(3);
    }
    expect(powder.construction.ledger.inventory.herbs.owned).toBe(alchemy.construction.ledger.inventory.herbs.owned - 3);
    expect(powder.construction.ledger.inventory.grain.owned).toBe(alchemy.construction.ledger.inventory.grain.owned - 1);
    expect(powder.construction.ledger.inventory.herbs.reserved).toBe(0);
    expect(powder.production.jobs.at(-1)!.terminal!.tick).toBe(awaiting.construction.lastSimulationTick + 1);
  });
  it('retains a cancellable delivery with no debit when alchemy expires on the final boundary', () => {
    // Explicit calendar-pressure fixture: preserve all genuine work/site evidence and move only the idle current clocks to the boundary.
    const due = alchemy.construction.buildings[1]!.firstMaintenanceCalendarTick;
    const delta = due - 1 - awaiting.construction.lastCalendarTick;
    const frame = { ...awaiting, construction: { ...awaiting.construction, lastCalendarTick: due - 1, lastSimulationTick: awaiting.construction.lastSimulationTick + delta } };
    expect(validateSectResearchFrame(frame)).toEqual([]); const inventory = frame.construction.ledger.inventory;
    const blocked = step(frame); expect(blocked.production.jobs.at(-1)).toMatchObject({ phase: 'AwaitingDelivery', blockedReason: 'WORKSTATION_UNAVAILABLE', terminal: null });
    expect(blocked.construction.ledger.inventory).toEqual(inventory); expect(blocked.construction.ledger.stock['wound-powder'].owned).toBe(0);
    const cancelled = cancel(blocked); expect(cancelled.construction.ledger.inventory.herbs).toMatchObject({ owned: inventory.herbs.owned, reserved: 0 });
    failed(cancelled, applySectResearchProductionCommand(cancelled, context(cancelled), prodCommand(cancelled)), 'WORKSTATION_UNAVAILABLE');
    expect(sectResearchCompletion(cancelled, 'basic-medicine.v9')).not.toBeNull();
  });
  it('does not debit either ledger when powder stock is full, and safely cancels without removing existing stock', () => {
    // Explicit stock-pressure fixture, not alleged earned output.
    const frame = { ...awaiting, construction: { ...awaiting.construction, ledger: { ...awaiting.construction.ledger,
      stock: { ...awaiting.construction.ledger.stock, 'wound-powder': { owned: 99, reserved: 0, capacity: 99 as const } } } } };
    expect(validateSectResearchFrame(frame)).toEqual([]); const blocked = step(frame);
    expect(blocked.production.jobs.at(-1)).toMatchObject({ blockedReason: 'CAPACITY_EXCEEDED', terminal: null });
    expect(blocked.construction.ledger).toEqual(frame.construction.ledger); const cancelled = cancel(blocked);
    expect(cancelled.construction.ledger.inventory.herbs.owned).toBe(frame.construction.ledger.inventory.herbs.owned); expect(cancelled.construction.ledger.stock['wound-powder'].owned).toBe(99);
  });
  it('cancels alchemy after the real midpoint without refunding paid materials and replays exactly', () => {
    const command = cancelBuildCommand(half); const cancelled = construct(half, command); const job = cancelled.construction.jobs.at(-1)!;
    expect(job.terminal).toMatchObject({ kind: 'cancelled', previousPhase: 'working' }); expect(job.terminal!.consumed).toEqual(job.terminal!.released);
    expect(cancelled.construction.ledger.inventory.wood.owned).toBe(earned.construction.ledger.inventory.wood.owned - 4);
    expect(cancelled.construction.ledger.inventory.wood.reserved).toBe(0); expect(cancelled.construction.people).toEqual(half.construction.people);
    expect(cancelled.construction.buildings).toHaveLength(1); expect(sectAllLocalClaims(cancelled)).toEqual([]);
    expect(applySectResearchConstructionCommand(cancelled, context(cancelled), command)).toMatchObject({ ok: true, repeated: true, frame: cancelled });
  });
  it.each(['waiting', 'travelling', 'working', 'delivering', 'awaiting'] as const)('cancels medicine in %s and preserves the authentic reference/history and last position', phase => {
    const frame = ({ waiting, travelling, working, delivering, awaiting })[phase]; const command = cancelCommand(frame); const text = canonicalStringify(frame);
    const cancelled = accept(applySectResearchProductionCommand(frame, context(frame), command));
    expect(cancelled.production.jobs.at(-1)!.terminal).toMatchObject({ kind: 'cancelled', previousPhase: frame.production.jobs.at(-1)!.phase, consumed: [], outputs: [] });
    expect(cancelled.production.jobs.at(-1)!.researchGate).toEqual(frame.production.jobs.at(-1)!.researchGate);
    expect(cancelled.construction.ledger.inventory).toEqual(alchemy.construction.ledger.inventory); expect(cancelled.construction.people).toEqual(frame.construction.people);
    expect(sectAllLocalClaims(cancelled)).toEqual([]); expect(canonicalStringify(frame)).toBe(text);
    expect(applySectResearchProductionCommand(cancelled, context(cancelled), command)).toMatchObject({ ok: true, repeated: true, frame: cancelled });
  });
  it('replays exact placement/start/medicine receipts before fresh pressure admission, but only after full boundary validation', () => {
    for (const [frame, command] of [[planned, placeCommand(earned)], [building, buildCommand(planned)], [alchemy, buildCommand(planned)]] as const) {
      const pressure = context(frame, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:2', ownerId: 'away' }] });
      expect(applySectResearchConstructionCommand(frame, pressure, command)).toMatchObject({ ok: true, repeated: true, frame });
      failed(frame, applySectResearchConstructionCommand(frame, { ...pressure, calendarTick: pressure.calendarTick + 1 }, command), 'STALE_CLOCK');
    }
    for (const frame of [waiting, powder]) {
      const pressure = context(frame, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:3', ownerId: 'away' }] });
      expect(applySectResearchProductionCommand(frame, pressure, prodCommand(alchemy))).toMatchObject({ ok: true, repeated: true, frame });
      failed(frame, applySectResearchProductionCommand(frame, { ...pressure, externalActiveJobs: 37 }, prodCommand(alchemy)), 'INVALID_CONTEXT');
    }
    const forged = cloneJson(powder) as any; delete forged.production.jobs.at(-1).researchGate;
    failed(forged, applySectResearchProductionCommand(forged, context(forged), prodCommand(alchemy)), 'INVALID_FRAME');
  });
  it.each(['planned', 'building', 'halfBefore', 'half', 'waiting', 'travelling', 'working', 'delivering', 'awaiting'] as const)('round-trips and deterministically continues frozen %s without mutating it', phase => {
    const source = freeze(cloneJson(({ planned, building, halfBefore, half, waiting, travelling, working, delivering, awaiting })[phase]));
    const text = canonicalStringify(source); const restored = JSON.parse(JSON.stringify(source)) as SectResearchFrame;
    expect(validateSectResearchFrame(restored)).toEqual([]); expect(step(restored)).toEqual(step(source)); expect(canonicalStringify(source)).toBe(text);
    expect(tickSectResearch(source, context(source), createWorkPathBudget(source.construction.lastSimulationTick))).toMatchObject({ ok: true, repeated: true, frame: source });
  });
  it('enforces worker/seat/storage/global claims and uses the single exhausted path budget for consumer navigation', () => {
    failed(alchemy, applySectResearchProductionCommand(alchemy, context(alchemy, { externalActiveJobs: 36 }), prodCommand(alchemy)), 'CAPACITY_EXCEEDED');
    failed(alchemy, applySectResearchProductionCommand(alchemy, context(alchemy, { externalClaims: [{ kind: 'worker', key: 'entity:3', ownerId: 'care' }] }), prodCommand(alchemy)), 'CLAIM_CONFLICT');
    failed(alchemy, applySectResearchProductionCommand(alchemy, context(alchemy, { externalClaims: [{ kind: 'seat', key: alchemy.construction.buildings[1]!.buildingId, ownerId: 'upgrade' }] }), prodCommand(alchemy)), 'CLAIM_CONFLICT');
    const storageClosed = { ...alchemy, construction: { ...alchemy.construction, legacyStations: alchemy.construction.legacyStations.map(site => site.blueprintId === 'storage' ? { ...site, operational: false } : site) } };
    failed(storageClosed, applySectResearchProductionCommand(storageClosed, context(storageClosed), prodCommand(storageClosed)), 'STORAGE_UNAVAILABLE');
    const stalled = step(delivering, { externalClaims: [{ kind: 'entrance', key: '7,5', ownerId: 'other-delivery' }] });
    expect(stalled.production.jobs.at(-1)!.blockedReason).toBe('STORAGE_UNAVAILABLE'); expect(stalled.construction.ledger).toEqual(delivering.construction.ledger);
    const ctx = context(waiting, { simulationTick: waiting.construction.lastSimulationTick + 1, calendarTick: waiting.construction.lastCalendarTick + 1 });
    const budget = createWorkPathBudget(ctx.simulationTick);
    for (let n = 0; n < 4; n++) advanceWorkNavigationWithBudget({ map: empty.construction.map, position: { x: 0, y: 0 }, target: { x: 1, y: 0 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    const noPath = accept(tickSectResearch(waiting, ctx, budget)); expect(budget.remaining).toBe(0);
    expect(noPath.construction.people).toEqual(waiting.construction.people); expect(noPath.production.jobs.at(-1)!.activeTicks).toBe(0);
  });
  it('re-reads claims after each medicine candidate so two starts never acquire the same seat or duplicate outputs', () => {
    const double = produceStart(waiting, 'craft.wound-powder.v9', 'entity:4'); const advanced = step(double);
    const active = advanced.production.jobs.filter(job => !job.terminal);
    expect(active.filter(job => job.seatSiteId !== null)).toHaveLength(1); expect(active.filter(job => job.phase === 'WaitingForStation')).toHaveLength(1);
    expect(new Set(sectAllLocalClaims(advanced).map(claim => `${claim.kind}:${claim.key}`)).size).toBe(sectAllLocalClaims(advanced).length);
    expect(advanced.construction.ledger.stock['wound-powder'].owned).toBe(0); expect(validateSectResearchFrame(advanced)).toEqual([]);
  });
  it('preserves exact numerical cancellation headroom for both gated domains', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const buildSeed = { ...planned, construction: { ...planned.construction, revision: MAX - 2, nextId: MAX - 3 } };
    const begun = construct(buildSeed, buildCommand(buildSeed)); expect(begun.construction.nextId).toBe(MAX);
    expect(construct(begun, cancelBuildCommand(begun)).construction.revision).toBe(MAX);
    const shortBuild = { ...buildSeed, construction: { ...buildSeed.construction, nextId: MAX - 2 } };
    failed(shortBuild, applySectResearchConstructionCommand(shortBuild, context(shortBuild), buildCommand(shortBuild)), 'CAPACITY_EXCEEDED');
    const prodSeed = { ...alchemy, production: { ...alchemy.production, revision: MAX - 2, nextId: MAX - 2 } };
    const running = produceStart(prodSeed); expect(running.production.nextId).toBe(MAX); expect(cancel(running).production.revision).toBe(MAX);
    const shortProd = { ...prodSeed, production: { ...prodSeed.production, revision: MAX - 1 } };
    failed(shortProd, applySectResearchProductionCommand(shortProd, context(shortProd), prodCommand(shortProd)), 'CAPACITY_EXCEEDED');
  });
  it('preserves the final medicine cancellation at the exact reachable record limit and accounts for every new reference node', () => {
    const one = cancel(waiting); const seed = alchemy; const template = one.production.jobs.at(-1)!;
    // Explicit replay-equivalent same-clock terminal pressure; verify the first three pairs with real reducers.
    function pressure(count: number): SectResearchFrame {
      const jobs = Array.from({ length: count }, (_, n) => ({ ...cloneJson(template), transactionId: `sect-production:${seed.production.nextId + n * 2}`,
        reservationId: `sect-production-reservation:${seed.production.nextId + n * 2 + 1}` }));
      const reservations = jobs.map(job => {
        const claim = cloneJson(one.construction.ledger.reservations.at(-1)!); const identity = { reservationId: job.reservationId, ownerTransactionId: job.transactionId };
        const settlement = { kind: 'released' as const, operationId: `cancel:${job.transactionId}` };
        return { ...claim, ...identity, base: { ...claim.base, ...identity, settlement }, sect: { ...claim.sect, ...identity, settlement } };
      });
      const receipts = jobs.flatMap((job, n) => {
        const revision = seed.production.revision + n * 2;
        return [{ command: { ...prodCommand(seed), commandId: `consumer.produce:${revision}`, expectedRevision: revision }, revision: revision + 1, jobId: job.transactionId },
          { command: { kind: 'production.cancel' as const, commandId: `consumer.cancel:${revision + 1}`, expectedRevision: revision + 1, jobId: job.transactionId }, revision: revision + 2, jobId: job.transactionId }];
      });
      return { ...seed, construction: { ...seed.construction, ledger: { ...seed.construction.ledger, reservations: [...seed.construction.ledger.reservations, ...reservations] } },
        production: { revision: seed.production.revision + count * 2, nextId: seed.production.nextId + count * 2,
          jobs: [...seed.production.jobs, ...jobs], receipts: [...seed.production.receipts, ...receipts] } };
    }
    let replay = seed; for (let n = 0; n < 3; n++) replay = cancel(produceStart(replay)); expect(pressure(3)).toEqual(replay);
    const source = pressure(SECT_PRODUCTION_LIMITS.records - seed.production.jobs.length - 1); expect(validateSectResearchFrame(source)).toEqual([]);
    const final = cancel(produceStart(source)); expect(final.production.jobs).toHaveLength(128);
    expect(final.production.receipts).toHaveLength(252); expect(final.construction.ledger.stock['wound-powder'].owned).toBe(0);
    failed(final, applySectResearchProductionCommand(final, context(final), prodCommand(final)), 'CAPACITY_EXCEEDED');
    expect(CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND - CONSTRUCTION_DESCRIPTOR_NODE_BOUND).toBe(128 * 3);
    expect(SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND).toBe(CONSTRUCTION_DESCRIPTOR_NODE_BOUND + 16 + 128 * (256 + 240 * 5) + 36 * 65536 * 3 + 256 * 12);
    expect(SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND - SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND).toBe(768);
    expect(SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND).toBe(CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND + 16 + 128 * (259 + 240 * 5) + 36 * 65536 * 3 + 256 * 12);
    const nodes = (value: unknown): number => value !== null && typeof value === 'object' ? 1 + Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0) : 1;
    expect(nodes(final)).toBeLessThan(SECT_RESEARCH_DESCRIPTOR_NODE_BOUND); expect(validateSectResearchFrame(final)).toEqual([]);
  });
  it('closes exactly all three reservation owner domains and does not accept unrelated paid claims as research proof', () => {
    const extra = reserveSectResources(powder.construction.ledger, { reservationId: 'alien:1', ownerTransactionId: 'alien:2' }, [], 'on-completion');
    if (!extra.ok) throw new Error(extra.rejection.code);
    const frame = { ...powder, construction: { ...powder.construction, ledger: extra.context } };
    expect(validateSectResearchFrame(frame)).toEqual([{ code: 'ORPHAN_RESERVATION', path: 'alien:1' }]);
  });
});
