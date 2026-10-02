import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { resolveContentIdentity } from '../../src/content/registry';
import type { SectRecipeId } from '../../src/content/sect-v9/types';
import { previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import { lookupProduction } from '../../src/core/world/history-access';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9, SectCommandV9 } from '../../src/core/kernel/contracts-v9';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { inspectUnregisteredWorldV9Records, validateWorldState, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createWorld } from '../../src/core/world/create-world';
import { EMPTY_V9_EXPEDITION, inspectV9LifecycleRecords } from '../../src/core/world/v9-lifecycle-records';
import { inspectV9KnownRecordHeadroom } from '../../src/core/world/v9-record-headroom';
import { ownedV9SectRecords, projectV9SectFrame, v9SectContext, v9WorkOwners } from '../../src/core/world/v9-sect-bridge';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { captureSectHistoricalIdentitiesV9, isArchivedSectWorkerReference } from '../../src/core/sect-expansion/history-identity';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';

function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function dispatch(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string) {
  return dispatchUnregisteredCommandV9(world, { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 });
}
function accepted(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): WorldStateV9 {
  const result = dispatch(world, body, commandId);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
  expect(inspectUnregisteredWorldV9Records(result.world)).toEqual([]); return result.world;
}
function sect(world: WorldStateV9, payload: SectCommandV9): WorldStateV9 {
  return accepted(world, { kind: 'sect.command', payload }, payload.command.commandId);
}
function ticks(world: WorldStateV9, count: number): WorldStateV9 {
  const result = advanceUnregisteredTicksV9(world, count);
  expect(result.stopped, JSON.stringify(result.stopped)).toBeNull(); return result.world;
}
function finish(world: WorldStateV9, done: (world: WorldStateV9) => boolean, maximum = 640): WorldStateV9 {
  let next = world;
  for (let n = 0; n < maximum && !done(next); n += 16) next = ticks(next, 16);
  expect(done(next)).toBe(true); return next;
}
function oldProduction(world: WorldStateV9, recipeId: string, commandId: string, workerId = 'entity:3'): WorldStateV9 {
  const result = dispatch(world, { kind: 'production.start', payload: { recipeId, workerId } }, commandId);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
  const id = result.result.transactionId!;
  return finish(result.world, value => lookupProduction(value, id)?.state === 'Committed');
}
function sectProduction(world: WorldStateV9, recipeId: SectRecipeId, commandId: string, workerId = 'entity:2'): WorldStateV9 {
  const next = sect(world, { domain: 'production', command: { kind: 'production.start', commandId,
    expectedRevision: world.sectExpansion.production.revision, workerId, recipeId } });
  const id = next.sectExpansion.production.jobs.at(-1)!.transactionId;
  return finish(next, value => value.sectExpansion.production.jobs.find(job => job.transactionId === id)!.terminal?.kind === 'completed');
}
function startConstruction(world: WorldStateV9, definitionId: 'library.v9' | 'alchemy.v9', commandId: string, x: number, y = 1, workerId = 'entity:2'): WorldStateV9 {
  let next = sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: `${commandId}.place`, expectedRevision: world.sectExpansion.construction.revision,
    placement: { definitionId, anchor: { x, y }, rotation: 0 } } });
  next = sect(next, { domain: 'construction', command: { kind: 'construction.start', commandId: `${commandId}.start`, expectedRevision: next.sectExpansion.construction.revision,
    blueprintId: next.sectExpansion.construction.blueprints.at(-1)!.blueprintId, workerId } }); return next;
}
function nearExpiry(world: WorldStateV9, workerId: string, remaining = 1): WorldStateV9 {
  // Bounded chronology fixture only. No work/resources/deaths are injected; expiry,
  // cancellation, acknowledgement and retirement still execute actual World commands/ticks.
  const next = cloneJson(world); const actor = next.disciples.find(actor => actor.id === workerId)!;
  const profile = next.cultivation.disciples.find(profile => profile.discipleId === workerId)!;
  // Keep the already-proven month-aligned birthday residue. This explicit boundary
  // fixture advances only within the current month; it cannot invent past birthday rows.
  const target = Math.ceil((next.clock.calendarTick + remaining) / CALENDAR_TICKS_PER_MONTH) * CALENDAR_TICKS_PER_MONTH;
  next.clock = { ...next.clock, simulationTick: target - remaining, calendarTick: target - remaining };
  actor.birthCalendarTick = target - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((next.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  expect(inspectUnregisteredWorldV9Records(next)).toEqual([]); return next;
}
function finalize(world: WorldStateV9, workerId: string): WorldStateV9 {
  const death = world.cultivation.pendingDeaths.find(death => death.discipleId === workerId)!;
  const commandId = `finalize.${workerId.replace(':', '.')}`;
  return accepted(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId,
    expectedRevision: world.cultivation.revision, discipleId: workerId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, commandId);
}

describe('fresh internal v9 management boundary', () => {

  it('rejects reserved new fields under old labels and never evaluates hostile descriptors', () => {
    for (const legacy of [createWorld(), createWorldV8()]) {
      const validate = legacy.simulationVersion === '0.8.0' ? validateWorldStateV8 : validateWorldState;
      expect(validate({ ...legacy, sectExpansion: {} }).length).toBeGreaterThan(0);
      expect(validate({ ...legacy, runtimeProtocol: 'fresh-management-v9-unregistered.1' }).length).toBeGreaterThan(0);
    }
    const source = createUnregisteredWorldV9('descriptor-world'); let calls = 0;
    const hostile = { ...source }; Object.defineProperty(hostile, 'seed', { enumerable: true, get: () => { calls++; return source.seed; } });
    expect(inspectUnregisteredWorldV9Records(hostile).length).toBeGreaterThan(0);
    expect(advanceUnregisteredTicksV9(hostile, 1).stopped?.kind).toBe('invalid-records');
    expect(dispatchUnregisteredCommandV9(hostile, {}).result.rejection?.code).toBe('INVALID_WORLD_RECORDS');
    const command = { commandId: 'getter.command', sequence: 0, issuedTick: 0, kind: 'production.start', payload: { workerId: 'entity:2', recipeId: 'gather.wood' } };
    Object.defineProperty(command, 'issuedTick', { enumerable: true, get: () => { calls++; source.inventory.wood.owned++; return 0; } });
    const other = { commandId: 'safe.command', sequence: 1, issuedTick: 0, kind: 'production.start', payload: { workerId: 'entity:3', recipeId: 'gather.wood' } };
    expect(advanceUnregisteredTicksV9(source, 1, [command, other] as CommandV9[]).stopped?.kind).toBe('invalid-records');
    const commands: CommandV9[] = []; Object.defineProperty(commands, '0', { enumerable: true, get: () => { calls++; return command; } });
    expect(advanceUnregisteredTicksV9(source, 1, commands).stopped?.kind).toBe('invalid-records');
    expect(calls).toBe(0); expect(source.inventory.wood.owned).toBe(24);
  });
  it('keeps closed-family records and a persisted queue outside the internal boundary', () => {
    const world = createUnregisteredWorldV9('closed-records'); const queued = cloneJson(world);
    queued.pendingCommands.push({ kind: 'production.start', commandId: 'queued', sequence: 0, issuedTick: 0, payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    expect(inspectUnregisteredWorldV9Records(queued).length).toBeGreaterThan(0);
    expect(advanceUnregisteredTicksV9(queued, 1).stopped?.kind).toBe('invalid-records');
    expect(dispatch(queued, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'next').result.rejection?.code).toBe('INVALID_WORLD_RECORDS');
    const forged = cloneJson(world);
    forged.commandReceipts.fake = { commandId: 'fake', fingerprint: canonicalStringify({ kind: 'campaign.command', payload: { command: { kind: 'campaign.relief', commandId: 'fake' } } }),
      result: { commandId: 'fake', status: 'accepted', transactionId: null, eventIds: [], rejection: null, campaignResult: {} as never } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('Internal v9 campaign/departure receipts are closed');
    const event = cloneJson(world); event.sequences.nextAction++; event.sequences.nextEvent++;
    event.events.push({ eventId: 'event:1', rootActionId: 'action:1', parentEventId: null, tick: 0, kind: 'campaign.committed', payload: {} });
    expect(inspectUnregisteredWorldV9Records(event)).toContain('Internal v9 campaign events are closed');
    expect(Object.isFrozen(EMPTY_V9_EXPEDITION.history)).toBe(true); expect(Object.isFrozen(EMPTY_V9_EXPEDITION.deathMappings)).toBe(true);
    expect(() => Object.defineProperty(EMPTY_V9_EXPEDITION.effectReceipts, '0', { value: {}, enumerable: true })).toThrow();
    expect(createUnregisteredWorldV9('after-poison-attempt').expedition.effectReceipts).toEqual([]);
  });
  it('binds historical paired clocks to the same fresh management genesis', () => {
    let world = ticks(createUnregisteredWorldV9('clock-proof'), 10);
    world = sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'clock.place', expectedRevision: world.sectExpansion.construction.revision,
      placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } });
    const forged = cloneJson(world); const bp = forged.sectExpansion.construction.blueprints[0]!;
    forged.sectExpansion = { ...forged.sectExpansion, construction: { ...forged.sectExpansion.construction, blueprints: [{ ...bp, placedTick: 0 }] } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('V9 management historical clocks differ');
    expect(inspectUnregisteredWorldV9Records({ ...world, clock: { ...world.clock, calendarTick: 9, encounterTick: 1 } }).length).toBeGreaterThan(0);
    expect(inspectUnregisteredWorldV9Records({ ...world, clock: { ...world.clock, mode: 'combat' } }).length).toBeGreaterThan(0);
  });
  it('preserves traveling on non-final cell boundaries with zero movement remainder', () => {
    let world = sect(createUnregisteredWorldV9('travel-boundary'), { domain: 'production', command: { kind: 'production.start', commandId: 'travel.stone', expectedRevision: 0,
      workerId: 'entity:2', recipeId: 'gather.stone.v9' } });
    for (let tick = 1; tick <= 12; tick++) {
      world = ticks(world, 1); const job = world.sectExpansion.production.jobs[0]!; const actor = world.disciples.find(actor => actor.id === job.workerId)!;
      if (job.navigation.path.length && job.blockedReason === null) expect(actor.traveling).toBe(true);
      if (tick === 4) { expect(job.navigation.movementTicks).toBe(0); expect(job.navigation.path.length).toBeGreaterThan(0); expect(actor.traveling).toBe(true); }
    }
  });
  it('has its own explicit identity and zero expansion genesis without registering a save or changing old constructors', () => {
    const world = createUnregisteredWorldV9('fresh-v9');
    expect(world.simulationVersion).toBe('0.9.0'); expect(world.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(resolveContentIdentity(world.contentIdentity, { allowCandidate: true })).toBeNull();
    expect(world.sectExpansion.stock).toEqual({ 'spirit-stone': { owned: 0, reserved: 0, capacity: 99 }, 'basic-insight': { owned: 0, reserved: 0, capacity: 99 }, 'wound-powder': { owned: 0, reserved: 0, capacity: 99 } });
    expect(world.sectExpansion.construction.jobs).toEqual([]); expect(world.sectExpansion.construction.buildings).toEqual([]);
    expect(world.sectExpansion.research.jobs).toEqual([]); expect(world.sectExpansion.reservations).toEqual([]);
    expect(validateWorldState(createWorld())).toEqual([]); expect(validateWorldStateV8(createWorldV8())).toEqual([]);
    expect(validateWorldState(world).length).toBeGreaterThan(0); expect(validateWorldStateV8(world).length).toBeGreaterThan(0);
    expect(inspectUnregisteredWorldV9Records({ ...world, simulationVersion: '0.8.0' } as unknown as WorldStateV9).length).toBeGreaterThan(0);
    expect(inspectUnregisteredWorldV9Records({ ...world, contentIdentity: createWorldV8().contentIdentity }).length).toBeGreaterThan(0);
    expect(inspectV9KnownRecordHeadroom(world)).toEqual([]);
  });
  it('borrows unique real World authority and persists no projection snapshot', () => {
    const world = freeze(createUnregisteredWorldV9('authority')); const before = canonicalStringify(world); const frame = projectV9SectFrame(world);
    expect(frame.construction.map).toBe(world.map); expect(frame.construction.ledger.inventory).toBe(world.inventory);
    expect(frame.construction.people[0]!.position).toBe(world.disciples[0]!.position);
    expect(ownedV9SectRecords(frame)).toEqual(world.sectExpansion);
    expect(Object.keys(world.sectExpansion.construction).sort()).toEqual(['blueprints', 'buildings', 'catalogIdentity', 'jobs', 'nextId', 'receipts', 'revision', 'schemaVersion']);
    const after = ticks(world, 1); expect(after.clock.calendarTick).toBe(1); expect(canonicalStringify(world)).toBe(before);
  });
  it('rejects departures explicitly and rejects free sect stock or old labels', () => {
    const world = freeze(createUnregisteredWorldV9('closed-departure'));
    const departed = dispatch(world, { kind: 'expedition.command', payload: { command: { commandId: 'depart', kind: 'expedition.depart', request: { squadIds: ['entity:2'], routeId: 'route.qingfeng-trial' } } } }, 'depart');
    expect(departed.result.rejection?.code).toBe('UNREGISTERED_COMMAND_FAMILY'); expect(departed.world).toBe(world);
    const forged = cloneJson(world); forged.sectExpansion = { ...forged.sectExpansion, stock: { ...forged.sectExpansion.stock, 'spirit-stone': { owned: 1, reserved: 0, capacity: 99 } } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('V9 zero-genesis stock provenance differs');
    expect(advanceUnregisteredTicksV9(forged, 1).world).toBe(forged);
  });
  it('runs actual old gathering with deterministic events, movement, retries and immutable inputs', () => {
    const world = freeze(createUnregisteredWorldV9('gathering'));
    const first = dispatch(world, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'gather');
    expect(first.result.status).toBe('accepted');
    const retry = dispatch(first.world, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'gather');
    expect(retry.world).toBe(first.world); expect(retry.result).toEqual(first.result);
    const next = finish(first.world, value => value.activeProductionTransactionIds.length === 0);
    expect(next.inventory.wood.owned).toBe(world.inventory.wood.owned + 4);
    expect(next.clock.simulationTick).toBeGreaterThan(120); expect(next.disciples[1]!.position).toEqual({ x: 7, y: 5 });
    expect(world.clock.simulationTick).toBe(0); expect(world.inventory.wood.owned).toBe(24);
  });
  it('derives shared base reservations from actual old and sect owners', () => {
    let world = createUnregisteredWorldV9('shared-ledger');
    world = accepted(world, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'old.plank');
    world = sect(world, { domain: 'production', command: { kind: 'production.start', commandId: 'sect.stone', expectedRevision: 0, workerId: 'entity:3', recipeId: 'gather.stone.v9' } });
    expect(world.inventory.wood.reserved).toBe(4); expect(v9WorkOwners(world)).toHaveLength(2);
    const forged = cloneJson(world); forged.inventory.wood.reserved = 3;
    expect(inspectUnregisteredWorldV9Records(forged).length).toBeGreaterThan(0);
    const job = world.sectExpansion.production.jobs[0]!;
    world = sect(world, { domain: 'production', command: { kind: 'production.cancel', commandId: 'sect.cancel', expectedRevision: world.sectExpansion.production.revision, jobId: job.transactionId } });
    expect(world.inventory.wood.reserved).toBe(3); expect(world.inventory.wood.owned).toBe(24);
  });
  it('blocks old manual/automatic, teaching both roles and breakthrough from stealing a sect worker', () => {
    let world = sect(createUnregisteredWorldV9('eligibility'), { domain: 'production', command: { kind: 'production.start', commandId: 'sect.busy', expectedRevision: 0, workerId: 'entity:2', recipeId: 'gather.stone.v9' } });
    expect(dispatch(world, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'old.busy').result.rejection?.code).toBe('WORKER_UNAVAILABLE');
    for (const [discipleId, studentId] of [['entity:2', 'entity:3'], ['entity:3', 'entity:2']]) {
      const commandId = `teach.${discipleId}`;
      const result = dispatch(world, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision, discipleId: discipleId!, studentId: studentId!, knowledgeId: 'knowledge.sword' } } }, commandId);
      expect(result.result).toMatchObject({ status: 'rejected', rejection: { cultivationCode: 'DISCIPLE_UNAVAILABLE' } });
    }
    const preview = previewBreakthroughV3(world, 'entity:2');
    const b = dispatch(world, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm', commandId: 'break.busy', expectedRevision: world.cultivation.revision, preview } } }, 'break.busy');
    expect(b.result).toMatchObject({ status: 'rejected', rejection: { cultivationCode: 'DISCIPLE_UNAVAILABLE' } });
    world = accepted(world, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'plan');
    world = accepted(world, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'auto');
    world = ticks(world, 1); expect(world.activeProductionTransactionIds).toEqual([]); expect(world.sectExpansion.production.jobs[0]!.terminal).toBeNull();
    const old = accepted(createUnregisteredWorldV9('reverse'), { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'old');
    const rejectedSect = dispatch(old, { kind: 'sect.command', payload: { domain: 'production', command: { kind: 'production.start', commandId: 'reverse.sect', expectedRevision: 0, workerId: 'entity:2', recipeId: 'gather.stone.v9' } } }, 'reverse.sect');
    expect(rejectedSect.result.status).toBe('rejected'); expect(rejectedSect.world).toBe(old);
  });
  it('cancels on the already-advanced lifespan tick before work and archives the real identity on confirmation', () => {
    let world = sect(createUnregisteredWorldV9('lifespan-work'), { domain: 'production', command: { kind: 'production.start', commandId: 'mortal.work', expectedRevision: 0, workerId: 'entity:2', recipeId: 'gather.stone.v9' } });
    world = ticks(world, 32); world = nearExpiry(world, 'entity:2'); const before = freeze(world); const job = world.sectExpansion.production.jobs[0]!;
    const pending = ticks(before, 100);
    expect(pending.clock.simulationTick).toBe(before.clock.simulationTick + 1); expect(pending.clock.pauseReasons).toContain('cultivation');
    expect(pending.sectExpansion.production.jobs[0]!.activeTicks).toBe(job.activeTicks);
    expect(pending.sectExpansion.production.jobs[0]!.terminal?.kind).toBe('cancelled'); expect(pending.inventory.wood.reserved).toBe(0);
    expect(pending.inventory.wood.owned).toBe(before.inventory.wood.owned); expect(v9WorkOwners(pending)).toEqual([]);
    expect(ticks(pending, 100).clock).toEqual(pending.clock);
    const retired = finalize(pending, 'entity:2');
    expect(retired.disciples.some(actor => actor.id === 'entity:2')).toBe(false); expect(retired.legacy.estates[0]!.settledMonth).not.toBeNull();
    expect(retired.cultivation.archivedDisciples).toHaveLength(1); expect(retired.builds.retiredDisciples).toHaveLength(1);
    expect(inspectUnregisteredWorldV9Records(retired)).toEqual([]);
    expect(validateSectMaintenanceFrame(projectV9SectFrame(retired)).length).toBeGreaterThan(0);
    const evidence = inspectV9LifecycleRecords(retired); const historical = captureSectHistoricalIdentitiesV9(evidence);
    const terminal = retired.sectExpansion.production.jobs[0]!.terminal!;
    expect(isArchivedSectWorkerReference(historical, 'entity:2', terminal)).toBe(true);
    expect(() => captureSectHistoricalIdentitiesV9({} as typeof evidence)).toThrow();
    const continued = ticks(JSON.parse(JSON.stringify(retired)) as WorldStateV9, 3);
    expect(continued.clock.simulationTick).toBe(retired.clock.simulationTick + 3); expect(continued.inventory).toEqual(retired.inventory);
  });
});

// Every checkpoint below starts from the preceding ACTUAL World command/tick output.
// No direct stock grants, completed jobs/buildings, research flags or map/person merges.
let journey: WorldStateV9;
let libraryReady: WorldStateV9;
let researchActive: WorldStateV9;
let constructionActive: WorldStateV9;
describe('ordinary gathering → paid library/research → alchemy powder in a real World', () => {
  beforeAll(() => { journey = createUnregisteredWorldV9('real-v9-management-journey'); });
  for (const [index, recipe] of ['gather.wood', 'gather.wood', 'gather.wood', 'gather.wood', 'gather.herbs', 'gather.herbs', 'gather.herbs',
    'craft.plank', 'craft.plank', 'craft.plank', 'craft.plank', 'craft.plank'].entries()) {
    it(`funds checkpoint ${index + 1} with real ${recipe}`, () => {
      journey = oldProduction(journey, recipe, `journey.old.${index}`);
      expect(Object.values(journey.sectExpansion.stock).every(entry => entry.owned === 0)).toBe(true);
      expect(journey.cultivation.calendarMonth).toBe(Math.floor(journey.clock.calendarTick / 1200));
    });
  }
  it('produces stone at the real mine without enlarging the legacy catalog', () => {
    const wood = journey.inventory.wood.owned; const stone = journey.inventory.stone.owned;
    journey = sectProduction(journey, 'gather.stone.v9', 'journey.stone');
    expect(journey.inventory.wood.owned).toBe(wood - 1); expect(journey.inventory.stone.owned).toBe(stone + 3);
  });
  it('builds the paid library with actual travel and both material checkpoints', () => {
    constructionActive = startConstruction(journey, 'library.v9', 'journey.library', 1);
    journey = finish(constructionActive, value => value.sectExpansion.construction.jobs[0]!.terminal?.kind === 'completed'); libraryReady = journey;
    const claim = journey.sectExpansion.reservations.find(claim => claim.policy === 'construction-checkpoints')!;
    expect(claim.base.checkpoints).toHaveLength(2); expect(journey.sectExpansion.construction.jobs[0]!.activeTicks).toBe(320);
    expect(journey.map.navVersion).toBeGreaterThan(constructionActive.map.navVersion);
  });
  for (const index of [0, 1]) it(`extracts paid spirit stone ${index + 1}`, () => {
    journey = sectProduction(journey, 'extract.spirit-stone.v9', `journey.spirit.${index}`);
    expect(journey.sectExpansion.stock['spirit-stone'].owned).toBe(index + 1);
  });
  for (const index of [0, 1]) it(`studies paid insight ${index + 1} at the real library`, () => {
    journey = sectProduction(journey, 'study.basic-insight.v9', `journey.insight.${index}`);
    expect(journey.sectExpansion.stock['basic-insight'].owned).toBe(index + 1);
  });
  it('completes 240 actual research work ticks and consumes both zero-genesis materials', () => {
    researchActive = sect(journey, { domain: 'research', command: { kind: 'research.start', commandId: 'journey.medicine', expectedRevision: journey.sectExpansion.research.revision,
      workerId: 'entity:2', researchId: 'basic-medicine.v9' } });
    journey = finish(researchActive, value => value.sectExpansion.research.jobs[0]!.terminal?.kind === 'completed');
    expect(journey.sectExpansion.research.jobs[0]!.activeTicks).toBe(240);
    expect(journey.sectExpansion.stock['spirit-stone'].owned).toBe(0); expect(journey.sectExpansion.stock['basic-insight'].owned).toBe(0);
    expect(journey.sectExpansion.maintenance.payments.length).toBeGreaterThan(0);
  });
  it('builds real alchemy from the completed research proof', () => {
    journey = startConstruction(journey, 'alchemy.v9', 'journey.alchemy', 10);
    journey = finish(journey, value => value.sectExpansion.construction.jobs.at(-1)!.terminal?.kind === 'completed');
    expect(journey.sectExpansion.construction.buildings.map(building => building.definitionId)).toEqual(['library.v9', 'alchemy.v9']);
    expect(journey.sectExpansion.construction.blueprints.at(-1)!.researchGate?.researchId).toBe('basic-medicine.v9');
  });
  it('crafts and delivers one real powder, with no fabricated care or injury effect', () => {
    const herbs = journey.inventory.herbs.owned; const grain = journey.inventory.grain.owned;
    journey = sectProduction(journey, 'craft.wound-powder.v9', 'journey.powder');
    expect(journey.sectExpansion.stock['wound-powder'].owned).toBe(1);
    expect(journey.inventory.herbs.owned).toBe(herbs - 3); expect(journey.inventory.grain.owned).toBe(grain - 1);
    expect(journey.sectExpansion.production.jobs.at(-1)!.activeTicks).toBe(160);
    expect(journey.cultivation.calendarMonth).toBeGreaterThan(0); expect(inspectUnregisteredWorldV9Records(journey)).toEqual([]);
  });
  it('continues data-only JSON deterministically while remaining unregistered', () => {
    const snapshot = JSON.parse(JSON.stringify(journey)) as WorldStateV9;
    expect(ticks(snapshot, 32)).toEqual(ticks(journey, 32));
    expect(validateWorldStateV8(snapshot).length).toBeGreaterThan(0);
    expect(resolveContentIdentity(snapshot.contentIdentity, { allowCandidate: true })).toBeNull();
  });
  it('cancels construction on death before estate removal and leaves no active footprint claim', () => {
    const pending = ticks(nearExpiry(constructionActive, 'entity:2'), 1);
    expect(pending.sectExpansion.construction.jobs[0]!.activeTicks).toBe(0);
    expect(pending.sectExpansion.construction.jobs[0]!.terminal?.kind).toBe('cancelled');
    const retired = finalize(pending, 'entity:2'); expect(inspectUnregisteredWorldV9Records(retired)).toEqual([]);
    expect(retired.inventory.plank.reserved).toBe(0); expect(retired.sectExpansion.construction.buildings).toEqual([]);
  });
  it('cancels research on lifespan and releases actual research materials before retirement', () => {
    const pending = ticks(nearExpiry(researchActive, 'entity:2'), 1);
    expect(pending.sectExpansion.research.jobs[0]!.terminal?.kind).toBe('cancelled');
    expect(pending.sectExpansion.stock['spirit-stone']).toMatchObject({ owned: 2, reserved: 0 });
    const retired = finalize(pending, 'entity:2'); expect(inspectUnregisteredWorldV9Records(retired)).toEqual([]);
    expect(retired.sectExpansion.research.jobs[0]!.activeTicks).toBe(0);
  });
  it('honors the shared effective map for old production after construction and exact paused retry', () => {
    const command = { kind: 'production.start' as const, commandId: 'old.after.library', sequence: 0, issuedTick: libraryReady.clock.simulationTick,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } };
    const started = dispatchUnregisteredCommandV9(libraryReady, command); expect(started.result.status).toBe('accepted');
    const paused = { ...started.world, clock: setPauseReason(started.world.clock, 'player', true) };
    expect(advanceUnregisteredTicksV9(paused, 100).world).toEqual(paused);
    expect(dispatchUnregisteredCommandV9(paused, command).world).toBe(paused);
    const done = finish(started.world, world => world.activeProductionTransactionIds.length === 0);
    expect(done.inventory.wood.owned).toBeGreaterThan(libraryReady.inventory.wood.owned);
    expect(v9SectContext(done).externalClaims).toEqual([]);
  });
});
