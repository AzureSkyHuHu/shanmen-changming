import { readFileSync } from 'node:fs';
import { parseSave } from '../../src/core/kernel/save';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { dispatchWorldExpeditionV8 } from '../../src/core/expeditions/v8-world-adapter';
import { describe, expect, it } from 'vitest';
import { createWorldV8, dispatchCommandV8, advanceTicksWithStatusV8, previewWorldExpeditionV8, previewWorldEmergencyRetreatV8,
  validateWorldStateV8, parseSaveV8, createSaveEnvelopeV8, serializeSaveV8, type WorldStateV8, type PlayerExpeditionCommandV8 } from '../../src/core/kernel/v8';
import { remainingRunCommandReserve, returnClearanceReservation } from '../../src/core/world/expedition-return-capacity';
import { assessCoveredBoundaryCapacityV8 } from '../../src/core/world/runtime-capacity-v8';
import { registeredWorldRun } from '../../src/core/expeditions/v8-world-adapter';
import { applyRegisteredExpeditionCommand } from '../../src/core/expeditions/versioned';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { tickWorldAutomaticWorkV8 } from '../../src/core/world/automatic-work-bridge-v8';
import { assessRegisteredExpeditionExitBudget } from '../../src/core/world/expedition-exit-budget';
import type { ExpeditionCommand, ExpeditionReceipt } from '../../src/core/expeditions/types';
type Body<T> = T extends T ? Omit<T, 'commandId'> : never;
function act(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>, commandId = `recovery:${world.clock.simulationTick}:${world.expedition.run?.revision ?? 0}`) {
  return dispatchCommandV8(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, kind: 'expedition.command',
    payload: { command: { ...body, commandId } as PlayerExpeditionCommandV8 } });
}
function depart(seed = 'recovery-admission') {
  const initial = createWorldV8(seed); const result = act(initial, { kind: 'expedition.depart', request: {
    squadIds: initial.disciples.slice(0, 2).map(actor => actor.id), routeId: 'route.qingfeng-trial' } });
  expect(result.result.status).toBe('accepted'); return result.world;
}
function step(world: WorldStateV8, count: number) {
  const result = advanceTicksWithStatusV8(world, count); expect(result.invariantStop).toBeNull(); expect(result.capacityStop).toBeNull(); return result.world;
}
function endingWithRealController() {
  let world = step(depart(), 1200);
  const begin = act(world, { kind: 'expedition.continue' }); expect(begin.result.status).toBe('accepted'); world = step(begin.world, 17);
  const preview = previewWorldEmergencyRetreatV8(world)!;
  const retreat = act(world, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true });
  expect(retreat.result.status).toBe('accepted'); return retreat.world;
}

