import { describe, expect, it } from 'vitest';
import { advanceTicks, CALENDAR_TICKS_PER_MONTH, createWorld, dispatchCommand, validateWorldState } from '../../src/core/kernel';
import type { PlayerCultivationCommand, WorldState } from '../../src/core/kernel';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { cloneJson } from '../../src/core/kernel/serialization';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import { assessWorldBuildHistoryObligations } from '../../src/core/world/progression-obligations';

type CultureInput<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function culture(world: WorldState, body: CultureInput<PlayerCultivationCommand>): WorldState {
  const commandId = `estate-player:${world.cultivation.revision}`;
  const result = dispatchCommand(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'cultivation.command', payload: { command: { ...body, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); expect(validateWorldState(result.world)).toEqual([]); return result.world;
}
function expireAt(world: WorldState, index: number, tick: number) {
  const profile = world.cultivation.disciples[index]!; const actor = world.disciples[index]!;
  actor.birthCalendarTick = tick - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
}
function acknowledge(world: WorldState, index: number) {
  const profile = world.cultivation.disciples[index]!;
  return culture(world, { kind: 'death.finalize', discipleId: profile.discipleId, deathId: profile.pendingDeathId!, cause: 'lifespan', acknowledgeDeath: true });
}
function realDeath(heir = true) {
  let world = createWorld('estate-world-boundary');
  if (heir) world = culture(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' });
  expireAt(world, 0, 17); world = advanceTicks(world, 17); return acknowledge(world, 0);
}

describe('unpublished v8 World estate settlement candidates', () => {
  it('atomically retires, transfers and archives a real World lifespan death, preserving receipts and source input', () => {
    const source = realDeath(); const world = migrateWorldV7ToV8(source); const before = cloneJson(world);
    const items = world.legacy.estates[0]!.itemInstanceIds; const deathId = world.cultivation.deaths[0]!.deathId;
    const rowsBefore = assessWorldBuildHistoryObligations(world);
    const result = prepareWorldEstateSettlement(world);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.settledDeathIds).toEqual([deathId]); expect(result.pendingDeathIds).toEqual([]);
    expect(validateWorldStateV8(result.candidate)).toEqual([]);
    expect(result.candidate.disciples.map(member => member.id)).not.toContain('entity:1');
    expect(result.candidate.legacy.archivedIdentities[0]).toMatchObject({ discipleId: 'entity:1', deathId, presentationId: 'disciple-0' });
    expect(result.candidate.builds.equipment.filter(item => items.includes(item.instanceId)).every(item => item.owner.kind === 'disciple' && item.owner.discipleId === 'entity:2')).toBe(true);
    expect(result.candidate.sequences).toEqual(world.sequences); expect(result.candidate.randomStreams).toEqual(world.randomStreams);
    expect(result.candidate.commandReceipts).toEqual(world.commandReceipts); expect(result.candidate.events).toEqual(world.events);
    expect(result.candidate.history).toBe(world.history);
    const rowsAfter = assessWorldBuildHistoryObligations(result.candidate);
    expect(rowsAfter.historyCount + rowsAfter.reservedCommands).toBeLessThanOrEqual(rowsBefore.historyCount + rowsBefore.reservedCommands);
    expect(world).toEqual(before);
    const retry = prepareWorldEstateSettlement(result.candidate);
    expect(retry.ok).toBe(true); if (!retry.ok) throw new Error(retry.details.join('; '));
    expect(retry.settledDeathIds).toEqual([]); expect(retry.candidate).toEqual(result.candidate);
  });

  it('keeps estate ownership when no living heir was committed', () => {
    const world = migrateWorldV7ToV8(realDeath(false)); const result = prepareWorldEstateSettlement(world);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.details.join('; '));
    expect(validateWorldStateV8(result.candidate)).toEqual([]);
    expect(result.candidate.legacy.estates[0]!.settledOwner).toEqual({ kind: 'sect-estate' });
    expect(result.candidate.builds.equipment.filter(item => result.candidate.legacy.estates[0]!.itemInstanceIds.includes(item.instanceId)).every(item => item.owner.kind === 'sect-estate')).toBe(true);
  });

  it('keeps a real dead traveler locked with every source/item until the run actually unlocks', () => {
    let previous = createWorld('locked-estate'); expireAt(previous, 0, 17);
    const commandId = 'estate:depart';
    const departure = dispatchCommand(previous, { commandId, sequence: 0, issuedTick: 0, kind: 'expedition.command', payload: { command: { commandId, kind: 'expedition.depart',
      request: { routeId: 'route.qingfeng-trial', squadIds: ['entity:1', 'entity:2'] } } } });
    expect(departure.result.status).toBe('accepted'); previous = acknowledge(advanceTicks(departure.world, 17), 0);
    const world = migrateWorldV7ToV8(previous); const result = prepareWorldEstateSettlement(world);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.settledDeathIds).toEqual([]); expect(result.pendingDeathIds).toEqual([world.cultivation.deaths[0]!.deathId]);
    expect(result.candidate.builds).toEqual(world.builds); expect(result.candidate.expedition).toEqual(world.expedition);
    expect(result.candidate.cultivation).toEqual(world.cultivation); expect(validateWorldStateV8(result.candidate)).toEqual([]);
  });

  it('returns a transient preparation failure without publishing a partial retirement when its complete bytes cannot fit', () => {
    const base = migrateWorldV7ToV8(realDeath());
    const unpadded = { ...base, legacyAudit: '' }; const bytes = measureWorldSaveBytes(unpadded, { saveVersion: 8 });
    const nearCap = { ...unpadded, legacyAudit: 'x'.repeat(SAVE_FILE_LIMIT_BYTES - bytes) };
    expect(measureWorldSaveBytes(nearCap, { saveVersion: 8 })).toBe(SAVE_FILE_LIMIT_BYTES);
    expect(validateWorldStateV8(nearCap)).toEqual([]);
    const before = cloneJson(nearCap); const result = prepareWorldEstateSettlement(nearCap);
    expect(result).toMatchObject({ ok: false, code: 'SAVE_CAPACITY_EXCEEDED' });
    expect(nearCap).toEqual(before);
  });
});
