import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import { tickProduction } from '../../src/core/economy/production';
import type { ProductionTransaction } from '../../src/core/economy/types';
import { dispatchCommand } from '../../src/core/kernel/commands';
import type { Command, DomainEvent } from '../../src/core/kernel/contracts';
import { allocateId } from '../../src/core/kernel/ids';
import { createSaveEnvelope, MAX_SAVE_CHARACTERS, serializeSave } from '../../src/core/kernel/save';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceTicks } from '../../src/core/kernel/simulation';
import { validateWorldState } from '../../src/core/kernel/validation';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldState } from '../../src/core/world/types';
import { MAX_SAVE_FILE_BYTES, parseSaveFile } from '../../src/platform/files/save-files';

const SEED = 'save-growth-review-v4';
const METADATA = { buildId: 'save-growth-review-v4', savedAt: '2026-10-01T00:00:00.000Z' };
const SYNTHETIC_SIZES = [0, 100, 1_000, 2_500, 5_000, 10_000];
const ACTUAL_SIZES = new Set([0, 1, 10, 100]);
const MAX_TICKS_PER_JOB = 600;
const SAMPLES = 3;
const MICRO_ITERATIONS = 64;
const FULL_TICKS = 40;
let observed = 0;

function command(world: WorldState, commandId: string): Command {
  return { commandId, sequence: 0, issuedTick: world.clock.simulationTick,
    kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } };
}

function start(world: WorldState, commandId: string): { world: WorldState; id: string } {
  const started = dispatchCommand(world, command(world, commandId));
  if (started.result.status !== 'accepted' || !started.result.transactionId) throw new Error(`Cannot start benchmark job: ${JSON.stringify(started.result)}`);
  return { world: started.world, id: started.result.transactionId };
}

function finishOne(world: WorldState, commandId: string): WorldState {
  const started = start(world, commandId);
  let next = started.world;
  for (let tick = 0; tick < MAX_TICKS_PER_JOB && next.activeProductionTransactionIds.length; tick += 1) next = advanceTicks(next, 1);
  if (next.transactions[started.id]?.state !== 'Committed') throw new Error(`Benchmark job did not commit within ${MAX_TICKS_PER_JOB} ticks`);
  return next;
}

function workingBoundary(world: WorldState): WorldState {
  const started = start(world, 'bench.active');
  let next = started.world;
  for (let tick = 0; tick < MAX_TICKS_PER_JOB; tick += 1) {
    if (next.transactions[started.id]?.phase === 'Working') return next;
    next = advanceTicks(next, 1);
  }
  throw new Error('Benchmark worker did not reach its station');
}

/** A valid shape stress fixture, NOT a causally simulated economic history.
 * Copies one genuinely committed job with fresh owned IDs; deliberately keeps
 * its resource ledger and elapsed time fixed to isolate history collection size.
 */
function syntheticHistory(template: WorldState, historyCount: number): WorldState {
  const terminal = Object.values(template.transactions)[0]!;
  const reservation = template.reservations[terminal.reservationId]!;
  const startedEvent = template.events.find(event => event.kind === 'production.started')!;
  const endedEvent = template.events.find(event => event.eventId === terminal.resultEventId)!;
  const fingerprint = template.commandReceipts[terminal.commandId]!.fingerprint;
  const world = cloneJson(template);
  world.transactions = {}; world.reservations = {}; world.commandReceipts = {}; world.events = [];
  world.activeProductionTransactionIds = [];
  function id(kind: 'instance' | 'event' | 'action'): string {
    const result = allocateId(world.sequences, kind); world.sequences = result.sequences; return result.id;
  }
  for (let index = 0; index < historyCount; index += 1) {
    const transactionId = id('instance'); const reservationId = id('instance'); const rootActionId = id('action');
    const firstEventId = id('event'); const resultEventId = id('event'); const commandId = `bench.history.${index}`;
    const transaction: ProductionTransaction = { ...terminal, transactionId, reservationId, rootActionId, commandId, resultEventId };
    world.transactions[transactionId] = transaction;
    world.reservations[reservationId] = { ...reservation, reservationId, ownerTransactionId: transactionId };
    const remap = (event: DomainEvent, eventId: string): DomainEvent => ({ ...event, eventId, rootActionId, payload: { ...event.payload, transactionId } });
    world.events.push(remap(startedEvent, firstEventId), remap(endedEvent, resultEventId));
    world.commandReceipts[commandId] = { commandId, fingerprint, result: {
      commandId, status: 'accepted', transactionId, eventIds: [firstEventId], rejection: null,
    } };
  }
  return world;
}

