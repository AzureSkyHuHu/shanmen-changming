import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { CALENDAR_TICKS_PER_MONTH as MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 as strict, dispatchCapacityLimitedCommandV10 as dispatch } from '../../src/core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10, type RuntimeOperationV10 } from '../../src/core/world/runtime-instance-v10';
import { createOwnedIdleLeafV10 } from '../../src/core/world/runtime-owned-internals-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Explicit record-only lift of earned old histories. Base-stock funding is
 * fixture setup, not a codec, migration, new game or gameplay-reachability claim. */
function records(source: WorldStateV9 = createUnregisteredWorldV9('v10-retained-idle')): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No old L2 fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function runtime(world: WorldStateV10): PrivateRuntimeInstanceV10 {
  const created = createPrivateRuntimeV10(world); expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error('Expected admitted runtime');
  expect(created.metrics).toMatchObject({ sourceChecks: 1, fastTicks: 0 }); return created.instance;
}
function snapshot(instance: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = instance.snapshot(); expect(result).toMatchObject({ ok: true, metrics: { sourceChecks: 1, exports: 1, fastTicks: 0 } });
  expect(result.world).not.toBeNull(); return result.world!;
}
function compare(instance: PrivateRuntimeInstanceV10, source: WorldStateV10, steps: number, publication: number, generation = 1) {
  const oracle = strict(source, steps); const actual = instance.advance(steps);
  const ticks = oracle.world.clock.simulationTick - source.clock.simulationTick;
  expect(actual.advancedTicks).toBe(ticks); expect(actual.stopped).toEqual(oracle.stopped);
  expect(actual.stamp).toEqual({ generation, publication: publication + ticks });
  const world = snapshot(instance); expect(world).toEqual(oracle.world);
  expect(actual.recoveryOnly).toBe(!assess(world).fits); return { world, actual };
}
function input(world: WorldStateV10, body: Omit<CommandV10, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): CommandV10 {
  return { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 } as CommandV10;
}
function discard(world: WorldStateV10, id = 'idle.discard'): CommandV10 {
  return input(world, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, id);
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
  return apply(world, input(world, { kind: 'sect.command', payload }, payload.command.commandId));
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = world;
  for (let n = 0; n < limit && !done(next); n++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Actual fixture did not finish'); return next;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function atTick(world: WorldStateV10, tick: number): WorldStateV10 {
  const source = cloneJson(world); source.clock = { ...source.clock, simulationTick: tick, calendarTick: tick };
  expect(inspectUnregisteredWorldV10Records(source)).toEqual([]); return source;
}
function birthday(tick: number, death = false): WorldStateV10 {
  const old = createUnregisteredWorldV9('retained-birthday'); const actor = old.disciples[0]!;
  const profile = old.cultivation.disciples.find(member => member.discipleId === actor.id)!;
  actor.birthCalendarTick = tick - (death ? profile.lifespanMonths : profile.ageMonths) * MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / MONTH); profile.ageMonths = actor.ageMonths;
  return records(old);
}

