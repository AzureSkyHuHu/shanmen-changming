import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import * as v5 from '@save-growth-v5/core/kernel/index.ts';
import * as v6 from '@save-growth-current/core/kernel/index.ts';
import { parseSaveFile as parseV5File } from '@save-growth-v5/platform/files/save-files.ts';
import { parseSaveFile as parseV6File, MAX_SAVE_FILE_BYTES } from '@save-growth-current/platform/files/save-files.ts';
import { migrateWorldHistory } from '@save-growth-current/core/world/history-access.ts';
import { iterateArchivedProduction, iterateArchivedCommandReceipts } from '@save-growth-current/core/history/index.ts';

const SEED = 'save-growth-review-v4';
const META = { buildId: 'save-growth-v5-v6-comparison', savedAt: '2026-10-01T00:00:00.000Z' };
const SIZES = [100, 1_000, 2_500, 10_000];
const SAMPLES = 3; const MICRO_ITERATIONS = 64; const FULL_TICKS = 40; const MAX_JOB_TICKS = 600;
let consumed = 0;

function sourceHash(root) {
  const source = join(root, 'src'); const files = [];
  const collect = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path); else if (entry.isFile()) files.push(path);
    }
  };
  collect(source); const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(relative(source, file)).update('\0').update(readFileSync(file)).update('\0');
  return { root, sourceFiles: files.length, sha256: hash.digest('hex'), algorithm: 'sorted src-relative path + NUL + bytes + NUL' };
}
const bytes = value => Buffer.byteLength(v6.canonicalStringify(value), 'utf8');
function measure(fn) {
  const times = []; let value;
  for (let index = 0; index < SAMPLES; index += 1) {
    const start = performance.now(); value = fn(); times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { value, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), samplesMs: times };
}
function timing({ value: _value, ...result }) { return result; }
function command(world, commandId) {
  return { commandId, sequence: 0, issuedTick: world.clock.simulationTick,
    kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } };
}
function lookup(engine, world, id) { return engine === v6 ? engine.lookupProduction(world, id) : world.transactions[id]; }
function startJob(engine, world, commandId) {
  const result = engine.dispatchCommand(world, command(world, commandId));
  if (result.result.status !== 'accepted' || !result.result.transactionId) throw new Error(`Cannot start: ${JSON.stringify(result.result)}`);
  return { world: result.world, id: result.result.transactionId };
}
function finishJob(engine, world, commandId) {
  const started = startJob(engine, world, commandId); let next = started.world;
  for (let tick = 0; tick < MAX_JOB_TICKS && next.activeProductionTransactionIds.length; tick += 1) next = engine.advanceTicks(next, 1);
  if (lookup(engine, next, started.id)?.state !== 'Committed') throw new Error('Job did not settle within bounded tick budget');
  return next;
}
function atWork(engine, world) {
  const started = startJob(engine, world, 'bench.active'); let next = started.world;
  for (let tick = 0; tick < MAX_JOB_TICKS; tick += 1) {
    if (next.transactions[started.id]?.phase === 'Working') return next;
    next = engine.advanceTicks(next, 1);
  }
  throw new Error('Worker did not reach Working boundary');
}
function synthetic(template, count) {
  const terminal = Object.values(template.transactions)[0];
  const reservation = template.reservations[terminal.reservationId];
  const first = template.events.find(event => event.kind === 'production.started');
  const last = template.events.find(event => event.eventId === terminal.resultEventId);
  const fingerprint = template.commandReceipts[terminal.commandId].fingerprint;
  const world = v5.cloneJson(template);
  world.transactions = {}; world.reservations = {}; world.commandReceipts = {}; world.events = []; world.activeProductionTransactionIds = [];
  const id = kind => { const result = v5.allocateId(world.sequences, kind); world.sequences = result.sequences; return result.id; };
  for (let index = 0; index < count; index += 1) {
    const transactionId = id('instance'); const reservationId = id('instance'); const rootActionId = id('action');
    const firstEventId = id('event'); const resultEventId = id('event'); const commandId = `bench.history.${index}`;
    world.transactions[transactionId] = { ...terminal, transactionId, reservationId, rootActionId, commandId, resultEventId };
    world.reservations[reservationId] = { ...reservation, reservationId, ownerTransactionId: transactionId };
    world.events.push({ ...first, eventId: firstEventId, rootActionId, payload: { ...first.payload, transactionId } },
      { ...last, eventId: resultEventId, rootActionId, payload: { ...last.payload, transactionId } });
    world.commandReceipts[commandId] = { commandId, fingerprint, result: { commandId, status: 'accepted', transactionId, eventIds: [firstEventId], rejection: null } };
  }
  return world;
}
// Comparison only, outside timings. Runtime must not construct a full combined history map.
function expandedV6(world) {
  const { history: _history, ...expanded } = world;
  expanded.transactions = { ...world.transactions }; expanded.reservations = { ...world.reservations };
  expanded.commandReceipts = { ...world.commandReceipts };
  for (const record of iterateArchivedProduction(world.history)) {
    expanded.transactions[record.transaction.transactionId] = record.transaction;
    expanded.reservations[record.reservation.reservationId] = record.reservation;
  }
  for (const record of iterateArchivedCommandReceipts(world.history)) expanded.commandReceipts[record.commandId] = record;
  expanded.events = v6.worldEventsSince(world, 0); expanded.simulationVersion = 'semantic-comparison';
  return expanded;
}
const semanticV5 = world => v5.canonicalStringify({ ...world, simulationVersion: 'semantic-comparison' });
function assertSameFacts(legacy, current) { expect(v6.canonicalStringify(expandedV6(current))).toBe(semanticV5(legacy)); }

