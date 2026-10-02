import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_GENESIS, MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { resolveContentIdentity } from '../../src/content/registry';
import type { SectRecipeId } from '../../src/content/sect-v9/types';
import { applyCultivationCommandV3, previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import { prepareWoundPowderEffectV9 } from '../../src/core/cultivation/care-effect-v9';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9, isCommandV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9, SectCommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { composeV9CultivationFrame } from '../../src/core/world/v9-cultivation-bridge';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { lookupProduction } from '../../src/core/world/history-access';
import { inspectV9KnownRecordHeadroom } from '../../src/core/world/v9-record-headroom';
import { projectV9SectFrame, v9WorkOwners } from '../../src/core/world/v9-sect-bridge';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { tickValidatedCareV9 } from '../../src/core/sect-expansion/care-runtime';
import { v9SectContext } from '../../src/core/world/v9-sect-bridge';

const elder = MANAGEMENT_V9_GENESIS.patientId;
function dispatch(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string) {
  return dispatchUnregisteredCommandV9(world, { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 });
}
function accepted(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): WorldStateV9 {
  const result = dispatch(world, body, commandId); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted');
  expect(inspectUnregisteredWorldV9Records(result.world)).toEqual([]); return result.world;
}
const sect = (world: WorldStateV9, payload: SectCommandV9): WorldStateV9 => accepted(world, { kind: 'sect.command', payload }, payload.command.commandId);
function ticks(world: WorldStateV9, count: number): WorldStateV9 {
  const result = advanceUnregisteredTicksV9(world, count); expect(result.stopped, JSON.stringify(result.stopped)).toBeNull(); return result.world;
}
function finish(world: WorldStateV9, done: (world: WorldStateV9) => boolean, maximum = 640): WorldStateV9 {
  let next = world; for (let n = 0; n < maximum && !done(next); n += 8) next = ticks(next, 8);
  expect(done(next)).toBe(true); return next;
}
function oldProduction(world: WorldStateV9, recipeId: string, commandId: string, workerId = 'entity:3'): WorldStateV9 {
  const result = dispatch(world, { kind: 'production.start', payload: { recipeId, workerId } }, commandId);
  expect(result.result.status).toBe('accepted'); return finish(result.world, value => lookupProduction(value, result.result.transactionId!)?.state === 'Committed');
}
function production(world: WorldStateV9, recipeId: SectRecipeId, commandId: string, workerId = 'entity:2'): WorldStateV9 {
  const next = sect(world, { domain: 'production', command: { kind: 'production.start', commandId, expectedRevision: world.sectExpansion.production.revision, workerId, recipeId } });
  const id = next.sectExpansion.production.jobs.at(-1)!.transactionId;
  return finish(next, value => value.sectExpansion.production.jobs.find(job => job.transactionId === id)!.terminal?.kind === 'completed');
}
function construction(world: WorldStateV9, definitionId: 'library.v9' | 'alchemy.v9', name: string, x: number): WorldStateV9 {
  let next = sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: `${name}.place`, expectedRevision: world.sectExpansion.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } } });
  next = sect(next, { domain: 'construction', command: { kind: 'construction.start', commandId: `${name}.start`, expectedRevision: next.sectExpansion.construction.revision,
    blueprintId: next.sectExpansion.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' } });
  return finish(next, value => value.sectExpansion.construction.jobs.at(-1)!.terminal?.kind === 'completed');
}
function careStart(world: WorldStateV9, commandId: string, patientId: string = elder): WorldStateV9 {
  return sect(world, { domain: 'care', command: { kind: 'care.start', commandId, expectedRevision: world.sectExpansion.care.revision, patientId } });
}
function careCancel(world: WorldStateV9, commandId: string): WorldStateV9 {
  return sect(world, { domain: 'care', command: { kind: 'care.cancel', commandId, expectedRevision: world.sectExpansion.care.revision, jobId: world.sectExpansion.care.jobs.at(-1)!.jobId } });
}
function training(world: WorldStateV9, patientId: string, mode: 'duty' | 'rest' | 'training', commandId: string): WorldStateV9 {
  return accepted(world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId, expectedRevision: world.cultivation.revision, discipleId: patientId, mode } } }, commandId);
}
function boundaryInjury(world: WorldStateV9, patientId: string, injury: number): WorldStateV9 {
  // Explicit injury boundary fixture only: economy, medicine and every treatment tick are real.
  const next = cloneJson(world); next.cultivation.disciples.find(profile => profile.discipleId === patientId)!.injury = injury;
  expect(inspectUnregisteredWorldV9Records(next)).toEqual([]); return next;
}
function nearExpiry(world: WorldStateV9, patientId: string, remaining = 1): WorldStateV9 {
  // Explicit birthday boundary fixture. Actual pending death, release and estate run normally.
  const next = cloneJson(world); const actor = next.disciples.find(actor => actor.id === patientId)!;
  const profile = next.cultivation.disciples.find(profile => profile.discipleId === patientId)!;
  actor.birthCalendarTick = next.clock.calendarTick + remaining - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((next.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  expect(inspectUnregisteredWorldV9Records(next)).toEqual([]); return next;
}
function finalize(world: WorldStateV9, patientId: string): WorldStateV9 {
  const death = world.cultivation.pendingDeaths.find(death => death.discipleId === patientId)!; const commandId = 'care.death.finalize';
  return accepted(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId, expectedRevision: world.cultivation.revision,
    discipleId: patientId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, commandId);
}
const injuryOf = (world: WorldStateV9, id: string = elder): number => world.cultivation.disciples.find(profile => profile.discipleId === id)!.injury;
let journey: WorldStateV9; let medicineReady: WorldStateV9; let cared: WorldStateV9;
describe('zero new stock → genuine medicine → actual v9 patient care (bounded checkpoints)', () => {
  beforeAll(() => { journey = createUnregisteredWorldV9('medicine-care-journey'); });
  it('versions the named injured-elder fresh genesis without changing old worlds or registering a save', () => {
    expect(injuryOf(journey)).toBe(25); expect(journey.runtimeProtocol).toBe('fresh-management-v9-unregistered.2');
    expect(journey.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY); expect(resolveContentIdentity(journey.contentIdentity, { allowCandidate: true })).toBeNull();
    expect(createWorld().cultivation.disciples.every(profile => profile.injury === 0)).toBe(true);
    expect(createWorldV8().cultivation.disciples.every(profile => profile.injury === 0)).toBe(true);
    expect(Object.values(journey.sectExpansion.stock).every(entry => entry.owned === 0 && entry.reserved === 0)).toBe(true);
    expect(inspectUnregisteredWorldV9Records({ ...journey, runtimeProtocol: 'fresh-management-v9-unregistered.1' } as unknown as WorldStateV9).length).toBeGreaterThan(0);
    expect(validateWorldStateV8(journey).length).toBeGreaterThan(0);
  });
  for (const [index, recipe] of ['gather.wood', 'gather.wood', 'gather.wood', 'gather.wood', 'gather.herbs', 'gather.herbs', 'gather.herbs',
    'craft.plank', 'craft.plank', 'craft.plank', 'craft.plank', 'craft.plank'].entries()) it(`earns old resources checkpoint ${index + 1}: ${recipe}`, () => {
    journey = oldProduction(journey, recipe, `care.fund.${index}`); expect(injuryOf(journey)).toBe(25);
  });
  it('earns stone from the actual mine', () => { journey = production(journey, 'gather.stone.v9', 'care.stone'); });
  it('constructs the genuine library', () => { journey = construction(journey, 'library.v9', 'care.library', 1); });
  for (const index of [0, 1]) it(`earns spirit stone ${index + 1}`, () => { journey = production(journey, 'extract.spirit-stone.v9', `care.spirit.${index}`); });
  for (const index of [0, 1]) it(`earns basic insight ${index + 1}`, () => { journey = production(journey, 'study.basic-insight.v9', `care.insight.${index}`); });
  it('pays for and completes real basic medicine research', () => {
    journey = sect(journey, { domain: 'research', command: { kind: 'research.start', commandId: 'care.research', expectedRevision: journey.sectExpansion.research.revision,
      workerId: 'entity:2', researchId: 'basic-medicine.v9' } });
    journey = finish(journey, value => value.sectExpansion.research.jobs.at(-1)!.terminal?.kind === 'completed');
  });
  it('constructs actual alchemy from its research source', () => { journey = construction(journey, 'alchemy.v9', 'care.alchemy', 10); });
  it('manufactures and delivers the one powder from paid work and maintenance', () => {
    journey = production(journey, 'craft.wound-powder.v9', 'care.powder'); medicineReady = journey;
    expect(journey.sectExpansion.stock['wound-powder'].owned).toBe(1); expect(journey.sectExpansion.maintenance.payments.length).toBeGreaterThan(0);
    expect(journey.sectExpansion.production.jobs.at(-1)!.terminal?.outputs).toEqual([{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }]);
  });
  it('walks the real elder to storage, then treats for exactly forty ticks and changes the real breakthrough preview', () => {
    const source = canonicalStringify(medicineReady); const preview = previewBreakthroughV3(medicineReady, elder); const rng = cloneJson(medicineReady.randomStreams);
    const started = careStart(medicineReady, 'care.elder'); const id = started.sectExpansion.care.jobs[0]!.jobId;
    expect(started.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 1 });
    let next = started; while (next.sectExpansion.care.jobs[0]!.phase === 'to-storage') next = ticks(next, 1);
    expect(next.sectExpansion.care.jobs[0]!.activeTicks).toBe(0); expect(injuryOf(next)).toBe(25);
    expect(next.disciples.find(actor => actor.id === elder)!.position).toEqual({ x: 7, y: 5 });
    next = ticks(next, 39); expect(next.sectExpansion.care.jobs[0]!.terminal).toBeNull(); expect(injuryOf(next)).toBe(25);
    cared = ticks(next, 1); const job = cared.sectExpansion.care.jobs[0]!;
    expect(job.activeTicks).toBe(40); expect(job.terminal?.effect).toMatchObject({ careJobId: id, patientId: elder, beforeInjury: 25, afterInjury: 5 });
    expect(injuryOf(cared)).toBe(5); expect(cared.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 0, reserved: 0 });
    expect(v9WorkOwners(cared)).toEqual([]); expect(cared.randomStreams).toEqual(rng);
    expect(previewBreakthroughV3(cared, elder).factors.find(factor => factor.key === 'injury')!.contributionBps).toBeGreaterThan(preview.factors.find(factor => factor.key === 'injury')!.contributionBps);
    expect(canonicalStringify(medicineReady)).toBe(source);
  });
  it('exactly retries the original start after completion without charging or applying twice', () => {
    const command = { domain: 'care' as const, command: { kind: 'care.start' as const, commandId: 'care.elder', expectedRevision: 0, patientId: elder } };
    const first = dispatch(medicineReady, { kind: 'sect.command', payload: command }, 'care.elder');
    const replay = dispatch(cared, { kind: 'sect.command', payload: command }, 'care.elder');
    expect(replay.result).toEqual(first.result); expect(replay.world).toBe(cared); expect(injuryOf(replay.world)).toBe(5);
  });
  it('rejects a concurrent last-dose claimant and uninjured patients without consuming IDs', () => {
    const source = boundaryInjury(medicineReady, 'entity:1', 30); const started = careStart(source, 'care.first');
    const body: SectCommandV9 = { domain: 'care', command: { kind: 'care.start', commandId: 'care.last', expectedRevision: started.sectExpansion.care.revision, patientId: 'entity:1' } };
    const failed = dispatch(started, { kind: 'sect.command', payload: body }, 'care.last'); expect(failed.result).toMatchObject({ status: 'rejected', rejection: { detail: 'NO_AVAILABLE_DOSE' } });
    expect(failed.world).toBe(started); expect(started.sectExpansion.care.nextId).toBe(3);
    const healthy = dispatch(medicineReady, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId: 'healthy', expectedRevision: 0, patientId: 'entity:2' } } }, 'healthy');
    expect(healthy.result.status).toBe('rejected'); expect(healthy.world).toBe(medicineReady);
  });
  it('cancels without teleporting, reuses exactly the released dose, and preserves retry and JSON continuation', () => {
    const started = careStart(medicineReady, 'care.cancel.start'); const moving = ticks(started, 2); const position = moving.disciples.find(actor => actor.id === elder)!.position;
    const cancelled = careCancel(moving, 'care.cancel'); expect(cancelled.disciples.find(actor => actor.id === elder)!.position).toEqual(position);
    expect(cancelled.sectExpansion.care.jobs[0]!.terminal?.position).toEqual(position); expect(cancelled.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    const resumed = careStart(cancelled, 'care.reuse'); const job = resumed.sectExpansion.care.jobs[1]!;
    expect(job.previousCancelledCareId).toBe(cancelled.sectExpansion.care.jobs[0]!.jobId); expect(job.doseProductionJobId).toBe(cancelled.sectExpansion.care.jobs[0]!.doseProductionJobId);
    const direct = finish(resumed, world => !!world.sectExpansion.care.jobs[1]!.terminal);
    const json = finish(JSON.parse(JSON.stringify(resumed)) as WorldStateV9, world => !!world.sectExpansion.care.jobs[1]!.terminal);
    expect(json).toEqual(direct); expect(injuryOf(direct)).toBe(5); expect(direct.sectExpansion.stock['wound-powder'].owned).toBe(0);
    const cancelReceipt = cancelled.sectExpansion.care.receipts.at(-1)!;
    const retry = dispatch(direct, { kind: 'sect.command', payload: { domain: 'care', command: cancelReceipt.command } }, cancelReceipt.command.commandId);
    expect(retry.world).toBe(direct); expect(retry.result.status).toBe('accepted');
  });
  it('admits an injured resting child and clamps the registered effect at zero', () => {
    let world = boundaryInjury(medicineReady, 'entity:1', 7); world = training(world, 'entity:1', 'rest', 'child.rest');
    expect(world.disciples[0]!.canWork).toBe(false); world = careStart(world, 'child.care', 'entity:1');
    world = finish(world, value => !!value.sectExpansion.care.jobs[0]!.terminal);
    expect(injuryOf(world, 'entity:1')).toBe(0); expect(world.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 7, afterInjury: 0 });
  });
  it('pauses both travel and care progress and rejects caller supplied effects, doses or eligibility', () => {
    const started = careStart(medicineReady, 'pause.care'); const paused = { ...started, clock: setPauseReason(started.clock, 'player', true) };
    expect(ticks(paused, 500)).toEqual(paused);
    for (const extra of [{ amount: 100 }, { eligible: true }, { price: [] }, { doseProductionJobId: 'fake' }, { result: { injury: 0 } }]) {
      const command = { kind: 'sect.command', commandId: 'forged.command', sequence: 0, issuedTick: medicineReady.clock.simulationTick,
        payload: { domain: 'care', command: { kind: 'care.start', commandId: 'forged.command', expectedRevision: 0, patientId: elder, ...extra } } };
      expect(isCommandV9(command)).toBe(false); expect(dispatchUnregisteredCommandV9(medicineReady, command).world).toBe(medicineReady);
    }
  });
  it('uses the explicit cultivation primitive without HP, life, random, skill or lifespan effects', () => {
    const source = medicineReady.cultivation; const result = prepareWoundPowderEffectV9(source, 'sect-care:1', elder, medicineReady.clock.simulationTick);
    const expected = cloneJson(source); expected.revision++; expected.disciples.find(profile => profile.discipleId === elder)!.injury = 5;
    expect(result.cultivation).toEqual(expected); expect(injuryOf(medicineReady)).toBe(25);
  });
});

