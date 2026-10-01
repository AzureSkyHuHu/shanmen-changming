import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ApplicationSession } from '../../src/application/session';
import { SaveController } from '../../src/application/save-controller';
import { createWorld, stableHash } from '../../src/core/kernel';
import legacy from '../integration/fixtures/save-v2-in-progress.json';

afterEach(() => vi.unstubAllGlobals());
describe('transient campaign overlays', () => {
  it('blocks ticks and hidden gameplay input without persisting its hold', () => {
    const session = new ApplicationSession();
    const original = session.exportWorld();
    session.setOverlayPaused(true);
    expect(session.getSnapshot().paused).toBe(true);
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    session.frame(0); session.frame(10_000);
    session.setSpeed(3); session.togglePlayerPause();
    const result = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: original.disciples[1]!.id } });
    expect(result.status).toBe('rejected');
    expect(session.exportWorld()).toEqual(original);
    session.setOverlayPaused(false);
    session.frame(10_000); session.frame(10_100);
    expect(session.getSnapshot().clock.simulationTick).toBe(2);
  });
  it('keeps authority pauses and remains held across world replacement', () => {
    const session = new ApplicationSession();
    session.setPaused('choice', true); session.setPaused('danger', true);
    session.setOverlayPaused(true); session.setOverlayPaused(false);
    expect(session.exportWorld().clock.pauseReasons).toEqual(['choice', 'danger']);
    session.setOverlayPaused(true);
    session.replaceWorld(createWorld('replacement'));
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    expect(session.exportWorld().clock.pauseReasons).toEqual(['player']);
    session.setOverlayPaused(false);
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['player']);
  });
  it('loads historical UI holds without altering the legacy source or domain safety pauses', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const copy = { ...structuredClone(legacy), payload: { ...structuredClone(legacy.payload), clock: { ...legacy.payload.clock, pauseReasons: ['choice', 'danger'] } } };
    const { checksum: _oldChecksum, ...body } = copy;
    const text = JSON.stringify({ ...body, checksum: stableHash(body) });
    const session = new ApplicationSession(); const controller = new SaveController(session);
    try {
      await controller.start();
      expect(await controller.selectImportFile({ name: 'legacy.json', size: new TextEncoder().encode(text).byteLength, text: async () => text })).toBe(true);
      expect(controller.selectImportTarget('campaign-1')).toBe(true);
      const preview = controller.getSnapshot().import;
      expect(await controller.commitImport({ selectionId: preview.selectionId, slotId: 'campaign-1', expectedRevision: preview.target!.revision, overwriteConfirmed: false })).toBe(true);
      session.setOverlayPaused(true);
      await controller.load('campaign-1');
      expect(session.exportWorld().clock.pauseReasons).toEqual(['player', 'danger']);
      expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
      session.setOverlayPaused(false);
      expect(session.getSnapshot().clock.pauseReasons).toEqual(['player', 'danger']);
      expect(JSON.parse(text).payload.clock.pauseReasons).toEqual(['choice', 'danger']);
    } finally { controller.stop(); }
  });
});
