import { describe, expect, it, vi } from 'vitest';
import { restoreHistoryArchive } from '../../src/core/history';
import * as capacityQueries from '../../src/core/world/management-capacity-v9';
import * as simulationCandidates from '../../src/core/kernel/simulation-v9';
import { createCultivationStateV3, previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9 } from '../../src/core/world/runtime-capacity-v9';
import { createPrivateRuntimeV9, type PrivateRuntimeInstanceV9, type RuntimeOperationV9 } from '../../src/core/world/runtime-instance-v9';
import * as ownedHelpers from '../../src/core/world/runtime-owned-internals-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureResearchStart, fixtureSectCommand,
  fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

function runtime(world: unknown): PrivateRuntimeInstanceV9 {
  const created = createPrivateRuntimeV9(world); expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(JSON.stringify(created));
  expect(created.metrics.fullQueries).toBe(1); return created.instance;
}
function snapshot(instance: PrivateRuntimeInstanceV9): WorldStateV9 {
  const result = instance.snapshot(); expect(result.ok).toBe(true); expect(result.world).not.toBeNull(); return result.world!;
}
function advance(instance: PrivateRuntimeInstanceV9, before: WorldStateV9, ticks: number): WorldStateV9 {
  const strict = advanceCapacityLimitedTicksV9(before, ticks); const actual = instance.advance(ticks);
  expect(actual.stopped).toEqual(strict.stopped); expect(actual.advancedTicks).toBe(strict.world.clock.simulationTick - before.clock.simulationTick);
  const after = snapshot(instance); expect(after).toEqual(strict.world); expect('world' in actual).toBe(false); return after;
}
function command(instance: PrivateRuntimeInstanceV9, before: WorldStateV9, input: CommandV9): WorldStateV9 {
  const strict = dispatchCapacityLimitedCommandV9(before, input); const actual = instance.command(input);
  expect(actual.result).toEqual(strict.result); expect(actual.published).toBe(strict.world !== before);
  const after = snapshot(instance); expect(after).toEqual(strict.world); expect('world' in actual).toBe(false); return after;
}
function training(world: WorldStateV9, id: string, mode: 'duty' | 'rest' | 'training' = 'duty'): CommandV9 {
  return fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
    expectedRevision: world.cultivation.revision, discipleId: 'entity:2', mode } } }, id);
}
function atTick(source: WorldStateV9, tick: number): WorldStateV9 {
  const world = cloneJson(source); world.clock = { ...world.clock, simulationTick: tick, calendarTick: tick }; return recordChecked(world);
}
function birthday(source: WorldStateV9, tick: number, death = false): WorldStateV9 {
  const world = cloneJson(source); const actor = world.disciples.find(actor => actor.id === 'entity:2')!;
  const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
  actor.birthCalendarTick = tick - (death ? profile.lifespanMonths : profile.ageMonths) * MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
  return recordChecked(world);
}
function pressure(source: WorldStateV9, target = SAVE_FILE_LIMIT_BYTES + 100): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const before = assessManagementCapacityV9(world); expect(before.supported).toBe(true);
  world.diagnostics.at(-1)!.message = 'x'.repeat(target - before.costs.wireBytes!); return recordChecked(world);
}
function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const entry of Object.values(value)) freeze(entry); Object.freeze(value);
}

