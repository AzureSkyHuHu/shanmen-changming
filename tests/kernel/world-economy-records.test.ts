import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import provenance from '../integration/fixtures/save-v7-campaign-provenance.json';
import { beforeAll, describe, expect, it } from 'vitest';
import * as current from '../../src/core/kernel/validation';
import * as frozen from './fixtures/pre-extraction-world-validation';
import * as publicKernel from '../../src/core/kernel';
import { closeLegacyWorldEconomyReservations, closeWorldEconomyOwnerLinks, inspectWorldEconomyRecords,
  type WorldEconomyRecords } from '../../src/core/kernel/world-economy-records';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { createSaveEnvelope, parseSave, serializeSave } from '../../src/core/kernel/save';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { CALENDAR_TICKS_PER_MONTH, tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { cancelProduction, completeProduction, startProduction, tickProduction } from '../../src/core/economy/production';
import { iterateArchivedProduction, restoreHistoryArchive } from '../../src/core/history';
import { recordWorldReceipt } from '../../src/core/world/history-access';
import { advanceWorldCultivationV8, dispatchWorldCultivationV8 } from '../../src/core/world/cultivation-bridge-v8';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import type { WorldState } from '../../src/core/world/types';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

type World = WorldState | WorldStateV8;
type Version = 7 | 8;
const metadata = { buildId: 'economy-record-extraction', savedAt: '2026-10-02T00:00:00.000Z' };
const fixture = (file: string): unknown => (JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as { payload: unknown }).payload;
const validators = {
  7: { current: current.validateWorldState, frozen: frozen.validateWorldState },
  8: { current: current.validateWorldStateV8, frozen: frozen.validateWorldStateV8 },
};
function equivalent(world: World, version: Version, expected?: string[]) {
  const before = canonicalStringify(world);
  const prior = validators[version].frozen(world);
  if (expected) expect(prior).toEqual(expected);
  expect(validators[version].current(world)).toEqual(prior);
  expect(canonicalStringify(world)).toBe(before);
}
function begin<W extends World>(world: W, commandId = 'record.start', workerId = 'entity:2'): W {
  const payload = { recipeId: 'craft.plank', workerId };
  const result = startProduction(world, commandId, payload.recipeId, payload.workerId);
  if (!result.ok) throw new Error(result.rejection.code);
  return recordWorldReceipt(result.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.start', payload }),
    result: { commandId, status: 'accepted', transactionId: result.transactionId, eventIds: result.eventIds, rejection: null } });
}
function cancel<W extends World>(world: W, transactionId: string, commandId = 'record.cancel'): W {
  const result = cancelProduction(world, transactionId, { commandId });
  if (!result.ok) throw new Error(result.rejection.code);
  return recordWorldReceipt(result.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId } }),
    result: { commandId, status: 'accepted', transactionId: result.transactionId, eventIds: result.eventIds, rejection: null } });
}
function retryCancel(world: World, transactionId: string, commandId = 'record.cancel'): World {
  const command = { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'production.cancel' as const, payload: { transactionId } };
  const result = 'campaign' in world ? dispatchCommandV8(world, command) : publicKernel.dispatchCommand(world, command);
  expect(result.result.status).toBe('accepted'); expect(result.world).toBe(world);
  return result.world;
}
function steps<W extends World>(world: W, count: number): W {
  for (let tick = 0; tick < count; tick++) world = tickProduction({ ...world, clock: tickClock(world.clock) });
  return world;
}
function finish<W extends World>(world: W): W {
  for (let n = 0; n < 800 && world.activeProductionTransactionIds.length; n++) world = steps(world, 1);
  expect(world.activeProductionTransactionIds).toEqual([]);
  return world;
}
function first(world: World) {
  const transaction = Object.values(world.transactions)[0]!;
  return { transaction, reservation: world.reservations[transaction.reservationId]! };
}
function orphan(world: World, ownerTransactionId = 'instance:900000', lines = [] as { resourceId: 'wood'; quantity: number }[]) {
  const reservationId = `instance:${world.sequences.nextInstance++}`;
  world.reservations[reservationId] = { reservationId, ownerTransactionId, state: 'reserved', lines };
  return reservationId;
}
const sources: Record<Version, World> = { 7: createWorld('record-source-v7'), 8: createWorldV8('record-source-v8') };
const started = {} as Record<Version, World>;
const completed = {} as Record<Version, World>;
beforeAll(() => {
  for (const version of [7, 8] as const) {
    started[version] = begin(sources[version]); completed[version] = finish(started[version]);
  }
});

