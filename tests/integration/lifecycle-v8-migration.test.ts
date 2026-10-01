import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSave } from '../../src/core/kernel/save';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateWorldLifecycleMigration } from '../../src/core/world/lifecycle-migration';
import { cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { advanceTicks } from '../../src/core/kernel/simulation';
import { dispatchCommand } from '../../src/core/kernel/commands';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import type { WorldState } from '../../src/core/world/types';
function legacy() {
  const text = readFileSync(new URL('./fixtures/save-v7-active-automatic.json', import.meta.url), 'utf8'); const parsed = parseSave(text);
  if (!parsed.ok) throw new Error(parsed.error.message); return { text, world: parsed.world };
}
function actualOldDeath() {
  let world: WorldState = cloneJson(legacy().world);
  const profile = world.cultivation.disciples[3]!; const actor = world.disciples.find(entry => entry.id === profile.discipleId)!;
  // Explicit near-expiry fixture arrangement; the actual expiry/death is still
  // processed by the frozen v7 engine before the migration is invoked.
  actor.birthCalendarTick = world.clock.calendarTick + 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  world = advanceTicks(world, 1);
  const pending = world.cultivation.pendingDeaths.find(entry => entry.discipleId === actor.id)!;
  const result = dispatchCommand(world, { kind: 'cultivation.command', commandId: 'old:death', sequence: 100, issuedTick: world.clock.simulationTick,
    payload: { command: { kind: 'death.finalize', commandId: 'old:death', expectedRevision: world.cultivation.revision,
      discipleId: actor.id, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
  expect(result.result.status).toBe('accepted'); return migrateWorldV7ToV8(result.world);
}
describe('explicit legacy lifecycle ownership', () => {
  it('binds genuine source prefixes without mutating the saved bytes', () => {
    const original = legacy(); const before = stableHash(original.world); const migrated = migrateWorldV7ToV8(original.world);
    expect(validateWorldLifecycleMigration(migrated)).toEqual([]); expect(stableHash(original.world)).toBe(before);
    expect(migrated.legacy.migrationLifecycle?.receiptCount).toBe(original.world.cultivation.receipts.length);
    expect(readFileSync(new URL('./fixtures/save-v7-active-automatic.json', import.meta.url), 'utf8')).toBe(original.text);
  });
  it('requires null metadata in fresh Worlds and rejects a changed summary', () => {
    const world = actualOldDeath(); expect(validateWorldLifecycleMigration(world)).toEqual([]);
    const changed = cloneJson(world); changed.legacy.migrationLifecycle!.finalizedDeaths[0]!.discipleId = 'entity:999';
    expect(validateWorldLifecycleMigration(changed).length).toBeGreaterThan(0);
    const fresh = createWorldV8('no-legacy-exception'); fresh.legacy.migrationLifecycle = cloneJson(world.legacy.migrationLifecycle);
    expect(validateWorldLifecycleMigration(fresh)).toEqual(['Fresh World cannot claim legacy lifecycle exceptions']);
  });
  it('rejects enlarged prefixes and post-migration death events borrowing old exemptions', () => {
    const world = actualOldDeath(); const enlarged = cloneJson(world); enlarged.legacy.migrationLifecycle!.receiptCount++;
    expect(validateWorldLifecycleMigration(enlarged).length).toBeGreaterThan(0);
    const forged = cloneJson(world); const original = forged.cultivation.events.find(event => event.kind === 'cultivation.died')!;
    forged.cultivation.events.push({ ...original, eventId: `event:${forged.sequences.nextEvent}`, rootActionId: `action:${forged.sequences.nextAction}` });
    expect(validateWorldLifecycleMigration(forged)).toEqual(['New death borrowed an old lifecycle exception']);
  });
});
