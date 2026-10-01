import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { exportSessionWorld, ownSessionWorld, sessionBuildFrame, sessionSaveMetadata, engineCampaignProjection, engineCampaignPreview, engineDeparturePreview } from '../../src/application/world-engine';

describe('explicitly versioned Session ownership', () => {
  it('retains the exact v7 version and domain boundary rather than silently migrating', () => {
    const world = createWorld('engine-v7'); const before = JSON.stringify(world); const state = ownSessionWorld(world);
    expect(state.version).toBe(7); expect(state.world).toEqual(world); expect(state.world).not.toBe(world);
    expect(state.world.inventory).not.toBe(world.inventory); expect(JSON.stringify(world)).toBe(before);
    expect(sessionBuildFrame(state).builds.schemaVersion).toBe(1); expect(sessionSaveMetadata(state).saveVersion).toBe(7);
  });
  it('owns a genuine v8 new World and preserves its content identity without v7 casts', () => {
    const world = createWorldV8('engine-v8', { mode: 'standard' }); const before = JSON.stringify(world); const state = ownSessionWorld(world);
    expect(state.version).toBe(8); expect(state.world).toEqual(world); expect(state.world.inventory).not.toBe(world.inventory);
    expect(sessionBuildFrame(state).builds.schemaVersion).toBe(2); expect(sessionSaveMetadata(state).saveVersion).toBe(8);
    const exported = exportSessionWorld(state); expect(exported).toEqual(world); expect(exported.inventory).not.toBe(state.world.inventory);
    exported.inventory.wood.owned = 0; expect(state.world.inventory.wood.owned).toBe(world.inventory.wood.owned);
    expect(JSON.stringify(world)).toBe(before);
  });
  it('does not expose v8 campaign commands or routes through a legacy engine', () => {
    const legacy = ownSessionWorld(createWorld('engine-legacy-port'));
    expect(engineCampaignProjection(legacy)).toBeNull();
    expect(engineCampaignPreview(legacy, { kind: 'campaign.relief', school: 'sword' })).toBeNull();
    expect(() => engineDeparturePreview(legacy, { routeId: 'route.miasma-seal', squadIds: [] })).toThrow();
    const current = ownSessionWorld(createWorldV8('engine-current-port'));
    const before = JSON.stringify(current.world);
    expect(engineCampaignProjection(current)?.routes).toHaveLength(5);
    expect(engineCampaignPreview(current, { kind: 'campaign.relief', school: 'sword' })?.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(current.world)).toBe(before);
  });
  it('rejects missing, future and falsely relabelled versions without rewriting input', () => {
    const world = createWorld('engine-invalid');
    for (const version of [undefined, '0.9.0', '0.8.0']) {
      const input = { ...world, simulationVersion: version }; const before = JSON.stringify(input);
      expect(() => ownSessionWorld(input)).toThrow(); expect(JSON.stringify(input)).toBe(before);
    }
  });
  it('rejects v8 content identity on a v7 World without stripping or relabelling it', () => {
    const input = { ...createWorld('engine-mixed-identity'), contentIdentity: createWorldV8('engine-identity').contentIdentity };
    const before = JSON.stringify(input);
    expect(() => ownSessionWorld(input)).toThrow('Invalid version 7 session World');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('does not execute an untrusted property getter while selecting an engine', () => {
    let calls = 0; const input = { ...createWorld('engine-getter') };
    Object.defineProperty(input, 'simulationVersion', { enumerable: true, get() { calls++; return '0.8.0'; } });
    expect(() => ownSessionWorld(input)).toThrow(); expect(calls).toBe(0);
  });
});
