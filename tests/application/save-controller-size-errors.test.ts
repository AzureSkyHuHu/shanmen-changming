import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { SaveController } from '../../src/application/save-controller';
import * as saveCodec from '../../src/platform/save-codec';

const controllers: SaveController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('manual save size error classification', () => {
  it.each(['memory', 'browser'] as const)('rejects oversized UTF-8 data before claiming an empty %s slot', async mode => {
    vi.stubGlobal('indexedDB', mode === 'browser' ? new IDBFactory() : undefined);
    const session = new ApplicationSession();
    const controller = new SaveController(session);
    controllers.push(controller);
    await controller.start();
    const oversized = Object.assign(session.exportWorld(), { extension: '山'.repeat(1_400_000) });
    vi.spyOn(session, 'exportWorld').mockReturnValue(oversized);

    await controller.save('campaign-1');

    expect(controller.getSnapshot().notice).toBe('save.error.tooLarge');
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().boundSlot).toBeNull();
    expect(controller.getSnapshot().lastSavedAt).toBeNull();
    expect(controller.getSnapshot().slots.every(entry => entry.slot === null)).toBe(true);
  });

  it.each(['memory', 'browser'] as const)('does not relabel an unrelated codec RangeError as an oversized %s save', async mode => {
    vi.stubGlobal('indexedDB', mode === 'browser' ? new IDBFactory() : undefined);
    const session = new ApplicationSession();
    const controller = new SaveController(session);
    controllers.push(controller);
    await controller.start();
    await controller.save('campaign-1');
    const original = controller.getSnapshot().slots[0]!.slot!;
    vi.spyOn(saveCodec, 'createVersionedSaveEnvelope').mockImplementationOnce(() => {
      throw new RangeError('Unrelated codec failure');
    });

    await controller.save('campaign-1');

    expect(controller.getSnapshot().notice).toBe(mode === 'memory' ? 'save.error.transaction' : 'save.error.invalid');
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().slots[0]!.slot).toEqual(original);
    await controller.load('campaign-1');
    expect(controller.getSnapshot().notice).toBe('save.loadedPaused');
  });

  it.each(['memory', 'browser'] as const)('clears busy and preserves the prior %s snapshot when export throws an unrelated RangeError', async mode => {
    vi.stubGlobal('indexedDB', mode === 'browser' ? new IDBFactory() : undefined);
    const session = new ApplicationSession();
    const controller = new SaveController(session);
    controllers.push(controller);
    await controller.start();
    await controller.save('campaign-1');
    const original = controller.getSnapshot().slots[0]!.slot!;
    vi.spyOn(session, 'exportWorld').mockImplementationOnce(() => {
      throw new RangeError('Unrelated export failure');
    });

    await controller.save('campaign-1');

    expect(controller.getSnapshot().notice).toBe('save.error.transaction');
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().slots[0]!.slot).toEqual(original);
    await controller.load('campaign-1');
    expect(controller.getSnapshot().notice).toBe('save.loadedPaused');
  });
});