let monthBoundary: WorldStateV9; let expiredMedicine: WorldStateV9; let monthTarget = 0; let expiryTarget = 0;
describe('care lifecycle ordering, expiration and ownership', () => {
  it('prepares real calendar targets without manufacturing history or advancing detached clocks', () => {
    monthBoundary = medicineReady; monthTarget = Math.ceil((medicineReady.clock.calendarTick + 44) / CALENDAR_TICKS_PER_MONTH) * CALENDAR_TICKS_PER_MONTH - 44;
    expiredMedicine = accepted(medicineReady, { kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: medicineReady.inventory.wood.owned } }, 'expire.wood');
    expiryTarget = medicineReady.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.firstMaintenanceCalendarTick;
  });
  for (let checkpoint = 0; checkpoint < 6; checkpoint++) it(`advances month-alignment checkpoint ${checkpoint + 1}`, () => {
    monthBoundary = ticks(monthBoundary, Math.min(200, monthTarget - monthBoundary.clock.calendarTick));
  });
  for (let checkpoint = 0; checkpoint < 6; checkpoint++) it(`advances genuine alchemy-expiry checkpoint ${checkpoint + 1}`, () => {
    expiredMedicine = ticks(expiredMedicine, Math.min(200, Math.max(0, expiryTarget - expiredMedicine.clock.calendarTick)));
  });
  it('uses an already delivered dose after its manufacturing building has expired', () => {
    expect(expiredMedicine.clock.calendarTick).toBeGreaterThanOrEqual(expiryTarget); expect(expiredMedicine.inventory.wood.owned).toBe(0);
    const result = finish(careStart(expiredMedicine, 'expired.care'), value => !!value.sectExpansion.care.jobs[0]!.terminal);
    expect(injuryOf(result)).toBe(5); expect(result.sectExpansion.stock['wound-powder'].owned).toBe(0);
  });
  it('uses actual completion-time injury after the same-tick monthly rest effect', () => {
    expect(monthBoundary.clock.calendarTick).toBe(monthTarget);
    let world = training(monthBoundary, elder, 'rest', 'finish.rest'); world = careStart(world, 'finish.rest.care');
    const before = ticks(world, 43); expect(before.sectExpansion.care.jobs[0]!.activeTicks).toBe(39); expect(injuryOf(before)).toBe(25);
    const after = ticks(before, 1); expect(after.clock.calendarTick % 1200).toBe(0);
    expect(after.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 17, afterInjury: 0 });
    expect(after.sectExpansion.stock['wound-powder'].owned).toBe(0);
  });
  it('cancels before the fortieth treatment tick when same-tick rest already healed the patient', () => {
    let world = training(boundaryInjury(monthBoundary, elder, 8), elder, 'rest', 'healed.rest'); world = careStart(world, 'healed.care');
    const before = ticks(world, 43); expect(before.sectExpansion.care.jobs[0]!.activeTicks).toBe(39);
    const after = ticks(before, 1); const terminal = after.sectExpansion.care.jobs[0]!.terminal!;
    expect(terminal.kind).toBe('cancelled'); expect(terminal.cancellation?.kind).toBe('rest-healed'); expect(terminal.effect).toBeNull();
    expect(after.sectExpansion.care.jobs[0]!.activeTicks).toBe(39); expect(injuryOf(after)).toBe(0);
    expect(after.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 }); expect(v9WorkOwners(after)).toEqual([]);
    expect(after.disciples.find(actor => actor.id === elder)!.position).toEqual(before.disciples.find(actor => actor.id === elder)!.position);
    expect(ticks(JSON.parse(JSON.stringify(after)) as WorldStateV9, 1)).toEqual(ticks(after, 1));
  });
  it('cancels before same-tick rest/treatment on pending death and preserves the real position through estate retirement', () => {
    let world = training(boundaryInjury(monthBoundary, elder, 8), elder, 'rest', 'death.rest'); world = careStart(world, 'death.care');
    world = nearExpiry(ticks(world, 43), elder); const position = cloneJson(world.disciples.find(actor => actor.id === elder)!.position);
    const pending = ticks(world, 20); const terminal = pending.sectExpansion.care.jobs[0]!.terminal!;
    expect(pending.clock.simulationTick).toBe(world.clock.simulationTick + 1); expect(pending.clock.pauseReasons).toContain('cultivation');
    expect(terminal.cancellation?.kind).toBe('death'); expect(terminal.position).toEqual(position); expect(terminal.effect).toBeNull();
    expect(pending.sectExpansion.care.jobs[0]!.activeTicks).toBe(39); expect(pending.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    expect(ticks(pending, 20)).toEqual(pending);
    const archived = finalize(pending, elder); expect(archived.disciples.some(actor => actor.id === elder)).toBe(false);
    expect(archived.cultivation.archivedDisciples.some(profile => profile.discipleId === elder)).toBe(true); expect(inspectUnregisteredWorldV9Records(archived)).toEqual([]);
    expect(archived.sectExpansion.care.jobs[0]!.terminal!.position).toEqual(position);
    const orphan = cloneJson(archived); orphan.legacy.archivedIdentities = []; expect(inspectUnregisteredWorldV9Records(orphan).length).toBeGreaterThan(0);
  });
  it('keeps completed care history after genuine death and archive admission, without retaining an active corpse', () => {
    const pending = ticks(nearExpiry(cared, elder), 1); const archived = finalize(pending, elder);
    expect(archived.disciples.some(actor => actor.id === elder)).toBe(false); expect(archived.sectExpansion.care.jobs[0]!.terminal?.kind).toBe('completed');
    expect(archived.cultivation.archivedDisciples.find(profile => profile.discipleId === elder)!.injury).toBe(5);
    expect(inspectUnregisteredWorldV9Records(JSON.parse(JSON.stringify(archived)) as WorldStateV9)).toEqual([]);
  });
  it('blocks old manual/automatic work, production, research, construction, teaching both roles, breakthrough, training and departure', () => {
    let world = careStart(medicineReady, 'busy.care');
    expect(dispatch(world, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: elder } }, 'busy.old').result.rejection?.code).toBe('WORKER_UNAVAILABLE');
    const productionResult = dispatch(world, { kind: 'sect.command', payload: { domain: 'production', command: { kind: 'production.start', commandId: 'busy.production',
      expectedRevision: world.sectExpansion.production.revision, workerId: elder, recipeId: 'gather.stone.v9' } } }, 'busy.production'); expect(productionResult.result.status).toBe('rejected');
    const researchResult = dispatch(world, { kind: 'sect.command', payload: { domain: 'research', command: { kind: 'research.start', commandId: 'busy.research',
      expectedRevision: world.sectExpansion.research.revision, workerId: elder, researchId: 'herbal-compatibility.v9' } } }, 'busy.research'); expect(researchResult.result.status).toBe('rejected');
    world = sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'busy.blueprint', expectedRevision: world.sectExpansion.construction.revision,
      placement: { definitionId: 'library.v9', anchor: { x: 4, y: 1 }, rotation: 0 } } });
    expect(dispatch(world, { kind: 'sect.command', payload: { domain: 'construction', command: { kind: 'construction.start', commandId: 'busy.construction',
      expectedRevision: world.sectExpansion.construction.revision, blueprintId: world.sectExpansion.construction.blueprints.at(-1)!.blueprintId, workerId: elder } } }, 'busy.construction').result.status).toBe('rejected');
    for (const [teacher, student] of [[elder, 'entity:2'], ['entity:2', elder]]) {
      const commandId = `busy.teach.${teacher}`;
      expect(dispatch(world, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision,
        discipleId: teacher!, studentId: student!, knowledgeId: 'knowledge.sword' } } }, commandId).result).toMatchObject({ status: 'rejected', rejection: { cultivationCode: 'DISCIPLE_UNAVAILABLE' } });
    }
    expect(dispatch(world, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm', commandId: 'busy.break', expectedRevision: world.cultivation.revision,
      preview: previewBreakthroughV3(world, elder) } } }, 'busy.break').result).toMatchObject({ status: 'rejected', rejection: { cultivationCode: 'DISCIPLE_UNAVAILABLE' } });
    expect(dispatch(world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: 'busy.training', expectedRevision: world.cultivation.revision,
      discipleId: elder, mode: 'training' } } }, 'busy.training').result.status).toBe('rejected');
    expect(dispatch(world, { kind: 'expedition.command', payload: { command: { commandId: 'busy.depart', kind: 'expedition.depart', request: { squadIds: [elder], routeId: 'route.qingfeng-trial' } } } }, 'busy.depart').result.rejection?.code).toBe('UNREGISTERED_COMMAND_FAMILY');
    world = accepted(world, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: { workerId: elder, enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'busy.plan');
    world = accepted(world, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'busy.auto');
    world = ticks(world, 1); expect(world.activeProductionTransactionIds).toEqual([]);
    const resting = training(world, elder, 'rest', 'busy.rest.allowed'); expect(resting.sectExpansion.care.jobs[0]!.terminal).toBeNull();
  });
  it('rejects care while the patient already owns old work, new work or training', () => {
    const old = accepted(medicineReady, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: elder } }, 'reverse.old');
    const modern = sect(medicineReady, { domain: 'production', command: { kind: 'production.start', commandId: 'reverse.new', expectedRevision: medicineReady.sectExpansion.production.revision,
      workerId: elder, recipeId: 'gather.stone.v9' } });
    const trainingWorld = training(medicineReady, elder, 'training', 'reverse.training');
    for (const [i, source] of [old, modern, trainingWorld].entries()) {
      const commandId = `reverse.care.${i}`; const result = dispatch(source, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId,
        expectedRevision: 0, patientId: elder } } }, commandId); expect(result.result.status).toBe('rejected'); expect(result.world).toBe(source);
    }
  });
  it('uses the exact shared path budget rather than replenishing it for care', () => {
    const started = careStart(medicineReady, 'budget.care'); const world = { ...started, clock: { ...started.clock, simulationTick: started.clock.simulationTick + 1, calendarTick: started.clock.calendarTick + 1 } };
    const budget = createWorkPathBudget(world.clock.simulationTick);
    for (let i = 0; i < 4; i++) advanceWorkNavigationWithBudget({ map: world.map, position: { x: 8, y: 5 }, target: { x: 7, y: 5 }, navigation: emptyNavigation(), simulationTick: world.clock.simulationTick }, budget);
    expect(budget.remaining).toBe(0);
    const blocked = tickValidatedCareV9(world, projectV9SectFrame(world), v9SectContext(world), budget);
    expect(blocked.sectExpansion.care.jobs[0]!.blocked).toBe('PATH_BUDGET'); expect(blocked.sectExpansion.care.jobs[0]!.activeTicks).toBe(0);
    expect(blocked.disciples.find(actor => actor.id === elder)!.position).toEqual(started.disciples.find(actor => actor.id === elder)!.position);
    expect(inspectUnregisteredWorldV9Records(blocked)).toEqual([]);
  });
});

