import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advanceTicks, canonicalStringify, cloneJson, createSaveEnvelope, createWorld, dispatchCommand, enqueueCommands,
  isCommand, lookupCommandReceipt, parseSave, serializeSave, validateLegacyWorldStateV6, validateWorldState,
  type Command, type WorldState } from '../../src/core/kernel';
import { cancelProduction } from '../../src/core/economy/production';
import { classifyAutomaticHandle, lookupLiveProduction, startAutomaticProduction } from '../../src/core/economy/automatic-production';

const sourceText = readFileSync(new URL('./fixtures/save-v6-before-automatic-work.json', import.meta.url), 'utf8');
const metadata = { buildId: 'automatic-world-tests', savedAt: '2026-10-01T11:00:00Z' };
function parsed(text: string) {
  const result = parseSave(text); if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result;
}
function reload(world: WorldState) { return parsed(serializeSave(createSaveEnvelope(world, metadata))).world; }
function configure(world = createWorld('automatic-production'), recipeId = 'gather.grain', workerId = world.disciples[1]!.id) {
  for (const [suffix, command] of [['plan', { kind: 'plan.set', plan: { workerId, enabled: true, priorities: [{ recipeId, targetStock: 999 }] } }],
    ['enabled', { kind: 'enabled.set', enabled: true }]] as const) {
    const operation = dispatchCommand(world, { commandId: `setup.${workerId}.${suffix}`, sequence: world.sequences.nextAction,
      issuedTick: world.clock.simulationTick, kind: 'sect-economy.command', payload: { command } });
    expect(operation.result.status).toBe('accepted'); world = operation.world;
  }
  return world;
}
function start(world: WorldState, recipeId = 'gather.grain', workerId = world.disciples[1]!.id) {
  const operation = startAutomaticProduction(world, { recipeId, workerId });
  if (!operation.ok) throw new Error(operation.reason);
  return operation;
}
function disable(world: WorldState, commandId: string): WorldState {
  const operation = dispatchCommand(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } });
  expect(operation.result.status).toBe('accepted'); return operation.world;
}
function cancel(world: WorldState, id: string, commandId = 'manual.cancel'): Command {
  return { commandId, kind: 'production.cancel', payload: { transactionId: id }, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick };
}