describe('frozen whole-validator equivalence across genuine historical Worlds', () => {
  it.each([
    ['v1 live work', '../agents/fixtures/save-v1-in-progress.json', 'validateLegacyWorldStateV1'],
    ['v2 live work', '../integration/fixtures/save-v2-in-progress.json', 'validateLegacyWorldStateV2'],
    ['v3 breakthrough and work', '../integration/fixtures/save-v3-in-progress.json', 'validateLegacyWorldStateV3'],
    ['v3 no identities', '../integration/fixtures/save-v3-empty-archive.json', 'validateLegacyWorldStateV3'],
    ['v4 active battle', '../integration/fixtures/save-v4-active-battle.json', 'validateLegacyWorldStateV4'],
    ['v5 terminal and active work', '../integration/fixtures/save-v5-mixed-history.json', 'validateLegacyWorldStateV5'],
    ['v6 archive', '../integration/fixtures/save-v6-before-automatic-work.json', 'validateLegacyWorldStateV6'],
  ] as const)('preserves %s without relabeling or regenerating its source', (_name, path, validator) => {
    const world = fixture(path); const before = canonicalStringify(world);
    expect(frozen[validator](world)).toEqual([]); expect(current[validator](world)).toEqual([]);
    expect(canonicalStringify(world)).toBe(before);
  });
  it('uses the provenance manifest to authenticate the four genuine v7 source files', () => {
    expect(provenance.fixtures).toHaveLength(4);
    for (const source of provenance.fixtures) {
      const bytes = readFileSync(new URL(`../integration/fixtures/${source.filename}`, import.meta.url));
      expect(bytes.byteLength).toBe(source.bytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    }
  });
  it.each(['active-automatic', 'active-battle', 'awaiting-choice', 'ended-clear'])('preserves real v7 %s and its explicit v8 migration', name => {
    const world = fixture(`../integration/fixtures/save-v7-${name}.json`);
    expect(frozen.validateWorldState(world)).toEqual([]); expect(current.validateLegacyWorldStateV7(world)).toEqual([]);
    const migrated = migrateWorldV7ToV8(world);
    equivalent(migrated, 8, []);
  });
  it('keeps genuine cultivation and manual-production reservations additive through v7 and v8 migration', () => {
    const result = parseSave(readFileSync(new URL('../integration/fixtures/save-v3-in-progress.json', import.meta.url), 'utf8'));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.world.inventory.herbs.reserved).toBe(2); expect(result.world.inventory.wood.reserved).toBe(3);
    equivalent(result.world, 7, []); equivalent(migrateWorldV7ToV8(result.world), 8, []);
    const changed = cloneJson(result.world); changed.inventory.herbs.reserved++;
    equivalent(changed, 7, ['Reservation totals do not match inventory']);
  });
});

