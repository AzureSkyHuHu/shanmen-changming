import { beforeAll, describe, expect, it as runCase } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { setPauseReason } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 as advance, CAPACITY_LIMITED_V10_MAX_STEPS,
  dispatchCapacityLimitedCommandV10 as dispatch, verifyCapacityLimitedCandidateV10 as verify } from '../../src/core/world/runtime-capacity-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

// Repeated full-envelope/reducer proofs on near-4-MiB fixtures need a bounded
// correctness-test budget. This is not a gameplay/performance acceptance limit.
function it(name: string, body: () => void): void { runCase(name, body, 30_000); }

/** Explicit record-test lift only. No codec, migration, save or UI is exercised. */
function records(source: WorldStateV9 = createUnregisteredWorldV9('fixed-v10-runtime')): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable old L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture has no L2'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function command(world: WorldStateV10, body: Omit<CommandV10, 'commandId' | 'sequence' | 'issuedTick'>, commandId: string): CommandV10 {
  return { ...body, commandId, sequence: 0, issuedTick: world.clock.simulationTick } as CommandV10;
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 {
  return command(world, { kind: 'sect.command', payload }, payload.command.commandId);
}
function accepted(world: WorldStateV10, input: CommandV10): WorldStateV10 {
  const result = dispatch(world, input); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function atWireCost(source: WorldStateV10, target: number): WorldStateV10 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const initial = assess(world); expect(initial.supported, initial.sourceRecordIssues.join(';')).toBe(true);
  const count = target - initial.costs.wireBytes!; expect(count).toBeGreaterThanOrEqual(0);
  world.diagnostics.at(-1)!.message = 'x'.repeat(count);
  // This is explicit valid diagnostic pressure, never forged histories or budgets.
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]);
  expect(assess(world).costs.wireBytes).toBe(target); return world;
}
function deficient(world: WorldStateV10, excess = 200_000): WorldStateV10 { return atWireCost(world, SAVE_FILE_LIMIT_BYTES + excess); }
function place(world: WorldStateV10, commandId: string, x = 1): WorldStateV10 {
  return accepted(world, sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId,
    expectedRevision: world.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } } }));
}
function cancelBlueprint(world: WorldStateV10, commandId: string, index = 0): CommandV10 {
  return sect(world, { domain: 'construction', command: { kind: 'construction.cancel', commandId,
    expectedRevision: world.sectExpansion.construction.revision, blueprintId: world.sectExpansion.construction.blueprints[index]!.blueprintId } });
}
function until(source: WorldStateV10, predicate: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = source;
  for (let count = 0; count < limit && !predicate(next); count++) next = prepareNormalTickCandidateV10(next);
  if (!predicate(next)) throw new Error('Real v10 candidate fixture did not complete'); return next;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

describe('fixed whole-v10 candidate capacity admission', () => {
  it('admits a real start at exact whole cost and refuses one extra byte atomically', () => {
    const source = records(); const input = sect(source, { domain: 'production', command: { kind: 'production.start', commandId: 'exact.start',
      expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2' } });
    const candidate = prepareUnregisteredCommandCandidateV10(source, input); expect(candidate.result.status).toBe('accepted');
    const delta = assess(candidate.world).costs.wireBytes! - assess(source).costs.wireBytes!;
    const equal = atWireCost(source, SAVE_FILE_LIMIT_BYTES - delta);
    const applied = dispatch(equal, input); expect(applied.result.status).toBe('accepted');
    expect(assess(applied.world).costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES);
    const short = cloneJson(equal); short.diagnostics.at(-1)!.message += 'x'; const before = canonicalStringify(short);
    const refused = dispatch(short, input); expect(refused.world).toBe(short);
    expect(refused.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED');
    expect(canonicalStringify(short)).toBe(before); expect(short.sectExpansion.production.receipts).toEqual([]);
    expect(short.commandReceipts).toEqual({}); expect(short.sectExpansion.production.nextId).toBe(1);
  });
  it('does not admit individually fitting but unrelated Worlds or a forged real candidate plus RNG change', () => {
    const source = records(); const unrelated = cloneJson(source); unrelated.inventory.wood.owned++;
    expect(assess(source).fits).toBe(true); expect(assess(unrelated).fits).toBe(true);
    expect(verify(source, unrelated)).toMatchObject({ ok: false, reason: 'unsupported-transition' });
    const input = command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'witness.discard');
    const real = prepareUnregisteredCommandCandidateV10(source, input); expect(real.result.status).toBe('accepted');
    expect(verify(source, real.world)).toMatchObject({ ok: true, reason: 'ordinary' });
    const forged = cloneJson(real.world); forged.randomStreams.events.state = (forged.randomStreams.events.state + 1) >>> 0;
    expect(assess(forged).fits).toBe(true); expect(verify(source, forged)).toMatchObject({ ok: false, reason: 'unsupported-transition' });
  });
  it('derives fresh assessments and cannot be admitted by mutating returned diagnostics', () => {
    const source = deficient(records(), 1); const first = verify(source, source);
    expect(first.ok).toBe(false); first.assessment.fits = true; first.assessment.current.wireBytes = 0;
    first.assessment.deficits.length = 0;
    const next = verify(source, source); expect(next.ok).toBe(false); expect(next.assessment.fits).toBe(false);
    expect(next.assessment.deficits.length).toBeGreaterThan(0);
  });
  it('accepts genuine sequential planned discharges while remaining recovery-only', () => {
    const source = deficient(place(place(records(), 'one.place'), 'two.place', 10), 700_000);
    const before = canonicalStringify(source); const first = accepted(source, cancelBlueprint(source, 'one.cancel'));
    expect(assess(first).fits).toBe(false); expect(verify(source, first)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    const second = accepted(first, cancelBlueprint(first, 'two.cancel', 1));
    expect(assess(second).fits).toBe(false); expect(second.sectExpansion.construction.blueprints.every(bp => bp.status === 'cancelled')).toBe(true);
    expect(verify(first, second).discharged).toHaveLength(1); expect(canonicalStringify(source)).toBe(before);
  });
  it('does not fund ordinary command receipts or transfer a planned reserve as discharge', () => {
    let source = place(records(), 'planned'); source.inventory.wood.owned = 99; source.inventory.stone.owned = 99; source.inventory.plank.owned = 99;
    source = deficient(source, 100_000); const before = canonicalStringify(source);
    const input = sect(source, { domain: 'construction', command: { kind: 'construction.start', commandId: 'owner.transfer',
      expectedRevision: source.sectExpansion.construction.revision, blueprintId: source.sectExpansion.construction.blueprints[0]!.blueprintId, workerId: 'entity:2' } });
    expect(prepareUnregisteredCommandCandidateV10(source, input).result.status).toBe('accepted');
    expect(dispatch(source, input).result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED');
    const discard = dispatch(source, command(source, { kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: 1 } }, 'unfunded.discard'));
    expect(discard.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(discard.world).toBe(source);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('authenticates last-event manual cancellation and preserves exact retries/conflicts at the original boundary', () => {
    let source = records(); const start = command(source, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'manual.start');
    source = accepted(source, start); source.sequences.nextEvent = Number.MAX_SAFE_INTEGER - 1;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]); expect(assess(source).fits).toBe(false);
    const input = command(source, { kind: 'production.cancel', payload: { transactionId: source.activeProductionTransactionIds[0]! } }, 'manual.cancel');
    const after = accepted(source, input); expect(after.sequences.nextEvent).toBe(Number.MAX_SAFE_INTEGER);
    expect(after.inventory.wood.reserved).toBe(0); expect(after.history.production.count).toBe(1);
    expect(verify(source, after)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    const retry = dispatch(after, input); expect(retry.world).toBe(after); expect(retry.result.status).toBe('accepted');
    const conflict = dispatch(after, { ...input, payload: { transactionId: 'instance:999' } });
    expect(conflict.world).toBe(after); expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT');
  });
  it('keeps exact retries ahead of deficient wire capacity and allocates no extra receipt', () => {
    let source = records(); const input = command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'retry.discard');
    source = deficient(accepted(source, input)); const before = canonicalStringify(source);
    const repeated = dispatch(source, input); expect(repeated.world).toBe(source); expect(repeated.result.status).toBe('accepted');
    expect(dispatch(source, { ...input, payload: { resourceId: 'grain', quantity: 2 } }).result.rejection?.code).toBe('COMMAND_CONFLICT');
    expect(canonicalStringify(source)).toBe(before);
  });
  it('refuses a real reserved completion when a different future counter deficit would increase', () => {
    let source = place(records(), 'counter.planned');
    source = accepted(source, command(source, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'counter.production'));
    const id = source.activeProductionTransactionIds[0]!;
    // Finishing productive work is not delivery. Run the real return path and
    // capture arrival, so the next actual tick can commit the reserved output.
    source = until(source, world => world.transactions[id]!.phase === 'AwaitingDelivery');
    expect(source.transactions[id]!.activeTicks).toBe(source.transactions[id]!.requiredTicks);
    source.sectExpansion = { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 2 } };
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]); expect(assess(source).fits).toBe(true);
    const candidate = prepareNormalTickCandidateV10(source); expect(candidate.activeProductionTransactionIds).not.toContain(id);
    expect(assess(candidate).deficits.some(deficit => deficit.dimension === 'sect.constructionRevision')).toBe(true);
    expect(verify(source, candidate)).toMatchObject({ ok: false, reason: 'future-capacity' });
    const before = canonicalStringify(source); const result = advance(source, 1);
    expect(result.world).toBe(source); expect(result.stopped?.kind).toBe('capacity'); expect(canonicalStringify(source)).toBe(before);
  });
  it('reprepares optional growth from the same complete source and publishes exactly the fallback', () => {
    let source = records();
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'optional.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'optional.enable'));
    source = atWireCost(source, SAVE_FILE_LIMIT_BYTES - 100); const before = canonicalStringify(source);
    const fallback = prepareNoOptionalGrowthTickCandidateV10(source); const normal = prepareNormalTickCandidateV10(source);
    expect(assess(fallback).fits).toBe(true); expect(assess(normal).fits).toBe(false);
    const actual = advance(source, 1); expect(actual.stopped).toBeNull(); expect(actual.world).toEqual(fallback);
    expect(actual.metrics).toEqual({ normalCandidates: 1, noOptionalCandidates: 1 });
    expect(actual.world.sectEconomy.enabled).toBe(true); expect(actual.world.automaticProduction.nextCycle).toBe(1);
    expect(actual.world.sectEconomy.nextDecisionTick).toBe(source.sectEconomy.nextDecisionTick);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('stops atomically with all domains and RNG unchanged when neither candidate fits', () => {
    const source = deficient(records(), 1); const before = canonicalStringify(source);
    for (let count = 0; count < 2; count++) {
      const result = advance(source, 20); expect(result.stopped?.kind).toBe('capacity'); expect(result.world).toBe(source);
      expect(result.commandResults).toEqual([]); expect(result.world.diagnostics).toHaveLength(1);
      expect(result.metrics).toEqual({ normalCandidates: 1, noOptionalCandidates: 1 }); expect(canonicalStringify(source)).toBe(before);
    }
  });
  it('returns the last accepted command boundary when subsequent tick capacity is exhausted', () => {
    const source = deficient(place(records(), 'last.place'), 700_000); const cancel = cancelBlueprint(source, 'last.cancel');
    const expected = dispatch(source, cancel); expect(expected.result.status).toBe('accepted');
    const result = advance(source, 1, [cancel]); expect(result.stopped?.kind).toBe('capacity');
    expect(result.world).toEqual(expected.world); expect(result.world).not.toBe(source); expect(result.commandResults).toEqual([expected.result]);
  });
  it('sorts detached immediate commands and matches segmented real candidate advancement', () => {
    const source = records(); const first = { ...command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'ordered.first'), sequence: 1 };
    const second = { ...command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'ordered.second'), sequence: 2 };
    const inputs = [second, first]; const before = canonicalStringify(source); const batch = advance(source, 12, inputs);
    expect(batch.stopped).toBeNull(); expect(batch.commandResults.map(result => result.commandId)).toEqual(['ordered.first', 'ordered.second']);
    let expected = accepted(accepted(source, first), second);
    for (let count = 0; count < 12; count++) expected = prepareNormalTickCandidateV10(expected);
    expect(batch.world).toEqual(expected); expect(inputs[0]).toBe(second); expect(canonicalStringify(source)).toBe(before);
    const segment = advance(advance(source, 5, inputs).world, 7); expect(segment.world).toEqual(batch.world);
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'later caller edit' });
    expect(batch.world.diagnostics).toEqual([]); expect(Object.isFrozen(source)).toBe(false);
  });
  it('accepts frozen data without freezing mutable inputs or sharing source and output objects', () => {
    const source = records(); const input = command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'owned.discard');
    const frozen = freeze(cloneJson(source)); const applied = dispatch(frozen, freeze(cloneJson(input)));
    expect(applied.result.status).toBe('accepted'); expect(applied.world).not.toBe(frozen);
    const next = advance(source, 1); expect(next.stopped).toBeNull();
    next.world.inventory.wood.owned++; expect(source.inventory.wood.owned).not.toBe(next.world.inventory.wood.owned);
    expect(Object.isFrozen(source.inventory.wood)).toBe(false); expect(Object.isFrozen(input)).toBe(false);
  });
  it('honors all pauses and rejects invalid or excessive step counts before any command changes', () => {
    const source = records(); source.clock = setPauseReason(setPauseReason(source.clock, 'player', true), 'hidden', true);
    const paused = advance(source, CAPACITY_LIMITED_V10_MAX_STEPS); expect(paused.world).toBe(source); expect(paused.stopped).toBeNull();
    expect(paused.metrics).toEqual({ normalCandidates: 0, noOptionalCandidates: 0 });
    const input = command(source, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'never.executed');
    const before = canonicalStringify(source);
    for (const steps of [-1, 0.5, NaN, Infinity, CAPACITY_LIMITED_V10_MAX_STEPS + 1]) {
      const result = advance(source, steps, [input]); expect(result.world).toBe(source); expect(result.stopped?.kind).toBe('invalid-records');
      expect(result.commandResults).toEqual([]); expect(result.metrics).toEqual({ normalCandidates: 0, noOptionalCandidates: 0 });
    }
    expect(canonicalStringify(source)).toBe(before);
  });
  it('captures ordinary descriptors and never inspects hostile caught errors or command getters', () => {
    const source = records(); let reads = 0; const getter = (): never => { reads++; throw new Error('Do not invoke'); };
    const hostile = Object.defineProperty(cloneJson(source), 'clock', { enumerable: true, get: getter });
    const thrown = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const proxy = new Proxy({}, { ownKeys() { throw thrown; } });
    const alias = cloneJson(source); alias.disciples[1]!.position = alias.disciples[0]!.position;
    for (const world of [hostile, proxy, alias]) {
      expect(verify(world as WorldStateV10, source).ok).toBe(false);
      expect(dispatch(world as WorldStateV10, {}).result.rejection?.code).toBe('INVALID_WORLD_RECORDS');
      const result = advance(world as WorldStateV10, 1); expect(result.stopped?.kind).toBe('invalid-records'); expect(result.world).toBe(world);
    }
    const input = Object.defineProperty({}, 'commandId', { enumerable: true, get: getter });
    expect(dispatch(source, input).result.rejection?.code).toBe('INVALID_COMMAND');
    expect(advance(source, 1, [input as CommandV10]).stopped?.kind).toBe('invalid-records');
    expect(reads).toBe(0); expect(source.commandReceipts).toEqual({});
  });
  it('rejects wrong identities and persisted queues before executing any candidate', () => {
    const source = records(); const wrong = { ...source, simulationVersion: '0.9.0' } as unknown as WorldStateV10;
    const queued = cloneJson(source); queued.pendingCommands = [{ kind: 'inventory.discard', commandId: 'queue.closed', sequence: 0,
      issuedTick: source.clock.simulationTick, payload: { resourceId: 'grain', quantity: 1 } }];
    for (const world of [wrong, queued]) {
      expect(verify(world, source).ok).toBe(false); expect(advance(world, 1).stopped?.kind).toBe('invalid-records');
      expect(dispatch(world, {}).world).toBe(world);
    }
  });
  it('requires actual supported teaching and a whole transition witness even with ample space', () => {
    const old = createUnregisteredWorldV9('runtime-v10-teaching');
    old.cultivation = createCultivationStateV3(old.cultivation.disciples.map(profile => profile.discipleId === 'entity:2'
      ? { ...profile, knowledge: [{ knowledgeId: 'knowledge.gate', teacherId: null, teachingId: null }] } : profile));
    const source = records(old); const input = command(source, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: 'lesson.start',
      expectedRevision: source.cultivation.revision, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.gate' } } }, 'lesson.start');
    const teaching = accepted(source, input); const next = advance(teaching, 1); expect(next.stopped).toBeNull();
    expect(next.world.clock.simulationTick).toBe(1); expect(verify(teaching, next.world).ok).toBe(true);
    const forged = cloneJson(next.world); forged.inventory.wood.owned++;
    expect(assess(forged).fits).toBe(true); expect(verify(teaching, forged)).toMatchObject({ ok: false, reason: 'unsupported-continuation' });
    const short = cloneJson(teaching); short.sectExpansion = { ...short.sectExpansion,
      construction: { ...short.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 2399 } };
    expect(inspectUnregisteredWorldV10Records(short)).toEqual([]);
    expect(advance(short, 1)).toMatchObject({ world: short, stopped: { kind: 'unsupported-continuation' } });
    expect(dispatch(short, input).world).toBe(short); expect(dispatch(short, input).result.status).toBe('accepted');
    const batchRetry = advance(short, 0, [input]); expect(batchRetry.world).toBe(short);
    expect(batchRetry.stopped?.kind).toBe('unsupported-continuation'); expect(batchRetry.commandResults[0]?.status).toBe('accepted');
  });
});

let oldMedicine: WorldStateV9; let ready: WorldStateV10; let started: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10;
describe('actual sixth-owner work through the fixed candidate gate', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let count = 0; count < 4; count++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  }
  beforeAll(() => {
    const world = records(oldMedicine);
    const research = accepted(world, sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'gate.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    ready = until(research, source => source.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = accepted(ready, sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'gate.upgrade',
      expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
    half = until(started, source => source.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
    almost = until(half, source => source.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
  }, 120000);
  it('preserves half-consumed upgrade materials and proves the exact reserved cancellation', () => {
    const source = deficient(half); const job = source.sectExpansion.upgrade.jobs[0]!; const before = canonicalStringify(source);
    const input = sect(source, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'gate.half.cancel',
      expectedRevision: source.sectExpansion.upgrade.revision, jobId: job.jobId } });
    const after = accepted(source, input); const proof = verify(source, after);
    expect(proof).toMatchObject({ ok: true, reason: 'reserved-recovery' }); expect(proof.discharged).toContain(`sect.upgrade:${job.jobId}`);
    expect(after.inventory.stone.owned).toBe(source.inventory.stone.owned); expect(after.inventory.plank.owned).toBe(source.inventory.plank.owned);
    expect(after.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', resultLevel: 1 });
    expect(after.sectExpansion.construction.buildings).toEqual(ready.sectExpansion.construction.buildings);
    expect(after.randomStreams).toEqual(source.randomStreams); expect(after.clock).toEqual(source.clock); expect(canonicalStringify(source)).toBe(before);
    expect(dispatch(after, input).world).toBe(after);
    const conflict = sect(after, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'gate.half.cancel',
      expectedRevision: after.sectExpansion.upgrade.revision, jobId: 'sect-upgrade:999' } });
    expect(dispatch(after, conflict).result.rejection?.code).toBe('COMMAND_CONFLICT');
  });
  it('admits genuine final upgrade work and retains the immutable L1 construction record', () => {
    const source = deficient(almost); const before = canonicalStringify(source); const actual = advance(source, 1);
    expect(actual.stopped).toBeNull(); expect(actual.world.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 400, terminal: { kind: 'completed', resultLevel: 2 } });
    expect(verify(source, actual.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    expect(actual.world.sectExpansion.construction.buildings).toEqual(source.sectExpansion.construction.buildings);
    expect(actual.world.sectExpansion.upgrade.receipts).toHaveLength(source.sectExpansion.upgrade.receipts.length);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('rejects a valid-looking cancelled upgrade spliced with unrelated resource/RNG changes', () => {
    const source = deficient(started); const job = source.sectExpansion.upgrade.jobs[0]!;
    const actual = accepted(source, sect(source, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'gate.splice.cancel',
      expectedRevision: source.sectExpansion.upgrade.revision, jobId: job.jobId } }));
    const forged = cloneJson(actual); forged.inventory.wood.owned++; forged.randomStreams.events.state = (forged.randomStreams.events.state + 1) >>> 0;
    expect(inspectUnregisteredWorldV10Records(forged)).toEqual([]);
    expect(verify(source, forged)).toMatchObject({ ok: false, reason: 'unsupported-transition', discharged: [] });
  });
});
