import { describe, expect, it } from 'vitest';
import { createCombatController } from '../../src/core/combat/ai';
import { createBattle, queryStat } from '../../src/core/combat/runtime';
import { applyBuildAuthorityCommand, applyBuildCommand } from '../../src/core/builds';
import { EXPEDITION_COMBAT_CATALOG, STARTER_ROUTE_ID } from '../../src/core/expeditions/encounter-catalog';
import { isWorldExpeditionCommand, previewWorldExpedition, projectWorldExpedition, validateWorldExpedition } from '../../src/core/expeditions/world-adapter';
import type { PlayerExpeditionCommand } from '../../src/core/expeditions/world-types';
import { advanceTicks, lookupProduction, CALENDAR_TICKS_PER_MONTH, cloneJson, createSaveEnvelope, createWorld, dispatchCommand, domainHash, parseSave, serializeSave,
  setPauseReason, validateWorldState, type Command, type WorldState } from '../../src/core/kernel';

type Input = PlayerExpeditionCommand extends infer C ? C extends PlayerExpeditionCommand ? Omit<C, 'commandId'> : never : never;
const metadata = { buildId: 'expedition-world-tests', savedAt: '2026-10-01T09:00:00Z' };
function act(world: WorldState, input: Input, commandId = `expedition-test:${world.commandReceipts ? Object.keys(world.commandReceipts).length + 1 : 1}`) {
  const command: Command = { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'expedition.command', payload: { command: { ...input, commandId } as PlayerExpeditionCommand } };
  const result = dispatchCommand(world, command);
  expect(result.result.status, JSON.stringify(result.result.rejection)).toBe('accepted');
  expect(validateWorldExpedition(result.world)).toEqual([]);
  expect(validateWorldState(result.world)).toEqual([]);
  return { ...result, command };
}
function reload(world: WorldState): WorldState {
  const parsed = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.world;
}
function depart(world = createWorld('expedition-world'), squad = world.disciples.slice(0, 2).map(member => member.id)) {
  return act(world, { kind: 'expedition.depart', request: { squadIds: squad, routeId: STARTER_ROUTE_ID } });
}
function reachNode(world: WorldState): WorldState {
  const next = advanceTicks(world, CALENDAR_TICKS_PER_MONTH * 2);
  expect(next.expedition.run?.phase).toBe('AtNode');
  expect(next.clock.pauseReasons).toContain('expedition');
  return next;
}
function finishBattle(world: WorldState): WorldState {
  let next = world;
  for (let step = 0; step < 70 && next.expedition.run?.phase === 'InEncounter'; step += 1) next = advanceTicks(next, 60);
  expect(next.expedition.run?.phase).not.toBe('InEncounter');
  expect(validateWorldExpedition(next)).toEqual([]);
  expect(validateWorldState(next)).toEqual([]);
  return next;
}
function runTrial(world: WorldState): WorldState {
  let next = world;
  for (let step = 0; step < 30 && next.expedition.run?.phase !== 'Ended'; step += 1) {
    const run = next.expedition.run!;
    if (run.phase === 'RewardPending') {
      const offer = run.offers.find(entry => entry.offerId === run.currentOfferId)!;
      next = act(next, { kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision }).world;
    } else if (run.phase === 'InEncounter') next = finishBattle(next);
    else if (next.expedition.travel) next = advanceTicks(next, CALENDAR_TICKS_PER_MONTH);
    else next = act(next, { kind: 'expedition.continue' }).world;
  }
  expect(next.expedition.run?.phase).toBe('Ended');
  return next;
}
function expireAt(world: WorldState, discipleId: string, calendarTick: number): WorldState {
  const next = cloneJson(world);
  const profile = next.cultivation.disciples.find(member => member.discipleId === discipleId)!;
  const disciple = next.disciples.find(member => member.id === discipleId)!;
  disciple.birthCalendarTick = calendarTick - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  disciple.ageMonths = Math.floor((next.clock.calendarTick - disciple.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
  profile.ageMonths = disciple.ageMonths;
  return next;
}
function acknowledgeDeath(world: WorldState, discipleId: string): WorldState {
  const profile = world.cultivation.disciples.find(member => member.discipleId === discipleId)!;
  const commandId = `ack-death:${discipleId}`;
  const result = dispatchCommand(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'cultivation.command', payload: { command: { commandId, expectedRevision: world.cultivation.revision, kind: 'death.finalize',
      discipleId, deathId: profile.pendingDeathId!, cause: 'lifespan', acknowledgeDeath: true } } });
  expect(result.result.status).toBe('accepted');
  expect(validateWorldState(result.world)).toEqual([]);
  return result.world;
}

describe('atomic World expedition integration', () => {
  it('previews the exact four-month cost and permits a two-member trial with the initial eight meals', () => {
    const world = createWorld('departure-preview'); const squadIds = world.disciples.slice(0, 2).map(member => member.id);
    expect(previewWorldExpedition(world, { squadIds, routeId: STARTER_ROUTE_ID })).toMatchObject({ expectedMonths: 4, minimumSupplies: [{ resourceId: 'meal', quantity: 8 }], blockers: [] });
    expect(previewWorldExpedition(world, { squadIds: world.disciples.map(member => member.id), routeId: STARTER_ROUTE_ID }).blockers).toContain('INSUFFICIENT_SUPPLIES');
    const first = depart(world);
    expect(first.world.inventory.meal.owned).toBe(0);
    expect(first.world.expedition.run?.supplies).toEqual([{ resourceId: 'meal', quantity: 6 }]);
    expect(first.world.expedition.run?.admittedCheckpoint?.supplyCost).toEqual([{ resourceId: 'meal', quantity: 2 }]);
    expect(first.world.expedition.travel?.targetCalendarTick).toBe(1200);
    for (const id of squadIds) {
      expect(first.world.cultivation.disciples.find(member => member.discipleId === id)?.activityOwner?.runId).toBe(first.world.expedition.run?.runId);
      expect(first.world.builds.disciples.find(member => member.discipleId === id)?.lock?.runId).toBe(first.world.expedition.run?.runId);
    }
    const duplicate = dispatchCommand(reload(first.world), first.command);
    expect(duplicate.world.inventory).toEqual(first.world.inventory);
    expect(duplicate.world.expedition).toEqual(first.world.expedition);
  });

  it('cancels an actual production reservation and blocks away training/work without changing return intent', () => {
    let world = createWorld('lock-activity'); const id = world.disciples[1]!.id;
    const production = dispatchCommand(world, { kind: 'production.start', commandId: 'before-departure', sequence: 0, issuedTick: 0, payload: { recipeId: 'craft.plank', workerId: id } });
    expect(production.result.status).toBe('accepted'); world = production.world;
    const started = depart(world).world;
    expect(lookupProduction(started, production.result.transactionId!)!.state).toBe('Cancelled');
    expect(started.inventory.wood.reserved).toBe(0);
    const profile = started.cultivation.disciples.find(member => member.discipleId === id)!;
    const denied = dispatchCommand(started, { commandId: 'train-away', sequence: 1, issuedTick: 0, kind: 'cultivation.command', payload: {
      command: { commandId: 'train-away', expectedRevision: started.cultivation.revision, kind: 'training.set', discipleId: id, mode: 'training' },
    } });
    expect(denied.result.status).toBe('rejected');
    const progressed = reachNode(started);
    expect(progressed.cultivation.disciples.find(member => member.discipleId === id)?.cultivation).toBe(profile.cultivation);
    expect(progressed.cultivation.disciples.find(member => member.discipleId === id)?.trainingMode).toBe(profile.trainingMode);
  });

  it('restores a partial prepaid month and respects player and hidden pauses without refund or duplicate debit', () => {
    const started = depart().world;
    const partial = advanceTicks(started, 417);
    expect(partial.clock.calendarTick).toBe(417);
    const frozenCargo = partial.expedition.run!.supplies;
    for (const reason of ['hidden', 'player'] as const) {
      const paused = { ...partial, clock: setPauseReason(partial.clock, reason, true) };
      expect(advanceTicks(paused, 5000).clock.calendarTick).toBe(417);
    }
    const restored = reload(partial);
    expect(domainHash(reachNode(restored))).toBe(domainHash(reachNode(partial)));
    expect(reachNode(restored).expedition.run?.supplies).toEqual(frozenCargo);
  });

  it('commits a reached checkpoint after death acknowledgement before any extra calendar tick', () => {
    let world = createWorld('target-death'); const discipleId = world.disciples[0]!.id;
    world = expireAt(world, discipleId, 1200);
    expect(previewWorldExpedition(world, { squadIds: world.disciples.slice(0, 2).map(member => member.id), routeId: STARTER_ROUTE_ID }).warnings)
      .toContainEqual({ code: 'LIFESPAN_BEFORE_RETURN', discipleId });
    const atRisk = advanceTicks(depart(world).world, 2000);
    expect(atRisk.clock.calendarTick).toBe(1200);
    expect(atRisk.clock.pauseReasons).toContain('cultivation');
    expect(atRisk.expedition.run?.travelLedger).toHaveLength(0);
    expect(atRisk.expedition.run?.admittedCheckpoint).not.toBeNull();
    const resolved = acknowledgeDeath(reload(atRisk), discipleId);
    const beforeExtraTick = advanceTicks(resolved, 1);
    expect(beforeExtraTick.clock.calendarTick).toBe(1200);
    expect(beforeExtraTick.expedition.run?.phase).toBe('AtNode');
    expect(beforeExtraTick.expedition.run?.travelLedger).toHaveLength(1);
    expect(beforeExtraTick.expedition.run?.supplies).toEqual([{ resourceId: 'meal', quantity: 6 }]);
    expect(beforeExtraTick.expedition.run?.members.find(member => member.discipleId === discipleId)?.permanentDeathId)
      .toBe(beforeExtraTick.cultivation.disciples.find(member => member.discipleId === discipleId)?.deathId);
  });

  it('records mid-month abandonment when all travelers die and never charges/refunds the prepaid month twice', () => {
    let world = createWorld('midmonth-death'); const ids = world.disciples.slice(0, 2).map(member => member.id);
    for (const id of ids) world = expireAt(world, id, 17);
    let stopped = advanceTicks(depart(world).world, 1200);
    expect(stopped.clock.calendarTick).toBe(17);
    for (const id of ids) stopped = acknowledgeDeath(stopped, id);
    stopped = advanceTicks(stopped, 1);
    expect(stopped.expedition.run?.phase).toBe('Ended');
    expect(stopped.expedition.run?.abandonedCheckpoints).toHaveLength(1);
    expect(stopped.expedition.run?.travelLedger).toHaveLength(0);
    expect(stopped.inventory.meal.owned).toBe(6);
    expect(reload(stopped).inventory).toEqual(stopped.inventory);
  });

  it('runs real combat, saves its controller, freezes the calendar, and never maps enemy IDs to World disciples', () => {
    let world = act(reachNode(depart().world), { kind: 'expedition.continue' }).world;
    const battle = world.expedition.battle!;
    expect(battle.participants.map(entry => entry.discipleId)).toEqual(world.disciples.slice(0, 2).map(member => member.id));
    expect(battle.enemies.some(enemy => world.disciples.some(member => member.id === enemy.battleEntityId))).toBe(true);
    const calendar = world.clock.calendarTick;
    world = advanceTicks(world, 40);
    expect(world.clock.calendarTick).toBe(calendar);
    expect(world.expedition.battle!.controller.elapsedTicks).toBe(40);
    const restored = reload(world);
    const first = finishBattle(world); const second = finishBattle(restored);
    expect(domainHash(second)).toBe(domainHash(first));
    expect(first.expedition.run?.phase).toBe('RewardPending');
    for (const disciple of first.disciples.slice(2)) expect(disciple.lifeState).toBe('alive');
    expect(first.cultivation.deaths).toHaveLength(0);
  }, 60_000);

  it('completes three real encounters and two saved offers, returns once, and grants one first-victory milestone', () => {
    const started = depart(createWorld('full-trial')).world;
    const ended = runTrial(started);
    expect(ended.expedition.run?.settlement?.reason).toBe('victory');
    expect(ended.clock.calendarTick).toBe(4800);
    expect(ended.expedition.run?.encounterResults).toHaveLength(3);
    expect(ended.expedition.run?.offers).toHaveLength(2);
    expect(ended.expedition.history).toHaveLength(1);
    expect(ended.builds.awards.filter(award => award.ruleId === 'expedition.first-victory')).toHaveLength(2);
    expect(ended.cultivation.disciples.every(profile => profile.activityOwner === null)).toBe(true);
    expect(ended.builds.disciples.every(profile => profile.lock === null)).toBe(true);
    const restored = reload(ended);
    expect(restored.expedition).toEqual(ended.expedition);
    expect(restored.inventory).toEqual(ended.inventory);
    expect(ended.expedition.effectReceipts.filter(receipt => receipt.kind === 'runSettled')).toHaveLength(1);
    expect(ended.clock.pauseReasons).not.toContain('expedition');
  }, 60_000);

  it('normalizes a real controller timeout as injured forced withdrawal without fabricated permanent deaths or victory rewards', () => {
    let world = act(reachNode(depart(createWorld('timeout-policy')).world), { kind: 'expedition.continue' }).world;
    const encounter = world.expedition.battle!;
    // Test-only short controller horizon; the terminal state is still produced by the real executor.
    const controller = createCombatController(EXPEDITION_COMBAT_CATALOG, encounter.controller.battle, {
      playerTeam: 'sect', arena: cloneJson(encounter.controller.config.arena), maximumTicks: 1,
    });
    world = { ...world, expedition: { ...world.expedition, battle: { ...encounter, controller, configHash: controller.configHash } } };
    world = advanceTicks(world, 1);
    expect(world.expedition.run?.phase).toBe('Ending');
    expect(world.expedition.forcedWithdrawal).toBe(true);
    expect(world.expedition.run?.settlement?.reason).toBe('defeat');
    expect(world.expedition.run?.settlement?.loot).toEqual([]);
    expect(world.cultivation.deaths).toEqual([]);
    expect(world.expedition.run?.members.every(member => member.alive && member.permanentDeathId === null && member.injury > 0)).toBe(true);
    world = act(world, { kind: 'expedition.continue' }).world;
    world = advanceTicks(world, 1200);
    expect(world.expedition.run?.phase).toBe('Ended');
    expect(world.expedition.history[0]?.forcedWithdrawal).toBe(true);
  });

  it('retains a capacity-blocked settlement and all locks until the entire credit can commit', () => {
    let world = finishBattle(act(reachNode(depart(createWorld('capacity-return')).world), { kind: 'expedition.continue' }).world);
    expect(world.expedition.run?.phase).toBe('RewardPending');
    world = act(world, { kind: 'expedition.retreat' }).world;
    const reward = world.expedition.run!.settlement!.loot[0]!;
    world = { ...world, inventory: { ...world.inventory, [reward.resourceId]: { ...world.inventory[reward.resourceId], owned: world.inventory[reward.resourceId].capacity } } };
    world = act(world, { kind: 'expedition.continue' }).world;
    world = advanceTicks(world, 1200);
    expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    expect(world.expedition.run?.phase).toBe('Ending');
    expect(world.expedition.run?.settlement?.committed).toBe(false);
    expect(world.expedition.effectReceipts.some(receipt => receipt.kind === 'runSettled')).toBe(false);
    world = { ...world, inventory: { ...world.inventory, [reward.resourceId]: { ...world.inventory[reward.resourceId], owned: world.inventory[reward.resourceId].capacity - reward.quantity } } };
    world = act(reload(world), { kind: 'expedition.continue' }).world;
    expect(world.expedition.run?.phase).toBe('Ended');
    expect(world.inventory[reward.resourceId].owned).toBe(world.inventory[reward.resourceId].capacity);
  }, 60_000);

  it('maps an actual local permanent battle death to one distinct global death identity and persists it', () => {
    let world = act(reachNode(depart(createWorld('death-id-map')).world), { kind: 'expedition.continue' }).world;
    const encounter = world.expedition.battle!;
    const basic = { coefficientBps: 10_000, cooldownTicks: 10, castTicks: 0, rangeUnits: 600, school: 'sword' as const };
    const battle = createBattle(EXPEDITION_COMBAT_CATALOG, { seed: 'actual-death-fixture', contentMode: 'experimental', entities: [
      { id: encounter.participants[0]!.battleEntityId, team: 'sect', position: { x: 80, y: 80 }, stats: { attack: 1, maxHealth: 1 }, deathRule: 'immediate', basic },
      { id: encounter.participants[1]!.battleEntityId, team: 'sect', position: { x: 80, y: 160 }, stats: { attack: 1, maxHealth: 100 }, deathRule: 'downed', basic },
      { id: 'entity:3', team: 'foe', position: { x: 160, y: 80 }, stats: { attack: 1000, maxHealth: 1000 }, deathRule: 'immediate', basic },
    ] });
    const controller = createCombatController(EXPEDITION_COMBAT_CATALOG, battle, { playerTeam: 'sect', arena: cloneJson(encounter.controller.config.arena), maximumTicks: 200 });
    world = { ...world, expedition: { ...world.expedition, battle: { ...encounter, controller, configHash: controller.configHash } } };
    world = finishBattle(world);
    const mappings = world.expedition.deathMappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.worldDeathId).not.toBe(mappings[0]!.battleDeathId);
    expect(world.cultivation.deaths.filter(death => death.deathId === mappings[0]!.worldDeathId)).toHaveLength(1);
    expect(world.expedition.run?.members.find(member => member.discipleId === mappings[0]!.discipleId)?.permanentDeathId).toBe(mappings[0]!.worldDeathId);
    const restored = reload(world);
    expect(restored.expedition.deathMappings).toEqual(mappings);
    expect(restored.cultivation.deaths).toEqual(world.cultivation.deaths);
    expect(restored.disciples[2]!.lifeState).toBe('alive'); // enemy entity:3 is not this World entity
  });

  it('rejects trusted commands at the player boundary and exposes bounded view data', () => {
    expect(isWorldExpeditionCommand({ commandId: 'forged:1', kind: 'encounter.resolve', result: {} })).toBe(false);
    expect(isWorldExpeditionCommand({ commandId: 'forged:1', kind: 'time.commit', checkpointId: 'x', expectedCalendarMonth: 0, resultingCalendarMonth: 1 })).toBe(false);
    const view = projectWorldExpedition(depart().world);
    expect('commandLog' in view).toBe(false);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.travelTotalTicks).toBe(1200);
  });

  it('keeps an ended run historical when a returned disciple later dies naturally', () => {
    let world = reachNode(depart(createWorld('historical-life')).world);
    world = act(world, { kind: 'expedition.retreat' }).world;
    world = act(world, { kind: 'expedition.continue' }).world;
    world = advanceTicks(world, 1200);
    expect(world.expedition.run?.phase).toBe('Ended');
    const discipleId = world.disciples[0]!.id;
    world = expireAt(world, discipleId, world.clock.calendarTick + 17);
    world = advanceTicks(world, 17);
    world = acknowledgeDeath(world, discipleId);
    expect(world.expedition.run?.members.find(member => member.discipleId === discipleId)?.alive).toBe(true); // historical return snapshot
    expect(world.cultivation.disciples.find(member => member.discipleId === discipleId)?.lifeState).toBe('dead');
    expect(validateWorldState(reload(world))).toEqual([]);
  });

  it('admits permanent max-health sources once before applying full and wounded health fractions', () => {
    for (const injury of [0, 50]) {
      let world = createWorld(`tree-health:${injury}`);
      const bodyId = world.builds.disciples.find(member => member.school === 'body')!.discipleId;
      // Explicit authority fixture grant isolates battle admission, not the first-victory unlock workflow.
      const award = applyBuildAuthorityCommand({ builds: world.builds, sequences: world.sequences }, { kind: 'milestone.award',
        commandId: 'fixture.body-point', expectedRevision: world.builds.revision, milestoneId: 'fixture.body-point', discipleId: bodyId, ruleId: 'expedition.first-victory' }, EXPEDITION_COMBAT_CATALOG);
      if (!award.ok) throw new Error(award.code);
      const tree = applyBuildCommand(award.frame, { kind: 'tree.respec', commandId: 'fixture.houtu', expectedRevision: award.frame.builds.revision,
        discipleId: bodyId, nodeIds: ['node.body.houtu'] }, EXPEDITION_COMBAT_CATALOG);
      if (!tree.ok) throw new Error(tree.code);
      world = { ...world, builds: cloneJson(tree.frame.builds), sequences: cloneJson(tree.frame.sequences), cultivation: { ...world.cultivation,
        disciples: world.cultivation.disciples.map(member => member.discipleId === bodyId ? { ...member, injury } : member) } } as WorldState;
      world = act(reachNode(depart(world, [bodyId]).world), { kind: 'expedition.continue' }).world;
      const encounter = world.expedition.battle!;
      const battleId = encounter.participants[0]!.battleEntityId;
      const maximum = queryStat(encounter.controller.battle, EXPEDITION_COMBAT_CATALOG, battleId, 'maxHealth');
      const entity = encounter.controller.battle.entities[battleId]!;
      expect(maximum).toBeGreaterThan(world.expedition.run!.members[0]!.loadout.stats.maxHealth);
      expect(entity.health).toBe(Math.floor(maximum * (100 - injury) / 100));
      expect(Object.values(encounter.controller.battle.sources).filter(source => source.sourceDefinitionId === 'node.body.houtu')).toHaveLength(1);
      expect(reload(world).expedition.battle?.controller.battle.entities[battleId]?.health).toBe(entity.health);
    }
  });

  it('rejects overflow before publishing any departure debit, lock or source change', () => {
    const world = createWorld('departure-overflow');
    world.cultivation.revision = Number.MAX_SAFE_INTEGER;
    const result = dispatchCommand(world, { kind: 'expedition.command', commandId: 'overflow.depart', sequence: 0, issuedTick: 0,
      payload: { command: { kind: 'expedition.depart', commandId: 'overflow.depart', request: { routeId: STARTER_ROUTE_ID, squadIds: world.disciples.slice(0, 2).map(member => member.id) } } } });
    expect(result.result.status).toBe('rejected');
    expect(result.world.inventory).toEqual(world.inventory);
    expect(result.world.expedition).toEqual(world.expedition);
    expect(result.world.builds).toEqual(world.builds);
    expect(result.world.sequences).toEqual(world.sequences);
    expect(result.world.cultivation).toEqual(world.cultivation);
  });
});