describe('private v10 retained scalar idle integration', () => {
  it('matches repeated advances and batches, with independent fully revalidated exports and no repeated source checks', () => {
    const source = records(); const before = canonicalStringify(source); const owner = runtime(source);
    let world = source; let publication = 0;
    const saved = snapshot(owner);
    for (const steps of [0, 1, 7, 3, 9]) {
      const result = compare(owner, world, steps, publication); world = result.world; publication += steps;
      expect(result.actual.metrics).toMatchObject({ fastTicks: steps, sourceChecks: 0, candidateChecks: 0,
        normalCandidates: 0, noOptionalCandidates: 0 });
    }
    const again = snapshot(owner); expect(again).toEqual(world); expect(again).not.toBe(world);
    expect(again.history).not.toBe(world.history); expect(again.cultivation).not.toBe(world.cultivation);
    expect(Object.isFrozen(again.cultivation)).toBe(true); expect(saved).toEqual(source);
    expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
    source.inventory.grain.owned = 0; expect(snapshot(owner).inventory.grain.owned).toBe(saved.inventory.grain.owned);
    expect(world.sectExpansion.care.revision).toBe(saved.sectExpansion.care.revision);
    expect(world.sectExpansion.upgrade.revision).toBe(saved.sectExpansion.upgrade.revision);
  }, 30000);

  it.each(['month', 'birthday'] as const)('crosses the exact %s boundary strictly, then resumes the private idle leaf', boundary => {
    const source = boundary === 'month' ? atTick(records(), MONTH - 2) : birthday(2);
    const owner = runtime(source); const first = compare(owner, source, 1, 0);
    expect(first.actual.metrics.fastTicks).toBe(1);
    const second = compare(owner, first.world, 1, 1);
    expect(second.actual.metrics).toMatchObject({ fastTicks: 0, sourceChecks: 1, normalCandidates: 1, candidateChecks: 1 });
    expect(second.world.cultivationClock.transitions.at(-1)?.kind).toBe(boundary === 'month' ? 'month' : 'age-sync');
    expect(compare(owner, second.world, 2, 2).actual.metrics.fastTicks).toBe(2);
  }, 30000);

  it('rechecks the planner boundary after a carried tick and never lets a leaf refusal become a stop', () => {
    const source = records(); source.sectEconomy = { ...source.sectEconomy, enabled: true, nextDecisionTick: 2 };
    const owner = runtime(source); const first = compare(owner, source, 1, 0);
    expect(first.actual.metrics.fastTicks).toBe(1);
    const second = compare(owner, first.world, 1, 1);
    expect(second.actual.metrics).toMatchObject({ fastTicks: 0, sourceChecks: 1, normalCandidates: 1 });
    expect(second.actual.stopped).toBeNull();
  });

  it.each([10, 100, 1000])('matches exact stored and derived dimensions across decimal width %i', next => {
    const base = atTick(records(), next - 1);
    const source: WorldStateV10 = { ...base, sectExpansion: { ...base.sectExpansion,
      construction: { ...base.sectExpansion.construction, revision: next - 1 },
      production: { ...base.sectExpansion.production, revision: next - 1 }, research: { ...base.sectExpansion.research, revision: next - 1 } } };
    const owner = runtime(source); const result = compare(owner, source, 2, 0);
    expect(result.actual.metrics.fastTicks).toBe(2);
    const before = assess(source); const after = assess(result.world);
    expect(after.current.wireBytes! - before.current.wireBytes!).toBe(5);
    for (const name of Object.keys(before.current).filter(key => /^birthday\..+\.elapsedTicks$/.test(key)))
      expect(after.current[name]).toBe(before.current[name]! + 2);
    expect(result.world.sectExpansion.care.revision).toBe(source.sectExpansion.care.revision);
    expect(result.world.sectExpansion.upgrade.revision).toBe(source.sectExpansion.upgrade.revision);
  });

  it('refreshes exact reserve after a failed conservative wire carry and publishes the real strict success', () => {
    const base = atTick(records(), 9);
    const source: WorldStateV10 = { ...base, sectExpansion: { ...base.sectExpansion,
      construction: { ...base.sectExpansion.construction, revision: 9 }, production: { ...base.sectExpansion.production, revision: 9 },
      research: { ...base.sectExpansion.research, revision: 9 } } };
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 9, message: '' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - assess(source).costs.wireBytes!);
    const leaf = createOwnedIdleLeafV10(); expect(leaf.capture(source)).not.toBeNull(); expect(leaf.advance()).toBeNull();
    const owner = runtime(source); const result = compare(owner, source, 1, 0);
    expect(result.actual).toMatchObject({ ok: true, advancedTicks: 1, stopped: null,
      metrics: { fastTicks: 0, sourceChecks: 1, normalCandidates: 1, noOptionalCandidates: 0, candidateChecks: 1 } });
  }, 60000);

  it('keeps real numeric safe-stops through retries, conflicts, failed replacement, invalidation and clock control', () => {
    const original = records(); const retry = discard(original); const accepted = apply(original, retry);
    const source: WorldStateV10 = { ...accepted, sectExpansion: { ...accepted.sectExpansion,
      construction: { ...accepted.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    const owner = runtime(source); const first = compare(owner, source, 1, 0);
    expect(first.actual.metrics.fastTicks).toBe(0);
    const oracle = strict(first.world, 1); expect(oracle.stopped?.kind).toBe('invalid-records');
    const stopped = owner.advance(1); expect(stopped).toMatchObject({ error: 'internal-failure', advancedTicks: 0,
      stopped: { kind: oracle.stopped!.kind }, stamp: { generation: 1, publication: 1 }, metrics: { fastTicks: 0 } });
    // The existing facade intentionally uses its own invalid-records diagnostic
    // text; both strict attempts and the complete retained boundary must agree.
    expect(snapshot(owner)).toEqual(oracle.world);
    expect(owner.command(retry)).toMatchObject({ published: false, stopped: stopped.stopped, stamp: stopped.stamp, result: { status: 'accepted' } });
    expect(owner.command({ ...retry, payload: { resourceId: 'grain', quantity: 2 } })).toMatchObject({ published: false,
      stopped: stopped.stopped, stamp: stopped.stamp, result: { rejection: { code: 'COMMAND_CONFLICT' } } });
    expect(owner.replace({ ...first.world, runtimeProtocol: 'foreign' })).toMatchObject({ error: 'invalid-source', stopped: stopped.stopped, stamp: stopped.stamp });
    expect(owner.invalidate()).toMatchObject({ stopped: stopped.stopped, stamp: { generation: 2, publication: 1 } });
    expect(owner.controlClock({ kind: 'speed', speed: 3 })).toMatchObject({ changed: true, stopped: stopped.stopped, stamp: { generation: 2, publication: 2 } });
    expect(owner.advance(1)).toMatchObject({ advancedTicks: 0, stopped: stopped.stopped, stamp: { generation: 2, publication: 2 } });
    expect(snapshot(owner)).toEqual({ ...first.world, clock: { ...first.world.clock, speed: 3 } });
    expect(owner.replace(original)).toMatchObject({ ok: true, stopped: null, stamp: { generation: 3, publication: 3 } });
    expect(owner.advance(1)).toMatchObject({ advancedTicks: 1, metrics: { fastTicks: 1 } });
  }, 30000);

  it('invalidates both proofs at controls, commands and replacements while retaining no-write stamps', () => {
    const source = records(); const owner = runtime(source); let world = compare(owner, source, 2, 0).world;
    expect(owner.invalidate()).toMatchObject({ stamp: { generation: 2, publication: 2 } });
    let result = compare(owner, world, 1, 2, 2); world = result.world;
    expect(result.actual.metrics).toMatchObject({ sourceChecks: 1, fastTicks: 1 });
    const command = discard(world); const oracle = dispatch(world, command); const actual = owner.command(command);
    expect(actual).toMatchObject({ published: true, result: oracle.result, stamp: { generation: 2, publication: 4 },
      metrics: { sourceChecks: 1, candidateChecks: 1, fastTicks: 0 } });
    world = snapshot(owner); expect(world).toEqual(oracle.world);
    expect(owner.command(command)).toMatchObject({ published: false, stamp: actual.stamp });
    expect(owner.controlClock({ kind: 'speed', speed: 1 })).toMatchObject({ changed: false, stamp: actual.stamp });
    expect(owner.controlClock({ kind: 'pause', reason: 'player', paused: true })).toMatchObject({ changed: true, stamp: { generation: 2, publication: 5 } });
    expect(owner.advance(5)).toMatchObject({ advancedTicks: 0, metrics: { fastTicks: 0 }, stamp: { generation: 2, publication: 5 } });
    expect(owner.controlClock({ kind: 'pause', reason: 'player', paused: false })).toMatchObject({ changed: true, stamp: { generation: 2, publication: 6 } });
    world = snapshot(owner); result = compare(owner, world, 1, 6, 2); world = result.world;
    expect(owner.controlClock({ kind: 'speed', speed: 2 })).toMatchObject({ error: 'invalid-control', changed: false, stamp: result.actual.stamp });
    result = compare(owner, world, 1, 7, 2); world = result.world; expect(result.actual.metrics.sourceChecks).toBe(1);
    expect(owner.command({})).toMatchObject({ published: false, stamp: result.actual.stamp });
    expect(owner.replace({ ...world, simulationVersion: '0.9.0' })).toMatchObject({ error: 'invalid-source', stamp: result.actual.stamp });
    result = compare(owner, world, 1, 8, 2); expect(result.actual.metrics.sourceChecks).toBe(1);
    const foreign = snapshot(runtime(source));
    expect(owner.replace(foreign)).toMatchObject({ ok: true, stamp: { generation: 3, publication: 10 }, metrics: { sourceChecks: 1 } });
    expect(compare(owner, foreign, 1, 10, 3).actual.metrics.fastTicks).toBe(1);
    const detached = snapshot(owner); const closed = owner.close(); let reflected = 0;
    const hostile = new Proxy({}, { ownKeys() { reflected++; throw null; } });
    for (const denied of [owner.command(hostile), owner.controlClock(hostile), owner.replace(hostile), owner.invalidate(), owner.advance(1), owner.snapshot()])
      expect(denied).toMatchObject({ error: 'closed', stamp: closed.stamp });
    expect(reflected).toBe(0); expect(detached.clock.simulationTick).toBe(1);
  }, 30000);

  it('never trusts foreign frozen roots or borrowed this, and guards reentry before inspecting nested inputs', () => {
    const source = records(); const a = runtime(source); a.advance(2); const foreign = snapshot(a); const b = runtime(foreign);
    expect(b.advance(1)).toMatchObject({ advancedTicks: 1, metrics: { fastTicks: 1 } }); expect(snapshot(a)).toEqual(foreign);
    expect(createPrivateRuntimeV10(freeze({ ...foreign, runtimeProtocol: 'foreign' }))).toMatchObject({ ok: false, error: 'invalid-source' });
    const before = a.snapshot(); let getters = 0;
    const accessor = Object.defineProperty(cloneJson(foreign), 'seed', { enumerable: true, get() { getters++; throw null; } });
    expect(a.replace(accessor)).toMatchObject({ error: 'invalid-source', stamp: before.stamp }); expect(getters).toBe(0);
    const calls: RuntimeOperationV10[] = []; let nestedReads = 0;
    const dangerous = new Proxy({}, { ownKeys() { nestedReads++; throw null; } });
    const proxy = new Proxy(discard(foreign), { ownKeys(target) {
      calls.push(a.advance(1), a.snapshot(), a.replace(dangerous), a.command(dangerous), a.controlClock(dangerous), a.invalidate(), a.close());
      return Reflect.ownKeys(target);
    } });
    const borrowed = a.command; const result = borrowed.call(dangerous, proxy);
    expect(result).toMatchObject({ published: true, stamp: { generation: 1, publication: 3 } });
    expect(calls).toHaveLength(7); for (const nested of calls) expect(nested).toMatchObject({ error: 'reentrant', stamp: before.stamp });
    expect(nestedReads).toBe(0); expect(snapshot(a)).toEqual(dispatch(foreign, discard(foreign)).world);
    let thrownReads = 0; const thrown = new Proxy({}, { get() { thrownReads++; throw null; }, getPrototypeOf() { thrownReads++; throw null; } });
    const hostile = new Proxy(foreign, { ownKeys() { throw thrown; } });
    expect(a.replace(hostile)).toMatchObject({ error: 'invalid-source', stamp: result.stamp });
    expect(thrownReads).toBe(0); expect(snapshot(b)).toEqual(strict(foreign, 1).world);
  }, 30000);

  it('falls back for natural death, finalizes through exact command admission and carries archived elapsed dimensions', () => {
    const source = birthday(2, true); const owner = runtime(source); const first = compare(owner, source, 1, 0);
    expect(first.actual.metrics.fastTicks).toBe(1); const pending = compare(owner, first.world, 2, 1);
    expect(pending.actual).toMatchObject({ advancedTicks: 1, metrics: { fastTicks: 0, sourceChecks: 1 } });
    const death = pending.world.cultivation.pendingDeaths[0]!; const id = 'retained.finalize';
    const command = input(pending.world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: id,
      expectedRevision: pending.world.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId,
      cause: 'lifespan', acknowledgeDeath: true } } }, id);
    const oracle = dispatch(pending.world, command); expect(owner.command(command)).toMatchObject({ published: true, result: oracle.result });
    const settled = snapshot(owner); expect(settled).toEqual(oracle.world);
    const next = compare(owner, settled, 2, 3); expect(next.actual.metrics.fastTicks).toBe(2);
    const dimension = `birthday.${death.discipleId}.archivedElapsedTicks`;
    expect(assess(next.world).current[dimension]).toBe(assess(settled).current[dimension]! + 2);
    expect(next.world.legacy.archivedIdentities).toEqual(settled.legacy.archivedIdentities);
  }, 30000);
});