describe('source-owned automatic production', () => {
  it('migrates genuine v6 without allocating facts and requires a fresh activation choice', () => {
    const source = JSON.parse(sourceText);
    expect(source.saveVersion).toBe(6); expect(validateLegacyWorldStateV6(source.payload)).toEqual([]);
    const result = parsed(sourceText);
    expect(result.envelope.saveVersion).toBe(7);
    expect(result.migration).toEqual({ sourceSaveVersion: 6, sourceSimulationVersion: '0.6.0', sourceChecksum: '0e743fc2' });
    expect(result.world.automaticProduction).toEqual({ schemaVersion: 1, nextCycle: 1, activationReviewRequired: true, live: {}, journal: [], pins: {} });
    const { automaticProduction: _automatic, ...projection } = cloneJson(result.world);
    projection.simulationVersion = '0.6.0'; projection.sectEconomy.enabled = true;
    expect(projection).toEqual(source.payload); expect(result.world.sectEconomy.enabled).toBe(false);
    const original = lookupCommandReceipt(result.world, 'v6.fixture.enabled')!;
    const retry = dispatchCommand(result.world, { ...JSON.parse(original.fingerprint), commandId: original.commandId, sequence: 999, issuedTick: 0 });
    expect(retry.world).toBe(result.world); expect(retry.result).toEqual(original.result);
    const fresh = dispatchCommand(result.world, { kind: 'sect-economy.command', commandId: 'v7.explicit-enable', sequence: 1,
      issuedTick: result.world.clock.simulationTick, payload: { command: { kind: 'enabled.set', enabled: true } } });
    expect(fresh.result.status).toBe('accepted'); expect(fresh.world.automaticProduction.activationReviewRequired).toBe(false);
    expect(JSON.parse(sourceText)).toEqual(source);
  });

  it('admits one private cycle with one nested escrow and no manual history or fake command', () => {
    const world = configure(createWorld(), 'craft.plank'); const before = canonicalStringify(world);
    const admitted = start(world, 'craft.plank'); const next = admitted.world;
    expect(admitted.transactionId).toBe('auto-job/1'); expect(next.automaticProduction.nextCycle).toBe(2);
    expect(next.transactions).toEqual({}); expect(next.reservations).toEqual({}); expect(next.history).toBe(world.history);
    expect(next.inventory.wood.reserved).toBe(3); expect(next.inventory.wood.owned).toBe(24);
    expect(next.sequences.nextInstance).toBe(world.sequences.nextInstance + 1);
    expect(next.sequences.nextAction).toBe(world.sequences.nextAction + 1);
    expect(next.sequences.nextEvent).toBe(world.sequences.nextEvent + 1);
    expect(next.events).toEqual(world.events); expect(next.commandReceipts).toEqual(world.commandReceipts);
    expect(lookupLiveProduction(next, admitted.transactionId)!.origin).toEqual({ kind: 'sect-plan', cycle: 1 });
    expect(validateWorldState(next)).toEqual([]); expect(reload(next)).toEqual(next); expect(canonicalStringify(world)).toBe(before);
    const duplicate = startAutomaticProduction(next, { recipeId: 'craft.plank', workerId: next.disciples[1]!.id });
    expect(duplicate).toEqual({ ok: false, reason: 'PLAN_CHANGED' });
  });

  it('completes and retires without per-cycle durable history; the high-water handle cannot settle again', () => {
    const admitted = start(configure(createWorld(), 'craft.plank'), 'craft.plank');
    const held = disable(admitted.world, 'hold.completion');
    const completed = advanceTicks(held, 400);
    expect(completed.inventory.plank.owned).toBe(2); expect(completed.inventory.wood.owned).toBe(21); expect(completed.inventory.wood.reserved).toBe(0);
    expect(classifyAutomaticHandle(completed, admitted.transactionId)).toEqual({ kind: 'retired', cycle: 1 });
    expect(completed.history.production.count).toBe(0); expect(completed.events).toEqual(admitted.world.events);
    expect(completed.commandReceipts).toEqual(held.commandReceipts);
    const retry = dispatchCommand(reload(completed), cancel(completed, admitted.transactionId));
    expect(retry.result.rejection?.code).toBe('AUTO_JOB_RETIRED'); expect(retry.world.inventory).toEqual(completed.inventory);
    expect(validateWorldState(retry.world)).toEqual([]);
  });

  it('pins an exact public cancellation once and replays it after reload without allocations', () => {
    const admitted = start(configure(createWorld(), 'craft.plank'), 'craft.plank');
    const command = cancel(admitted.world, admitted.transactionId); const operation = dispatchCommand(admitted.world, command);
    expect(operation.result.status).toBe('accepted'); expect(operation.result.eventIds).toHaveLength(1);
    expect(operation.world.inventory.wood).toEqual({ resourceId: 'wood', owned: 24, reserved: 0, capacity: 999 });
    expect(operation.world.automaticProduction.pins[admitted.transactionId]).toMatchObject({ state: 'Cancelled', retention: 'exact-receipt', resultEventId: operation.result.eventIds[0] });
    expect(operation.world.sectEconomy.nextDecisionTick).toBeGreaterThan(operation.world.clock.simulationTick);
    const restored = reload(operation.world); const replay = dispatchCommand(restored, { ...command, issuedTick: 999999 });
    expect(replay.world).toBe(restored); expect(replay.result).toEqual(operation.result);
    const another = dispatchCommand(restored, { ...command, commandId: 'another.cancel' });
    expect(another.result.eventIds).toEqual(operation.result.eventIds); expect(another.world.sequences).toEqual(restored.sequences);
    const conflict = dispatchCommand(restored, { ...command, payload: { transactionId: 'auto-job/2' } });
    expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT'); expect(conflict.world).toBe(restored);
    expect(validateWorldState(another.world)).toEqual([]);
    const extraPayload = cloneJson(restored);
    const recorded = JSON.parse(extraPayload.commandReceipts[command.commandId]!.fingerprint); recorded.payload.extra = 'forged';
    extraPayload.commandReceipts[command.commandId]!.fingerprint = canonicalStringify(recorded);
    expect(validateWorldState(extraPayload)).toContain('Invalid accepted automatic cancellation receipt');
    const badParent = cloneJson(restored);
    badParent.events = badParent.events.map((event) => event.eventId === operation.result.eventIds[0] ? { ...event, parentEventId: event.eventId } : event);
    expect(validateWorldState(badParent)).toContain('Automatic exact pin lacks matching receipt and event');
  });

  it('holds only the minimal terminal fact needed by a future cancellation, then removes the temporary pin', () => {
    const admitted = start(configure()); const command = { ...cancel(admitted.world, admitted.transactionId, 'future.cancel'), issuedTick: 450 };
    const queued = enqueueCommands(disable(admitted.world, 'hold.future'), [command]); const completed = advanceTicks(queued, 350);
    expect(completed.automaticProduction.pins[admitted.transactionId]).toMatchObject({ state: 'Committed', retention: 'pending-command', resultEventId: null });
    expect(lookupCommandReceipt(completed, command.commandId)).toBeUndefined(); expect(validateWorldState(completed)).toEqual([]);
    const due = advanceTicks(reload(completed), 101);
    expect(lookupCommandReceipt(due, command.commandId)!.result.rejection?.code).toBe('TRANSACTION_FINISHED');
    expect(due.automaticProduction.pins).toEqual({}); expect(due.pendingCommands).toEqual([]); expect(validateWorldState(due)).toEqual([]);
  });

  it('promotes an internally cancelled pending fact without releasing inputs a second time', () => {
    const admitted = start(configure(createWorld(), 'craft.plank'), 'craft.plank'); const command = { ...cancel(admitted.world, admitted.transactionId), issuedTick: 10 };
    const queued = enqueueCommands(disable(admitted.world, 'hold.internal'), [command]); const internal = cancelProduction(queued, admitted.transactionId);
    if (!internal.ok) throw new Error('cancel');
    expect(internal.world.automaticProduction.pins[admitted.transactionId]).toMatchObject({ state: 'Cancelled', retention: 'pending-command' });
    expect(internal.eventIds).toEqual([]); const due = advanceTicks(reload(internal.world), 11);
    expect(due.inventory).toEqual(internal.world.inventory); expect(due.automaticProduction.pins[admitted.transactionId]!.retention).toBe('exact-receipt');
    expect(lookupCommandReceipt(due, command.commandId)!.result.status).toBe('accepted'); expect(validateWorldState(due)).toEqual([]);
  });

  it('rejects source impersonation and malformed or unexplained saved automatic facts', () => {
    const world = configure(); const admitted = start(world);
    expect(isCommand({ ...cancel(world, 'auto-job/1'), commandId: 'auto-job/1' })).toBe(false);
    expect(isCommand({ ...cancel(world, 'auto-job/01') })).toBe(false);
    expect(isCommand({ commandId: 'bad.source', sequence: 1, issuedTick: 0, kind: 'production.start', payload: { workerId: 'entity:2', recipeId: 'gather.grain', origin: { kind: 'sect-plan', cycle: 1 } } })).toBe(false);
    for (const mutate of [
      (candidate: WorldState) => { candidate.automaticProduction.nextCycle = 1; },
      (candidate: WorldState) => { candidate.automaticProduction.live[admitted.transactionId]!.transaction.origin.cycle = 2; },
      (candidate: WorldState) => { candidate.automaticProduction.live[admitted.transactionId]!.reservation.ownerTransactionId = 'auto-job/2'; },
      (candidate: WorldState) => { candidate.automaticProduction.live[admitted.transactionId]!.transaction.navigation.path = [{ x: 999, y: 0 }]; },
    ]) { const candidate = cloneJson(admitted.world); mutate(candidate); expect(validateWorldState(candidate).length).toBeGreaterThan(0); }
    const cancelled = dispatchCommand(admitted.world, cancel(admitted.world, admitted.transactionId)).world;
    const noProof = cloneJson(cancelled); noProof.commandReceipts = {};
    expect(validateWorldState(noProof).length).toBeGreaterThan(0);
  });
  it('shares the common worker/seat/path lifecycle and cancels on an explicit cultivation role change', () => {
    const admitted = start(configure(createWorld(), 'craft.plank'), 'craft.plank');
    const walking = advanceTicks(admitted.world, 9);
    expect(lookupLiveProduction(walking, admitted.transactionId)!.transaction.navigation.path.length).toBeGreaterThan(0);
    const workerId = walking.disciples[1]!.id;
    const changed = dispatchCommand(walking, { kind: 'cultivation.command', commandId: 'role.change', sequence: walking.sequences.nextAction,
      issuedTick: walking.clock.simulationTick, payload: { command: { kind: 'training.set', commandId: 'role.change',
        expectedRevision: walking.cultivation.revision, discipleId: workerId, mode: 'rest' } } });
    expect(changed.result.status).toBe('accepted');
    expect(changed.world.inventory.wood.reserved).toBe(0);
    expect(changed.world.automaticProduction.pins[admitted.transactionId]!.retention).toBe('exact-receipt');
    expect(changed.result.eventIds).toContain(changed.world.automaticProduction.pins[admitted.transactionId]!.resultEventId);
    expect(changed.world.disciples[1]!.position).toEqual(walking.disciples[1]!.position);
    expect(changed.world.buildings.every((building) => building.stationTransactionId !== admitted.transactionId)).toBe(true);
    expect(validateWorldState(changed.world)).toEqual([]); expect(reload(changed.world)).toEqual(changed.world);
  });

  it('keeps admitted work after disabling its plan and preserves out-of-order retirement', () => {
    let world = configure(); world = configure(world, 'craft.plank', world.disciples[2]!.id);
    const slow = start(world, 'craft.plank', world.disciples[2]!.id);
    const fast = start(slow.world);
    const disabled = dispatchCommand(fast.world, { kind: 'sect-economy.command', commandId: 'disable', sequence: 9, issuedTick: 0,
      payload: { command: { kind: 'enabled.set', enabled: false } } }).world;
    expect(disabled.activeProductionTransactionIds).toHaveLength(2);
    const after = advanceTicks(disabled, 400);
    expect(after.automaticProduction.nextCycle).toBe(3); expect(after.automaticProduction.live).toEqual({});
    expect(after.history.production.count).toBe(0); expect(after.inventory.plank.owned).toBe(2); expect(after.inventory.grain.owned).toBe(21);
    expect(classifyAutomaticHandle(after, 'auto-job/3')).toEqual({ kind: 'unknown' });
    expect(classifyAutomaticHandle(after, 'auto-job/1')).toEqual({ kind: 'retired', cycle: 1 });
    expect(validateWorldState(after)).toEqual([]);
  });

  it('binds available-only discard to one durable receipt/event and preserves reserved inventory', () => {
    const admitted = start(configure(createWorld(), 'craft.plank'), 'craft.plank');
    const request = { kind: 'inventory.discard', commandId: 'discard.wood', sequence: 1, issuedTick: 0,
      payload: { resourceId: 'wood', quantity: 21 } } as const;
    const discarded = dispatchCommand(admitted.world, request);
    expect(discarded.result.status).toBe('accepted'); expect(discarded.result.discardResult).toEqual(request.payload);
    expect(discarded.world.inventory.wood.owned).toBe(3); expect(discarded.world.inventory.wood.reserved).toBe(3);
    expect(discarded.world.events.at(-1)).toMatchObject({ kind: 'inventory.discarded', payload: { commandId: 'discard.wood', resourceId: 'wood', quantity: 21 } });
    const restored = reload(discarded.world); const replay = dispatchCommand(restored, request);
    expect(replay.world).toBe(restored); expect(replay.result).toEqual(discarded.result);
    const underflow = dispatchCommand(restored, { ...request, commandId: 'discard.reserved', payload: { resourceId: 'wood', quantity: 1 } });
    expect(underflow.result.rejection?.code).toBe('INSUFFICIENT_AVAILABLE'); expect(underflow.world.inventory).toEqual(restored.inventory);
    expect(dispatchCommand(restored, { ...request, payload: { resourceId: 'wood', quantity: 1 } }).result.rejection?.code).toBe('COMMAND_CONFLICT');
    const forged = cloneJson(restored); forged.commandReceipts[request.commandId]!.result.discardResult!.quantity = 20;
    expect(validateWorldState(forged)).toContain('Invalid accepted inventory discard receipt');
    const orphan = cloneJson(restored); delete orphan.commandReceipts[request.commandId];
    expect(validateWorldState(orphan)).toContain('Orphan inventory discard event');
    expect(validateWorldState(underflow.world)).toEqual([]);
  });

  it.each([false, true])('cleans a queued temporary pin after early direct receipt insertion (conflict=%s)', (conflict) => {
    const admitted = start(configure());
    const command = { ...cancel(admitted.world, admitted.transactionId, 'early.cancel'), issuedTick: 450 };
    const completed = advanceTicks(enqueueCommands(disable(admitted.world, 'hold.early'), [command]), 350);
    expect(completed.automaticProduction.pins[admitted.transactionId]!.retention).toBe('pending-command');
    const early = dispatchCommand(completed, { ...command, issuedTick: completed.clock.simulationTick,
      ...(conflict ? { payload: { transactionId: 'auto-job/999' } } : {}) });
    expect(early.result.rejection?.code).toBe(conflict ? 'UNKNOWN_TRANSACTION' : 'TRANSACTION_FINISHED');
    expect(early.world.pendingCommands).toBe(completed.pendingCommands); expect(early.world.automaticProduction.pins).toEqual({});
    expect(validateWorldState(early.world)).toEqual([]); expect(reload(early.world)).toEqual(early.world);
    const replay = dispatchCommand(early.world, { ...command, issuedTick: completed.clock.simulationTick });
    expect(replay.world).toBe(early.world); expect(replay.result.rejection?.code).toBe(conflict ? 'COMMAND_CONFLICT' : 'TRANSACTION_FINISHED');
  });

  it('binds wrapper cancellation proofs to the actual teaching teacher and student', () => {
    let world = configure(); world = configure(world, 'gather.grain', 'entity:3');
    // Authored-knowledge fixture; no player knowledge grant is introduced.
    world.cultivation.disciples[1]!.knowledge = [{ knowledgeId: 'knowledge.test-breath', teacherId: null, teachingId: null }];
    const teacher = start(world); const student = start(teacher.world, 'gather.grain', 'entity:3');
    const commandId = 'teaching.ownership';
    const teaching = dispatchCommand(student.world, { commandId, sequence: 1, issuedTick: 0, kind: 'cultivation.command',
      payload: { command: { commandId, kind: 'teaching.begin', discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.test-breath',
        expectedRevision: student.world.cultivation.revision } } });
    expect(teaching.result.status).toBe('accepted'); expect(teaching.world.activeProductionTransactionIds).toEqual([]);
    expect(Object.keys(teaching.world.automaticProduction.pins)).toEqual([teacher.transactionId, student.transactionId]);
    expect(validateWorldState(teaching.world)).toEqual([]);
    const otherId = 'unrelated.training';
    const unrelated = dispatchCommand(teaching.world, { commandId: otherId, sequence: 2, issuedTick: 0, kind: 'cultivation.command',
      payload: { command: { commandId: otherId, kind: 'training.set', discipleId: 'entity:4', mode: 'rest', expectedRevision: teaching.world.cultivation.revision } } });
    expect(unrelated.result.status).toBe('accepted');
    const forged = cloneJson(unrelated.world);
    const pinEvents = Object.values(forged.automaticProduction.pins).map((pin) => pin.resultEventId!);
    forged.commandReceipts[commandId]!.result.eventIds = forged.commandReceipts[commandId]!.result.eventIds.filter((id) => !pinEvents.includes(id));
    forged.commandReceipts[otherId]!.result.eventIds.push(...pinEvents);
    expect(validateWorldState(forged)).toContain('Automatic exact pin lacks matching receipt and event');
  });

});