let pressure: WorldStateV9;
describe('care record headroom and rejection boundaries', () => {
  it('starts bounded cancellation pressure using one genuinely manufactured dose', () => { pressure = medicineReady; });
  for (let checkpoint = 0; checkpoint < 16; checkpoint++) it(`retains actual begin/cancel evidence checkpoint ${checkpoint + 1}`, () => {
    for (let i = checkpoint * 8; i < Math.min(127, (checkpoint + 1) * 8); i++) {
      pressure = careStart(pressure, `pressure.start.${i}`); pressure = careCancel(pressure, `pressure.cancel.${i}`);
    }
    expect(pressure.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    expect(inspectV9KnownRecordHeadroom(pressure)).toEqual([]);
  });
  it('retains the final cancellation slot and permits forced death cleanup at the exact record boundary', () => {
    let last = careStart(pressure, 'pressure.last'); expect(last.sectExpansion.care.jobs).toHaveLength(128);
    expect(last.sectExpansion.care.receipts).toHaveLength(255); expect(last.sectExpansion.care.nextId).toBe(257);
    last = nearExpiry(last, elder); const pending = ticks(last, 1); expect(pending.sectExpansion.care.receipts).toHaveLength(256);
    expect(pending.sectExpansion.care.jobs.at(-1)!.terminal?.cancellation?.kind).toBe('death');
    expect(pending.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    expect(inspectUnregisteredWorldV9Records(finalize(pending, elder))).toEqual([]);
    const released = careCancel(careStart(pressure, 'pressure.final.manual'), 'pressure.final.cancel');
    const commandId = 'pressure.overflow'; const result = dispatch(released, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId,
      expectedRevision: released.sectExpansion.care.revision, patientId: elder } } }, commandId);
    expect(result.result).toMatchObject({ status: 'rejected', rejection: { detail: 'CAPACITY_EXCEEDED' } }); expect(result.world).toBe(released);
  });
  it('rejects starts that cannot reserve both command and terminal revision or job/reservation IDs', () => {
    for (const key of ['revision', 'nextId'] as const) {
      const world = cloneJson(medicineReady); world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, [key]: Number.MAX_SAFE_INTEGER - 1 } };
      expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
      const commandId = `limit.${key}`; const result = dispatch(world, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId,
        expectedRevision: world.sectExpansion.care.revision, patientId: elder } } }, commandId);
      expect(result.result).toMatchObject({ status: 'rejected', rejection: { detail: 'CAPACITY_EXCEEDED' } }); expect(result.world).toBe(world);
    }
  });
  it('rejects orphan claims and genuine-looking forged doses, work, effects, payment or clocks', () => {
    const corruptions: ((world: WorldStateV9) => void)[] = [
      world => { world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [] } }; },
      world => { const job = world.sectExpansion.care.jobs[0]!; world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [{ ...job, doseProductionJobId: 'sect-production:999' }] } }; },
      world => { const job = world.sectExpansion.care.jobs[0]!; world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [{ ...job, activeTicks: 39 }] } }; },
      world => { const job = world.sectExpansion.care.jobs[0]!; const terminal = job.terminal!; world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [{ ...job, terminal: { ...terminal, effect: { ...terminal.effect!, afterInjury: 0 } } }] } }; },
      world => { const job = world.sectExpansion.care.jobs[0]!; const terminal = job.terminal!; world.sectExpansion = { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [{ ...job, terminal: { ...terminal, calendarTick: terminal.calendarTick - 1 } }] } }; },
      world => { world.sectExpansion = { ...world.sectExpansion, stock: { ...world.sectExpansion.stock, 'wound-powder': { owned: 1, reserved: 0, capacity: 99 } } }; },
      world => { const production = world.sectExpansion.production.jobs.at(-1)!; world.sectExpansion = { ...world.sectExpansion, production: { ...world.sectExpansion.production,
        jobs: world.sectExpansion.production.jobs.map(job => job.transactionId === production.transactionId ? { ...job, workSpans: [] } : job) } }; },
      world => { world.cultivation.disciples.find(profile => profile.discipleId === elder)!.injury = 25; },
    ];
    for (const corrupt of corruptions) { const world = cloneJson(cared); corrupt(world); expect(inspectUnregisteredWorldV9Records(world).length).toBeGreaterThan(0); }
  });
  it('keeps the old exact four-owner root closed to care reservations', () => {
    const frame = projectV9SectFrame(careStart(medicineReady, 'old.root'));
    const old = { schemaVersion: 1, construction: frame.construction, production: frame.production, research: frame.research, maintenance: frame.maintenance };
    expect(validateSectMaintenanceFrame(old)).toContainEqual({ code: 'ORPHAN_RESERVATION', path: frame.care.jobs[0]!.reservationId });
  });
  it('rejects a forged chronological dose reuse and a duplicated completion reference', () => {
    const cancelled = careCancel(careStart(medicineReady, 'reuse.original'), 'reuse.cancel'); const reused = careStart(cancelled, 'reuse.next');
    const job = reused.sectExpansion.care.jobs[1]!;
    const forged = cloneJson(reused); forged.sectExpansion = { ...forged.sectExpansion, care: { ...forged.sectExpansion.care,
      jobs: [forged.sectExpansion.care.jobs[0]!, { ...job, previousCancelledCareId: null }] } };
    expect(inspectUnregisteredWorldV9Records(forged).length).toBeGreaterThan(0);
    const futureRelease = cloneJson(reused); const first = futureRelease.sectExpansion.care.jobs[0]!;
    futureRelease.sectExpansion = { ...futureRelease.sectExpansion, care: { ...futureRelease.sectExpansion.care, jobs: [{ ...first,
      terminal: { ...first.terminal!, careRevision: futureRelease.sectExpansion.care.revision } }, job] } };
    expect(inspectUnregisteredWorldV9Records(futureRelease).length).toBeGreaterThan(0);
  });
  it('never evaluates malicious command or care-record getters', () => {
    let reads = 0; const command = { kind: 'care.start', commandId: 'getter.care', expectedRevision: 0, patientId: elder };
    Object.defineProperty(command, 'patientId', { enumerable: true, get: () => { reads++; return elder; } });
    expect(dispatchUnregisteredCommandV9(medicineReady, { kind: 'sect.command', commandId: 'getter.care', issuedTick: medicineReady.clock.simulationTick,
      sequence: 0, payload: { domain: 'care', command } }).result.status).toBe('rejected');
    const hostile = cloneJson(cared); Object.defineProperty(hostile.sectExpansion.care.jobs[0], 'terminal', { enumerable: true, get: () => { reads++; return null; } });
    expect(inspectUnregisteredWorldV9Records(hostile).length).toBeGreaterThan(0); expect(reads).toBe(0);
  });
});

