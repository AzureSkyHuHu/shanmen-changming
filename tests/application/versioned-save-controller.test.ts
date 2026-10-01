import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { SaveController } from '../../src/application/save-controller';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8, validateWorldStateV8 } from '../../src/core/kernel/v8';
import { parseSaveFile } from '../../src/platform/files/save-files';
import { openSaveRepository } from '../../src/platform/persistence';

const controllers: SaveController[] = [];
function own(controller: SaveController): SaveController { controllers.push(controller); return controller; }
function readExport(controller: SaveController) {
  const parsed = parseSaveFile(controller.exportCurrent().text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed;
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.unstubAllGlobals();
});

describe('SaveController version-preserving persistence', () => {
  it.each(['memory', 'browser'] as const)('saves real v8 work twice and resumes exactly after %s load', async mode => {
    vi.stubGlobal('indexedDB', mode === 'browser' ? new IDBFactory() : undefined);
    const input = createWorldV8(`controller-v8-${mode}`);
    const inputBytes = JSON.stringify(input);
    const session = new ApplicationSession(input);
    const controller = own(new SaveController(session));
    await controller.start();
    expect(controller.getSnapshot().mode).toBe(mode);
    const workerId = session.getSnapshot().disciples.find(actor => actor.canWork)!.id;
    expect(session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId } }).status).toBe('accepted');
    await controller.save('campaign-1');
    expect(controller.getSnapshot().notice).toBe(mode === 'browser' ? 'save.saved' : 'save.memorySaved');
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(1);
    session.frame(0); session.frame(1000);
    const secondBoundary = session.exportWorld();
    expect(secondBoundary.clock.simulationTick).toBe(20);
    await controller.save('campaign-1');
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    expect(controller.getSnapshot().readOnly).toBe(false);
    expect(session.exportWorld()).toEqual(secondBoundary);
    const secondExport = readExport(controller);
    expect(secondExport.envelope.saveVersion).toBe(8);
    expect(secondExport.envelope.buildId).toBe('playable-0.8.0');
    expect(secondExport.migration).toBeNull();
    expect(secondExport.world).toEqual(secondBoundary);
    session.frame(1050);
    expect(session.getSnapshot().clock.simulationTick).toBe(21);
    await controller.load('campaign-1');
    expect(controller.getSnapshot().notice).toBe('save.loadedPaused');
    expect(session.getSnapshot().sessionEpoch).toBe(1);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.getEngineVersion()).toBe(8);
    session.setPaused('player', false);
    expect(session.exportWorld()).toEqual(secondBoundary);
    // Resuming discards the pre-load frame baseline, not a saved simulation tick.
    session.frame(200_000); session.frame(200_050);
    expect(session.getSnapshot().clock.simulationTick).toBe(21);
    await controller.save('campaign-1');
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(3);
    expect(readExport(controller).envelope.saveVersion).toBe(8);
    expect(validateWorldStateV8(session.exportWorld())).toEqual([]);
    expect(JSON.stringify(input)).toBe(inputBytes);
    if (mode === 'browser') {
      const repository = await openSaveRepository();
      try {
        const stored = await repository.loadSlot('campaign-1');
        expect(stored.slot.revision).toBe(3);
        expect(stored.envelope.saveVersion).toBe(8);
        expect(stored.world).toEqual(session.exportWorld());
        expect(stored.recovered).toBe(false);
      } finally { repository.close(); }
    }
  });

  it.each(['memory', 'browser'] as const)('uses an explicit v8 new-campaign factory while retaining and reloading the older %s slot', async mode => {
    vi.stubGlobal('indexedDB', mode === 'browser' ? new IDBFactory() : undefined);
    const legacy = createWorld(`controller-legacy-${mode}`);
    const session = new ApplicationSession(legacy);
    const factory = vi.fn((seed: string) => createWorldV8(seed));
    const controller = own(new SaveController(session, factory));
    await controller.start(); await controller.save('campaign-1');
    const originalSlot = controller.getSnapshot().slots[0]!.slot;
    expect(readExport(controller).envelope.saveVersion).toBe(7);
    expect(await controller.beginNewCampaign(' ')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(session.getEngineVersion()).toBe(7);
    expect(await controller.beginNewCampaign('  genuine-new-v8  ')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('genuine-new-v8');
    expect(session.getEngineVersion()).toBe(8);
    expect(session.getSnapshot().seed).toBe('genuine-new-v8');
    expect(session.getSnapshot().sessionEpoch).toBe(1);
    expect(session.getBuildFrame().builds.schemaVersion).toBe(2);
    expect(controller.getSnapshot().boundSlot).toBeNull();
    expect(controller.getSnapshot().slots[0]!.slot).toEqual(originalSlot);
    expect(controller.canSave('campaign-1')).toBe(false);
    await controller.save('campaign-2');
    expect(readExport(controller).envelope.saveVersion).toBe(8);
    await controller.load('campaign-1');
    expect(session.getEngineVersion()).toBe(7);
    expect(session.getSnapshot().sessionEpoch).toBe(2);
    expect(readExport(controller).envelope.saveVersion).toBe(7);
    session.setPaused('player', false);
    expect(session.exportWorld()).toEqual(legacy);
    await controller.load('campaign-2');
    expect(session.getEngineVersion()).toBe(8);
    expect(session.getSnapshot().sessionEpoch).toBe(3);
    expect(session.getSnapshot().seed).toBe('genuine-new-v8');
    expect(readExport(controller).envelope.saveVersion).toBe(8);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().slots[0]!.slot).toEqual(originalSlot);
  });

  it('keeps the default new-campaign factory explicitly legacy even when its initial Session is v8', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const session = new ApplicationSession(createWorldV8('candidate-does-not-change-default'));
    const controller = own(new SaveController(session));
    await controller.start();
    expect(await controller.beginNewCampaign('default-still-v7')).toBe(true);
    expect(session.getEngineVersion()).toBe(7);
    expect(session.getBuildFrame().builds.schemaVersion).toBe(1);
    expect(readExport(controller).envelope.saveVersion).toBe(7);
  });
});