describe.each([7, 8] as const)('v%s exact record/owner/error contract', version => {
  it('retains whole-World validation at each real movement/work/settlement phase and input immutability', () => {
    let world = started[version]; const phases = new Set<string>();
    for (let n = 0; n < 800 && world.activeProductionTransactionIds.length; n++) {
      const transaction = first(world).transaction;
      if (!phases.has(transaction.phase) || transaction.activeTicks === transaction.requiredTicks) {
        equivalent(world, version, []); phases.add(transaction.phase);
      }
      world = steps(world, 1);
    }
    expect(world.activeProductionTransactionIds).toEqual([]);
    expect(phases).toEqual(new Set(['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery']));
    expect(world.history.production.count).toBe(1); expect(world.inventory.plank.owned).toBe(2);
    equivalent(world, version, []);
  });
  it.each([0, 7, 40, 110])('keeps cancellation at tick %s, exact retry, real position and saved reload', tick => {
    const world = steps(started[version], tick); const transactionId = world.activeProductionTransactionIds[0]!;
    const before = canonicalStringify(world); const position = world.disciples[1]!.position;
    const cancelled = cancel(world, transactionId);
    expect(cancelled.inventory.wood.owned).toBe(world.inventory.wood.owned); expect(cancelled.inventory.wood.reserved).toBe(0);
    expect(cancelled.disciples[1]!.position).toEqual(position); expect(cancelled.history.production.count).toBe(1);
    expect(canonicalStringify(retryCancel(cancelled, transactionId))).toBe(canonicalStringify(cancelled));
    expect(canonicalStringify(world)).toBe(before); equivalent(cancelled, version, []);
    // The version discriminator narrows real versioned fixtures; it does not reinterpret a World.
    if ('campaign' in cancelled) {
      const loaded = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(cancelled, metadata)));
      expect(loaded.ok).toBe(true); if (loaded.ok) equivalent(loaded.world, 8, []);
    } else {
      const loaded = parseSave(serializeSave(createSaveEnvelope(cancelled, metadata)));
      expect(loaded.ok).toBe(true); if (loaded.ok) equivalent(loaded.world, 7, []);
    }
  });
  const cases: { name: string; mutate: (world: World) => void; error: string }[] = [
    { name: 'unexplained balance', mutate: w => { w.inventory.wood.reserved++; }, error: 'Reservation totals do not match inventory' },
    { name: 'missing reservation', mutate: w => { delete w.reservations[first(w).reservation.reservationId]; }, error: 'Invalid transaction references' },
    { name: 'wrong owner before totals', mutate: w => { first(w).reservation.ownerTransactionId = 'instance:999'; w.inventory.wood.reserved++; }, error: 'Invalid transaction references' },
    { name: 'changed recipe price before totals', mutate: w => { first(w).reservation.lines[0]!.quantity++; }, error: 'Reservation does not match locked recipe inputs' },
    { name: 'duplicate resource rows before invalid transaction', mutate: w => { first(w).reservation.lines.push({ ...first(w).reservation.lines[0]! }); first(w).transaction.activeTicks = -1; }, error: 'Invalid reservation' },
    { name: 'unknown sect resource before total', mutate: w => { Object.assign(first(w).reservation.lines[0]!, { resourceId: 'wound-powder' }); }, error: 'Invalid reservation' },
    { name: 'tagged old input cannot become expansion input', mutate: w => { Object.assign(first(w).reservation.lines[0]!, { ledger: 'base' }); }, error: 'Reservation does not match locked recipe inputs' },
    { name: 'v9 recipe remains unsupported', mutate: w => { first(w).transaction.recipeId = 'gather.stone.v9'; }, error: 'Invalid production transaction' },
    { name: 'malformed record before total', mutate: w => { first(w).transaction.requiredTicks = -1; w.inventory.wood.reserved++; }, error: 'Invalid production transaction' },
    { name: 'orphan zero-cost claim', mutate: w => { orphan(w); }, error: 'Orphaned reservation' },
    { name: 'totals before orphan and events', mutate: w => { orphan(w); w.inventory.wood.reserved++; w.events[0] = { ...w.events[0]!, tick: -1 }; }, error: 'Reservation totals do not match inventory' },
    { name: 'reverse owner alias cannot double-claim', mutate: w => { orphan(w, first(w).transaction.transactionId, [{ resourceId: 'wood', quantity: 3 }]); w.inventory.wood.reserved += 3; }, error: 'Reservation ownership is not bidirectional' },
    { name: 'duplicate instance before owner closure', mutate: w => { const id = w.builds.equipment[0]!.instanceId; w.reservations[id] = { reservationId: id, ownerTransactionId: 'instance:999', state: 'reserved', lines: [] }; }, error: 'Invalid instance sequence continuity' },
    { name: 'next instance boundary before total', mutate: w => { w.sequences.nextInstance = Number(first(w).reservation.reservationId.slice('instance:'.length)); w.inventory.wood.reserved++; }, error: 'Invalid instance sequence continuity' },
    { name: 'active index mismatch before total', mutate: w => { w.activeProductionTransactionIds = []; w.inventory.wood.reserved++; }, error: 'Active production index does not match transactions' },
    { name: 'orphan before unrelated assignment', mutate: w => { orphan(w); w.disciples[2]!.assignmentTransactionId = 'instance:999'; }, error: 'Orphaned reservation' },
    { name: 'assignment before missing active job', mutate: w => { w.disciples[2]!.assignmentTransactionId = 'instance:999'; w.activeProductionTransactionIds.push('instance:999'); }, error: 'Invalid disciple assignment' },
    { name: 'missing active job before station ownership', mutate: w => { w.activeProductionTransactionIds.push('instance:999'); w.buildings[0]!.stationTransactionId = 'instance:999'; }, error: 'Active production index references a missing job' },
    { name: 'station ownership before event syntax', mutate: w => { w.buildings[0]!.stationTransactionId = 'instance:999'; w.events[0] = { ...w.events[0]!, tick: -1 }; }, error: 'Station ownership is not bidirectional' },
    { name: 'terminal live row remains forbidden by prefix', mutate: w => { first(w).reservation.state = 'released'; first(w).transaction.requiredTicks = -1; }, error: 'Terminal records retained in live production' },
    { name: 'inventory validity remains before records', mutate: w => { w.inventory.wood.reserved = w.inventory.wood.owned + 1; first(w).reservation.lines = []; }, error: 'Invalid inventory' },
  ];
  it.each(cases)('preserves first error: $name', ({ mutate, error }) => {
    const world = cloneJson(started[version]); mutate(world); equivalent(world, version, [error]);
  });
  it('rejects duplicate originating command and archived/live instance claims before owner totals', () => {
    const second = begin(completed[version], 'record.second');
    const repeatedCommand = cloneJson(second); first(repeatedCommand).transaction.commandId = 'record.start';
    repeatedCommand.inventory.wood.reserved++;
    equivalent(repeatedCommand, version, ['Duplicate transaction originating command ID']);
    const repeatedClaim = cloneJson(second); const archived = [...iterateArchivedProduction(repeatedClaim.history)][0]!;
    repeatedClaim.reservations[archived.reservation.reservationId] = { ...archived.reservation, state: 'reserved', lines: [] };
    equivalent(repeatedClaim, version, ['Invalid instance sequence continuity']);
  });
  it('keeps full-output capacity blocked with intact inputs, then cancels once without refunding extra', () => {
    const pressure = cloneJson(sources[version]); pressure.inventory.plank.capacity = 1; // Explicit inventory-pressure fixture.
    const world = steps(begin(pressure, 'record.full'), 250); const transactionId = world.activeProductionTransactionIds[0]!;
    expect(first(world).transaction).toMatchObject({ state: 'Blocked', phase: 'AwaitingDelivery', blockedReason: 'CAPACITY_EXCEEDED' });
    expect(world.inventory.wood.owned).toBe(pressure.inventory.wood.owned); expect(world.inventory.wood.reserved).toBe(3);
    equivalent(world, version, []);
    const denied = completeProduction(world, transactionId); expect(denied).toEqual({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED', resourceId: 'plank' } });
    const cancelled = cancel(world, transactionId); equivalent(cancelled, version, []);
    expect(cancelled.inventory.plank.owned).toBe(0); expect(cancelled.inventory.wood.owned).toBe(pressure.inventory.wood.owned);
    expect(cancelled.inventory.wood.reserved).toBe(0);
  });
  it('retains last-safe instance allocation and terminal-event cancellation capacity', () => {
    const pressure = cloneJson(sources[version]); // Numeric stress, not a claim of 2^53 real jobs.
    pressure.sequences.nextInstance = Number.MAX_SAFE_INTEGER - 2; pressure.sequences.nextEvent = Number.MAX_SAFE_INTEGER - 2;
    const world = begin(pressure, 'record.last-safe'); equivalent(world, version, []);
    expect(world.sequences.nextInstance).toBe(Number.MAX_SAFE_INTEGER);
    const cancelled = cancel(world, world.activeProductionTransactionIds[0]!); equivalent(cancelled, version, []);
    expect(cancelled.sequences.nextEvent).toBe(Number.MAX_SAFE_INTEGER); expect(cancelled.inventory.wood.reserved).toBe(0);
    expect(retryCancel(cancelled, world.activeProductionTransactionIds[0]!)).toEqual(cancelled);
  });
  it('preserves genuine automatic live reservations and exact pinned cancellation receipts', () => {
    const legacy = fixture('../integration/fixtures/save-v7-active-automatic.json') as WorldState;
    const world = version === 7 ? legacy : migrateWorldV7ToV8(legacy);
    const transactionId = Object.keys(world.automaticProduction.live)[0]! as keyof typeof world.automaticProduction.live;
    expect(transactionId).toBeTruthy(); equivalent(world, version, []);
    const cancelled = cancel(world, transactionId, 'record.auto-cancel'); equivalent(cancelled, version, []);
    expect(cancelled.automaticProduction.pins[transactionId]!.retention).toBe('exact-receipt');
    expect(retryCancel(cancelled, transactionId, 'record.auto-cancel')).toEqual(cancelled);
  });
});