function measure<T>(fn: () => T, count = SAMPLES): { medianMs: number; maxMs: number; samplesMs: number[]; value: T } {
  const samplesMs: number[] = [];
  let value!: T;
  for (let index = 0; index < count; index += 1) {
    const before = performance.now(); value = fn(); samplesMs.push(performance.now() - before);
  }
  const ordered = [...samplesMs].sort((a, b) => a - b);
  return { medianMs: ordered[Math.floor(ordered.length / 2)]!, maxMs: ordered.at(-1)!, samplesMs, value };
}

function timing<T>({ value: _value, ...result }: ReturnType<typeof measure<T>>) { return result; }
function bytes(value: unknown): number { return Buffer.byteLength(canonicalStringify(value), 'utf8'); }

function measureWorld(world: WorldState, kind: 'actual-simulation' | 'synthetic-history', historyCount: number) {
  const validation = measure(() => validateWorldState(world));
  expect(validation.value).toEqual([]);
  const snapshot = measure(() => createSaveEnvelope(world, METADATA));
  const encoding = measure(() => serializeSave(snapshot.value));
  const text = encoding.value;
  const fileBytes = Buffer.byteLength(text, 'utf8');
  const parsing = measure(() => parseSaveFile(text));
  const overLimit = fileBytes > MAX_SAVE_FILE_BYTES || text.length > MAX_SAVE_CHARACTERS;
  expect(parsing.value.ok).toBe(!overLimit);
  if (!parsing.value.ok) expect(parsing.value.error.code).toBe('TOO_LARGE');
  const duplicate = historyCount ? Object.values(world.commandReceipts).find(receipt => receipt.result.transactionId !== null) : undefined;
  const duplicateTiming = duplicate ? measure(() => dispatchCommand(world, command(world, duplicate.commandId))) : null;
  if (duplicateTiming && duplicate) expect(duplicateTiming.value.result).toEqual(duplicate.result);
  const active = workingBoundary(world);
  expect(validateWorldState(active)).toEqual([]);
  // Warm only the tick kernels; snapshot samples include their normal allocations.
  for (let index = 0; index < 8; index += 1) observed += tickProduction(active).transactions[active.activeProductionTransactionIds[0]!]!.activeTicks;
  const production = measure(() => {
    for (let index = 0; index < MICRO_ITERATIONS; index += 1) {
      const next = tickProduction(active);
      observed += next.transactions[next.activeProductionTransactionIds[0]!]!.activeTicks;
    }
  });
  const fullTick = measure(() => advanceTicks(active, FULL_TICKS));
  expect(fullTick.value.clock.simulationTick - active.clock.simulationTick).toBe(FULL_TICKS);
  expect(fullTick.value.activeProductionTransactionIds.length).toBe(1);
  const report = {
    kind, historyCount, simulationTick: world.clock.simulationTick, woodOwned: world.inventory.wood.owned,
    fileBytes, characters: text.length, overLimit, parseResult: parsing.value.ok ? 'ok' : parsing.value.error.code,
    branchBytes: { transactions: bytes(world.transactions), reservations: bytes(world.reservations), commandReceipts: bytes(world.commandReceipts), events: bytes(world.events), builds: bytes(world.builds), cultivation: bytes(world.cultivation) },
    validate: timing(validation), createEnvelope: timing(snapshot), serialize: timing(encoding), parseFile: timing(parsing),
    productionTickMedianMs: production.medianMs / MICRO_ITERATIONS,
    fullTickMedianMs: fullTick.medianMs / FULL_TICKS,
    duplicateCommandMedianMs: duplicateTiming?.medianMs ?? null,
  };
  console.log(`SAVE_GROWTH_ROW ${JSON.stringify(report)}`);
  return report;
}

test('report bounded v4 save growth and production costs; timings are observations, not pass thresholds', () => {
  console.log(`SAVE_GROWTH_ENV ${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, seed: SEED, syntheticSizes: SYNTHETIC_SIZES, actualSizes: [...ACTUAL_SIZES], samples: SAMPLES, microIterations: MICRO_ITERATIONS, fullTicks: FULL_TICKS, maxTicksPerActualJob: MAX_TICKS_PER_JOB, byteLimit: MAX_SAVE_FILE_BYTES })}`);
  let actual = createWorld(SEED);
  measureWorld(actual, 'actual-simulation', 0);
  let template!: WorldState;
  const actualStart = performance.now();
  for (let count = 1; count <= 100; count += 1) {
    actual = finishOne(actual, `bench.actual.${count}`);
    if (count === 1) template = actual;
    if (ACTUAL_SIZES.has(count)) measureWorld(actual, 'actual-simulation', count);
  }
  console.log(`SAVE_GROWTH_ACTUAL ${JSON.stringify({ completedJobs: 100, ticks: actual.clock.simulationTick, generationAndMeasurementsMs: performance.now() - actualStart })}`);
  for (const count of SYNTHETIC_SIZES) measureWorld(syntheticHistory(template, count), 'synthetic-history', count);
  expect(observed).toBeGreaterThan(0);
});