describe('private v9 roots and cross-call five-scalar proof', () => {
  it('constructs once and carries twenty separately requested idle ticks with no cold queries or implicit exports', () => {
    const source = createUnregisteredWorldV9('instance-idle'); const before = canonicalStringify(source); const instance = runtime(source);
    const oracle = advanceCapacityLimitedTicksV9(source, 20);
    for (let tick = 0; tick < 20; tick++) {
      const result = instance.advance(1); expect(result.ok).toBe(true); expect(result.advancedTicks).toBe(1);
      expect(result.metrics).toEqual({ fullQueries: 0, fastQueries: 1, normalCandidates: 0, noOptionalCandidates: 0, exports: 0 });
      expect(result.stamp).toEqual({ generation: 1, publication: tick + 1 }); expect(Object.isFrozen(result)).toBe(true);
      expect('world' in result).toBe(false);
    }
    expect(snapshot(instance)).toEqual(oracle.world); expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
  });
  for (const end of [10, 100]) it(`carries exact five decimal widths through ${end - 1}→${end} across calls`, () => {
    let source = createUnregisteredWorldV9(`instance-digits-${end}`);
    for (let tick = 0; tick < end - 2; tick++) source = prepareNormalTickCandidateV9(source);
    const instance = runtime(source); expect(instance.advance(1).metrics.fastQueries).toBe(1);
    const result = instance.advance(1); expect(result.metrics.fullQueries).toBe(0); expect(result.metrics.fastQueries).toBe(1);
    expect(snapshot(instance)).toEqual(advanceCapacityLimitedTicksV9(source, 2).world);
  });
  it('refreshes an exact anchor before strict work after a carried reserve reaches its conservative byte ceiling', () => {
    let source = createUnregisteredWorldV9('instance-conservative');
    for (let tick = 0; tick < 8; tick++) source = prepareNormalTickCandidateV9(source);
    source = pressure(source, SAVE_FILE_LIMIT_BYTES - 1); const instance = runtime(source);
    expect(instance.advance(1).metrics.fastQueries).toBe(1);
    const result = instance.advance(1); expect(result.stopped).toBeNull(); expect(result.metrics.fullQueries).toBe(2);
    expect(result.metrics.normalCandidates).toBe(1); expect(snapshot(instance)).toEqual(advanceCapacityLimitedTicksV9(source, 2).world);
  });
  it('interleaves commands, retries, conflicts, replacement, invalidation and differently sized batches against the strict oracle', () => {
    let world = fundedRuntimeFixture(); const instance = runtime(world);
    world = advance(instance, world, 3); const first = training(world, 'mixed.train', 'rest');
    world = command(instance, world, first); world = command(instance, world, first);
    world = command(instance, world, { ...first, kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: first.commandId,
      expectedRevision: world.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } });
    world = advance(instance, world, 20); expect(instance.invalidate().ok).toBe(true);
    world = advance(instance, world, 1); world = command(instance, world, training(world, 'mixed.duty'));
    const replacement = atTick(world, MONTH - 2); expect(instance.replace(replacement).ok).toBe(true); world = replacement;
    world = advance(instance, world, 1); world = advance(instance, world, 2); expect(snapshot(instance)).toEqual(world);
  });
  it('never aliases caller objects, cross-instance inputs, stale snapshots or receipt results', () => {
    const source = createUnregisteredWorldV9('instance-ownership'); const a = runtime(source); const b = runtime(source);
    const stale = snapshot(a); expect(stale).not.toBe(source); expect(stale.history).not.toBe(source.history);
    source.inventory.wood.owned++; source.cultivation.revision++; source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'caller changed' });
    expect(snapshot(a)).toBe(stale); expect(snapshot(b)).toEqual(stale); expect(snapshot(b)).not.toBe(stale);
    expect(() => { stale.disciples[0]!.position.x++; }).toThrow(); expect(() => { stale.inventory.wood.owned++; }).toThrow();
    const input = training(stale, 'owned.result'); const result = a.command(input);
    expect(result.published).toBe(true); expect(result.result).not.toBeNull(); expect(Object.isFrozen(result.result?.eventIds)).toBe(true);
    expect(Reflect.set(result.result!.eventIds, '0', 'event:999')).toBe(false); expect(snapshot(b)).toEqual(stale);
    a.advance(1); const current = snapshot(a); expect(current).not.toBe(stale); expect(stale.clock.simulationTick).toBe(0);
    expect(a.command(input).result).toEqual(result.result); expect(snapshot(a).commandReceipts['owned.result']!.result).not.toBe(result.result);
  });
  it('caches only detached deep-frozen exports until a publication and never exports during advance or command', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-snapshot')); const first = instance.snapshot(); const second = instance.snapshot();
    expect(first.metrics.exports).toBe(1); expect(second.metrics.exports).toBe(0); expect(first.world).toBe(second.world);
    expect(instance.advance(0).stamp).toEqual(first.stamp); expect(instance.snapshot().world).toBe(first.world);
    instance.advance(1); const third = instance.snapshot(); expect(third.metrics.exports).toBe(1); expect(third.world).not.toBe(first.world);
    expect(Object.isFrozen(third.world?.sectExpansion.stock)).toBe(true); expect(Object.isFrozen(third.world?.history)).toBe(true);
  });
});

let heavy: WorldStateV9;
describe('real heavy-history cross-call ownership', () => {
  for (let group = 0; group < 4; group++) it(`prepares genuine command checkpoint ${group + 1}`, () => {
    if (group === 0) heavy = fundedRuntimeFixture();
    for (let index = group * 64; index < (group + 1) * 64; index++) heavy = fixtureApply(heavy, training(heavy, `instance.heavy.${index}`));
    recordChecked(heavy);
  });
  it('matches twenty strict single-tick calls after exactly one cold assessment of 256 real receipts', () => {
    expect(heavy.cultivation.receipts).toHaveLength(256); const instance = runtime(heavy); let oracle = heavy;
    for (let index = 0; index < 20; index++) {
      oracle = advanceCapacityLimitedTicksV9(oracle, 1).world;
      expect(instance.advance(1).metrics).toMatchObject({ fullQueries: 0, fastQueries: 1, exports: 0 });
    }
    expect(snapshot(instance)).toEqual(oracle); expect(snapshot(instance).cultivation.receipts).not.toBe(heavy.cultivation.receipts);
  });
});