describe('care interruption audit regressions', () => {
  it('clears traveling when storage disables, preserves position/route, then resumes and completes', () => {
    let world = ticks(careStart(medicineReady, 'storage.care'), 1); const job = world.sectExpansion.care.jobs[0]!;
    expect(world.disciples.find(actor => actor.id === elder)!.traveling).toBe(true);
    world = { ...world, buildings: world.buildings.map(site => site.blueprintId === 'storage' ? { ...site, operational: false } : site) };
    expect(inspectUnregisteredWorldV9Records(world)).toEqual([]); const position = cloneJson(world.disciples.find(actor => actor.id === elder)!.position);
    const blocked = ticks(world, 1); expect(blocked.sectExpansion.care.jobs[0]!.blocked).toBe('STORAGE_UNAVAILABLE');
    expect(blocked.disciples.find(actor => actor.id === elder)).toMatchObject({ position, traveling: false }); expect(blocked.sectExpansion.care.jobs[0]!.navigation).toEqual(job.navigation);
    expect(blocked.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 1 });
    const cancelled = careCancel(blocked, 'storage.cancel'); expect(cancelled.disciples.find(actor => actor.id === elder)!.position).toEqual(position);
    const resumed = { ...blocked, buildings: blocked.buildings.map(site => site.blueprintId === 'storage' ? { ...site, operational: true } : site) };
    const finished = finish(resumed, value => !!value.sectExpansion.care.jobs[0]!.terminal); expect(injuryOf(finished)).toBe(5);
  });
  it('awards no treatment when the storage cell becomes obstructed after arrival and safely waits for restoration', () => {
    let world = careStart(medicineReady, 'obstruction.care'); world = ticks(world, 4); expect(world.sectExpansion.care.jobs[0]!.phase).toBe('working');
    world = { ...world, map: { ...world.map, navVersion: world.map.navVersion + 1,
      tiles: world.map.tiles.map(tile => tile.x === 7 && tile.y === 5 ? { ...tile, walkable: false } : tile) } };
    expect(inspectUnregisteredWorldV9Records(world)).toEqual([]); const blocked = ticks(world, 1);
    expect(blocked.sectExpansion.care.jobs[0]!.activeTicks).toBe(0); expect(blocked.sectExpansion.care.jobs[0]!.blocked).toBe('PATH_BLOCKED');
    expect(blocked.sectExpansion.care.jobs[0]!.phase).toBe('to-storage'); expect(injuryOf(blocked)).toBe(25);
    expect(blocked.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 1 });
    const cancel = dispatch(blocked, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.cancel', commandId: 'obstruction.cancel',
      expectedRevision: blocked.sectExpansion.care.revision, jobId: blocked.sectExpansion.care.jobs[0]!.jobId } } }, 'obstruction.cancel');
    expect(cancel.result.status).toBe('rejected'); expect(cancel.world).toBe(blocked);
    const restored = { ...blocked, map: { ...blocked.map, navVersion: blocked.map.navVersion + 1,
      tiles: blocked.map.tiles.map(tile => tile.x === 7 && tile.y === 5 ? { ...tile, walkable: true } : tile) } };
    const arrived = ticks(restored, 1); expect(arrived.sectExpansion.care.jobs[0]!.activeTicks).toBe(0);
    expect(injuryOf(ticks(arrived, 40))).toBe(5);
  });
  it('retains the authenticated historical healing source after later death deactivates a resilient-body talent', () => {
    let world = boundaryInjury(monthBoundary, elder, 10);
    // Explicit domain-authority boundary fixture. A genuine schema-3 talent grant produces its
    // own source instance/event; the public player command remains unable to grant talents.
    const grant = applyCultivationCommandV3(world, { kind: 'talent.grant', commandId: 'fixture.resilient', expectedRevision: world.cultivation.revision,
      discipleId: elder, talentId: 'cultivation.resilient-body' });
    expect(grant.ok).toBe(true); if (!grant.ok) return;
    world = composeV9CultivationFrame(world, grant.frame); expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
    world = training(world, elder, 'rest', 'resilient.rest'); world = ticks(careStart(world, 'resilient.care'), 44);
    const reason = world.sectExpansion.care.jobs[0]!.terminal!.cancellation;
    expect(reason).toMatchObject({ kind: 'rest-healed', beforeInjury: 10 });
    if (reason?.kind !== 'rest-healed') throw new Error('Expected rest-healed source');
    expect(reason.healingSourceInstanceIds).toEqual([world.cultivation.disciples.find(profile => profile.discipleId === elder)!.talents[0]!.sourceInstanceId]);
    const pending = ticks(nearExpiry(world, elder), 1); const archived = finalize(pending, elder);
    expect(archived.cultivation.archivedDisciples.find(profile => profile.discipleId === elder)!.talents[0]!.active).toBe(false);
    expect(inspectUnregisteredWorldV9Records(archived)).toEqual([]); expect(archived.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    const bad = cloneJson(archived); const job = bad.sectExpansion.care.jobs[0]!;
    bad.sectExpansion = { ...bad.sectExpansion, care: { ...bad.sectExpansion.care, jobs: [{ ...job, terminal: { ...job.terminal!, cancellation: { ...reason, healingSourceInstanceIds: [] } } }] } };
    expect(inspectUnregisteredWorldV9Records(bad).length).toBeGreaterThan(0);
  });
});