function measureWorld(engine, world, kind, historyCount) {
  const version = engine === v5 ? 'v5' : 'v6'; const parse = engine === v5 ? parseV5File : parseV6File;
  const validation = measure(() => engine.validateWorldState(world)); expect(validation.value).toEqual([]);
  const envelope = measure(() => engine.createSaveEnvelope(world, META));
  const encoding = measure(() => engine.serializeSave(envelope.value));
  const text = encoding.value; const fileBytes = Buffer.byteLength(text, 'utf8');
  const parsing = measure(() => parse(text));
  if (fileBytes > MAX_SAVE_FILE_BYTES) { expect(parsing.value.ok).toBe(false); expect(parsing.value.error.code).toBe('TOO_LARGE'); }
  else expect(parsing.value.ok).toBe(true);
  if (version === 'v6') {
    expect(parsing.value.ok).toBe(true);
    expect(v6.canonicalStringify(expandedV6(parsing.value.world))).toBe(v6.canonicalStringify(expandedV6(world)));
  }
  const active = atWork(engine, world); expect(engine.validateWorldState(active)).toEqual([]);
  const history = active.history;
  if (version === 'v6') expect(engine.tickProduction(active).history).toBe(history);
  for (let index = 0; index < 8; index += 1) consumed += engine.tickProduction(active).transactions[active.activeProductionTransactionIds[0]].activeTicks;
  const production = measure(() => {
    for (let index = 0; index < MICRO_ITERATIONS; index += 1) {
      const next = engine.tickProduction(active); consumed += next.transactions[next.activeProductionTransactionIds[0]].activeTicks;
    }
  });
  const whole = measure(() => engine.advanceTicks(active, FULL_TICKS));
  expect(whole.value.clock.simulationTick - active.clock.simulationTick).toBe(FULL_TICKS);
  expect(whole.value.activeProductionTransactionIds).toHaveLength(1);
  if (version === 'v6') expect(whole.value.history).toBe(history);
  const report = { version, kind, historyCount, simulationTick: world.clock.simulationTick, woodOwned: world.inventory.wood.owned,
    fileBytes, characters: text.length, parseResult: parsing.value.ok ? 'ok' : parsing.value.error.code,
    counts: { liveTransactions: Object.keys(world.transactions).length, liveReservations: Object.keys(world.reservations).length,
      recentReceipts: Object.keys(world.commandReceipts).length, recentEvents: world.events.length,
      archivedProduction: world.history?.production.count ?? 0, archivedReceipts: world.history?.commandReceipts.count ?? 0,
      archivedEvents: world.history?.events.count ?? 0 }, historyBytes: world.history ? bytes(world.history) : null,
    validate: timing(validation), createEnvelope: timing(envelope), serialize: timing(encoding), parseFile: timing(parsing),
    productionTickMedianMs: production.medianMs / MICRO_ITERATIONS, fullTickMedianMs: whole.medianMs / FULL_TICKS,
    ordinaryTickPreservesArchiveIdentity: version === 'v6' ? true : null };
  console.log(`SAVE_GROWTH_V6_ROW ${JSON.stringify(report)}`); return { report, text };
}

