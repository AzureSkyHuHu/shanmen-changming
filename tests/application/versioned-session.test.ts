import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8, dispatchCommandV8, advanceTicksV8, validateWorldStateV8 } from '../../src/core/kernel/v8';
import { lookupProduction } from '../../src/core/world/history-access';
import { createVersionedSaveEnvelope, parseVersionedSave, serializeVersionedSave } from '../../src/platform/save-codec';

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

const metadata = { buildId: 'versioned-session-test', savedAt: '2026-10-01T18:00:00Z' };

describe('genuine versioned application Session', () => {
  it('owns frozen fresh v8 input and exposes detached, frozen projections without changing source bytes', () => {
    const input = createWorldV8('session-v8-owned');
    const before = JSON.stringify(input);
    freezeTree(input);
    const session = new ApplicationSession(input);
    expect(session.getEngineVersion()).toBe(8);
    expect(session.getSaveIdentity()).toEqual({ saveVersion: 8, simulationVersion: input.simulationVersion, contentVersion: input.contentVersion });
    expect(session.exportWorld()).toEqual(input);
    expect(session.getBuildFrame().builds.schemaVersion).toBe(2);
    expect(Object.isFrozen(session.getBuildFrame().builds)).toBe(true);
    const projection = session.getSnapshot();
    expect(Object.isFrozen(projection.disciples[0]!.position)).toBe(true);
    expect(Reflect.set(projection.disciples[0]!.position, 'x', 999)).toBe(false);
    const exported = session.exportWorld();
    exported.inventory.wood.owned = 0;
    exported.disciples[0]!.position.x = 999;
    expect(session.exportWorld()).toEqual(input);
    session.frame(0); session.frame(50);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(session.getSnapshot().capacityStop).toBeNull();
    expect(validateWorldStateV8(session.exportWorld())).toEqual([]);
  });

  it('dispatches and advances through the v8 authority and roundtrips the exact complete boundary', () => {
    const input = createWorldV8('session-v8-replay');
    freezeTree(input);
    const before = JSON.stringify(input);
    const session = new ApplicationSession(input);
    const workerId = session.getSnapshot().disciples.find(actor => actor.canWork)!.id;
    const payload = { recipeId: 'craft.plank', workerId };
    const result = session.dispatch({ kind: 'production.start', payload });
    expect(result.status).toBe('accepted');
    const direct = dispatchCommandV8(input, { kind: 'production.start', payload, commandId: result.commandId, sequence: 0, issuedTick: 0 });
    expect(result).toEqual(direct.result);
    expect(session.exportWorld()).toEqual(direct.world);
    payload.recipeId = 'unknown';
    expect(lookupProduction(session.exportWorld(), result.transactionId!)!.recipeId).toBe('craft.plank');
    session.frame(0); session.frame(1000);
    const advanced = session.exportWorld();
    expect(advanced.clock.simulationTick).toBe(20);
    expect(advanced).toEqual(advanceTicksV8(direct.world, 20));
    const text = serializeVersionedSave(createVersionedSaveEnvelope(advanced, metadata));
    const parsed = parseVersionedSave(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.envelope.saveVersion).toBe(8);
    expect(parsed.migration).toBeNull();
    expect(parsed.world).toEqual(advanced);
    const restored = new ApplicationSession(parsed.world);
    const cancelled = restored.dispatch({ kind: 'production.cancel', payload: { transactionId: result.transactionId! } });
    expect(cancelled.status).toBe('accepted');
    expect(cancelled.commandId).not.toBe(result.commandId);
    expect(lookupProduction(restored.exportWorld(), result.transactionId!)!.state).toBe('Cancelled');
    expect(validateWorldStateV8(restored.exportWorld())).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('switches v7 to v8 and back without migration, invalidating every previous epoch guard', () => {
    const legacy = createWorld('session-version-switch');
    const candidate = createWorldV8('session-version-switch');
    const sourceBytes = [JSON.stringify(legacy), JSON.stringify(candidate)];
    freezeTree(legacy); freezeTree(candidate);
    const session = new ApplicationSession(legacy);
    expect(session.getEngineVersion()).toBe(7);
    expect(session.getSnapshot().sessionEpoch).toBe(0);
    for (const [index, world] of [candidate, legacy, candidate, legacy].entries()) {
      const oldBuild = session.getBuildFrame();
      const resource = session.getSnapshot().resources.find(row => row.resourceId === 'herbs')!;
      const guard = { sessionEpoch: session.getSnapshot().sessionEpoch, resourceId: resource.resourceId, owned: resource.owned, reserved: resource.reserved, capacity: resource.capacity };
      session.select({ kind: 'building', id: session.getSnapshot().buildings[0]!.id });
      session.frame(0); session.frame(25);
      session.replaceWorld(world);
      const version = world.simulationVersion === '0.8.0' ? 8 : 7;
      expect(session.getEngineVersion()).toBe(version);
      expect(session.getSaveIdentity().saveVersion).toBe(version);
      expect(session.getSnapshot().sessionEpoch).toBe(index + 1);
      expect(session.getSnapshot().selection).toEqual({ kind: 'disciple', id: world.disciples[1]!.id });
      expect(session.getSnapshot().clock.pauseReasons).toContain('player');
      expect(session.getBuildFrame()).not.toBe(oldBuild);
      expect(session.getBuildFrame().builds.schemaVersion).toBe(version === 8 ? 2 : 1);
      const replacement = session.exportWorld();
      expect(session.dispatchInventoryDiscard({ resourceId: 'herbs', quantity: 1 }, guard)).toEqual({ ok: false, code: 'STALE_INVENTORY' });
      expect(session.exportWorld()).toEqual(replacement);
      session.setPaused('player', false);
      expect(session.exportWorld()).toEqual(world);
      expect('contentIdentity' in session.exportWorld()).toBe(version === 8);
      session.frame(100_000); session.frame(100_025);
      expect(session.getSnapshot().clock.simulationTick).toBe(0);
      session.frame(100_050);
      expect(session.getSnapshot().clock.simulationTick).toBe(1);
      expect(createVersionedSaveEnvelope(session.exportWorld(), metadata).saveVersion).toBe(version);
    }
    expect([JSON.stringify(legacy), JSON.stringify(candidate)]).toEqual(sourceBytes);
  });

  it('rejects invalid replacements atomically without advancing epoch or downgrading a v8 owner', () => {
    const session = new ApplicationSession(createWorldV8('session-v8-atomic'));
    const snapshot = session.getSnapshot();
    const before = session.exportWorld();
    const invalid = createWorldV8('session-v8-invalid');
    invalid.inventory.wood.owned = -1;
    const relabeled = createWorld('session-v7-relabeled');
    relabeled.simulationVersion = '0.8.0';
    for (const input of [invalid, relabeled]) {
      const bytes = JSON.stringify(input);
      freezeTree(input);
      expect(() => session.replaceWorld(input)).toThrow();
      expect(session.getSnapshot()).toBe(snapshot);
      expect(session.getSnapshot().sessionEpoch).toBe(0);
      expect(session.getEngineVersion()).toBe(8);
      expect(session.exportWorld()).toEqual(before);
      expect(JSON.stringify(input)).toBe(bytes);
    }
  });
});