let twoDoses: WorldStateV9;
describe('care deterministic dose identity', () => {
  it('manufactures a second genuine dose rather than adding stock in a fixture', () => {
    twoDoses = production(medicineReady, 'craft.wound-powder.v9', 'second.powder'); expect(twoDoses.sectExpansion.stock['wound-powder'].owned).toBe(2);
  });
  it('selects the oldest delivered unused production output and never reuses a consumed dose', () => {
    const powders = twoDoses.sectExpansion.production.jobs.filter(job => job.recipeId === 'craft.wound-powder.v9');
    let world = careStart(twoDoses, 'two.first'); expect(world.sectExpansion.care.jobs[0]!.doseProductionJobId).toBe(powders[0]!.transactionId);
    world = finish(world, value => !!value.sectExpansion.care.jobs[0]!.terminal); expect(injuryOf(world)).toBe(5);
    world = careStart(world, 'two.second'); expect(world.sectExpansion.care.jobs[1]!.doseProductionJobId).toBe(powders[1]!.transactionId);
    expect(world.sectExpansion.care.jobs[1]!.previousCancelledCareId).toBeNull();
    world = finish(world, value => !!value.sectExpansion.care.jobs[1]!.terminal); expect(injuryOf(world)).toBe(0);
    expect(world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 0, reserved: 0 });
    const forged = cloneJson(world); const second = forged.sectExpansion.care.jobs[1]!;
    forged.sectExpansion = { ...forged.sectExpansion, care: { ...forged.sectExpansion.care, jobs: [forged.sectExpansion.care.jobs[0]!, { ...second, doseProductionJobId: powders[0]!.transactionId }] } };
    expect(inspectUnregisteredWorldV9Records(forged).length).toBeGreaterThan(0);
  });
  it('deterministically admits only one of two same-boundary last-dose commands', () => {
    const world = boundaryInjury(medicineReady, 'entity:1', 10);
    const commands = ['b', 'a'].map((suffix, index): CommandV9 => ({ kind: 'sect.command', commandId: `simultaneous.${suffix}`, issuedTick: world.clock.simulationTick, sequence: 0,
      payload: { domain: 'care', command: { kind: 'care.start', commandId: `simultaneous.${suffix}`, expectedRevision: 0, patientId: index === 0 ? 'entity:1' : elder } } }));
    const result = advanceUnregisteredTicksV9(world, 0, commands);
    expect(result.stopped).toBeNull(); expect(result.commandResults.map(result => result.status)).toEqual(['accepted', 'rejected']);
    expect(result.world.sectExpansion.care.jobs).toHaveLength(1); expect(result.world.sectExpansion.care.jobs[0]!.patientId).toBe(elder);
    expect(result.world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 1 });
  });
});

