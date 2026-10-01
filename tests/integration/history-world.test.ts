import type { PlayerExpeditionCommand } from '../../src/core/expeditions/world-types';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { appendHistoryBatch, createHistoryArchive, iterateArchivedCommandReceipts, iterateArchivedEvents, iterateArchivedProduction,
  lookupArchivedProduction, type HistoryArchive } from '../../src/core/history';
import { dispatchWorldExpedition } from '../../src/core/expeditions/world-adapter';
import { advanceTicks, cancelProduction, canonicalStringify, cloneJson, cloneWorldWithSharedHistory, completeProduction, createSaveEnvelope,
  createWorld, dispatchCommand, lookupCommandReceipt, lookupEvent, lookupProduction, parseSave, recentWorldEvents, restoreWorldHistory,
  serializeSave, stableHash, validateLegacyWorldStateV5, validateWorldState, worldEventCursor, worldEventsSince, type Command,
  type CommandResult, type WorldState } from '../../src/core/kernel';
import { openSaveRepository } from '../../src/platform/persistence';

const sourceText = readFileSync(new URL('./fixtures/save-v5-mixed-history.json', import.meta.url), 'utf8');
const metadata = { buildId: 'history-world-tests', savedAt: '2026-10-01T10:10:00Z' };
function parsed(text: string) {
  const result = parseSave(text);
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}
function reload(world: WorldState) { return parsed(serializeSave(createSaveEnvelope(world, metadata))).world; }
function start(world: WorldState, commandId: string, recipeId = 'craft.plank'): Command {
  return { commandId, kind: 'production.start', sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { recipeId, workerId: world.disciples[1]!.id } };
}
function settledHistory(cycles = 40) {
  let world = createWorld('history-tails');
  const attempts: { command: Command; result: CommandResult }[] = [];
  const rejected = start(world, 'a.old-rejected', 'recipe.missing');
  const denial = dispatchCommand(world, rejected); world = denial.world;
  attempts.push({ command: rejected, result: denial.result });
  for (let cycle = 0; cycle < cycles; cycle++) {
    const command = start(world, `job.${String(cycle).padStart(4, '0')}.start`);
    const accepted = dispatchCommand(world, command); expect(accepted.result.status).toBe('accepted');
    const cancel: Command = { commandId: `job.${String(cycle).padStart(4, '0')}.cancel`, sequence: accepted.world.sequences.nextAction,
      issuedTick: 0, kind: 'production.cancel', payload: { transactionId: accepted.result.transactionId! } };
    const cancelled = dispatchCommand(accepted.world, cancel); expect(cancelled.result.status).toBe('accepted');
    world = cancelled.world; attempts.push({ command, result: accepted.result }, { command: cancel, result: cancelled.result });
  }
  expect(validateWorldState(world)).toEqual([]);
  return { world, attempts };
}
function expanded(world: WorldState) {
  const { history, automaticProduction, ...body } = cloneJson(world);
  for (const entry of iterateArchivedProduction(history)) {
    body.transactions[entry.transaction.transactionId] = entry.transaction;
    body.reservations[entry.reservation.reservationId] = entry.reservation;
  }
  for (const receipt of iterateArchivedCommandReceipts(history)) body.commandReceipts[receipt.commandId] = receipt;
  body.events = [...iterateArchivedEvents(history), ...body.events];
  body.simulationVersion = '0.5.0';
  if (automaticProduction.activationReviewRequired) body.sectEconomy.enabled = true;
  return body;
}