function migrateAndCheck(legacy, text, kind, historyCount) {
  expect(v5.validateWorldState(legacy)).toEqual([]); const original = v5.canonicalStringify(legacy);
  const sourceBytes = Buffer.byteLength(text, 'utf8'); let migration; let route;
  if (sourceBytes <= MAX_SAVE_FILE_BYTES) {
    route = 'public-v5-file-import';
    migration = measure(() => {
      const result = parseV6File(text);
      if (!result.ok) throw new Error(`Public migration failed: ${JSON.stringify(result.error)}`);
      expect(result.migration?.sourceSaveVersion).toBe(5); return v6.restoreWorldHistory(result.world);
    });
  } else {
    const refused = parseV6File(text); expect(refused.ok).toBe(false); expect(refused.error.code).toBe('TOO_LARGE');
    route = 'validated-in-memory-stress-migration-not-file-import';
    migration = measure(() => v6.restoreWorldHistory(migrateWorldHistory(legacy)));
  }
  const current = migration.value;
  expect(v6.validateWorldState(current)).toEqual([]); expect(v6.restoreWorldHistory(current)).toBe(current);
  assertSameFacts(legacy, current); expect(v5.canonicalStringify(legacy)).toBe(original);
  const records = Object.values(legacy.transactions);
  for (const index of [...new Set([0, Math.floor(records.length / 2), records.length - 1])]) {
    const record = records[index]; if (!record) continue;
    const replay = v6.dispatchCommand(current, command(current, record.commandId));
    expect(replay.result).toEqual(legacy.commandReceipts[record.commandId].result); expect(replay.world).toBe(current);
    const changed = command(current, record.commandId); changed.payload.recipeId = 'gather.herbs';
    expect(v6.dispatchCommand(current, changed).result.rejection?.code).toBe('COMMAND_CONFLICT');
    const terminal = v6.completeProduction(current, record.transactionId);
    expect(terminal.ok).toBe(true); expect(terminal.world).toBe(current); expect(terminal.eventIds).toEqual([record.resultEventId]);
    expect(v6.cancelProduction(current, record.transactionId)).toEqual({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
  }
  console.log(`SAVE_GROWTH_V6_MIGRATION ${JSON.stringify({ kind, historyCount, sourceBytes, route, timing: timing(migration),
    exactSemanticProjectionPreserved: true, originalSourcePreserved: true, sampledOriginalReceiptsAndTerminalRetriesPreserved: true })}`);
  return current;
}

test('compare frozen v5 and v6 history without accepting oversize legacy files', () => {
  expect(v5.SAVE_VERSION).toBe(5); expect(v5.SIMULATION_VERSION).toBe('0.5.0');
  expect(v6.SAVE_VERSION).toBe(6); expect(v6.SIMULATION_VERSION).toBe('0.6.0');
  console.log(`SAVE_GROWTH_V6_ENV ${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, seed: SEED, sizes: SIZES, samples: SAMPLES, microIterations: MICRO_ITERATIONS, fullTicks: FULL_TICKS,
    legacy: sourceHash(process.env.SAVE_GROWTH_V5_ROOT), current: sourceHash(process.env.SAVE_GROWTH_CURRENT_ROOT) })}`);
  let actualV5 = v5.createWorld(SEED); let actualV6 = v6.createWorld(SEED); let template;
  for (let count = 1; count <= 100; count += 1) {
    actualV5 = finishJob(v5, actualV5, `bench.actual.${count}`); actualV6 = finishJob(v6, actualV6, `bench.actual.${count}`);
    if (count === 1) template = actualV5;
  }
  assertSameFacts(actualV5, actualV6);
  const oldActual = measureWorld(v5, actualV5, 'actual-simulation', 100);
  assertSameFacts(actualV5, migrateAndCheck(actualV5, oldActual.text, 'actual-simulation', 100));
  measureWorld(v6, actualV6, 'actual-simulation', 100);
  const comparisons = [];
  for (const count of SIZES) {
    const legacy = synthetic(template, count); const old = measureWorld(v5, legacy, 'synthetic-history', count);
    const current = migrateAndCheck(legacy, old.text, 'synthetic-history', count);
    const modern = measureWorld(v6, current, 'synthetic-history', count);
    comparisons.push({ jobs: count, v5Bytes: old.report.fileBytes, v6Bytes: modern.report.fileBytes,
      byteFraction: modern.report.fileBytes / old.report.fileBytes, v5WorkingTickMs: old.report.productionTickMedianMs,
      v6WorkingTickMs: modern.report.productionTickMedianMs, v5FullTickMs: old.report.fullTickMedianMs, v6FullTickMs: modern.report.fullTickMedianMs });
  }
  const first = comparisons[0]; const last = comparisons.at(-1);
  console.log(`SAVE_GROWTH_V6_COMPARISON ${JSON.stringify({ rows: comparisons,
    current100To10000WorkingTickRatio: last.v6WorkingTickMs / first.v6WorkingTickMs,
    current100To10000FullTickRatio: last.v6FullTickMs / first.v6FullTickMs,
    timingThresholdsAsserted: false, archiveIdentityAsserted: true })}`);
  expect(consumed).toBeGreaterThan(0);
});