describe('care reverse cultivation-owner boundary fixtures', () => {
  it('rejects both sides of a genuinely started teaching session', () => {
    // Explicit knowledge-origin boundary fixture only. The teaching transaction and its
    // real IDs, ownership, events and command receipts execute through the v9 dispatcher.
    for (const [teacher, student] of [[elder, 'entity:2'], ['entity:2', elder]]) {
      let world = cloneJson(medicineReady); const knowledge = { knowledgeId: 'knowledge.care-fixture', teacherId: null, teachingId: null };
      world.cultivation.disciples.find(profile => profile.discipleId === teacher)!.knowledge.push(knowledge);
      world.cultivation.legacyIdentities.find(profile => profile.discipleId === teacher)!.knowledge.push(cloneJson(knowledge));
      expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
      const commandId = `fixture.teach.${teacher}`;
      world = accepted(world, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision,
        discipleId: teacher!, studentId: student!, knowledgeId: knowledge.knowledgeId } } }, commandId);
      const careId = `fixture.care.${teacher}`;
      expect(dispatch(world, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId: careId,
        expectedRevision: 0, patientId: elder } } }, careId).result).toMatchObject({ status: 'rejected', rejection: { detail: 'PATIENT_UNAVAILABLE' } });
    }
  });
  it('rejects a genuine pending breakthrough owner and rejects pending or archived patients', () => {
    // Explicit cultivation-progress boundary fixture; escrow and breakthrough ownership are real.
    let world = cloneJson(medicineReady); world.cultivation.disciples.find(profile => profile.discipleId === elder)!.cultivation = 120;
    world = accepted(world, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm', commandId: 'fixture.break', expectedRevision: world.cultivation.revision,
      preview: previewBreakthroughV3(world, elder) } } }, 'fixture.break');
    expect(dispatch(world, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId: 'fixture.break.care', expectedRevision: 0, patientId: elder } } }, 'fixture.break.care').result.status).toBe('rejected');
    const pending = ticks(nearExpiry(medicineReady, elder), 1); const archived = finalize(pending, elder);
    for (const [index, source] of [pending, archived].entries()) {
      const commandId = `fixture.dead.${index}`;
      expect(dispatch(source, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId, expectedRevision: 0, patientId: elder } } }, commandId).result.status).toBe('rejected');
    }
  });
});