describe('v6 live and immutable history split', () => {
  it('migrates genuine mixed v5 data losslessly and keeps live work/RNG/IDs at the same boundary', () => {
    const source = JSON.parse(sourceText);
    expect(source.saveVersion).toBe(5);
    expect(validateLegacyWorldStateV5(source.payload)).toEqual([]);
    const result = parsed(sourceText);
    expect(result.envelope.saveVersion).toBe(7);
    expect(result.migration).toEqual({ sourceSaveVersion: 5, sourceSimulationVersion: '0.5.0', sourceChecksum: '9edd213d' });
    expect(result.world.history.production.count).toBe(3);
    expect(Object.keys(result.world.transactions)).toEqual(['instance:43']);
    expect(Object.keys(result.world.reservations)).toEqual(['instance:44']);
    expect(result.world.inventory.grain.reserved).toBe(1);
    expect(expanded(result.world)).toEqual(source.payload);
    expect(result.world.sequences).toEqual(source.payload.sequences);
    expect(JSON.parse(sourceText)).toEqual(source);
    expect(advanceTicks(result.world, 30)).toEqual(advanceTicks(reload(advanceTicks(result.world, 7)), 23));
  });

  it('retains exact accepted, cancelled and rejected results after both tails rotate and after restore', () => {
    const { world, attempts } = settledHistory();
    expect(Object.keys(world.transactions)).toEqual([]); expect(Object.keys(world.reservations)).toEqual([]);
    expect(world.history.production.count).toBe(40);
    expect(world.history.commandReceipts.count).toBe(17); expect(Object.keys(world.commandReceipts)).toHaveLength(64);
    expect(world.history.events.count).toBe(16); expect(world.events).toHaveLength(64);
    const restored = reload(world);
    for (const attempt of attempts) {
      const replay = dispatchCommand(restored, { ...attempt.command, issuedTick: 99999, sequence: 99999 });
      expect(replay.world).toBe(restored); expect(replay.result).toEqual(attempt.result);
      const conflict = dispatchCommand(restored, { ...attempt.command, payload: { recipeId: 'gather.wood', workerId: 'entity:3' }, kind: 'production.start' });
      expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT');
    }
    expect(lookupCommandReceipt(restored, 'a.old-rejected')!.result.rejection?.code).toBe('UNKNOWN_RECIPE');
    expect(restored.history).toBe(restoreWorldHistory(restored).history);
    const firstJob = attempts[1]!.result.transactionId!;
    expect(cancelProduction(restored, firstJob)).toMatchObject({ ok: true, world: restored, eventIds: attempts[2]!.result.eventIds });
    expect(completeProduction(restored, firstJob)).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
  });

  it('commits once, archives transaction and reservation atomically, and preserves the original start result', () => {
    const initial = createWorld(); const command = start(initial, 'commit.once');
    const admitted = dispatchCommand(initial, command);
    const completed = advanceTicks(admitted.world, 400);
    const id = admitted.result.transactionId!;
    expect(completed.inventory.plank.owned).toBe(2); expect(completed.inventory.wood.reserved).toBe(0);
    expect(completed.transactions[id]).toBeUndefined();
    const record = lookupArchivedProduction(completed.history, id)!;
    expect(record.transaction.state).toBe('Committed'); expect(record.reservation.state).toBe('committed');
    expect(completed.reservations[record.reservation.reservationId]).toBeUndefined();
    expect(completed.activeProductionTransactionIds).toEqual([]);
    expect(completed.disciples[1]!.assignmentTransactionId).toBeNull();
    expect(completed.buildings.every((building) => building.stationTransactionId === null)).toBe(true);
    expect(completeProduction(completed, id)).toMatchObject({ ok: true, world: completed, eventIds: [record.transaction.resultEventId] });
    expect(cancelProduction(completed, id)).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(dispatchCommand(completed, command).result).toEqual(admitted.result);
    expect(validateWorldState(completed)).toEqual([]);
  });

  it('preserves ordinal event cursors across rollover and exposes detached records', () => {
    const { world } = settledHistory(32); const cursor = worldEventCursor(world);
    expect(cursor).toBe(64);
    const command = start(world, 'zz.new-start'); const admitted = dispatchCommand(world, command);
    const cancelled = cancelProduction(admitted.world, admitted.result.transactionId!);
    if (!cancelled.ok) throw new Error('cancel');
    const additions = worldEventsSince(cancelled.world, cursor);
    expect(additions.map((event) => event.kind)).toEqual(['production.started', 'production.cancelled']);
    expect(recentWorldEvents(cancelled.world, 2)).toEqual(additions);
    const old = lookupEvent(cancelled.world, 'event:1')!;
    expect(old.kind).toBe('production.started');
    (old.payload as Record<string, unknown>).recipeId = 'bad';
    expect(lookupEvent(cancelled.world, 'event:1')!.payload.recipeId).toBe('craft.plank');
    const job = lookupProduction(cancelled.world, admitted.result.transactionId!)!; job.recipeId = 'bad';
    expect(lookupProduction(cancelled.world, admitted.result.transactionId!)!.recipeId).toBe('craft.plank');
    expect(() => worldEventsSince(world, 65)).toThrow();
  });

  it('keeps ordinary work ticks and expedition drafts independent of archived-map size', () => {
    const { world } = settledHistory();
    const admitted = dispatchCommand(world, start(world, 'zz.live-work')).world;
    const moved = advanceTicks(admitted, 2);
    expect(moved.history).toBe(admitted.history);
    expect(Object.keys(moved.transactions)).toHaveLength(1);
    const draft = cloneWorldWithSharedHistory(moved);
    expect(draft.history).toBe(moved.history); expect(draft.disciples).not.toBe(moved.disciples);
    draft.inventory.wood.owned = 0; expect(moved.inventory.wood.owned).toBe(24);
    const before = canonicalStringify(moved);
    const rejected = dispatchWorldExpedition(moved, { commandId: 'bad-departure', kind: 'expedition.depart', request: { routeId: 'route.missing', squadIds: ['entity:1'] } } as unknown as PlayerExpeditionCommand);
    expect(rejected.ok).toBe(false); expect(canonicalStringify(moved)).toBe(before);
    const departed = dispatchWorldExpedition(moved, { commandId: 'good-departure', kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: ['entity:1', 'entity:4'] } });
    expect(departed.ok).toBe(true);
    if (departed.ok) { expect(departed.world.history).toBe(moved.history); expect(canonicalStringify(moved)).toBe(before); }
  });

  it('rejects archive/live collisions, broken receipts, bad clocks and missing settlement events', () => {
    const { world } = settledHistory(1);
    const record = [...iterateArchivedProduction(world.history)][0]!;
    const collision = cloneJson(world); collision.transactions[record.transaction.transactionId] = record.transaction;
    expect(validateWorldState(collision).length).toBeGreaterThan(0);
    const badReceipt = cloneJson(world); delete badReceipt.commandReceipts[record.transaction.commandId];
    expect(validateWorldState(badReceipt)).toContain('Transaction is missing its matching originating command receipt');
    const badTime = cloneJson(record); badTime.transaction.completedTick = 999;
    const forged = { ...world, history: appendHistoryBatch(createHistoryArchive(), { production: [badTime] }) };
    expect(validateWorldState(forged)).toContain('Invalid production transaction');
    const noEvent = { ...world, events: world.events.filter((event) => event.eventId !== record.transaction.resultEventId) };
    expect(validateWorldState(noEvent)).toContain('Missing settlement event');
    const duplicateReceipt = { ...world, history: appendHistoryBatch(world.history, { commandReceipts: [world.commandReceipts[record.transaction.commandId]!] }) };
    expect(validateWorldState(duplicateReceipt)).toContain('Duplicate command receipt IDs');
  });

  it('checks archived pair ownership, origin receipts and settlement IDs without expanded maps', () => {
    const world = settledHistory().world;
    const production = [...iterateArchivedProduction(world.history)];
    const commandReceipts = [...iterateArchivedCommandReceipts(world.history)];
    const events = [...iterateArchivedEvents(world.history)];
    const rebuild = (pairs = production, receipts = commandReceipts) => ({ ...world,
      history: appendHistoryBatch(createHistoryArchive(), { production: pairs, commandReceipts: receipts, events }) });
    const wrongOwner = cloneJson(production);
    wrongOwner[0]!.reservation.ownerTransactionId = wrongOwner[1]!.transaction.transactionId;
    // Structural archive validation also owns the pair edge; either layer must reject.
    expect(() => createSaveEnvelope(rebuild(wrongOwner), metadata)).toThrow();
    const wrongInputs = cloneJson(production);
    wrongInputs[0]!.reservation.lines[0]!.quantity += 1;
    expect(validateWorldState(rebuild(wrongInputs))).toContain('Reservation does not match locked recipe inputs');
    const wrongOrigin = cloneJson(commandReceipts);
    const origin = wrongOrigin.find((receipt) => receipt.commandId === production[0]!.transaction.commandId)!;
    origin.result.transactionId = production[1]!.transaction.transactionId;
    expect(validateWorldState(rebuild(production, wrongOrigin))).toContain('Transaction is missing its matching originating command receipt');
    const missingOrigin = commandReceipts.filter((receipt) => receipt.commandId !== production[0]!.transaction.commandId);
    expect(validateWorldState(rebuild(production, missingOrigin))).toContain('Transaction is missing its matching originating command receipt');
    const missingSettlement = cloneJson(production);
    missingSettlement[0]!.transaction.resultEventId = 'event:999999';
    expect(validateWorldState(rebuild(missingSettlement))).toContain('Missing settlement event');
    const unknownAccepted = cloneJson(world);
    unknownAccepted.commandReceipts['zz.forged'] = { commandId: 'zz.forged', fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId: 'instance:999999' } }),
      result: { status: 'accepted', commandId: 'zz.forged', transactionId: 'instance:999999', rejection: null, eventIds: [] } };
    delete unknownAccepted.commandReceipts[Object.keys(unknownAccepted.commandReceipts)[0]!];
    expect(validateWorldState(unknownAccepted)).toContain('Invalid accepted receipt');
  });

  it('validates forward event-parent references across archive and live tail in one ordered pass', () => {
    const world = settledHistory().world;
    const events = [...iterateArchivedEvents(world.history)];
    events[0] = { ...events[0]!, parentEventId: world.events[world.events.length - 1]!.eventId };
    const rebuild = () => ({ ...world, history: appendHistoryBatch(createHistoryArchive(), {
      production: [...iterateArchivedProduction(world.history)], commandReceipts: [...iterateArchivedCommandReceipts(world.history)], events }) });
    const forward = rebuild();
    expect(validateWorldState(forward)).toEqual([]);
    expect(reload(forward)).toEqual(forward);
    events[0] = { ...events[0]!, parentEventId: 'event:999999' };
    expect(validateWorldState(rebuild())).toContain('Missing parent event');
  });

  it('preserves valid legacy extensions via raw fallback and deeply seals them before sharing', () => {
    const source = JSON.parse(sourceText);
    source.payload.transactions['instance:37'].extension = { nested: ['untouched', { value: 7 }] };
    const { checksum: _checksum, ...body } = source;
    const world = parsed(canonicalStringify({ ...body, checksum: stableHash(body) })).world;
    expect(expanded(world)).toEqual(source.payload);
    const row = world.history.production.pages[0]![0]!;
    expect(row[0]).toBe(1);
    const raw = row[2] as unknown as { transaction: { extension: { nested: unknown[] } } };
    expect(Object.isFrozen(raw.transaction.extension.nested)).toBe(true);
    expect(() => raw.transaction.extension.nested.push('mutation')).toThrow();
    const draft = cloneWorldWithSharedHistory(world); expect(draft.history).toBe(world.history);
  });

  it('rejects malformed archive rows without mutating supplied bytes', () => {
    const world = settledHistory(1).world;
    const envelope = createSaveEnvelope(world, metadata);
    envelope.payload.history = { ...envelope.payload.history, production: { count: 1, pages: [[[0, 999]]] } } as HistoryArchive;
    const { checksum: _checksum, ...body } = envelope;
    const text = canonicalStringify({ ...body, checksum: stableHash(body) });
    expect(parseSave(text)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(text).toBe(canonicalStringify({ ...body, checksum: stableHash(body) }));
  });

  it('shares only authenticated immutable history when creating saves and detaches mutable caller input', () => {
    const owned = settledHistory(2).world;
    const envelope = createSaveEnvelope(owned, metadata);
    expect(envelope.payload.history).toBe(owned.history);
    expect(envelope.payload.inventory).not.toBe(owned.inventory);
    envelope.payload.inventory.wood.owned = 0;
    expect(owned.inventory.wood.owned).toBe(24);
    const unowned = cloneJson(owned);
    const detached = createSaveEnvelope(unowned, metadata);
    expect(detached.payload.history).not.toBe(unowned.history);
    (unowned.history.strings as string[]).push('caller-mutated');
    expect(detached.payload.history.strings).not.toContain('caller-mutated');
    expect(parsed(serializeSave(detached)).world).toEqual(owned);
  });

  it('loads the exact original stored v5 generation until an explicit v6 save', async () => {
    const repo = await openSaveRepository({ indexedDB: new IDBFactory(), now: () => 1000 });
    try {
      const imported = await repo.importSave(sourceText, { ownerId: 'v5-history' });
      const loaded = await repo.loadSlot(imported.slot.slotId);
      expect(loaded.envelope.saveVersion).toBe(7); expect(loaded.snapshot.text).toBe(sourceText);
      expect((await repo.exportSlot(imported.slot.slotId)).text).toBe(sourceText);
      await repo.saveWorld(imported.slot.slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
      expect(await repo.exportRawSnapshot(imported.slot.slotId, imported.snapshot.id)).toBe(sourceText);
    } finally { repo.close(); }
  });
});
