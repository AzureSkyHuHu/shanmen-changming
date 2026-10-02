import { describe, expect, it } from 'vitest';
import { recordAutomaticNotice } from '../../src/core/economy/automatic-production';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9, prepareUnregisteredCommandCandidateV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9, SectCommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9, prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9, verifyCapacityLimitedCandidateV9 } from '../../src/core/world/runtime-capacity-v9';
import { inspectReservedDischargesV9 } from '../../src/core/world/sect-release-v9';
import { inspectV9KnownRecordHeadroom } from '../../src/core/world/v9-record-headroom';
import type { WorldStateV9 } from '../../src/core/world/v9-types';

function command(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'sequence' | 'issuedTick'>, commandId: string): CommandV9 {
  return { ...body, commandId, sequence: 0, issuedTick: world.clock.simulationTick } as CommandV9;
}
function sectCommand(world: WorldStateV9, payload: SectCommandV9): CommandV9 {
  return command(world, { kind: 'sect.command', payload }, payload.command.commandId);
}
function accepted(world: WorldStateV9, input: CommandV9): WorldStateV9 {
  const applied = dispatchCapacityLimitedCommandV9(world, input);
  expect(applied.result.status, JSON.stringify(applied.result)).toBe('accepted'); return applied.world;
}
function place(world: WorldStateV9, id: string, x = 1): WorldStateV9 {
  return accepted(world, sectCommand(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: id,
    expectedRevision: world.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } } }));
}
function cancelBlueprint(world: WorldStateV9, id: string, index = 0): CommandV9 {
  return sectCommand(world, { domain: 'construction', command: { kind: 'construction.cancel', commandId: id,
    expectedRevision: world.sectExpansion.construction.revision, blueprintId: world.sectExpansion.construction.blueprints[index]!.blueprintId } });
}
/** Explicit valid diagnostic-pressure fixture. No forged histories, caps or budget
 * callbacks: the complete source validator must accept every pressure boundary. */
function atWireCost(source: WorldStateV9, target: number): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const measured = assessManagementCapacityV9(world); expect(measured.supported, measured.sourceRecordIssues.join(';')).toBe(true);
  const count = target - measured.costs.wireBytes!; expect(count).toBeGreaterThanOrEqual(0);
  world.diagnostics.at(-1)!.message = 'x'.repeat(count);
  expect(inspectUnregisteredWorldV9Records(world)).toEqual([]); return world;
}
function deficient(source: WorldStateV9, excess = 200_000): WorldStateV9 { return atWireCost(source, SAVE_FILE_LIMIT_BYTES + excess); }
function releaseEvidence(before: WorldStateV9, after: WorldStateV9) {
  const left = assessManagementCapacityV9(before); const right = assessManagementCapacityV9(after);
  expect(left.supported).toBe(true); expect(right.supported).toBe(true);
  return inspectReservedDischargesV9(before, after, { sect: left.sect!, progression: left.progression! }, { sect: right.sect!, progression: right.progression! });
}
function nearDeath(world: WorldStateV9, id: string): WorldStateV9 {
  const next = cloneJson(world); const actor = next.disciples.find(actor => actor.id === id)!;
  const profile = next.cultivation.disciples.find(profile => profile.discipleId === id)!;
  // Zero-history lifespan fixture; actual pending death/settlement execute normally.
  expect(next.clock.simulationTick).toBe(0);
  actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  expect(inspectUnregisteredWorldV9Records(next)).toEqual([]); return next;
}

