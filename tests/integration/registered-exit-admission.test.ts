import { describe, expect, it } from 'vitest';
import { createWorldV8, dispatchCommandV8, advanceTicksWithStatusV8, previewWorldEmergencyRetreatV8, validateWorldStateV8,
  createSaveEnvelopeV8, serializeSaveV8, parseSaveV8, type CommandV8, type WorldStateV8, type PlayerExpeditionCommandV8 } from '../../src/core/kernel/v8';
import { assessRegisteredExpeditionExitBudget as assess, REGISTERED_EXPEDITION_EXIT_QUOTAS as QUOTA } from '../../src/core/world/expedition-exit-budget';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { canonicalUtf8ByteLength, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';

import { RESOURCE_IDS } from '../../src/core/economy/types';
import { isCultivationWorkerAvailable } from '../../src/core/world/cultivation-bridge';
import { registeredWorldRun, afterWorldExpeditionTickV8 } from '../../src/core/expeditions/v8-world-adapter';
import { startAutomaticProduction } from '../../src/core/economy/automatic-production';
import { tickClock } from '../../src/core/kernel/clock';
import { returnClearanceReservation } from '../../src/core/world/expedition-return-capacity';
import { applyRegisteredExpeditionCommand } from '../../src/core/expeditions/versioned';
import type { ExpeditionCommand, ExpeditionReceipt } from '../../src/core/expeditions/types';

type Body<T> = T extends T ? Omit<T, 'commandId'> : never;
function act(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>, commandId = 'admission:depart') {
  return dispatchCommandV8(world, { commandId, issuedTick: world.clock.simulationTick, sequence: world.sequences.nextAction,
    kind: 'expedition.command', payload: { command: { ...body, commandId } as PlayerExpeditionCommandV8 } });
}
const request = (world: WorldStateV8) => ({ kind: 'expedition.depart' as const,
  request: { routeId: 'route.qingfeng-trial' as const, squadIds: world.disciples.slice(0, 2).map(actor => actor.id) } });

function accepted(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>, commandId = `admission:${world.clock.simulationTick}:${world.expedition.run?.revision ?? 0}`) {
  const result = act(world, body, commandId); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function command(world: WorldStateV8, body: CommandV8) {
  const result = dispatchCommandV8(world, body); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function step(world: WorldStateV8, ticks: number) {
  const result = advanceTicksWithStatusV8(world, ticks);
  expect(result.invariantStop, JSON.stringify(result.invariantStop)).toBeNull(); expect(result.capacityStop).toBeNull(); return result.world;
}
function restore(world: WorldStateV8) {
  const text = serializeSaveV8(createSaveEnvelopeV8(world, { buildId: 'registered-admission', savedAt: '2026-10-01T20:00:00Z' }));
  const restored = parseSaveV8(text); expect(restored.ok, restored.ok ? '' : restored.error.message).toBe(true);
  if (!restored.ok) throw new Error(restored.error.message);
  expect(canonicalStringify(restored.world)).toBe(canonicalStringify(world)); return restored.world;
}
function worker(world: WorldStateV8) {
  const actor = world.disciples.find(actor => actor.canWork && actor.lifeState === 'alive' && !actor.traveling
    && !actor.assignmentTransactionId && isCultivationWorkerAvailable(world, actor.id));
  if (!actor) throw new Error('No legal idle worker'); return actor.id;
}
/** Imported no-effect history pressure; final Worlds are independently replay-validated. */
function crowdedRun(world: WorldStateV8, total: number, width = 1) {
  const run = world.expedition.run!; const checkpoint = run.admittedCheckpoint!;
  const commandLog = [...run.commandLog]; const receipts = [...run.receipts]; let revision = run.revision;
  while (commandLog.length < total) {
    const body: ExpeditionCommand = { kind: 'time.admit', commandId: `rows:${revision}`.padEnd(width, 'x'), expectedRevision: revision,
      checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth };
    revision += 1;
    const receipt: ExpeditionReceipt = { commandId: body.commandId, commandHash: stableHash(body), kind: body.kind,
      revision, effectIds: [], resultId: checkpoint.checkpointId };
    commandLog.push(body); receipts.push(receipt);
  }
  return { ...world, expedition: { ...world.expedition, run: { ...run, commandLog, receipts, revision } } };
}

describe('registered v8 complete candidate exit admission', () => {
  it('admits the complete departure exactly at its paid-exit wire ceiling and refuses one extra byte atomically', () => {
    const initial = createWorldV8('registered-wire-admission');
    initial.diagnostics = [{ code: 'INVARIANT_FAILURE', tick: 0, message: '' }]; // Explicit import byte-pressure fixture, no error pause.
    const detached = act(initial, request(initial)); expect(detached.result.status).toBe('accepted');
    const room = SAVE_FILE_LIMIT_BYTES - assess(detached.world).peak.totalBytes; expect(room).toBeGreaterThan(0);
    const exact: WorldStateV8 = { ...initial, diagnostics: [{ ...initial.diagnostics[0]!, message: 'x'.repeat(room) }] };
    const accepted = act(exact, request(exact)); expect(accepted.result.status, JSON.stringify(accepted.result)).toBe('accepted');
    expect(assess(accepted.world)).toMatchObject({ supported: true, fits: true, peak: { totalBytes: SAVE_FILE_LIMIT_BYTES } });
    const extra: WorldStateV8 = { ...exact, diagnostics: [{ ...exact.diagnostics[0]!, message: `${exact.diagnostics[0]!.message}x` }] };
    const bytes = canonicalStringify(extra); const refused = act(extra, request(extra));
    expect(refused.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(refused.world).toBe(extra);
    expect(canonicalStringify(extra)).toBe(bytes); expect(extra.expedition.run).toBeNull();
  }, 30_000);
  it('rejects a player ID that cannot preserve its full future effect ID without spending run state or RNG', () => {
    const world = createWorldV8('registered-id-admission');
    const accepted = act(world, request(world)); expect(accepted.result.status).toBe('accepted');
    const before = accepted.world; const maximum = assess(before).plan!.commandIdMaximumLength;
    const rejected = act(before, { kind: 'expedition.continue' }, 'r'.repeat(maximum + 1));
    expect(rejected.result.rejection).toEqual({ code: 'EXPEDITION_REJECTED', expeditionCode: 'INVALID_COMMAND' });
    expect(rejected.world.expedition.run).toEqual(before.expedition.run); expect(rejected.world.randomStreams).toEqual(before.randomStreams);
  });
  it('retains a funded controller when its next real tick exceeds C, then really cancels, clears six resources and returns through saves', () => {
    let world = createWorldV8('registered-c-overflow');
    world = command(world, { commandId: 'admission:plank', sequence: 1, issuedTick: world.clock.simulationTick,
      kind: 'production.start', payload: { workerId: worker(world), recipeId: 'craft.plank' } });
    for (let index = 0; index < 5 && world.activeProductionTransactionIds.length; index++) world = step(world, 600);
    expect(world.activeProductionTransactionIds).toEqual([]); expect(world.inventory.plank.owned).toBeGreaterThan(0);
    world = accepted(world, { kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial',
      squadIds: world.disciples.slice(0, 2).map(actor => actor.id),
      supplies: RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: resourceId === 'meal' ? 8 : 1 })) } });
    world = step(world, 1200);
    world = command(world, { commandId: 'admission:home-job', sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'production.start', payload: { workerId: worker(world), recipeId: 'cook.meal' } });
    world = accepted(world, { kind: 'expedition.continue' }); expect(world.expedition.run?.phase).toBe('InEncounter');
    let growth = 0;
    for (let index = 0; index < 60 && growth <= 0; index++) {
      const encounter = world.expedition.battle!;
      const diagnostic = { tick: encounter.controller.battle.tick, actorId: encounter.participants[0]!.battleEntityId, reason: '' };
      const candidate = { ...world, expedition: { ...world.expedition, battle: { ...encounter,
        controller: { ...encounter.controller, diagnostics: [diagnostic] } } } };
      const actualNext = afterWorldExpeditionTickV8({ ...candidate, clock: tickClock(candidate.clock) });
      growth = canonicalUtf8ByteLength(actualNext.expedition.battle) - canonicalUtf8ByteLength(candidate.expedition.battle);
      if (growth > 0) world = candidate; else world = step(world, 1);
    }
    expect(growth).toBeGreaterThan(0);
    // Diagnostic-only imported pressure; stats, life, outcome, clocks and RNG are untouched.
    const encounter = world.expedition.battle!;
    world = { ...world, expedition: { ...world.expedition, battle: { ...encounter, controller: { ...encounter.controller,
      diagnostics: encounter.controller.diagnostics.map(entry => ({ ...entry,
        reason: 'x'.repeat(QUOTA.worldEncounterBytes - growth + 1 - canonicalUtf8ByteLength(encounter)) })) } } } };
    expect(validateWorldStateV8(world)).toEqual([]); expect(assess(world).fits).toBe(true);
    expect(canonicalUtf8ByteLength(afterWorldExpeditionTickV8({ ...world, clock: tickClock(world.clock) }).expedition.battle)).toBe(QUOTA.worldEncounterBytes + 1);
    const source = canonicalStringify(world); const beforeController = canonicalStringify(world.expedition.battle!.controller);
    const refused = advanceTicksWithStatusV8(world, 1);
    expect(refused.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(refused.invariantStop).toBeNull();
    expect(refused.world.clock.pauseReasons).toContain('save-capacity'); expect(refused.world.clock.pauseReasons).not.toContain('error');
    expect(canonicalStringify(refused.world.expedition.battle!.controller)).toBe(beforeController);
    expect(refused.world.randomStreams).toEqual(world.randomStreams); expect(refused.world.clock.simulationTick).toBe(world.clock.simulationTick);
    expect(canonicalStringify(world)).toBe(source);
    world = restore(refused.world); const preview = previewWorldEmergencyRetreatV8(world)!;
    world = restore(accepted(world, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true }));
    expect(world.clock.pauseReasons).not.toContain('save-capacity');
    for (const transactionId of [...world.activeProductionTransactionIds]) world = command(world, {
      commandId: `admission:cancel:${transactionId}`, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'production.cancel', payload: { transactionId } });
    expect(world.activeProductionTransactionIds).toEqual([]); expect(world.inventory.grain.reserved).toBe(0);
    world = accepted(world, { kind: 'expedition.continue' });
    world = cloneJson(world); for (const id of RESOURCE_IDS) world.inventory[id].owned = world.inventory[id].capacity;
    expect(validateWorldStateV8(world)).toEqual([]); expect(assess(world).fits).toBe(true);
    world = restore(step(world, 600)); world = restore(step(world, 600));
    expect(world.expedition.blockedReason).toBe('INVENTORY_FULL'); expect(returnClearanceReservation(world).discardResourceIds).toEqual([...RESOURCE_IDS]);
    let discarded = 0;
    for (const resourceId of RESOURCE_IDS) {
      world = command(world, { commandId: `admission:discard:${resourceId}`, sequence: world.sequences.nextAction,
        issuedTick: world.clock.simulationTick, kind: 'inventory.discard', payload: { resourceId, quantity: world.inventory[resourceId].owned } });
      discarded += 1;
    }
    expect(discarded).toBe(6); world = restore(step(world, 1));
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.expedition.run?.settlement?.reason).toBe('emergencyRetreat');
    expect(world.campaign.progress.clears).toEqual([]); expect(world.campaign.settledRunEvidence).toEqual([]);
    expect(world.expedition.history).toHaveLength(1); expect(world.builds.disciples.every(member => member.lock === null)).toBe(true);
    expect(validateWorldStateV8(world)).toEqual([]);
  }, 30_000);
  it('enforces the indispensable run-row vector on reader-valid imported pressure', () => {
    const initial = createWorldV8('registered-row-admission'); const travelling = accepted(initial, request(initial));
    const reserve = assess(travelling).plan!.requiredRunCommands;
    const exact = crowdedRun(travelling, QUOTA.runCommands - reserve);
    const checkpoint = travelling.expedition.run!.admittedCheckpoint!;
    const sample = applyRegisteredExpeditionCommand(registeredWorldRun(travelling), { kind: 'time.admit', commandId: `rows:${travelling.expedition.run!.revision}`,
      expectedRevision: travelling.expedition.run!.revision, checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth });
    expect(sample.ok).toBe(true); if (!sample.ok) throw new Error(sample.code);
    expect(crowdedRun(travelling, travelling.expedition.run!.commandLog.length + 1).expedition.run).toEqual(sample.expedition.run);
    const exactBudget = assess(exact); // Includes complete World replay, not a trusted fixture shortcut.
    expect(exactBudget.supported).toBe(true); expect(exactBudget.costs.runCommands).toBe(QUOTA.runCommands); expect(exactBudget.fits).toBe(true);
    const progressed = step(exact, 1200); expect(progressed.expedition.run?.phase).toBe('AtNode');
    expect(progressed.expedition.run!.commandLog.length).toBe(exact.expedition.run!.commandLog.length + 1);
    const extra = crowdedRun(exact, exact.expedition.run!.commandLog.length + 1);
    expect(validateWorldStateV8(extra)).toEqual([]); const old = canonicalStringify(extra);
    const rejected = dispatchCommandV8(extra, { commandId: 'admission:optional', sequence: extra.sequences.nextAction,
      issuedTick: extra.clock.simulationTick, kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } });
    expect(rejected.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(rejected.world).toBe(extra); expect(canonicalStringify(extra)).toBe(old);
  }, 30_000);
  it('refuses an actual oversized run without touching a reader-valid imported source', () => {
    const initial = createWorldV8('registered-actual-run-quota'); const travelling = accepted(initial, request(initial));
    const large = crowdedRun(travelling, 500, 120); expect(validateWorldStateV8(large)).toEqual([]);
    expect(canonicalUtf8ByteLength(large.expedition.run)).toBeGreaterThan(QUOTA.runBytes);
    const blocked = advanceTicksWithStatusV8(large, 1); expect(blocked.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(blocked.invariantStop).toBeNull(); expect(blocked.world).toBe(large);
  }, 30_000);
  it('revalidates a mutable input on every invocation and preserves unknown imports exactly', () => {
    const initial = createWorldV8('registered-mutable-source'); let world = accepted(initial, request(initial));
    expect(advanceTicksWithStatusV8(world, 1).capacityStop).toBeNull();
    // Reusing the original object is not a cache key or an ownership credential.
    world.expedition.contentIdentity = { ...world.expedition.contentIdentity!, registryId: 'future.unregistered' };
    const source = canonicalStringify(world); const result = advanceTicksWithStatusV8(world, 1);
    expect(result.world).toBe(world); expect(result.capacityStop).toBe('SAVE_OBLIGATION_UNBOUNDED'); expect(result.invariantStop).toBeNull();
    expect(canonicalStringify(world)).toBe(source);
  });

  it('discharges a real automatic cancellation pin while a reader-valid import still has a composed wire deficit', () => {
    let world = createWorldV8('registered-auto-release');
    const ids = world.disciples.slice(2).filter(actor => actor.canWork).map(actor => actor.id); expect(ids.length).toBeGreaterThanOrEqual(1);
    world.sectEconomy = { ...world.sectEconomy, enabled: true, plans: ids.map(workerId => ({ workerId, enabled: true,
      priorities: [{ recipeId: 'cook.meal', targetStock: 80 }] })) };
    const started = startAutomaticProduction(world, { workerId: ids[0]!, recipeId: 'cook.meal' });
    expect(started.ok).toBe(true); if (!started.ok) throw new Error(started.reason); world = started.world;
    world = accepted(world, request(world));
    world = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }] };
    const base = assess(world); expect(base.fits).toBe(true);
    world.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - base.peak.totalBytes + 500_000);
    expect(validateWorldStateV8(world)).toEqual([]); const before = assess(world);
    expect(before.actualFits).toBe(true); expect(before.fits).toBe(false);
    const cancelled = dispatchCommandV8(world, { commandId: 'admission:auto-cancel', sequence: world.sequences.nextAction,
      issuedTick: world.clock.simulationTick, kind: 'production.cancel', payload: { transactionId: started.transactionId } });
    expect(cancelled.result.status, JSON.stringify(cancelled.result)).toBe('accepted');
    expect(cancelled.world.automaticProduction.pins[started.transactionId]).toMatchObject({ state: 'Cancelled', retention: 'exact-receipt' });
    const after = assess(cancelled.world); expect(after.fits).toBe(false); expect(after.actualFits).toBe(true);
    expect(after.costs.wireBytes).toBeLessThan(before.costs.wireBytes!); expect(validateWorldStateV8(cancelled.world)).toEqual([]);
  }, 30_000);
  it('preserves every unknown registered queue occurrence, including conflicting duplicate IDs and a forged context flag', () => {
    const initial = createWorldV8('registered-queue-preserved'); const travelling = accepted(initial, request(initial));
    const first: CommandV8 = { commandId: 'queued:duplicate', sequence: 10, issuedTick: travelling.clock.simulationTick,
      kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } };
    const second: CommandV8 = { ...first, sequence: 11, issuedTick: travelling.clock.simulationTick + 1,
      payload: { command: { kind: 'enabled.set', enabled: true } } };
    for (const tail of [second, { ...second, commandId: 'queued:distinct' }]) {
      const queued = { ...travelling, pendingCommands: [first, tail] }; expect(validateWorldStateV8(queued)).toEqual([]);
      const source = canonicalStringify(queued);
      for (const body of [first, { ...first, commandId: 'unrelated:flag' }]) {
        const attempted = dispatchCommandV8(queued, body, { existingQueuedCommand: true });
        expect(attempted.result.rejection?.code).toBe('SAVE_OBLIGATION_UNBOUNDED'); expect(attempted.world).toBe(queued);
      }
      const tick = advanceTicksWithStatusV8(queued, 1); expect(tick.capacityStop).toBe('SAVE_OBLIGATION_UNBOUNDED');
      expect(tick.invariantStop).toBeNull(); expect(tick.world).toBe(queued); expect(canonicalStringify(queued)).toBe(source);
    }
  });

  it('keeps the typed run finish quota within one byte of R and rejects the next two-byte replay-valid ID increment', () => {
    const initial = createWorldV8('registered-r-edge'); const travelling = accepted(initial, request(initial));
    const base = crowdedRun(travelling, 400); const budget = assess(base);
    const room = QUOTA.runBytes - budget.costs.runQuota!; expect(room).toBeGreaterThan(0);
    // A no-effect command ID appears exactly twice: its command and receipt.
    // Preserve its real replay shape and recompute only the authentic command hash.
    const widen = (characters: number) => {
      const run = base.expedition.run!; let left = characters;
      const commandLog = run.commandLog.map((body, index) => {
        if (index < travelling.expedition.run!.commandLog.length) return body;
        const count = Math.min(left, 120 - body.commandId.length); left -= count;
        return { ...body, commandId: body.commandId + 'x'.repeat(count) };
      });
      expect(left).toBe(0);
      const receipts = run.receipts.map((receipt, index) => commandLog[index] === run.commandLog[index] ? receipt
        : { ...receipt, commandId: commandLog[index]!.commandId, commandHash: stableHash(commandLog[index]) });
      return { ...base, expedition: { ...base.expedition, run: { ...run, commandLog, receipts } } };
    };
    const edge = widen(Math.floor(room / 2));
    const funded = assess(edge); expect(funded.supported).toBe(true); expect(funded.fits).toBe(true); expect(QUOTA.runBytes - funded.costs.runQuota!).toBeLessThanOrEqual(1);
    expect(step(edge, 1).clock.simulationTick).toBe(edge.clock.simulationTick + 1);
    const over = widen(Math.floor(room / 2) + 1);
    const exceeded = assess(over); expect(exceeded.supported).toBe(true); expect(exceeded.violations).toContain('runQuota'); expect(exceeded.costs.runQuota! - QUOTA.runBytes).toBeLessThanOrEqual(2);
    const rejected = dispatchCommandV8(over, { commandId: 'admission:r-over', sequence: over.sequences.nextAction,
      issuedTick: over.clock.simulationTick, kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } });
    expect(rejected.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(rejected.world).toBe(over);
  }, 30_000);

  it('owns a detached frozen invocation snapshot without freezing any caller-owned mutable World or history branch', () => {
    const initial = createWorldV8('registered-owned-snapshot');
    const source = cloneJson(accepted(initial, request(initial)));
    const callerObjects = [source, source.clock, source.inventory, source.inventory.meal, source.randomStreams, source.history,
      source.history.strings, source.history.production, source.history.production.pages, source.expedition, source.expedition.run!, source.disciples];
    for (const value of callerObjects) expect(Object.isFrozen(value)).toBe(false);
    const bytes = canonicalStringify(source); const result = advanceTicksWithStatusV8(source, 1);
    expect(result.capacityStop).toBeNull(); expect(result.invariantStop).toBeNull(); expect(result.world).not.toBe(source);
    expect(Object.isFrozen(result.world)).toBe(true); expect(Object.isFrozen(result.world.history)).toBe(true);
    expect(Object.isFrozen(result.world.expedition.run)).toBe(true);
    for (const value of callerObjects) expect(Object.isFrozen(value)).toBe(false);
    expect(canonicalStringify(source)).toBe(bytes);
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: source.clock.simulationTick, message: 'still caller-owned' });
    expect(result.world.diagnostics).toEqual([]);
  });

  it('reassesses real manual work digit growth in future terminal copies before accepting a near-cap tick', () => {
    let world = createWorldV8('registered-manual-width'); const away = new Set(world.disciples.slice(0, 2).map(actor => actor.id));
    const home = world.disciples.find(actor => !away.has(actor.id) && actor.canWork && actor.lifeState === 'alive'
      && !actor.assignmentTransactionId && isCultivationWorkerAvailable(world, actor.id));
    expect(home).toBeDefined();
    world = command(world, { commandId: 'admission:manual-width', sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'production.start', payload: { workerId: home!.id, recipeId: 'cook.meal' } });
    const transactionId = world.activeProductionTransactionIds[0]!;
    for (let tick = 0; tick < 2000 && world.transactions[transactionId]!.activeTicks < 9; tick++) world = step(world, 1);
    expect(world.transactions[transactionId]).toMatchObject({ phase: 'Working', activeTicks: 9 });
    world = accepted(world, request(world));
    world = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }] };
    const before = assess(world); expect(before.fits).toBe(true);
    const actualNext = step(world, 1); expect(actualNext.transactions[transactionId]!.activeTicks).toBe(10);
    const completeNext = assess(actualNext); expect(completeNext.fits).toBe(true);
    expect(completeNext.peak.totalBytes - before.peak.totalBytes).toBeGreaterThan(1);
    const pressure = { ...world, diagnostics: [{ ...world.diagnostics[0]!, message: 'x'.repeat(SAVE_FILE_LIMIT_BYTES - before.peak.totalBytes - 1) }] };
    expect(validateWorldStateV8(pressure)).toEqual([]); expect(assess(pressure).peak.totalBytes).toBe(SAVE_FILE_LIMIT_BYTES - 1);
    expect(assess(pressure).fits).toBe(true);
    const rejected = advanceTicksWithStatusV8(pressure, 1);
    expect(rejected.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(rejected.invariantStop).toBeNull();
    expect(rejected.world.transactions[transactionId]!.activeTicks).toBe(9); expect(rejected.world.randomStreams).toEqual(pressure.randomStreams);
    const cancelled = command(restore(rejected.world), { commandId: 'admission:manual-width-cancel', sequence: rejected.world.sequences.nextAction,
      issuedTick: rejected.world.clock.simulationTick, kind: 'production.cancel', payload: { transactionId } });
    expect(assess(cancelled).fits).toBe(true); expect(assess(step(cancelled, 1)).fits).toBe(true);
  }, 30_000);

  it('spends high simulation counters with a small exact delta and retains the final real return ticks', () => {
    const initial = createWorldV8('registered-high-tick'); let world = step(accepted(initial, request(initial)), 1200);
    world = accepted(world, { kind: 'expedition.continue' }); expect(world.expedition.run?.phase).toBe('InEncounter');
    const sourceTick = Number.MAX_SAFE_INTEGER - 1203; // 2^53 - 1204, then exactly 1200 reserved return ticks.
    const encounter = world.expedition.battle!;
    world = { ...world, clock: { ...world.clock, simulationTick: sourceTick, encounterTick: sourceTick - world.clock.calendarTick },
      expedition: { ...world.expedition, battle: { ...encounter, lastAdvancedSimulationTick: sourceTick,
        admittedSimulationTick: sourceTick - encounter.controller.elapsedTicks } } };
    // Explicit high-counter import pressure. Real run/controller and calendar remain unchanged.
    expect(validateWorldStateV8(world)).toEqual([]); const budget = assess(world);
    expect(budget.fits).toBe(true); expect(budget.costs.simulationTick).toBe(Number.MAX_SAFE_INTEGER - 3);
    const original = canonicalStringify(world); const third = step(world, 3);
    expect(assess(third).costs.simulationTick).toBe(Number.MAX_SAFE_INTEGER); expect(assess(third).fits).toBe(true);
    const refused = advanceTicksWithStatusV8(world, 4);
    expect(refused.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(refused.invariantStop).toBeNull();
    expect(refused.world.clock.simulationTick).toBe(sourceTick + 3);
    expect(refused.world.expedition.battle!.controller).toEqual(third.expedition.battle!.controller);
    expect(refused.world.randomStreams).toEqual(third.randomStreams); expect(canonicalStringify(world)).toBe(original);
    world = restore(refused.world); const preview = previewWorldEmergencyRetreatV8(world)!;
    world = accepted(world, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true });
    world = restore(step(accepted(world, { kind: 'expedition.continue' }), 1200));
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.clock.simulationTick).toBe(Number.MAX_SAFE_INTEGER);
    expect(world.expedition.run?.settlement?.reason).toBe('emergencyRetreat');
  }, 30_000);

  it('commits a real nonvictory terminal history under a composed deficit without inventing an unnecessary campaign proof', () => {
    const initial = createWorldV8('registered-terminal-release'); let world = step(accepted(initial, request(initial)), 1200);
    world = accepted(world, { kind: 'expedition.continue' }); const preview = previewWorldEmergencyRetreatV8(world)!;
    world = accepted(world, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true });
    world = accepted(world, { kind: 'expedition.continue' });
    world = { ...world, inventory: { ...world.inventory, meal: { ...world.inventory.meal, owned: world.inventory.meal.capacity } } };
    world = step(world, 1200); expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    world = command(world, { commandId: 'admission:terminal-discard', sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'inventory.discard', payload: { resourceId: 'meal', quantity: world.inventory.meal.owned } });
    expect(world.expedition.run?.phase).toBe('Ending');
    world = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }] };
    const ordinaryTerminal = step(world, 1); expect(ordinaryTerminal.expedition.run?.phase).toBe('Ended');
    const terminalBudget = assess(ordinaryTerminal); expect(terminalBudget.fits).toBe(true);
    const pressure = { ...world, diagnostics: [{ ...world.diagnostics[0]!, message: 'x'.repeat(SAVE_FILE_LIMIT_BYTES - terminalBudget.peak.totalBytes + 1) }] };
    expect(validateWorldStateV8(pressure)).toEqual([]); const reserved = assess(pressure);
    expect(reserved.supported).toBe(true); expect(reserved.actualFits).toBe(true); expect(reserved.fits).toBe(false);
    const result = advanceTicksWithStatusV8(restore(pressure), 1);
    expect(result.capacityStop).toBeNull(); expect(result.invariantStop).toBeNull();
    world = restore(result.world); const terminal = assess(world);
    expect(terminal.supported).toBe(true); expect(terminal.actualFits).toBe(true); expect(terminal.fits).toBe(false);
    expect(world.expedition.run?.settlement).toMatchObject({ committed: true, reason: 'emergencyRetreat' });
    expect(world.expedition.history).toHaveLength(1); expect(world.expedition.history[0]!.settlementId).toBe(world.expedition.run!.settlement!.settlementId);
    const receipt = world.expedition.run!.receipts.find(receipt => receipt.kind === 'run.settle'); expect(receipt).toBeDefined();
    expect(receipt!.effectIds.every(effectId => world.expedition.effectReceipts.some(effect => effect.effectId === effectId && effect.kind === 'runSettled'))).toBe(true);
    expect(world.campaign.settledRunEvidence).toEqual([]); expect(world.campaign.progress.clears).toEqual([]);
    expect(world.builds.disciples.every(member => member.lock === null)).toBe(true); expect(validateWorldStateV8(world)).toEqual([]);
  }, 30_000);

});