/** Observe direct-validator descriptor behavior separately from descriptor-safe save admission.
 * This refactor intentionally neither blesses hostile accessors nor changes old accepted sets. */
function observe(validate: (value: unknown) => string[], source: World, install: (world: World, reads: string[]) => void) {
  const world = cloneJson(source); const reads: string[] = []; install(world, reads);
  try { return { errors: validate(world), reads }; }
  catch (error) { return { thrown: error instanceof Error ? `${error.name}:${error.message}` : String(error), reads }; }
}
describe.each([7, 8] as const)('v%s descriptor and internal-stage behavior', version => {
  it.each(['activeTicks', 'ownerTransactionId', 'lines', 'builds'] as const)('retains identical getter count/order and outcome for %s', property => {
    const install = (world: World, reads: string[]) => {
      const target = property === 'builds' ? world : property === 'activeTicks' ? first(world).transaction : first(world).reservation;
      const descriptor = Object.getOwnPropertyDescriptor(target, property)!;
      Object.defineProperty(target, property, { configurable: true, enumerable: true, get() { reads.push(property); return descriptor.value; } });
    };
    const prior = observe(validators[version].frozen, started[version], install);
    expect(prior.reads.length).toBeGreaterThan(0);
    expect(observe(validators[version].current, started[version], install)).toEqual(prior);
  });
  it('retains the throwing-accessor boundary and never reads it when an earlier reservation fails', () => {
    const throwing = (world: World, reads: string[]) => {
      Object.defineProperty(first(world).transaction, 'activeTicks', { enumerable: true, get() { reads.push('activeTicks'); throw new Error('hostile getter'); } });
    };
    const prior = observe(validators[version].frozen, started[version], throwing);
    expect(prior).toEqual({ thrown: 'Error:hostile getter', reads: ['activeTicks'] });
    expect(observe(validators[version].current, started[version], throwing)).toEqual(prior);
    const before = (world: World, reads: string[]) => { throwing(world, reads); first(world).reservation.lines[0]!.quantity = 0; };
    expect(observe(validators[version].current, started[version], before)).toEqual({ errors: ['Invalid reservation'], reads: [] });
    expect(observe(validators[version].frozen, started[version], before)).toEqual({ errors: ['Invalid reservation'], reads: [] });
  });
  it.each(['non-enumerable row', 'symbol row', 'null-prototype reservation', 'sparse lines'] as const)('preserves %s behavior without silently widening or tightening legacy validation', kind => {
    const install = (world: World) => {
      if (kind === 'non-enumerable row') Object.defineProperty(world.reservations, 'hidden', { value: null, enumerable: false });
      else if (kind === 'symbol row') Object.defineProperty(world.reservations, Symbol('hidden'), { value: null, enumerable: true });
      else if (kind === 'null-prototype reservation') Object.setPrototypeOf(first(world).reservation, null);
      else first(world).reservation.lines = new Array(1);
    };
    const prior = observe(validators[version].frozen, started[version], install);
    expect(observe(validators[version].current, started[version], install)).toEqual(prior);
    if (kind === 'null-prototype reservation') expect(prior).toEqual({ errors: ['Terminal records retained in live production'], reads: [] });
  });
});