describe('rest healing grant chronology', () => {
  it('rejects a same-tick post-rest talent grant as evidence for healing that already happened', () => {
    let world = training(boundaryInjury(monthBoundary, elder, 8), elder, 'rest', 'late.grant.rest');
    world = ticks(careStart(world, 'late.grant.care'), 44);
    const grant = applyCultivationCommandV3(world, { kind: 'talent.grant', commandId: 'fixture.late.resilient', expectedRevision: world.cultivation.revision,
      discipleId: elder, talentId: 'cultivation.resilient-body' });
    expect(grant.ok).toBe(true); if (!grant.ok) return;
    world = composeV9CultivationFrame(world, grant.frame); expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
    const job = world.sectExpansion.care.jobs[0]!; const reason = job.terminal!.cancellation;
    if (reason?.kind !== 'rest-healed') throw new Error('Expected rest-healed source');
    const sourceId = world.cultivation.disciples.find(profile => profile.discipleId === elder)!.talents[0]!.sourceInstanceId;
    const forged = { ...world, sectExpansion: { ...world.sectExpansion, care: { ...world.sectExpansion.care, jobs: [{ ...job, terminal: { ...job.terminal!,
      cancellation: { ...reason, beforeInjury: 10, healingSourceInstanceIds: [sourceId] } } }] } } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain(`INVALID_CARE_HEAL_SOURCE:${job.jobId}`);
  });
});


describe('rest healing source definition authentication', () => {
  it('rejects replacing a genuine non-healing grant definition with resilient-body', () => {
    let world = boundaryInjury(monthBoundary, elder, 8);
    const grant = applyCultivationCommandV3(world, { kind: 'talent.grant', commandId: 'fixture.steady', expectedRevision: world.cultivation.revision,
      discipleId: elder, talentId: 'cultivation.steady-breath' });
    expect(grant.ok).toBe(true); if (!grant.ok) return;
    world = composeV9CultivationFrame(world, grant.frame); world = training(world, elder, 'rest', 'steady.rest');
    world = ticks(careStart(world, 'steady.care'), 44); expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
    const forged = cloneJson(world); const patient = forged.cultivation.disciples.find(profile => profile.discipleId === elder)!;
    const sourceId = patient.talents[0]!.sourceInstanceId;
    patient.talents = patient.talents.map(talent => ({ ...talent, sourceDefinitionId: 'cultivation.resilient-body' }));
    const job = forged.sectExpansion.care.jobs[0]!; const reason = job.terminal!.cancellation;
    if (reason?.kind !== 'rest-healed') throw new Error('Expected rest-healed source');
    forged.sectExpansion = { ...forged.sectExpansion, care: { ...forged.sectExpansion.care, jobs: [{ ...job, terminal: { ...job.terminal!,
      cancellation: { ...reason, beforeInjury: 10, healingSourceInstanceIds: [sourceId] } } }] } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain(`INVALID_CARE_HEAL_SOURCE:${job.jobId}`);
  });
});


describe('historical care rest mode', () => {
  it('rejects relabelling a real duty-mode cancellation as monthly rest healing', () => {
    let world = ticks(boundaryInjury(monthBoundary, elder, 8), 1); world = careStart(world, 'duty.cancel.care');
    world = ticks(world, 42); const beforeRevision = world.cultivation.revision;
    world = ticks(world, 1); expect(world.clock.calendarTick % 1200).toBe(0); expect(world.sectExpansion.care.jobs[0]!.activeTicks).toBe(39);
    world = careCancel(world, 'duty.cancel'); expect(injuryOf(world)).toBe(8);
    const forged = cloneJson(world); forged.cultivation.disciples.find(profile => profile.discipleId === elder)!.injury = 0;
    const job = forged.sectExpansion.care.jobs[0]!; const month = forged.cultivation.calendarMonth;
    const commandId = `system/v9/healed/${month}/${job.jobId}`;
    forged.sectExpansion = { ...forged.sectExpansion, care: { ...forged.sectExpansion.care,
      jobs: [{ ...job, terminal: { ...job.terminal!, cancellation: { kind: 'rest-healed', beforeInjury: 8, beforeRevision,
        afterRevision: forged.cultivation.revision, month, healingSourceInstanceIds: [] } } }],
      receipts: forged.sectExpansion.care.receipts.map(receipt => receipt.command.kind === 'care.cancel' ? { ...receipt, command: { ...receipt.command, commandId } } : receipt) } };
    expect(inspectUnregisteredWorldV9Records(forged)).toContain(`INVALID_CARE_HEAL_SOURCE:${job.jobId}`);
  });
  it('keeps genuine rest-healed evidence valid after a later duty command and final archive', () => {
    let world = training(boundaryInjury(monthBoundary, elder, 8), elder, 'rest', 'historical.rest');
    world = ticks(careStart(world, 'historical.care'), 44);
    expect(world.sectExpansion.care.jobs[0]!.terminal?.cancellation?.kind).toBe('rest-healed');
    world = training(world, elder, 'duty', 'historical.duty'); expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
    const archived = finalize(ticks(nearExpiry(world, elder), 1), elder);
    expect(inspectUnregisteredWorldV9Records(archived)).toEqual([]); expect(archived.disciples.some(actor => actor.id === elder)).toBe(false);
  });
});


describe('rest-mode admission consistency', () => {
  it('rejects unproven resting state at care start and on an active patient without widening cultivation validation', () => {
    const source = cloneJson(medicineReady); source.cultivation.disciples.find(profile => profile.discipleId === elder)!.trainingMode = 'rest';
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    const result = dispatch(source, { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', commandId: 'unproven.rest', expectedRevision: 0, patientId: elder } } }, 'unproven.rest');
    expect(result.result).toMatchObject({ status: 'rejected', rejection: { detail: 'PATIENT_UNAVAILABLE' } }); expect(result.world).toBe(source);
    const active = cloneJson(careStart(medicineReady, 'unproven.active')); active.cultivation.disciples.find(profile => profile.discipleId === elder)!.trainingMode = 'rest';
    expect(inspectUnregisteredWorldV9Records(active).length).toBeGreaterThan(0);
  });
});