describe('replace, invalidate, stop and close lifecycle', () => {
  it('replaces atomically with an independent source, renews generation and detaches before caller mutation', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-replace-old')); instance.advance(3); const old = instance.snapshot();
    const replacement = atTick(createUnregisteredWorldV9('instance-replace-new'), 99); const before = canonicalStringify(replacement);
    const replaced = instance.replace(replacement); expect(replaced.ok).toBe(true); expect(replaced.metrics.fullQueries).toBe(1);
    expect(replaced.stamp).toEqual({ generation: 2, publication: 4 }); expect(Object.isFrozen(replacement)).toBe(false);
    replacement.inventory.wood.owned++; expect(canonicalStringify(snapshot(instance))).toBe(before); expect(old.world?.clock.simulationTick).toBe(3);
    expect(instance.advance(1).metrics.fullQueries).toBe(0);
  });
  it('preserves the old root, exact/carry certificates, export, stamps and stop on rejected replacement', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-failed-replace')); instance.advance(1); const before = instance.snapshot();
    const forged = cloneJson(before.world!); forged.cultivation.revision++;
    const result = instance.replace(forged); expect(result.ok).toBe(false); expect(result.stamp).toEqual(before.stamp);
    expect(result.stopped).toEqual(before.stopped); expect(instance.snapshot().world).toBe(before.world);
    expect(instance.advance(1).metrics.fullQueries).toBe(0); // Carried proof was not dropped.
    expect(snapshot(instance).clock.simulationTick).toBe(2);
  });
  it('invalidates certificates once, keeps the cached export and world, and authenticates on the next read exactly once', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-invalidate')); instance.advance(1); const before = instance.snapshot();
    const invalidated = instance.invalidate(); expect(invalidated.stamp.generation).toBe(2); expect(invalidated.stamp.publication).toBe(1);
    const first = instance.snapshot(); expect(first.metrics.fullQueries).toBe(1); expect(first.world).toBe(before.world);
    expect(instance.snapshot().metrics.fullQueries).toBe(0); expect(instance.advance(1).metrics.fullQueries).toBe(0);
    instance.invalidate(); const next = instance.advance(1); expect(next.metrics.fullQueries).toBe(1); expect(next.metrics.fastQueries).toBe(1);
  });
  it('holds a recovery-only source, latches failed advance without publishing, and permits a real cancellation after invalidation', () => {
    let world = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    world = { ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    recordChecked(world); const created = createPrivateRuntimeV9(world); expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('Expected recovery-only source'); expect(created.recoveryOnly).toBe(true);
    const instance = created.instance; const before = instance.snapshot(); const strict = advanceCapacityLimitedTicksV9(world, 1);
    const failed = instance.advance(1); expect(failed.stopped).toEqual(strict.stopped); expect(failed.advancedTicks).toBe(0);
    expect(instance.snapshot().world).toBe(before.world); expect(failed.stamp).toEqual(before.stamp);
    const repeated = instance.advance(1); expect(repeated.stopped).toEqual(failed.stopped); expect(repeated.metrics.fullQueries).toBe(0);
    expect(instance.invalidate().stopped).toEqual(failed.stopped); expect(instance.advance(1).metrics.fullQueries).toBe(1);
    const forged = cloneJson(world); forged.cultivation.revision++; const replace = instance.replace(forged);
    expect(replace.ok).toBe(false); expect(replace.stopped).toEqual(failed.stopped);
    const input = fixtureSectCommand(world, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'instance.recover',
      expectedRevision: world.sectExpansion.construction.revision, blueprintId: world.sectExpansion.construction.blueprints[0]!.blueprintId } });
    world = command(instance, world, input); expect(instance.snapshot().stopped).toBeNull();
    expect(world.sectExpansion.construction.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('closes without executing cancellation or save, releases access, and explicitly rejects every later operation', () => {
    const world = fixtureApply(fundedRuntimeFixture(), fixtureCommand(fundedRuntimeFixture(), { kind: 'production.start',
      payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'instance.close.work'));
    const instance = runtime(world); const before = snapshot(instance); expect(before.activeProductionTransactionIds).toHaveLength(1);
    expect(instance.close().ok).toBe(true); expect(instance.close().error).toBe('closed');
    expect(instance.advance(1).error).toBe('closed'); expect(instance.command({}).error).toBe('closed');
    expect(instance.invalidate().error).toBe('closed'); expect(instance.replace(world).error).toBe('closed');
    expect(instance.snapshot()).toMatchObject({ error: 'closed', world: null }); expect(before.activeProductionTransactionIds).toHaveLength(1);
  });
  it('does not close or advance after a failed snapshot export, and can retry a clean export', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-export-failure')); const stamp = instance.advance(0).stamp;
    const spy = vi.spyOn(ownedHelpers, 'detachData').mockImplementationOnce(() => { throw new Error('Injected export allocation failure'); });
    try { expect(instance.snapshot()).toMatchObject({ ok: false, error: 'snapshot-failed', world: null, stamp }); }
    finally { spy.mockRestore(); }
    expect(instance.snapshot().ok).toBe(true); expect(instance.advance(1).advancedTicks).toBe(1); expect(instance.close().ok).toBe(true);
  });
  for (const steps of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) it(`refuses invalid step count ${steps} without changing the root or stop`, () => {
    const instance = runtime(createUnregisteredWorldV9('instance-steps')); const before = instance.snapshot();
    expect(instance.advance(steps)).toMatchObject({ error: 'invalid-steps', advancedTicks: 0, stamp: before.stamp, stopped: null });
    expect(instance.snapshot().world).toBe(before.world);
  });
  it('allows clock controls only by full validated replacement and preserves a paused boundary', () => {
    const source = createUnregisteredWorldV9('instance-clock-control'); const instance = runtime(source); const paused = cloneJson(snapshot(instance));
    paused.clock = setPauseReason(paused.clock, 'player', true); expect(instance.replace(paused).ok).toBe(true);
    expect(instance.advance(20)).toMatchObject({ advancedTicks: 0, stopped: null }); expect(snapshot(instance)).toEqual(paused);
    const resumed = cloneJson(paused); resumed.clock = setPauseReason(resumed.clock, 'player', false); expect(instance.replace(resumed).ok).toBe(true);
    advance(instance, resumed, 1);
  });
});

