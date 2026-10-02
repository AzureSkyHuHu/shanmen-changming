import { describe, expect, it } from 'vitest';
import { previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH, setPauseReason } from '../../src/core/kernel/clock';
import type { CommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { measureWorldSaveBytes } from '../../src/core/save-budget/envelope';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9 } from '../../src/core/world/runtime-capacity-v9';
import { advanceIdleCapacityLimitedTicksV9 } from '../../src/core/world/runtime-idle-v9';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureResearchStart,
  fixtureSectCommand, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

function equivalent(world: WorldStateV9, steps: number, commands: readonly CommandV9[] = []) {
  const before = canonicalStringify(world); const strict = advanceCapacityLimitedTicksV9(world, steps, commands);
  const actual = advanceIdleCapacityLimitedTicksV9(world, steps, commands);
  expect(actual.world).toEqual(strict.world); expect(actual.stopped).toEqual(strict.stopped);
  expect(actual.commandResults).toEqual(strict.commandResults); expect(canonicalStringify(world)).toBe(before);
  if (strict.world === world) expect(actual.world).toBe(world);
  return actual;
}
function initialStrictFallback(world: WorldStateV9, steps = 2) {
  const result = equivalent(world, steps); const strict = advanceCapacityLimitedTicksV9(world, steps);
  expect(result.metrics.fastQueries).toBe(0); expect(result.metrics.fullQueries).toBe(strict.metrics.fullQueries);
  return result;
}
function atTick(source: WorldStateV9, tick: number): WorldStateV9 {
  const world = cloneJson(source); world.clock = { ...world.clock, simulationTick: tick, calendarTick: tick }; return recordChecked(world);
}
function birthday(source: WorldStateV9, tick: number, death = false, all = false): WorldStateV9 {
  const world = cloneJson(source);
  for (const actor of world.disciples.filter(actor => all || actor.id === 'entity:2')) {
    const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
    actor.birthCalendarTick = tick - (death ? profile.lifespanMonths : profile.ageMonths) * MONTH;
    actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
  }
  return recordChecked(world);
}
function atWireCost(source: WorldStateV9, target: number): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const before = assessManagementCapacityV9(world); expect(before.supported).toBe(true);
  world.diagnostics.at(-1)!.message = 'x'.repeat(target - before.costs.wireBytes!); return recordChecked(world);
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeTree(child); Object.freeze(value);
}