function records(world: World): WorldEconomyRecords {
  // This helper supplies the genuine, already prefix-validated domain branches. It is not a
  // v9 parser and cannot authenticate the rest of a World by observing record success.
  const result = inspectWorldEconomyRecords({ source: { ...world }, protocol: 'automatic-production', map: { ...world.map }, clock: { ...world.clock },
    sequences: { ...world.sequences }, inventory: world.inventory, cultivation: world.cultivation, automatic: world.automaticProduction,
    archive: restoreHistoryArchive(world.history), archivedIdentities: 'legacy' in world ? world.legacy.archivedIdentities : [], campaignPaymentIds: [] });
  if (!result.ok) throw new Error(result.errors.join('; ')); return result.records;
}
describe('internal records are narrower than World admission', () => {
  it('separates local owner facts from the exact old inventory equation without allowing supplied extra totals', () => {
    const world = cloneJson(started[8]); world.inventory.wood.reserved++;
    const inspected = records(world); const owners = closeWorldEconomyOwnerLinks(inspected);
    expect(owners.ok).toBe(true); if (!owners.ok) throw new Error(owners.errors.join('; '));
    expect(owners.claims.reservedTotals).toEqual({ wood: 3, stone: 0, herbs: 0, grain: 0, meal: 0, plank: 0 });
    expect(Object.isFrozen(owners.claims)).toBe(true); expect(Object.isFrozen(owners.claims.reservedTotals)).toBe(true);
    expect(closeLegacyWorldEconomyReservations(inspected)).toEqual(['Reservation totals do not match inventory']);
    equivalent(world, 8, ['Reservation totals do not match inventory']);
  });
  it('does not authenticate a zero-cost orphan merely because record arithmetic succeeded', () => {
    const world = cloneJson(started[8]); orphan(world);
    const inspected = records(world);
    expect(closeWorldEconomyOwnerLinks(inspected)).toEqual({ ok: false, errors: ['Orphaned reservation'] });
    expect(closeLegacyWorldEconomyReservations(inspected)).toEqual(['Orphaned reservation']);
  });
  it('requires full event/receipt validation after valid economy records', () => {
    const world = cloneJson(started[8]); world.events[0] = { ...world.events[0]!, tick: -1 };
    expect(closeLegacyWorldEconomyReservations(records(world))).toEqual([]);
    equivalent(world, 8, ['Invalid event']);
    const missingReceipt = cloneJson(started[8]); delete missingReceipt.commandReceipts['record.start'];
    expect(closeLegacyWorldEconomyReservations(records(missingReceipt))).toEqual([]);
    equivalent(missingReceipt, 8, ['Transaction is missing its matching originating command receipt']);
  });
  it('rejects JSON/spread/caller-forged stage evidence and exposes no unchecked World parser in the public kernel', () => {
    const inspected = records(started[8]);
    for (const fake of [{}, { ...inspected }, JSON.parse(JSON.stringify(inspected))] as WorldEconomyRecords[]) {
      expect(() => closeWorldEconomyOwnerLinks(fake)).toThrow('World economy records were not inspected');
      expect(() => closeLegacyWorldEconomyReservations(fake)).toThrow('World economy records were not inspected');
    }
    expect(publicKernel).not.toHaveProperty('inspectWorldEconomyRecords');
    expect(publicKernel).not.toHaveProperty('closeWorldEconomyOwnerLinks');
  });
  it('keeps output reference collections detached from private owner-link evidence', () => {
    const world = cloneJson(started[8]); const owner = 'instance:900000'; orphan(world, owner);
    const inspected = records(world);
    // Deliberately violate the readonly test contract: altering a diagnostic set cannot mint an owner.
    (inspected.transactionIds as Set<string>).add(owner);
    expect(closeWorldEconomyOwnerLinks(inspected)).toEqual({ ok: false, errors: ['Orphaned reservation'] });
  });
  it('does not turn a v9 identity into either v7 or v8 merely because it has old economy records', () => {
    const world = cloneJson(started[8]); world.simulationVersion = '0.9.0';
    Object.assign(world, { sectExpansion: { schemaVersion: 1 } });
    expect(closeLegacyWorldEconomyReservations(records(world))).toEqual([]);
    expect(current.validateWorldState(world)).toEqual(['Unsupported world identity/version']);
    expect(current.validateWorldStateV8(world)).toEqual(['Unsupported world identity/version']);
  });
  it('keeps the descriptor-safe v8 snapshot boundary ahead of getter execution', () => {
    const world = cloneJson(started[8]); if (!('campaign' in world)) throw new Error('Expected real v8');
    let calls = 0; const transaction = first(world).transaction;
    Object.defineProperty(transaction, 'activeTicks', { enumerable: true, get() { calls++; return 0; } });
    expect(() => createSaveEnvelopeV8(world, metadata)).toThrow(); expect(calls).toBe(0);
  });
  it('accepts authenticated deceased archival production after actual expiry, acknowledgement and retirement', () => {
    let world = cloneJson(completed[8]); if (!('campaign' in world)) throw new Error('Expected real v8');
    const actor = world.disciples[1]!; const profile = world.cultivation.disciples[1]!;
    // Explicit synthetic age boundary; the production, death and retirement transitions are real.
    actor.birthCalendarTick = world.clock.calendarTick + 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    world = advanceWorldCultivationV8({ ...world, clock: tickClock(world.clock) });
    const death = world.cultivation.pendingDeaths[0]!; expect(death.discipleId).toBe(actor.id);
    const result = dispatchWorldCultivationV8(world, { kind: 'death.finalize', commandId: 'record.death', expectedRevision: world.cultivation.revision,
      discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    if (!result.ok) throw new Error(result.code);
    const settled = prepareWorldEstateSettlement(result.world); if (!settled.ok) throw new Error(settled.details.join('; '));
    expect(settled.candidate.disciples.some(member => member.id === actor.id)).toBe(false);
    expect([...iterateArchivedProduction(settled.candidate.history)][0]!.transaction.workerId).toBe(actor.id);
    equivalent(settled.candidate, 8, []);
  });
  it('retains exact 4 MiB v8 terminal snapshot admission and rejects one extra byte', () => {
    const source = cloneJson(started[8]); if (!('campaign' in source)) throw new Error('Expected real v8');
    const cancelled = cancel(source, source.activeProductionTransactionIds[0]!);
    const pressure = { ...cancelled, diagnostics: [{ code: 'INVARIANT_FAILURE' as const, tick: cancelled.clock.simulationTick, message: '' }] };
    // Synthetic wire-pressure padding after a genuine cancellation, not an unbounded gameplay claim.
    const missing = SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(pressure, { saveVersion: 8, metadata });
    pressure.diagnostics[0]!.message = 'x'.repeat(missing);
    equivalent(pressure, 8, []);
    const text = serializeSaveV8(createSaveEnvelopeV8(pressure, metadata)); expect(text.length).toBe(SAVE_FILE_LIMIT_BYTES);
    expect(parseSaveV8(text).ok).toBe(true);
    pressure.diagnostics[0]!.message += 'x';
    expect(() => createSaveEnvelopeV8(pressure, metadata)).toThrow('Save exceeds the file size limit');
  });
});