describe('separate limited v9 complete-candidate runtime gate', () => {
  it('admits a real sect start at exact complete cost and refuses the next byte without any writes', () => {
    const seed = createUnregisteredWorldV9('runtime-exact-start');
    const input = sectCommand(seed, { domain: 'production', command: { kind: 'production.start', commandId: 'exact.start',
      expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2' } });
    const candidate = prepareUnregisteredCommandCandidateV9(seed, input); expect(candidate.result.status).toBe('accepted');
    const delta = assessManagementCapacityV9(candidate.world).costs.wireBytes! - assessManagementCapacityV9(seed).costs.wireBytes!;
    const equal = atWireCost(seed, SAVE_FILE_LIMIT_BYTES - delta);
    const applied = dispatchCapacityLimitedCommandV9(equal, input); expect(applied.result.status).toBe('accepted');
    expect(assessManagementCapacityV9(applied.world).costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES);
    const short = cloneJson(equal); short.diagnostics.at(-1)!.message += 'x'; const frozen = canonicalStringify(short);
    const refused = dispatchCapacityLimitedCommandV9(short, input);
    expect(refused.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(refused.world).toBe(short);
    expect(canonicalStringify(short)).toBe(frozen); expect(short.sectExpansion.production.receipts).toEqual([]);
    expect(short.sectExpansion.production.nextId).toBe(1); expect(short.commandReceipts).toEqual({});
  });
  it('allows two genuine planned cancellations while both intermediate and final headroom remain deficient', () => {
    let source = place(createUnregisteredWorldV9('runtime-sequential-cancel'), 'one.place'); source = place(source, 'two.place', 10);
    source = deficient(source, 700_000); const initial = canonicalStringify(source);
    const first = dispatchCapacityLimitedCommandV9(source, cancelBlueprint(source, 'one.cancel'));
    expect(first.result.status).toBe('accepted'); expect(assessManagementCapacityV9(first.world).fits).toBe(false);
    const check = verifyCapacityLimitedCandidateV9(source, first.world);
    expect(check).toMatchObject({ ok: true, reason: 'reserved-recovery' }); expect(check.discharged).toHaveLength(1);
    const second = dispatchCapacityLimitedCommandV9(first.world, cancelBlueprint(first.world, 'two.cancel', 1));
    expect(second.result.status).toBe('accepted'); expect(assessManagementCapacityV9(second.world).fits).toBe(false);
    expect(second.world.sectExpansion.construction.blueprints.every(bp => bp.status === 'cancelled')).toBe(true);
    expect(canonicalStringify(source)).toBe(initial);
  });
  it('does not classify starting a previously planned owner as recovery', () => {
    const source = deficient(place(createUnregisteredWorldV9('runtime-owner-transfer'), 'planned'), 100_000);
    // No construction costs are available in this fresh fixture, so use a valid
    // base-resource fixture. New sect stock remains provenance-derived and zero.
    source.inventory.wood.owned = 99; source.inventory.stone.owned = 99; source.inventory.plank.owned = 99;
    const input = sectCommand(source, { domain: 'construction', command: { kind: 'construction.start', commandId: 'start.transfer',
      expectedRevision: source.sectExpansion.construction.revision, blueprintId: source.sectExpansion.construction.blueprints[0]!.blueprintId, workerId: 'entity:2' } });
    const candidate = prepareUnregisteredCommandCandidateV9(source, input); expect(candidate.result.status).toBe('accepted');
    expect(releaseEvidence(source, candidate.world).discharged).toEqual([]);
    expect(dispatchCapacityLimitedCommandV9(source, input).result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED');
  });
  it('supports the last real construction revision for cancellation while stopping any tick', () => {
    let source = place(createUnregisteredWorldV9('runtime-last-revision'), 'last.place');
    source = { ...source, sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]); expect(assessManagementCapacityV9(source).fits).toBe(false);
    const before = canonicalStringify(source); const stopped = advanceCapacityLimitedTicksV9(source, 1);
    expect(stopped.world).toBe(source); expect(stopped.stopped).not.toBeNull(); expect(canonicalStringify(source)).toBe(before);
    const applied = dispatchCapacityLimitedCommandV9(source, cancelBlueprint(source, 'last.cancel'));
    expect(applied.result.status).toBe('accepted'); expect(applied.world.sectExpansion.construction.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('authenticates a manual reserved cancellation including archive, ledger, event and receipt', () => {
    let source = createUnregisteredWorldV9('runtime-manual');
    const start = command(source, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'manual.start');
    source = accepted(source, start); source = deficient(source);
    const id = source.activeProductionTransactionIds[0]!;
    const input = command(source, { kind: 'production.cancel', payload: { transactionId: id } }, 'manual.cancel');
    const after = accepted(source, input);
    expect(releaseEvidence(source, after).discharged).toContain(`manual-production:${id}`);
    expect(after.inventory.wood.reserved).toBe(0); expect(after.history.production.count).toBe(1);
    expect(after.commandReceipts['manual.cancel']?.result.status).toBe('accepted');
    const retry = dispatchCapacityLimitedCommandV9(after, input); expect(retry.world).toBe(after); expect(retry.result.status).toBe('accepted');
    const conflict = dispatchCapacityLimitedCommandV9(after, { ...input, payload: { transactionId: 'instance:999' } });
    expect(conflict.world).toBe(after); expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT');
  });
  it('spends the last real event ID on authenticated cancellation despite the old headroom veto', () => {
    let source = createUnregisteredWorldV9('runtime-last-event-release');
    source = accepted(source, command(source, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'last.event.start'));
    source.sequences.nextEvent = Number.MAX_SAFE_INTEGER - 1;
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    const budget = assessManagementCapacityV9(source); expect(budget.supported).toBe(true); expect(budget.fits).toBe(false);
    expect(inspectV9KnownRecordHeadroom(source).length).toBeGreaterThan(0);
    const input = command(source, { kind: 'production.cancel', payload: { transactionId: source.activeProductionTransactionIds[0]! } }, 'last.event.cancel');
    const oldBoundary = dispatchUnregisteredCommandV9(source, input);
    expect(oldBoundary.world).toBe(source); expect(oldBoundary.result.rejection?.code).toBe('CAPACITY_EXCEEDED');
    const actual = dispatchCapacityLimitedCommandV9(source, input);
    expect(actual.result.status).toBe('accepted'); expect(actual.world.sequences.nextEvent).toBe(Number.MAX_SAFE_INTEGER);
    expect(actual.world.inventory.wood.reserved).toBe(0); expect(actual.world.inventory.wood.owned).toBe(source.inventory.wood.owned);
    expect(verifyCapacityLimitedCandidateV9(source, actual.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    expect(dispatchCapacityLimitedCommandV9(actual.world, input).world).toBe(actual.world);
  });
  it('authenticates an actual automatic cancellation and its durable exact-retry pin', () => {
    let source = createUnregisteredWorldV9('runtime-auto');
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'auto.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'auto.enable'));
    const tick = advanceCapacityLimitedTicksV9(source, 1); expect(tick.stopped).toBeNull(); source = deficient(tick.world);
    const id = source.activeProductionTransactionIds[0]!; expect(id).toMatch(/^auto-job\//);
    const input = command(source, { kind: 'production.cancel', payload: { transactionId: id } }, 'auto.cancel');
    const after = accepted(source, input); expect(releaseEvidence(source, after).discharged).toContain(`automatic-production:${id}`);
    expect(after.automaticProduction.pins[id as `auto-job/${number}`]?.retention).toBe('exact-receipt');
    expect(dispatchCapacityLimitedCommandV9(after, input).world).toBe(after);
  });
  it('rejects a forged committed automatic journal notice that never paid its nonempty inputs', () => {
    let source = createUnregisteredWorldV9('runtime-auto-forged-terminal');
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 99 }] } } } }, 'forged.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'forged.enable'));
    source = deficient(advanceCapacityLimitedTicksV9(source, 1).world, 700_000);
    const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`;
    const pair = source.automaticProduction.live[id]!; expect(pair.transaction.activeTicks).toBe(0); expect(pair.reservation.lines.length).toBeGreaterThan(0);
    let forged = prepareNormalTickCandidateV9(source);
    expect(forged.clock.simulationTick).toBe(source.clock.simulationTick + 1);
    expect(forged.automaticProduction.live[id]).toBeDefined(); // Genuine unfinished work tick, then forged settlement.
    forged = cloneJson(forged); delete forged.automaticProduction.live[id];
    forged.activeProductionTransactionIds = []; forged.disciples = forged.disciples.map(actor => actor.assignmentTransactionId === id ? { ...actor, assignmentTransactionId: null, traveling: false } : actor);
    forged.buildings = forged.buildings.map(site => site.stationTransactionId === id ? { ...site, stationTransactionId: null } : site);
    for (const line of pair.reservation.lines) forged.inventory[line.resourceId].reserved -= line.quantity;
    forged = recordAutomaticNotice(forged, { cycle: pair.transaction.origin.cycle, workerId: pair.transaction.workerId,
      recipeId: pair.transaction.recipeId, kind: 'committed', reason: null });
    expect(inspectUnregisteredWorldV9Records(forged)).toEqual([]); expect(assessManagementCapacityV9(forged).fits).toBe(false);
    expect(verifyCapacityLimitedCandidateV9(source, forged).ok).toBe(false);
    expect(releaseEvidence(source, forged).supported).toBe(false);
    expect(forged.inventory.wood.owned).toBe(source.inventory.wood.owned); expect(forged.inventory.plank.owned).toBe(source.inventory.plank.owned);
  });
  it('admits a genuine unpinned automatic completion only with exact real tick/payment evidence', () => {
    let source = createUnregisteredWorldV9('runtime-auto-real-completion');
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 1 }] } } } }, 'real.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'real.enable'));
    source = advanceCapacityLimitedTicksV9(source, 1).world; const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`;
    for (let i = 0; i < 400; i++) {
      const candidate = prepareNormalTickCandidateV9(source); if (!candidate.automaticProduction.live[id]) break; source = candidate;
    }
    expect(source.automaticProduction.live[id]).toBeDefined(); source = deficient(source, 700_000);
    const actual = advanceCapacityLimitedTicksV9(source, 1); expect(actual.stopped).toBeNull(); expect(actual.world.automaticProduction.live[id]).toBeUndefined();
    expect(actual.world.inventory.wood.owned).toBe(source.inventory.wood.owned - 3); expect(actual.world.inventory.plank.owned).toBe(source.inventory.plank.owned + 2);
    expect(verifyCapacityLimitedCandidateV9(source, actual.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
  });
  it('authenticates a genuine unpinned automatic natural-death cancellation', () => {
    let source = createUnregisteredWorldV9('runtime-auto-death');
    const actor = source.disciples.find(value => value.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    actor.birthCalendarTick = 2 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 99 }] } } } }, 'death.auto.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'death.auto.enable'));
    source = deficient(advanceCapacityLimitedTicksV9(source, 1).world, 700_000);
    const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`; expect(source.inventory.wood.reserved).toBe(3);
    const result = advanceCapacityLimitedTicksV9(source, 1); expect(result.stopped).toBeNull();
    expect(result.world.automaticProduction.pins[id]).toBeUndefined(); expect(result.world.automaticProduction.live[id]).toBeUndefined();
    expect(result.world.automaticProduction.journal.at(-1)?.kind).toBe('cancelled'); expect(result.world.inventory.wood.reserved).toBe(0);
    expect(result.world.inventory.wood.owned).toBe(source.inventory.wood.owned);
    const evidence = releaseEvidence(source, result.world); expect(evidence.supported).toBe(true);
    expect(evidence.discharged).toContain(`automatic-production:${id}`); expect(evidence.discharged).not.toContain('disciple-lifecycle:entity:2');
    expect(verifyCapacityLimitedCandidateV9(source, result.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
  });
  it('keeps exact retries and conflicts ahead of an unrelated old unconditional headroom veto', () => {
    let source = createUnregisteredWorldV9('runtime-priority');
    const input = command(source, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'priority.start');
    source = accepted(source, input); source.sequences.nextEvent = Number.MAX_SAFE_INTEGER - 1;
    expect(inspectV9KnownRecordHeadroom(source).length).toBeGreaterThan(0);
    const repeated = dispatchCapacityLimitedCommandV9(source, input); expect(repeated.world).toBe(source); expect(repeated.result.status).toBe('accepted');
    const conflict = dispatchCapacityLimitedCommandV9(source, { ...input, payload: { recipeId: 'gather.herbs', workerId: 'entity:2' } });
    expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT'); expect(conflict.world).toBe(source);
  });
  it('cancels work at pending death but retains its lifecycle owner until complete estate settlement', () => {
    let source = nearDeath(createUnregisteredWorldV9('runtime-death'), 'entity:2');
    source = accepted(source, sectCommand(source, { domain: 'production', command: { kind: 'production.start', commandId: 'death.start',
      expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2' } }));
    source = deficient(source); const before = canonicalStringify(source);
    const pending = advanceCapacityLimitedTicksV9(source, 1); expect(pending.stopped).toBeNull();
    const evidence = releaseEvidence(source, pending.world);
    expect(evidence.discharged.some(id => id.startsWith('sect.production:'))).toBe(true);
    expect(evidence.discharged).not.toContain('disciple-lifecycle:entity:2');
    expect(assessManagementCapacityV9(pending.world).progression!.owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === 'entity:2')).toBe(true);
    const death = pending.world.cultivation.pendingDeaths[0]!;
    const input = command(pending.world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: 'death.finalize',
      expectedRevision: pending.world.cultivation.revision, discipleId: 'entity:2', deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, 'death.finalize');
    const settled = accepted(pending.world, input);
    expect(releaseEvidence(pending.world, settled).discharged).toContain('disciple-lifecycle:entity:2');
    expect(settled.legacy.estates.find(estate => estate.deathId === death.deathId)?.settledMonth).not.toBeNull();
    expect(settled.legacy.archivedIdentities.some(actor => actor.discipleId === 'entity:2')).toBe(true);
    const partial = cloneJson(settled); partial.legacy.archivedIdentities = partial.legacy.archivedIdentities.filter(actor => actor.discipleId !== 'entity:2');
    expect(verifyCapacityLimitedCandidateV9(pending.world, partial)).toMatchObject({ ok: false, reason: 'unsupported-source' });
    expect(canonicalStringify(source)).toBe(before);
  });
  it('refuses missing owners and fabricated recovery without relaxing source validation', () => {
    const source = deficient(place(createUnregisteredWorldV9('runtime-forgery'), 'forgery.place'));
    const forged = cloneJson(source); forged.sectExpansion = { ...forged.sectExpansion, construction: { ...forged.sectExpansion.construction, blueprints: [] } };
    const check = verifyCapacityLimitedCandidateV9(source, forged); expect(check.ok).toBe(false); expect(check.reason).toBe('unsupported-source');
    const unchanged = cloneJson(source); expect(verifyCapacityLimitedCandidateV9(source, unchanged)).toMatchObject({ ok: false, reason: 'future-capacity' });
  });
  it('does not relax an actual hard cap even for an authentic prepared cancellation', () => {
    let source = place(createUnregisteredWorldV9('runtime-hard-cap'), 'hard.place');
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    source.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - assessManagementCapacityV9(source).measuredEnvelopeBytes!);
    expect(assessManagementCapacityV9(source).actualFits).toBe(true);
    const candidate = prepareUnregisteredCommandCandidateV9(source, cancelBlueprint(source, 'hard.cancel')); expect(candidate.result.status).toBe('accepted');
    expect(verifyCapacityLimitedCandidateV9(source, candidate.world)).toMatchObject({ ok: false, reason: 'actual-capacity' });
    expect(dispatchCapacityLimitedCommandV9(source, cancelBlueprint(source, 'hard.cancel')).world).toBe(source);
  });
  it('retries a rejected optional automatic start from the unchanged tick while retaining affordable work', () => {
    let source = createUnregisteredWorldV9('runtime-optional-auto');
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
      workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'optional.plan'));
    source = accepted(source, command(source, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'optional.enable'));
    source = atWireCost(source, SAVE_FILE_LIMIT_BYTES - 100);
    const before = canonicalStringify(source); const recovery = prepareNoOptionalGrowthTickCandidateV9(source);
    expect(assessManagementCapacityV9(recovery).fits).toBe(true);
    expect(assessManagementCapacityV9(prepareNormalTickCandidateV9(source)).fits).toBe(false);
    const actual = advanceCapacityLimitedTicksV9(source, 1); expect(actual.stopped).toBeNull(); expect(actual.world).toEqual(recovery);
    expect(actual.metrics).toEqual({ fullQueries: 3, normalCandidates: 1, noOptionalCandidates: 1 });
    expect(actual.world.sectEconomy.enabled).toBe(true); expect(actual.world.automaticProduction.nextCycle).toBe(1);
    expect(actual.world.sectEconomy.nextDecisionTick).toBe(source.sectEconomy.nextDecisionTick); expect(canonicalStringify(source)).toBe(before);
  });
  it('rolls back all state and returns only an ephemeral stop when even the no-optional tick is unsafe', () => {
    const source = deficient(createUnregisteredWorldV9('runtime-atomic-stop'), 1); const before = canonicalStringify(source);
    for (let i = 0; i < 3; i++) {
      const stopped = advanceCapacityLimitedTicksV9(source, 20); expect(stopped.stopped?.kind).toBe('capacity'); expect(stopped.world).toBe(source);
      expect(stopped.world.diagnostics).toHaveLength(1); expect(stopped.commandResults).toEqual([]); expect(canonicalStringify(source)).toBe(before);
    }
  });
  it('owns batch snapshots without caching or freezing mutable caller input and matches record-only scalar digit boundaries', () => {
    const source = createUnregisteredWorldV9('runtime-batch'); const before = canonicalStringify(source);
    const expected = advanceUnregisteredTicksV9(source, 20); const actual = advanceCapacityLimitedTicksV9(source, 20);
    expect(actual.stopped).toBeNull(); expect(actual.world).toEqual(expected.world); expect(actual.metrics.fullQueries).toBe(21);
    expect(Object.isFrozen(source)).toBe(false); expect(canonicalStringify(source)).toBe(before);
    const first = advanceCapacityLimitedTicksV9(source, 9); const second = advanceCapacityLimitedTicksV9(first.world, 11);
    expect(second.world).toEqual(actual.world);
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'caller edit' });
    expect(advanceCapacityLimitedTicksV9(source, 1).world.diagnostics).toEqual(source.diagnostics);
    expect(actual.world.diagnostics).toEqual([]);
  });
  it('rejects hostile input before getter execution and never stores a rejection receipt', () => {
    const source = createUnregisteredWorldV9('runtime-getter'); let reads = 0;
    Object.defineProperty(source.clock, 'simulationTick', { enumerable: true, get() { reads++; return 0; } });
    expect(advanceCapacityLimitedTicksV9(source, 1).stopped?.kind).toBe('invalid-records');
    expect(dispatchCapacityLimitedCommandV9(source, {}).result.rejection?.code).toBe('INVALID_WORLD_RECORDS'); expect(reads).toBe(0);
  });
  it('honors pauses without allocating any persistent capacity-stop marker', () => {
    const source = createUnregisteredWorldV9('runtime-paused'); source.clock = setPauseReason(source.clock, 'player', true);
    const result = advanceCapacityLimitedTicksV9(source, 20); expect(result.world).toBe(source); expect(result.stopped).toBeNull();
    expect(result.metrics.fullQueries).toBe(1); expect(result.metrics.normalCandidates).toBe(0);
  });
  it('admits the finite disjoint teaching subset while retaining one-short protection, .3 behavior and retry priority', () => {
    const source = createUnregisteredWorldV9('runtime-teaching-policy');
    source.cultivation = createCultivationStateV3(source.cultivation.disciples.map(profile => profile.discipleId === 'entity:2'
      ? { ...profile, knowledge: [{ knowledgeId: 'knowledge.test', teacherId: null, teachingId: null }] } : profile));
    const input = command(source, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: 'teaching.begin',
      expectedRevision: 0, discipleId: 'entity:2', studentId: 'entity:3', knowledgeId: 'knowledge.test' } } }, 'teaching.begin');
    const admitted = dispatchCapacityLimitedCommandV9(source, input); expect(admitted.result.status).toBe('accepted');
    const existing = dispatchUnregisteredCommandV9(source, input); expect(existing.result.status).toBe('accepted');
    expect(advanceUnregisteredTicksV9(existing.world, 1).stopped).toBeNull();
    const advanced = advanceCapacityLimitedTicksV9(existing.world, 1); expect(advanced.stopped).toBeNull(); expect(advanced.world.clock.simulationTick).toBe(1);
    const short = cloneJson(existing.world); short.sectExpansion = { ...short.sectExpansion, construction: { ...short.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 2 * CALENDAR_TICKS_PER_MONTH + 1 } };
    const stopped = advanceCapacityLimitedTicksV9(short, 1); expect(stopped.stopped?.kind).toBe('unsupported-continuation'); expect(stopped.world).toBe(short);
    expect(dispatchCapacityLimitedCommandV9(existing.world, input).result.status).toBe('accepted');
    const conflicting = command(existing.world, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: 'teaching.begin', expectedRevision: existing.world.cultivation.revision, discipleId: 'entity:2', mode: 'rest' } } }, 'teaching.begin');
    expect(dispatchCapacityLimitedCommandV9(existing.world, conflicting).result.rejection?.code).toBe('COMMAND_CONFLICT');
    expect(verifyCapacityLimitedCandidateV9(existing.world, existing.world).reason).toBe('ordinary');
    expect(verifyCapacityLimitedCandidateV9(short, short).reason).toBe('unsupported-continuation');
  });
});