describe('owned scalar-idle v9 batch, with the unchanged strict entry as oracle', () => {
  it('uses one full source query and twenty exact fast queries, leaving caller data writable and unchanged', () => {
    const source = createUnregisteredWorldV9('owned-idle'); const result = equivalent(source, 20);
    expect(result.stopped).toBeNull(); expect(result.metrics).toEqual({ fullQueries: 1, normalCandidates: 0, noOptionalCandidates: 0, fastQueries: 20 });
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.disciples[0])).toBe(false);
    expect(Object.isFrozen(result.world)).toBe(true); expect(Object.isFrozen(result.world.sectExpansion.construction)).toBe(true);
    expect(Object.isFrozen(result.world.disciples[0]!.position)).toBe(true);
    expect(result.world.disciples).not.toBe(source.disciples); expect(result.world.builds).not.toBe(source.builds);
    expect(result.world.history).not.toBe(source.history);
    expect(() => { result.world.inventory.wood.owned++; }).toThrow();
  });
  for (const end of [10, 100]) it(`preserves exact five-number UTF-8 growth through ${end - 1}→${end}`, () => {
    let source = createUnregisteredWorldV9(`owned-digits-${end}`);
    for (let index = 0; index < end - 1; index++) source = prepareNormalTickCandidateV9(source);
    recordChecked(source); const result = equivalent(source, 1);
    expect(result.metrics.fastQueries).toBe(1); expect(result.metrics.fullQueries).toBe(1);
    expect(measureWorldSaveBytes(result.world, { saveVersion: 9 }) - measureWorldSaveBytes(source, { saveVersion: 9 })).toBe(5);
  });
  it('reauthenticates every call after caller mutation and never returns a writable alias to its input', () => {
    const source = createUnregisteredWorldV9('owned-mutation'); const first = equivalent(source, 2);
    source.inventory.wood.owned++; source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'caller edit 汉字😀' });
    const second = equivalent(source, 2); expect(second.world.inventory.wood.owned).toBe(first.world.inventory.wood.owned + 1);
    expect(first.world.diagnostics).toEqual([]); expect(second.world.diagnostics).toEqual(source.diagnostics);
    expect(second.world.diagnostics).not.toBe(source.diagnostics);
    const resumed = equivalent(first.world, 2); expect(resumed.metrics.fullQueries).toBe(1); expect(resumed.world.clock.simulationTick).toBe(4);
  });
  it('keeps zero-tick, paused and rejected input identity and preserves command order, no-ops and exact retries', () => {
    const source = createUnregisteredWorldV9('owned-commands'); expect(equivalent(source, 0).world).toBe(source);
    const paused = cloneJson(source); paused.clock = setPauseReason(paused.clock, 'player', true);
    expect(equivalent(paused, 20).world).toBe(paused);
    const input = fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: 'owned.noop',
      expectedRevision: 0, discipleId: 'entity:2', mode: 'duty' } } }, 'owned.noop');
    const accepted = equivalent(source, 2, [input, input]); expect(accepted.metrics.fastQueries).toBe(0);
    expect(accepted.world.cultivation.receipts).toHaveLength(1); expect(accepted.commandResults).toHaveLength(2);
    expect(equivalent(accepted.world, 0, [input]).world).toBe(accepted.world);
    const refused = fixtureSectCommand(source, { domain: 'production', command: { kind: 'production.cancel', commandId: 'owned.missing', expectedRevision: 0, jobId: 'missing' } });
    expect(equivalent(source, 0, [refused]).world).toBe(source);
  });
  it('switches the remaining batch to strict before a month or off-month birthday', () => {
    const month = equivalent(atTick(createUnregisteredWorldV9('owned-month'), MONTH - 2), 3);
    expect(month.metrics.fastQueries).toBe(1); expect(month.world.cultivationClock.transitions).toHaveLength(1);
    const born = equivalent(birthday(createUnregisteredWorldV9('owned-birthday'), 2), 3);
    expect(born.metrics.fastQueries).toBe(1); expect(born.world.cultivationClock.transitions[0]!.kind).toBe('age-sync');
    const dying = equivalent(birthday(createUnregisteredWorldV9('owned-expiry'), 2, true), 20);
    expect(dying.metrics.fastQueries).toBe(1); expect(dying.world.clock.simulationTick).toBe(2); expect(dying.world.clock.pauseReasons).toContain('cultivation');
  });
  it('refreshes strict source capacity at a conservative digit-width ceiling instead of publishing a false stop or releasing a carried deficit', () => {
    let source = createUnregisteredWorldV9('owned-conservative-reserve');
    for (let index = 0; index < 8; index++) source = prepareNormalTickCandidateV9(source);
    source = atWireCost(source, SAVE_FILE_LIMIT_BYTES - 1);
    const result = equivalent(source, 4); expect(result.stopped).toBeNull(); expect(result.metrics.fastQueries).toBe(1);
    expect(result.metrics.fullQueries).toBeGreaterThan(1); expect(result.world.clock.simulationTick).toBe(12);
  });
  it('delegates initial future deficits and near-MAX revisions without spending or releasing unproved reserves', () => {
    const deficient = atWireCost(createUnregisteredWorldV9('owned-deficit'), SAVE_FILE_LIMIT_BYTES + 1);
    const result = equivalent(deficient, 20); expect(result.metrics.fastQueries).toBe(0); expect(result.world).toBe(deficient);
    let high = createUnregisteredWorldV9('owned-near-max');
    high = { ...high, sectExpansion: { ...high.sectExpansion, construction: { ...high.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    recordChecked(high); expect(equivalent(high, 2).metrics.fastQueries).toBe(0);
  });
  it('falls back for a due planner and for a planned blueprint with no active work', () => {
    let planned = fundedRuntimeFixture(); planned = fixturePlace(planned, 'library.v9', 1);
    initialStrictFallback(planned);
    let automated = createUnregisteredWorldV9('owned-planner');
    automated = fixtureApply(automated, fixtureCommand(automated, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 99 }] } } } }, 'owned.plan'));
    automated = fixtureApply(automated, fixtureCommand(automated, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'owned.enable'));
    initialStrictFallback(automated);
  });
  it('falls back for genuine committed breakthrough progression and its later decision pause', () => {
    let source = fundedRuntimeFixture(); source.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!.cultivation = 120;
    source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm', commandId: 'owned.confirm',
      expectedRevision: source.cultivation.revision, preview: previewBreakthroughV3(source, 'entity:2') } } }, 'owned.confirm'));
    initialStrictFallback(source, 1);
    source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.begin', commandId: 'owned.begin',
      expectedRevision: source.cultivation.revision, attemptId: source.cultivation.attempts[0]!.attemptId } } }, 'owned.begin'));
    initialStrictFallback(atTick(source, MONTH - 1));
  });
});

