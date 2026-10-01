import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createWorld, validateWorldState } from '../../src/core/kernel';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';

function boundaryWorld() {
  const world = { ...createWorld('clock-boundary'), extensionPadding: '' };
  world.extensionPadding = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(world, { saveVersion: 7 }));
  expect(measureWorldSaveBytes(world, { saveVersion: 7 })).toBe(SAVE_FILE_LIMIT_BYTES);
  expect(validateWorldState(world)).toEqual([]);
  return world;
}
describe('session pause controls preserve a full imported boundary', () => {
  it('pauses on background and player input without making saved bytes overflow', () => {
    const world = boundaryWorld();
    const session = new ApplicationSession(world);
    session.setForeground({ focused: false });
    expect(session.getSnapshot().clock.pauseReasons).toContain('hidden');
    expect(session.exportWorld()).toEqual(world);
    session.togglePlayerPause();
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    session.frame(0); session.frame(1000);
    expect(session.exportWorld()).toEqual(world);
    session.setForeground({ focused: true }); session.togglePlayerPause();
    expect(session.getSnapshot().clock.pauseReasons).toEqual([]);
    expect(measureWorldSaveBytes(session.exportWorld(), { saveVersion: 7 })).toBe(SAVE_FILE_LIMIT_BYTES);
  });
  it('loads visibly paused without adding bytes and discards stale ephemeral pauses for a new campaign', () => {
    const session = new ApplicationSession();
    const world = boundaryWorld();
    session.replaceWorld(world);
    expect(session.getSnapshot().paused).toBe(true);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.exportWorld()).toEqual(world);
    session.replaceWorld(createWorld('small'));
    session.togglePlayerPause();
    expect(session.getSnapshot().clock.pauseReasons).toEqual([]);
    expect(session.getSnapshot().paused).toBe(false);
  });
});