let oldMedicine: WorldStateV9; let started: WorldStateV10; let traveling: WorldStateV10; let working: WorldStateV10;
let checkpoint: WorldStateV10; let almost: WorldStateV10; let completed: WorldStateV10;
describe('retained idle and actual sixth-owner boundaries', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const)
    for (let n = 0; n < 4; n++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  beforeAll(() => {
    let world = records(oldMedicine);
    world = sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'retained.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } });
    world = until(world, value => value.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'retained.upgrade', expectedRevision: 0,
      buildingId: world.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId, workerId: 'entity:2' } });
    traveling = until(started, value => value.sectExpansion.upgrade.jobs[0]!.phase === 'to-site');
    working = until(traveling, value => value.sectExpansion.upgrade.jobs[0]!.phase === 'working');
    checkpoint = until(working, value => value.sectExpansion.upgrade.jobs[0]!.activeTicks === 199);
    almost = until(checkpoint, value => value.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
    completed = prepareNormalTickCandidateV10(almost);
  }, 180000);

  it('uses strict candidates for each live upgrade phase and actual paid checkpoints', () => {
    for (const source of [started, traveling, working, checkpoint, almost]) {
      const result = compare(runtime(source), source, 1, 0);
      expect(result.actual.metrics).toMatchObject({ fastTicks: 0, normalCandidates: 1, candidateChecks: 1 });
    }
    const owner = runtime(almost); const result = compare(owner, almost, 2, 0);
    expect(result.actual.metrics).toMatchObject({ fastTicks: 1, normalCandidates: 1, candidateChecks: 1 });
    expect(result.world.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 400, terminal: { kind: 'completed', resultLevel: 2 } });
    expect(result.world.sectExpansion.construction.buildings).toEqual(almost.sectExpansion.construction.buildings);
  }, 60000);

  it('keeps death-before-completion ordering strict and never advances a carried upgrade phase', () => {
    const source = cloneJson(almost); const target = Math.ceil((source.clock.calendarTick + 1) / MONTH) * MONTH;
    source.clock = { ...source.clock, simulationTick: target - 1, calendarTick: target - 1 };
    const actor = source.disciples.find(member => member.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * MONTH; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const result = compare(runtime(source), source, 2, 0);
    expect(result.actual).toMatchObject({ advancedTicks: 1, metrics: { fastTicks: 0, normalCandidates: 1 } });
    const death = result.world.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    expect(result.world.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 399,
      terminal: { kind: 'cancelled', cancellation: { kind: 'death', deathId: death.deathId } } });
  }, 60000);

  it('respects the latest actual L2 maintenance payment expiry across a batch and detached reconstruction', () => {
    const paid = until(completed, world => world.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2));
    const payment = paid.sectExpansion.maintenance.payments.findLast(value => value.rate?.level === 2)!;
    const edge = until(paid, world => world.clock.calendarTick === payment.dueCalendarTick - 2);
    const original = runtime(edge); const saved = snapshot(original); original.close(); const restored = runtime(saved);
    const result = compare(restored, saved, 2, 0);
    expect(result.actual.metrics).toMatchObject({ fastTicks: 1, sourceChecks: 1, normalCandidates: 1, candidateChecks: 1 });
    expect(result.world.sectExpansion.maintenance.payments.at(-1)).toMatchObject({ buildingId: payment.buildingId,
      paidCalendarTick: payment.dueCalendarTick, rate: { level: 2 } });
    expect(saved.sectExpansion.maintenance.payments).toEqual(edge.sectExpansion.maintenance.payments);
    expect(result.world.sectExpansion.upgrade.revision).toBe(saved.sectExpansion.upgrade.revision);
  }, 180000);
});