let heavy: WorldStateV9;
describe('genuine 256-command history stays immutable while idle scalars advance', () => {
  for (let group = 0; group < 4; group++) it(`prepares real heavy-history checkpoint ${group + 1}`, () => {
    if (group === 0) heavy = fundedRuntimeFixture();
    for (let index = group * 64; index < (group + 1) * 64; index++) {
      const id = `owned.heavy.${index}`;
      heavy = fixtureApply(heavy, fixtureCommand(heavy, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
        expectedRevision: heavy.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, id));
    }
    recordChecked(heavy);
  });
  it('matches strict for a twenty-tick heavy-history batch with only one complete source query', () => {
    expect(heavy.cultivation.receipts).toHaveLength(256); const result = equivalent(heavy, 20);
    expect(result.metrics.fullQueries).toBe(1); expect(result.metrics.fastQueries).toBe(20);
    expect(result.world.cultivation.receipts).toEqual(heavy.cultivation.receipts); expect(result.world.cultivation.receipts).not.toBe(heavy.cultivation.receipts);
  });
});

let constructing: WorldStateV9; let library: WorldStateV9; let medicine: WorldStateV9;
describe('all actual paid work owners and maintenance stay on the strict path', () => {
  it('prepares a real construction job, checks its fallback and completes the library', () => {
    constructing = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
    initialStrictFallback(constructing);
    library = fixtureUntil(constructing, value => !!value.sectExpansion.construction.jobs[0]!.terminal);
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`prepares real research stock checkpoint ${index + 1}`, () => {
      library = fixtureProduce(library, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9');
    });
  }
  it('checks an active research owner and completes actual research', () => {
    const researching = fixtureResearchStart(library); initialStrictFallback(researching);
    library = fixtureUntil(researching, value => !!value.sectExpansion.research.jobs[0]!.terminal);
  });
  it('builds alchemy and produces an actual wound-powder dose', () => {
    const alchemy = fixtureStartConstruction(fixturePlace(library, 'alchemy.v9', 10));
    medicine = fixtureProduce(fixtureUntil(alchemy, value => !!value.sectExpansion.construction.jobs.at(-1)!.terminal), 'craft.wound-powder.v9');
  });
  it('falls back for care, sect production and legacy production owners', () => {
    initialStrictFallback(fixtureCareStart(medicine));
    const sect = fixtureApply(medicine, fixtureSectCommand(medicine, { domain: 'production', command: { kind: 'production.start', commandId: 'owned.sect',
      expectedRevision: medicine.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    initialStrictFallback(sect);
    const legacy = fixtureApply(medicine, fixtureCommand(medicine, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'owned.legacy'));
    initialStrictFallback(legacy);
  });
  it('hands a due maintenance payment to strict even though no worker is active', () => {
    let source = medicine;
    for (let index = 0; index < 1300; index++) {
      const next = prepareNormalTickCandidateV9(source);
      if (next.sectExpansion.maintenance.payments.length > source.sectExpansion.maintenance.payments.length) break;
      source = next;
    }
    recordChecked(source); const result = initialStrictFallback(source, 1);
    expect(result.metrics.fastQueries).toBe(0); expect(result.world.sectExpansion.maintenance.payments.length).toBeGreaterThan(source.sectExpansion.maintenance.payments.length);
  });
});

describe('untrusted input never establishes owned-idle authority', () => {
  for (const frozen of [false, true]) it(`rejects nested accessors before execution with shallow-frozen root=${frozen}`, () => {
    const source = createUnregisteredWorldV9(`owned-getter-${frozen}`); let reads = 0;
    Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } });
    if (frozen) Object.freeze(source);
    const strict = advanceCapacityLimitedTicksV9(source, 1); const result = advanceIdleCapacityLimitedTicksV9(source, 1);
    expect(result.world).toBe(source); expect(result.stopped?.kind).toBe(strict.stopped?.kind); expect(result.metrics.fastQueries).toBe(0); expect(reads).toBe(0);
  });
  it('does not reuse a shallow-frozen caller with mutable children after those children change', () => {
    const source = createUnregisteredWorldV9('owned-borrowed'); Object.freeze(source);
    expect(equivalent(source, 1).metrics.fastQueries).toBe(1);
    // Deliberately adversarial mutable JSON boundary, despite the domain's readonly type.
    expect(Reflect.set(source.sectExpansion.stock['wound-powder'], 'owned', 1)).toBe(true); // No paid source; root identity is unchanged.
    const result = equivalent(source, 1); expect(result.stopped?.kind).toBe('invalid-records'); expect(result.metrics.fastQueries).toBe(0);
  });
  it('validates recursively frozen caller history instead of treating Object.isFrozen as authority', () => {
    const source = createUnregisteredWorldV9('owned-frozen-forgery'); source.cultivation.revision++; freezeTree(source);
    const result = equivalent(source, 1); expect(result.stopped?.kind).toBe('invalid-records'); expect(result.metrics.fastQueries).toBe(0);
  });
  it('preserves a legal nested clock extension through strict fallback without changing the validator contract', () => {
    const source = createUnregisteredWorldV9('owned-clock-extension');
    Object.defineProperty(source.clock, 'other', { enumerable: true, value: 0 });
    const result = initialStrictFallback(source, 1); expect(result.stopped).toBeNull();
    expect(result.world.clock.simulationTick).toBe(1); expect(Reflect.get(result.world.clock, 'other')).toBe(0);
  });
  for (const kind of ['symbol', 'hidden', 'sparse', 'foreign-prototype'] as const) it(`rejects ${kind} shape without advancing`, () => {
    const source = createUnregisteredWorldV9(`owned-shape-${kind}`);
    if (kind === 'symbol') Object.defineProperty(source.clock, Symbol('bad'), { value: 0 });
    else if (kind === 'hidden') Object.defineProperty(source.clock, 'hidden', { value: 0 });
    else if (kind === 'sparse') source.diagnostics.length = 1;
    else Object.setPrototypeOf(source.clock, null);
    const strict = advanceCapacityLimitedTicksV9(source, 1); const result = advanceIdleCapacityLimitedTicksV9(source, 1);
    expect(result.world).toBe(source); expect(result.stopped?.kind).toBe(strict.stopped?.kind); expect(result.stopped?.kind).toBe('invalid-records'); expect(result.metrics.fastQueries).toBe(0);
  });
  it('rejects command descriptors before getter execution and preserves invalid steps behavior', () => {
    const source = createUnregisteredWorldV9('owned-command-getter'); let reads = 0; const commands: CommandV9[] = [];
    Object.defineProperty(commands, '0', { enumerable: true, get() { reads++; return {}; } });
    const result = advanceIdleCapacityLimitedTicksV9(source, 1, commands);
    expect(result.world).toBe(source); expect(result.stopped?.kind).toBe('invalid-records'); expect(reads).toBe(0);
    for (const steps of [-1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => advanceIdleCapacityLimitedTicksV9(source, steps)).toThrow(RangeError);
  });
  it('never reads a commands Proxy length that can install a getter after World authentication', () => {
    const source = createUnregisteredWorldV9('owned-reentrant-length'); const expected = advanceCapacityLimitedTicksV9(cloneJson(source), 1);
    let reads = 0; let lengthReads = 0;
    const commands = new Proxy([] as CommandV9[], { get(target, key, receiver) {
      if (key === 'length') {
        lengthReads++;
        Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } });
      }
      return Reflect.get(target, key, receiver);
    } });
    const result = advanceIdleCapacityLimitedTicksV9(source, 1, commands);
    expect(result.world).toEqual(expected.world); expect(result.stopped).toEqual(expected.stopped);
    expect(lengthReads).toBe(0); expect(reads).toBe(0); expect(result.metrics.fastQueries).toBe(1);
  });
  it('uses only the detached World after a command reflection trap mutates caller data', () => {
    const source = createUnregisteredWorldV9('owned-reentrant-reflection'); const expected = advanceCapacityLimitedTicksV9(cloneJson(source), 1);
    let reads = 0; let traps = 0;
    const commands = new Proxy([] as CommandV9[], { ownKeys(target) {
      traps++;
      Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, configurable: true, get() { reads++; return 0; } });
      return Reflect.ownKeys(target);
    } });
    const result = advanceIdleCapacityLimitedTicksV9(source, 1, commands);
    expect(traps).toBeGreaterThan(0); expect(reads).toBe(0); expect(result.world).toEqual(expected.world);
    expect(result.stopped).toBeNull(); expect(result.metrics.fastQueries).toBe(1);
  });
  it('does not retry hostile originals through strict when descriptor detachment fails reentrantly', () => {
    const source = createUnregisteredWorldV9('owned-reentrant-rejection'); let reads = 0; let traps = 0;
    const proxy = new Proxy(source, { ownKeys(target) {
      traps++;
      Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, configurable: true, get() { reads++; return 0; } });
      return Reflect.ownKeys(target);
    } });
    const result = advanceIdleCapacityLimitedTicksV9(proxy, 1);
    expect(result.world).toBe(proxy); expect(result.stopped?.kind).toBe('invalid-records');
    expect(result.metrics.fullQueries).toBe(0); expect(reads).toBe(0); expect(traps).toBe(1);
  });
  for (const kind of ['message-getter', 'exception-proxy'] as const) it(`does not inspect a reflection trap's thrown ${kind}`, () => {
    const source = createUnregisteredWorldV9(`owned-thrown-${kind}`); let reads = 0;
    const error = new Error('untrusted');
    Object.defineProperty(error, 'message', { get() { reads++; throw new Error('Message getter must not run'); } });
    const thrown = kind === 'exception-proxy' ? new Proxy(error, {
      getPrototypeOf() { reads++; throw new Error('Exception prototype must not be inspected'); },
      get() { reads++; throw new Error('Exception properties must not be read'); },
    }) : error;
    const proxy = new Proxy(source, { ownKeys() { throw thrown; } });
    const result = advanceIdleCapacityLimitedTicksV9(proxy, 1);
    expect(result.world).toBe(proxy); expect(result.stopped).toEqual({ kind: 'invalid-records', details: ['Invalid external v9 JSON data'] });
    expect(result.metrics.fullQueries).toBe(0); expect(reads).toBe(0);
  });
  it('preserves the authentic clock-cap atomic stop without trusting constructed row counts alone', () => {
    let world = prepareNormalTickCandidateV9(atTick(birthday(createUnregisteredWorldV9('owned-clock-cap'), MONTH, true, true), MONTH - 1));
    for (const death of [...world.cultivation.pendingDeaths]) {
      const id = `owned.finalize.${death.discipleId}`;
      world = fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: id,
        expectedRevision: world.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, id));
    }
    // Explicit bounded history-pressure fixture after genuine deaths/archives.
    // Event-free all-deceased rows are arithmetic, not 9.8 million played ticks.
    world = cloneJson(world);
    for (let month = 2; month <= V9_CULTIVATION_CLOCK_LIMIT; month++) world.cultivationClock.transitions.push({ kind: 'month', tick: month * MONTH,
      beforeRevision: world.cultivation.revision++, rootActionId: `action:${world.sequences.nextAction++}` });
    world.cultivation.calendarMonth = V9_CULTIVATION_CLOCK_LIMIT;
    world = atTick(world, (V9_CULTIVATION_CLOCK_LIMIT + 1) * MONTH - 1);
    const result = equivalent(world, 1); expect(result.world).toBe(world); expect(result.stopped?.kind).toBe('capacity'); expect(result.metrics.fastQueries).toBe(0);
  });
});