let library: WorldStateV9; let medicine: WorldStateV9;
describe('real non-scalar work remains completely assessed', () => {
  it('fully assesses each genuine construction candidate and reuses the exact current source across calls', () => {
    const source = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1)); const instance = runtime(source);
    let world = source;
    for (let index = 0; index < 3; index++) {
      const strict = advanceCapacityLimitedTicksV9(world, 1); const result = instance.advance(1);
      expect(result.metrics).toMatchObject({ fullQueries: 1, fastQueries: 0, normalCandidates: 1 }); expect(snapshot(instance)).toEqual(strict.world); world = strict.world;
    }
    library = fixtureUntil(source, value => !!value.sectExpansion.construction.jobs[0]!.terminal);
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`prepares paid research stock checkpoint ${index + 1}`, () => { library = fixtureProduce(library, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9'); });
  }
  it('fully assesses real research and completes it for the medicine fixture', () => {
    const source = fixtureResearchStart(library); advance(runtime(source), source, 2);
    library = fixtureUntil(source, value => !!value.sectExpansion.research.jobs[0]!.terminal);
  });
  it('builds actual alchemy and delivers one paid dose', () => {
    const started = fixtureStartConstruction(fixturePlace(library, 'alchemy.v9', 10));
    medicine = fixtureProduce(fixtureUntil(started, value => !!value.sectExpansion.construction.jobs.at(-1)!.terminal), 'craft.wound-powder.v9');
  });
  it('matches mixed care, sect mining and legacy plank work for repeated calls and a batch', () => {
    let world = fixtureCareStart(medicine);
    world = fixtureApply(world, fixtureSectCommand(world, { domain: 'production', command: { kind: 'production.start', commandId: 'instance.mixed.sect',
      expectedRevision: world.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    world = fixtureApply(world, fixtureCommand(world, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:3' } }, 'instance.mixed.legacy'));
    const instance = runtime(world); for (let tick = 0; tick < 3; tick++) world = advance(instance, world, 1);
    advance(instance, world, 20);
  });
  it('performs a genuine due maintenance payment using a full candidate assessment', () => {
    let source = medicine;
    for (let index = 0; index < 1300; index++) {
      const next = prepareNormalTickCandidateV9(source);
      if (next.sectExpansion.maintenance.payments.length > source.sectExpansion.maintenance.payments.length) break;
      source = next;
    }
    recordChecked(source); const instance = runtime(source); const result = instance.advance(1);
    expect(result.metrics).toMatchObject({ fullQueries: 1, fastQueries: 0 }); expect(snapshot(instance)).toEqual(advanceCapacityLimitedTicksV9(source, 1).world);
    expect(snapshot(instance).sectExpansion.maintenance.payments.length).toBeGreaterThan(source.sectExpansion.maintenance.payments.length);
  });
  it('refreshes the exact current root after carry before a real month or birthday transition', () => {
    for (const source of [atTick(createUnregisteredWorldV9('instance-month'), MONTH - 2), birthday(createUnregisteredWorldV9('instance-birthday'), 2)]) {
      const instance = runtime(source); expect(instance.advance(1).metrics.fullQueries).toBe(0);
      const result = instance.advance(1); expect(result.metrics).toMatchObject({ fullQueries: 2, fastQueries: 0, normalCandidates: 1 });
      expect(snapshot(instance)).toEqual(advanceCapacityLimitedTicksV9(source, 2).world);
    }
  });
  it('handles natural death pause and actual finalize/archive commands without repeating the death', () => {
    let world = birthday(createUnregisteredWorldV9('instance-death'), 2, true); const instance = runtime(world);
    world = advance(instance, world, 1); world = advance(instance, world, 20); expect(world.clock.simulationTick).toBe(2);
    const death = world.cultivation.pendingDeaths[0]!; const id = 'instance.death.finalize';
    const input = fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: id,
      expectedRevision: world.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, id);
    world = command(instance, world, input); world = command(instance, world, input); advance(instance, world, 1);
    expect(snapshot(instance).disciples.some(actor => actor.id === death.discipleId)).toBe(false);
  });
  it('keeps committed breakthrough and decision boundaries strict', () => {
    let world = fundedRuntimeFixture(); world.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!.cultivation = 120;
    world = fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm', commandId: 'instance.confirm',
      expectedRevision: world.cultivation.revision, preview: previewBreakthroughV3(world, 'entity:2') } } }, 'instance.confirm'));
    const instance = runtime(world); expect(instance.advance(1).metrics.fastQueries).toBe(0); expect(snapshot(instance)).toEqual(advanceCapacityLimitedTicksV9(world, 1).world);
  });
  it('uses the strict same-source optional-free fallback for real recovery death cancellation', () => {
    let world = birthday(createUnregisteredWorldV9('instance-recovery-death'), 1, true);
    world = fixtureApply(world, fixtureSectCommand(world, { domain: 'production', command: { kind: 'production.start', commandId: 'instance.recovery.work',
      expectedRevision: world.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    world = pressure(world, SAVE_FILE_LIMIT_BYTES + 700_000); const instance = runtime(world); const strict = advanceCapacityLimitedTicksV9(world, 1);
    const result = instance.advance(1); expect(result.stopped).toEqual(strict.stopped); expect(snapshot(instance)).toEqual(strict.world);
    expect(result.metrics.fullQueries).toBe(strict.metrics.fullQueries - 1); expect(result.metrics.noOptionalCandidates).toBe(strict.metrics.noOptionalCandidates);
    expect(snapshot(instance).sectExpansion.production.jobs[0]!.terminal).not.toBeNull();
  });
});

describe('limited teaching and adversarial lifetime inputs', () => {
  it('admits finite teaching at construction/replacement, rejects unsafe headroom and preserves new-command/retry/conflict priority', () => {
    const source = createUnregisteredWorldV9('instance-teaching');
    source.cultivation = createCultivationStateV3(source.cultivation.disciples.map(profile => profile.discipleId === 'entity:2'
      ? { ...profile, knowledge: [{ knowledgeId: 'knowledge.test', teacherId: null, teachingId: null }] } : profile));
    const input = fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: 'instance.teaching.begin',
      expectedRevision: 0, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.test' } } }, 'instance.teaching.begin');
    const instance = runtime(source); const taught = command(instance, source, input); expect(instance.command(input).result?.status).toBe('accepted');
    const existing = dispatchUnregisteredCommandV9(source, input); expect(existing.result.status).toBe('accepted');
    expect(createPrivateRuntimeV9(existing.world).ok).toBe(true);
    expect(instance.replace(existing.world).ok).toBe(true);
    const short = cloneJson(existing.world); short.sectExpansion = { ...short.sectExpansion, construction: { ...short.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 2 * MONTH + 1 } };
    expect(createPrivateRuntimeV9(short)).toMatchObject({ ok: false, error: 'unsupported-continuation' });
    const before = instance.snapshot(); expect(instance.replace(short).error).toBe('unsupported-continuation'); expect(instance.snapshot().world).toBe(before.world);
    const original = training(taught, 'instance.priority'); const next = command(instance, taught, original);
    const conflict = fixtureCommand(next, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: original.commandId,
      expectedRevision: next.cultivation.revision, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.test' } } }, original.commandId);
    command(instance, next, conflict); expect(instance.command(conflict).result?.rejection?.code).toBe('COMMAND_CONFLICT');
  });
  for (const frozen of [false, true]) it(`rejects nested getters without invoking them, external root frozen=${frozen}`, () => {
    const source = createUnregisteredWorldV9('instance-getter'); let reads = 0;
    Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } }); if (frozen) Object.freeze(source);
    expect(createPrivateRuntimeV9(source).ok).toBe(false); expect(reads).toBe(0);
    const instance = runtime(createUnregisteredWorldV9('instance-getter-target')); const before = instance.snapshot();
    expect(instance.replace(source).ok).toBe(false); expect(instance.snapshot().world).toBe(before.world); expect(reads).toBe(0);
  });
  for (const shape of ['symbol', 'hidden', 'sparse', 'foreign-prototype', 'cycle', 'unsupported-protocol', 'invalid-record', 'actual-overflow'] as const) {
    it(`rejects ${shape} source rather than migrating, stripping or borrowing frozen trust`, () => {
      const source = createUnregisteredWorldV9(`instance-shape-${shape}`);
      if (shape === 'symbol') Object.defineProperty(source.clock, Symbol('x'), { value: 1 });
      if (shape === 'hidden') Object.defineProperty(source.clock, 'x', { value: 1 });
      if (shape === 'sparse') source.diagnostics.length = 1;
      if (shape === 'foreign-prototype') Object.setPrototypeOf(source.clock, { inherited: true });
      if (shape === 'cycle') Object.defineProperty(source.clock, 'loop', { value: source, enumerable: true });
      if (shape === 'unsupported-protocol') Reflect.set(source, 'runtimeProtocol', 'fresh-management-v9-unregistered.2');
      if (shape === 'invalid-record') { source.cultivation.revision++; freeze(source); }
      if (shape === 'actual-overflow') source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'x'.repeat(SAVE_FILE_LIMIT_BYTES) });
      expect(createPrivateRuntimeV9(source).ok).toBe(false);
    });
  }
  it('does not trust a shallow-frozen imported tree or repeated source identity after caller mutation', () => {
    const source = createUnregisteredWorldV9('instance-frozen'); Object.freeze(source); const instance = runtime(source);
    expect(Reflect.set(source.sectExpansion.stock['wound-powder'], 'owned', 1)).toBe(true);
    expect(createPrivateRuntimeV9(source).ok).toBe(false); expect(instance.replace(source).ok).toBe(false);
    expect(instance.advance(1).metrics.fastQueries).toBe(1); expect(snapshot(instance).sectExpansion.stock['wound-powder'].owned).toBe(0);
  });
  it('guards every method before reflecting on a replacement Proxy, including recursive replace/command/close', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-reentry')); instance.advance(1); const before = instance.snapshot();
    const nested: RuntimeOperationV9[] = []; let probes = 0;
    const neverRead = new Proxy({}, { getPrototypeOf() { probes++; throw new Error('Nested input must not be reflected'); } });
    let called = false; const replacement = new Proxy(createUnregisteredWorldV9('instance-reentry-new'), { getPrototypeOf(target) {
      if (!called) { called = true; nested.push(instance.advance(1), instance.command(neverRead), instance.replace(neverRead), instance.snapshot(), instance.invalidate(), instance.close()); }
      return Reflect.getPrototypeOf(target);
    } });
    expect(instance.replace(replacement).ok).toBe(true); expect(nested).toHaveLength(6);
    for (const result of nested) { expect(result.error).toBe('reentrant'); expect(result.stamp).toEqual(before.stamp); }
    expect(probes).toBe(0); expect(snapshot(instance).clock.simulationTick).toBe(0);
  });
  it('guards command capture before a Proxy can replace, advance or close the root midway', () => {
    const source = createUnregisteredWorldV9('instance-command-reentry'); const instance = runtime(source); const nested: string[] = []; let called = false;
    const input = training(source, 'instance.proxy.command'); const proxy = new Proxy(input, { ownKeys(target) {
      if (!called) { called = true; nested.push(instance.advance(1).error!, instance.replace(source).error!, instance.close().error!); }
      return Reflect.ownKeys(target);
    } });
    expect(instance.command(proxy).result).toEqual(dispatchCapacityLimitedCommandV9(source, input).result);
    expect(nested).toEqual(['reentrant', 'reentrant', 'reentrant']); expect(snapshot(instance).clock.simulationTick).toBe(0);
  });
  for (const operation of ['replace', 'command'] as const) it(`contains hostile thrown objects from ${operation} reflection without inspecting their getters or prototype`, () => {
    const instance = runtime(createUnregisteredWorldV9(`instance-thrown-${operation}`)); const before = instance.snapshot(); let inspected = 0;
    const thrown = new Proxy({}, { get() { inspected++; throw new Error('Do not inspect'); }, getPrototypeOf() { inspected++; throw new Error('Do not inspect'); } });
    const input = new Proxy({}, { getPrototypeOf() { throw thrown; } });
    expect(instance[operation](input).ok).toBe(false); expect(inspected).toBe(0); expect(instance.snapshot().world).toBe(before.world);
    expect(instance.advance(1).advancedTicks).toBe(1);
  });
  it('rejects command getters without recording a failure receipt or losing source/cached snapshot', () => {
    const source = createUnregisteredWorldV9('instance-command-getter'); const instance = runtime(source); const before = instance.snapshot(); let reads = 0;
    const input = training(source, 'instance.bad'); Object.defineProperty(input, 'payload', { enumerable: true, get() { reads++; return {}; } });
    expect(instance.command(input)).toMatchObject({ error: 'invalid-command', result: null, published: false, stamp: before.stamp });
    expect(instance.snapshot().world).toBe(before.world); expect(reads).toBe(0); expect(snapshot(instance).commandReceipts['instance.bad']).toBeUndefined();
  });
});

