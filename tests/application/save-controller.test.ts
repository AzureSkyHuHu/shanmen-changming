import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { SaveController } from '../../src/application/save-controller';
import { parseSave } from '../../src/core/kernel';

const controllers: SaveController[] = [];
function setup() { const session = new ApplicationSession(); const controller = new SaveController(session); controllers.push(controller); return { session, controller }; }
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); vi.unstubAllGlobals(); });

describe('manual save application coordination', () => {
  it('labels an unavailable-storage fallback as memory-only and still offers a valid export', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { session, controller } = setup();
    await controller.start();
    expect(controller.getSnapshot().mode).toBe('memory');
    await controller.save('campaign-1');
    expect(controller.getSnapshot().notice).toBe('save.memorySaved');
    session.frame(0); session.frame(1000);
    await controller.load('campaign-1');
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(parseSave(controller.exportCurrent().text).ok).toBe(true);
  });

  it('never overwrites an occupied unknown campaign and loads before allowing an owned update', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const first = setup(); const second = setup();
    await first.controller.start(); await first.controller.save('campaign-1');
    await second.controller.start();
    expect(second.controller.canSave('campaign-1')).toBe(false);
    await second.controller.save('campaign-1');
    expect(second.controller.getSnapshot().notice).toBe('save.error.slotOccupied');
    expect(second.controller.getSnapshot().slots[0]!.slot!.revision).toBe(1);
    await second.controller.load('campaign-1');
    expect(second.controller.getSnapshot().readOnly).toBe(true);
    expect(second.session.getSnapshot().clock.pauseReasons).toContain('danger');
    await second.controller.load('campaign-1', true);
    expect(second.controller.getSnapshot().readOnly).toBe(false);
    expect(second.controller.canSave('campaign-1')).toBe(true);
    await second.controller.save('campaign-1');
    expect(second.controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    await first.controller.save('campaign-1');
    expect(first.controller.getSnapshot().readOnly).toBe(true);
    expect(first.session.getSnapshot().clock.pauseReasons).toContain('danger');
  });

  it('restores a complete world and keeps stable external-store snapshot identity between changes', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const { session, controller } = setup();
    await controller.start();
    session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: session.getSnapshot().disciples[1]!.id } });
    await controller.save('campaign-2');
    const saved = session.exportWorld();
    const status = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(status);
    session.frame(0); session.frame(1000);
    await controller.load('campaign-2');
    const loaded = session.exportWorld();
    expect(loaded.transactions).toEqual(saved.transactions);
    expect(loaded.commandReceipts).toEqual(saved.commandReceipts);
    expect(loaded.randomStreams).toEqual(saved.randomStreams);
    expect(loaded.clock.simulationTick).toBe(saved.clock.simulationTick);
  });
});