describe('v8 bounded expedition recovery admission', () => {
  it('rejects repeated prepaid continuation without spending a run row, supply or RNG draw', () => {
    let world = depart(); const before = canonicalStringify(world.expedition);
    for (let index = 0; index < 4; index++) {
      const result = act(world, { kind: 'expedition.continue' }, `duplicate-prepaid:${index}`);
      expect(result.result.rejection).toEqual({ code: 'EXPEDITION_REJECTED', expeditionCode: 'INVALID_PHASE' });
      world = result.world; expect(canonicalStringify(world.expedition)).toBe(before);
    }
    expect(world.expedition.run?.commandLog).toHaveLength(2); expect(validateWorldStateV8(world)).toEqual([]);
  });
  it('rejects a route whose incoming reward exceeds physical capacity even if all current stock is discarded', () => {
    const world = createWorldV8('impossible-return'); world.inventory.wood = { ...world.inventory.wood, owned: 1, capacity: 1 };
    const request = { routeId: 'route.qingfeng-trial' as const, squadIds: world.disciples.slice(0, 2).map(actor => actor.id) };
    expect(previewWorldExpeditionV8(world, request).blockers).toContain('INVENTORY_FULL');
    const result = act(world, { kind: 'expedition.depart', request });
    expect(result.result.rejection).toEqual({ code: 'EXPEDITION_REJECTED', expeditionCode: 'INVENTORY_FULL' });
    expect(result.world.inventory).toEqual(world.inventory); expect(result.world.sequences).toEqual(world.sequences); expect(result.world.expedition.run).toBeNull();
  });
  it('does not consume a pending offer when its supply fallback creates an impossible return credit', () => {
    const text = readFileSync(new URL('./fixtures/save-v7-awaiting-choice.json', import.meta.url), 'utf8'); const parsed = parseSave(text);
    if (!parsed.ok) throw new Error(parsed.error.message); const world = migrateWorldV7ToV8(parsed.world);
    world.inventory.meal = { ...world.inventory.meal, owned: 0, capacity: 0 };
    const offer = world.expedition.run!.offers.find(offer => offer.offerId === world.expedition.run!.currentOfferId)!;
    const before = canonicalStringify(world);
    const refused = dispatchWorldExpeditionV8(world, { commandId: 'impossible-fallback', kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision });
    expect(refused).toEqual({ ok: false, code: 'INVENTORY_FULL' }); expect(canonicalStringify(world)).toBe(before);
  });
  it('keeps the actual paid-exit last run row usable and rejects its deficit without demanding all future victories', () => {
    const initial = depart('run-rows');
    const initialBudget = assessRegisteredExpeditionExitBudget(initial); expect(initialBudget.fits).toBe(true);
    const initialReserve = initialBudget.plan!.requiredRunCommands;
    // The older counter reserves every optional remaining battle/reward as well.
    // It is deliberately larger than the now-enforced immediate exit obligation.
    expect(remainingRunCommandReserve(initial).reserved).toBeGreaterThan(initialReserve);
    const seedRun = initial.expedition.run!; const checkpoint = seedRun.admittedCheckpoint!;
    const commandLog = [...seedRun.commandLog]; const receipts = [...seedRun.receipts]; let revision = seedRun.revision;
    while (commandLog.length < 512 - initialReserve) {
      const command: ExpeditionCommand = { kind: 'time.admit', commandId: `row:${revision}`, expectedRevision: revision,
        checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth };
      revision += 1;
      const receipt: ExpeditionReceipt = { commandId: command.commandId, commandHash: stableHash(command), kind: command.kind,
        revision, effectIds: [], resultId: checkpoint.checkpointId };
      commandLog.push(command); receipts.push(receipt);
    }
    // Linear imported-history construction, checked against the real first reducer
    // step and the strict query's complete final World/domain replay.
    const sampleBody = commandLog[seedRun.commandLog.length]!;
    if (sampleBody.kind !== 'time.admit') throw new Error('Expected imported no-effect admission row');
    const sample = applyRegisteredExpeditionCommand(registeredWorldRun(initial), { kind: 'time.admit', commandId: sampleBody.commandId,
      expectedRevision: sampleBody.expectedRevision, checkpointId: sampleBody.checkpointId, expectedCalendarMonth: sampleBody.expectedCalendarMonth });
    expect(sample.ok).toBe(true); if (!sample.ok) throw new Error(sample.code);
    expect(sample.effects).toEqual([]); expect(sample.expedition.run.commandLog.at(-1)).toEqual(commandLog[seedRun.commandLog.length]);
    expect(sample.expedition.run.receipts.at(-1)).toEqual(receipts[seedRun.receipts.length]);
    const world = { ...initial, expedition: { ...initial.expedition, run: { ...seedRun, commandLog, receipts, revision } } };
    const budget = assessRegisteredExpeditionExitBudget(world); expect(budget.supported).toBe(true);
    expect(budget.costs.runCommands).toBe(512); expect(budget.fits).toBe(true);
    const next = step(world, 1200);
    expect(next.expedition.run?.phase).toBe('AtNode'); expect(next.expedition.run!.commandLog.length).toBe(world.expedition.run!.commandLog.length + 1);
    const beforeRows = next.expedition.run!.commandLog.length;
    // The committed month spends one row and releases exactly one required row.
    expect(beforeRows + initialReserve - 1).toBe(512);
    const extra = applyRegisteredExpeditionCommand(registeredWorldRun(world), { kind: 'time.admit', commandId: 'one-too-many', expectedRevision: revision,
      checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth });
    if (!extra.ok) throw new Error(extra.code);
    const crowded = { ...world, expedition: { ...world.expedition, run: extra.expedition.run } };
    expect(validateWorldStateV8(crowded)).toEqual([]);
    const bytes = canonicalStringify(crowded);
    const refused = dispatchCommandV8(crowded, { commandId: 'unrelated', sequence: 1, issuedTick: crowded.clock.simulationTick,
      kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } });
    expect(refused.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(refused.world).toBe(crowded); expect(canonicalStringify(crowded)).toBe(bytes);
  }, 30_000);
  it('spends a real final-return discard reservation across bytes, archive charges, rows and IDs, then settles once', () => {
    let world = endingWithRealController(); const continued = act(world, { kind: 'expedition.continue' }); expect(continued.result.status).toBe('accepted'); world = continued.world;
    // Explicit full-stock boundary stress. All expedition outcomes and return
    // progress above are real; this test isolates the capacity-recovery obligation.
    world = { ...world, inventory: { ...world.inventory, meal: { ...world.inventory.meal, owned: world.inventory.meal.capacity } } };
    world = step(world, 1200); expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    expect(returnClearanceReservation(world).discardResourceIds).toEqual(['meal']);
    const base = assessCoveredBoundaryCapacityV8(world);
    const padded: WorldStateV8 = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }] };
    const padding = SAVE_FILE_LIMIT_BYTES - assessCoveredBoundaryCapacityV8(padded).costs.wireBytes!;
    padded.diagnostics[0]!.message = 'x'.repeat(padding);
    expect(validateWorldStateV8(padded)).toEqual([]); const before = assessCoveredBoundaryCapacityV8(padded);
    expect(before.costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES); expect(base.clearance.maximumDiscardOperations).toBe(1);
    const amount = padded.expedition.run!.settlement!.unusedSupplies.find(line => line.resourceId === 'meal')!.quantity;
    const command = { commandId: 'paid-clearance', sequence: 1, issuedTick: padded.clock.simulationTick, kind: 'inventory.discard', payload: { resourceId: 'meal', quantity: amount } } as const;
    const discarded = dispatchCommandV8(padded, command); expect(discarded.result.status, JSON.stringify(discarded.result)).toBe('accepted');
    expect(returnClearanceReservation(discarded.world).maximumDiscardOperations).toBe(0);
    const after = assessCoveredBoundaryCapacityV8(discarded.world);
    for (const key of ['wireBytes', 'archiveReceiptRows', 'archiveEventRows', 'archiveCharacters', 'archiveNodes', 'sequence.nextAction', 'sequence.nextEvent']) expect(after.costs[key]).toBeLessThanOrEqual(before.costs[key]!);
    expect(tickWorldAutomaticWorkV8(discarded.world)).toBe(discarded.world);
    expect(dispatchCommandV8(discarded.world, command).world).toBe(discarded.world);
    const settled = step(discarded.world, 1); expect(settled.expedition.run?.phase).toBe('Ended'); expect(settled.expedition.history).toHaveLength(1);
    expect(measureWorldSaveBytes(settled, { saveVersion: 8 })).toBeLessThan(SAVE_FILE_LIMIT_BYTES);
    const loaded = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(settled, { buildId: 'recovery-edge', savedAt: '1' }))); expect(loaded.ok).toBe(true);
  }, 30_000);
});