describe('bounded audit coverage for stopped and closed facades', () => {
  it('preserves a latched stop through exact retries and same-ID conflicts without publishing or clearing it', () => {
    let world = fundedRuntimeFixture(); const original = training(world, 'instance.stopped.retry');
    world = fixtureApply(world, original); world = fixturePlace(world, 'library.v9', 1);
    world = { ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    recordChecked(world); const instance = runtime(world); const stopped = instance.advance(1); expect(stopped.stopped).not.toBeNull();
    const before = instance.snapshot(); const retry = instance.command(original);
    expect(retry.result).toEqual(dispatchCapacityLimitedCommandV9(world, original).result);
    expect(retry).toMatchObject({ published: false, stopped: stopped.stopped, stamp: before.stamp });
    const conflicting = training(world, original.commandId, 'rest'); const conflict = instance.command(conflicting);
    expect(conflict.result).toEqual(dispatchCapacityLimitedCommandV9(world, conflicting).result);
    expect(conflict.result?.rejection?.code).toBe('COMMAND_CONFLICT');
    expect(conflict).toMatchObject({ published: false, stopped: stopped.stopped, stamp: before.stamp });
    expect(instance.snapshot().world).toBe(before.world); expect(instance.advance(1).stopped).toEqual(stopped.stopped);
  });
  it('deep-freezes returned stamps, measurements and stop details without exposing mutable private status', () => {
    const source = pressure(createUnregisteredWorldV9('instance-frozen-status')); const instance = runtime(source);
    const result = instance.advance(1); expect(result.stopped).not.toBeNull(); const before = canonicalStringify(result);
    expect(Object.isFrozen(result.stamp)).toBe(true); expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.stopped)).toBe(true); expect(Object.isFrozen(result.stopped!.details)).toBe(true);
    expect(Reflect.set(result.stamp, 'generation', 999)).toBe(false); expect(Reflect.set(result.metrics, 'fullQueries', 999)).toBe(false);
    expect(Reflect.set(result.stopped!, 'kind', 'invalid-records')).toBe(false);
    expect(Reflect.set(result.stopped!.details, '0', 'Forged diagnostic')).toBe(false);
    expect(canonicalStringify(result)).toBe(before); expect(instance.advance(1).stopped).toEqual(result.stopped);
    expect(instance.snapshot().stopped).toEqual(result.stopped);
  });
  it('rejects closed methods before touching hostile supplied values or a hostile receiver', () => {
    const instance = runtime(createUnregisteredWorldV9('instance-closed-proxy')); instance.close(); let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw new Error('Unexpected get'); },
      ownKeys() { traps++; throw new Error('Unexpected ownKeys'); }, getPrototypeOf() { traps++; throw new Error('Unexpected prototype'); } });
    expect(instance.command(hostile)).toMatchObject({ error: 'closed', published: false, result: null });
    expect(instance.replace(hostile).error).toBe('closed');
    expect(instance.advance(hostile as unknown as number)).toMatchObject({ error: 'closed', advancedTicks: 0 });
    expect(instance.command.call(hostile, hostile).error).toBe('closed');
    expect(instance.snapshot()).toMatchObject({ error: 'closed', world: null });
    expect(instance.invalidate().error).toBe('closed'); expect(instance.close().error).toBe('closed'); expect(traps).toBe(0);
  });
});

