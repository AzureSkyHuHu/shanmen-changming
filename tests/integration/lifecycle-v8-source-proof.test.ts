import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { appendWorldEvents } from '../../src/core/world/history-access';
import { describe, expect, it } from 'vitest';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { validateWorldLifecycleSources } from '../../src/core/world/lifecycle-source-proof';
import { applyCultivationCommandV3 } from '../../src/core/cultivation/v3';
import { cloneJson } from '../../src/core/kernel/serialization';
import { advanceTicksWithStatusV8 } from '../../src/core/kernel/simulation-v8';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

describe('new lifecycle cause authority', () => {
  it('rejects a valid standalone combat-death command without a registered mapped battle', () => {
    const world = createWorldV8('unearned-combat-death'); const discipleId = world.disciples[0]!.id;
    // A domain authority command is syntactically legal, but not a World source.
    const reserved = { ...world.sequences, nextInstance: world.sequences.nextInstance + 1 };
    const death = applyCultivationCommandV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: reserved }, {
      commandId: 'fake-domain-combat', expectedRevision: world.cultivation.revision, kind: 'death.finalize', discipleId,
      deathId: `instance:${world.sequences.nextInstance}`, cause: 'combat', acknowledgeDeath: true });
    expect(death.ok).toBe(true); if (!death.ok) throw new Error(death.code);
    const candidate: WorldStateV8 = { ...world, ...death.frame };
    expect(validateWorldLifecycleSources(candidate)).toEqual(['Combat death has no mapped registered encounter']);
    const mirrored = appendWorldEvents({ ...candidate, disciples: candidate.disciples.map(actor => actor.id === discipleId ? { ...actor, lifeState: 'dead' as const, canWork: false } : actor) },
      candidate.cultivation.events.map(event => ({ eventId: event.eventId, kind: event.kind, tick: 0, rootActionId: event.rootActionId, parentEventId: null,
        payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month } })));
    expect(validateWorldStateV8(mirrored)).toContain('Combat death has no mapped registered encounter');
  });
  it('accepts actual expiry and permanent death, then rejects relabeling it as breakthrough', () => {
    let world = createWorldV8('actual-life-proof'); const profile = world.cultivation.disciples[0]!; const actor = world.disciples[0]!;
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    const stepped = advanceTicksWithStatusV8(world, 1); expect(stepped.invariantStop).toBeNull(); world = stepped.world;
    expect(validateWorldLifecycleSources(world)).toEqual([]);
    const pending = world.cultivation.pendingDeaths[0]!;
    const acknowledged = dispatchCommandV8(world, { kind: 'cultivation.command', commandId: 'source:finalize', sequence: 1, issuedTick: world.clock.simulationTick,
      payload: { command: { kind: 'death.finalize', commandId: 'source:finalize', expectedRevision: world.cultivation.revision,
        discipleId: actor.id, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(acknowledged.result.status).toBe('accepted'); expect(validateWorldLifecycleSources(acknowledged.world)).toEqual([]);
    const forged: WorldStateV8 = cloneJson(acknowledged.world); forged.cultivation.deaths[0]!.cause = 'breakthrough';
    expect(validateWorldLifecycleSources(forged)).toEqual(['Breakthrough death has no resolved sampled attempt']);
  });
});