describe('candidate-only authenticated archive preservation', () => {
  it('keeps sealed history across active ticks while still copying every ordinary candidate subtree', () => {
    const source = cloneJson(heavy); const instance = runtime(source);
    const input = fixtureCommand(source, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'instance.archive.start');
    const spy = vi.spyOn(capacityQueries, 'assessTeachingManagementCapacityV9');
    try {
      const strictStart = dispatchCapacityLimitedCommandV9(source, input); spy.mockClear();
      expect(instance.command(input).result).toEqual(strictStart.result);
      const started = spy.mock.calls.at(-1)![0]; expect(restoreHistoryArchive(started.history)).toBe(started.history);
      expect(started.history.commandReceipts.count).toBe(source.history.commandReceipts.count + 1);
      expect(snapshot(instance)).toEqual(strictStart.world);
      let oracle = strictStart.world; let previous = started;
      for (let index = 0; index < 3; index++) {
        const strict = advanceCapacityLimitedTicksV9(oracle, 1); spy.mockClear();
        const actual = instance.advance(1); expect(actual.metrics).toMatchObject({ fullQueries: 1, fastQueries: 0 });
        const current = spy.mock.calls.at(-1)![0]; expect(current.history).toBe(previous.history);
        expect(current.builds).not.toBe(previous.builds); expect(current.cultivation).not.toBe(previous.cultivation);
        expect(snapshot(instance)).toEqual(strict.world); oracle = strict.world; previous = current;
      }
      const beforeRetry = instance.snapshot(); spy.mockClear();
      expect(instance.command(input)).toMatchObject({ published: false, result: strictStart.result });
      expect(spy).not.toHaveBeenCalled(); expect(instance.snapshot().world).toBe(beforeRetry.world);
    } finally { spy.mockRestore(); }
  });
  it('authenticates real archive growth and preserves archived exact retries plus payload conflicts', () => {
    let oracle = cloneJson(heavy); const instance = runtime(oracle); const startCount = oracle.history.commandReceipts.count;
    const first = training(oracle, 'a.instance.archive.first'); const secondId = 'a.instance.archive.second';
    const spy = vi.spyOn(capacityQueries, 'assessTeachingManagementCapacityV9');
    try {
      oracle = command(instance, oracle, first); const firstOwned = spy.mock.calls.at(-1)![0];
      expect(restoreHistoryArchive(firstOwned.history)).toBe(firstOwned.history);
      expect(oracle.commandReceipts[first.commandId]).toBeUndefined(); // Real sorted-tail retirement.
      const second = training(oracle, secondId); oracle = command(instance, oracle, second);
      const secondOwned = spy.mock.calls.at(-1)![0]; expect(secondOwned.history).not.toBe(firstOwned.history);
      expect(restoreHistoryArchive(secondOwned.history)).toBe(secondOwned.history);
      expect(oracle.history.commandReceipts.count).toBe(startCount + 2);
      const before = instance.snapshot(); oracle = command(instance, oracle, first);
      oracle = command(instance, oracle, training(oracle, first.commandId, 'rest'));
      expect(instance.snapshot().world).toBe(before.world);
      expect(instance.command(training(oracle, first.commandId, 'rest')).result?.rejection?.code).toBe('COMMAND_CONFLICT');
    } finally { spy.mockRestore(); }
  });
  it('never shares an imported or exported archive across instance or replacement boundaries', () => {
    const source = cloneJson(heavy); const baseline = canonicalStringify(source); const a = runtime(source); const b = runtime(source);
    const input = fixtureCommand(source, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'a.instance.archive.isolation');
    const spy = vi.spyOn(capacityQueries, 'assessTeachingManagementCapacityV9');
    try {
      a.command(input); const privateA = spy.mock.calls.at(-1)![0];
      b.command(input); const privateB = spy.mock.calls.at(-1)![0];
      expect(privateA.history).not.toBe(privateB.history); expect(privateA.history).not.toBe(source.history);
      const staleA = snapshot(a); const staleB = snapshot(b);
      expect(staleA).toEqual(staleB); expect(staleA.history).not.toBe(privateA.history); expect(staleA.history).not.toBe(staleB.history);
      expect(Reflect.set(staleA.history.commandReceipts.pages[0]!, '0', [])).toBe(false);
      expect(Reflect.set(source.history.commandReceipts, 'count', 0)).toBe(true);
      expect(canonicalStringify(source)).not.toBe(baseline); expect(snapshot(a)).toBe(staleA); expect(snapshot(b)).toBe(staleB);
      a.advance(1); expect(snapshot(a).clock.simulationTick).toBe(staleA.clock.simulationTick + 1);
      expect(snapshot(b)).toBe(staleB);
      const replaced = a.replace(staleB); expect(replaced.ok).toBe(true); const replacement = spy.mock.calls.at(-1)![0];
      expect(replacement.history).not.toBe(privateB.history); expect(replacement.history).not.toBe(staleB.history);
      a.advance(1); const after = spy.mock.calls.at(-1)![0]; expect(restoreHistoryArchive(after.history)).toBe(after.history);
      expect(after.history).not.toBe(privateB.history); expect(snapshot(b)).toBe(staleB);
      expect(snapshot(a)).toEqual(advanceCapacityLimitedTicksV9(staleB, 1).world);
    } finally { spy.mockRestore(); }
  });
  for (const field of ['history', 'builds'] as const) it(`rejects a candidate ${field} getter before invocation and safely uses the same-source fallback`, () => {
    const source = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1)); const instance = runtime(source);
    const expected = advanceCapacityLimitedTicksV9(source, 1); const prepared = prepareNormalTickCandidateV9(source); let reads = 0;
    Object.defineProperty(prepared, field, { enumerable: true, get() { reads++; throw new Error('Candidate getter must not run'); } });
    const spy = vi.spyOn(simulationCandidates, 'prepareNormalTickCandidateV9').mockReturnValueOnce(prepared);
    try {
      const actual = instance.advance(1); expect(actual.stopped).toBeNull(); expect(actual.advancedTicks).toBe(1);
      expect(actual.metrics).toMatchObject({ normalCandidates: 1, noOptionalCandidates: 1, fullQueries: 1 });
      expect(snapshot(instance)).toEqual(expected.world); expect(reads).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
