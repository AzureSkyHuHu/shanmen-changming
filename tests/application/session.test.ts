import { describe, expect, it, vi } from 'vitest';
import { createWorld, setPauseReason } from '../../src/core/kernel';
import { ApplicationSession } from '../../src/application/session';
import { attachBrowserRuntime } from '../../src/application/browser-runtime';
import { shouldHandlePause } from '../../src/input/actions';

function adult(session: ApplicationSession): string { return session.getSnapshot().disciples.find((entry) => entry.canWork)!.id; }

describe('application session ownership and projections', () => {
  it('takes ownership by copying inputs and returns detached frozen projections', () => {
    const input = createWorld('owned');
    const session = new ApplicationSession(input);
    const before = session.getSnapshot();
    input.inventory.wood.owned = 1;
    input.disciples[0]!.position.x = 0;
    expect(session.getSnapshot()).toBe(before);
    expect(before.resources.find((entry) => entry.resourceId === 'wood')!.owned).not.toBe(1);
    expect(before.disciples[0]!.position.x).not.toBe(0);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.disciples)).toBe(true);
    expect(Object.isFrozen(before.disciples[0]!.position)).toBe(true);
    expect(() => { (before.disciples[0]!.position as { x: number }).x = 13; }).toThrow();
    const exported = session.exportWorld();
    exported.clock.simulationTick = 500;
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
  });

  it('caches query snapshots until a real publication, including incomplete frames', () => {
    const session = new ApplicationSession();
    const initial = session.getSnapshot();
    session.frame(0); session.frame(24); session.frame(49);
    expect(session.getSnapshot()).toBe(initial);
    session.setSpeed(1);
    expect(session.getSnapshot()).toBe(initial);
    session.frame(50);
    expect(session.getSnapshot()).not.toBe(initial);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    expect(session.getSnapshot()).toBe(session.getSnapshot());
  });

  it('changes selection without changing the authoritative world revision or snapshot', () => {
    const session = new ApplicationSession();
    const before = session.exportWorld();
    const revision = session.getSnapshot().worldRevision;
    session.select({ kind: 'building', id: session.getSnapshot().buildings[0]!.id });
    expect(session.getSnapshot().worldRevision).toBe(revision);
    expect(session.exportWorld()).toEqual(before);
    session.select({ kind: 'disciple', id: 'missing' });
    expect(session.getSnapshot().selection?.kind).toBe('building');
  });

  it('bounds transaction projections while preserving active work and visible journal references', () => {
    const session = new ApplicationSession();
    const workers = session.getSnapshot().disciples.filter((entry) => entry.canWork);
    const active = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: workers[0]!.id } });
    for (let index = 0; index < 12; index += 1) {
      const order = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.herbs', workerId: workers[1]!.id } });
      session.dispatch({ kind: 'production.cancel', payload: { transactionId: order.transactionId! } });
    }
    const projection = session.getSnapshot();
    expect(Object.keys(session.exportWorld().transactions)).toHaveLength(13);
    expect(projection.transactions.length).toBeLessThanOrEqual(6);
    expect(projection.transactions.some((entry) => entry.transactionId === active.transactionId)).toBe(true);
    for (const event of projection.recentEvents) expect(projection.transactions.some((entry) => entry.transactionId === event.transactionId)).toBe(true);
  });

  it('unsubscribes once and never calls disposed consumers on later revisions', () => {
    const session = new ApplicationSession();
    const observer = vi.fn();
    const unsubscribe = session.subscribe(observer);
    session.setPaused('player', true);
    expect(observer).toHaveBeenCalledTimes(1);
    unsubscribe(); unsubscribe();
    session.setPaused('player', false);
    expect(observer).toHaveBeenCalledTimes(1);
  });
});

describe('application fixed frames and pause reasons', () => {
  it('converts speed outside the kernel and never skips a catch-up backlog', () => {
    const session = new ApplicationSession();
    session.setSpeed(3); session.frame(0); session.frame(50);
    expect(session.getSnapshot().clock.simulationTick).toBe(3);
    session.setSpeed(1); session.frame(100); session.frame(3100);
    expect(session.getSnapshot().clock.simulationTick).toBe(23);
    session.frame(3100); session.frame(3100);
    expect(session.getSnapshot().clock.simulationTick).toBe(63);
  });

  it('discards hidden wall time and resets the first resumed frame baseline', () => {
    const session = new ApplicationSession();
    session.frame(0); session.frame(50);
    session.setForeground({ visible: false });
    session.frame(60_000);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    session.setForeground({ visible: true });
    session.frame(120_000);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    session.frame(120_050);
    expect(session.getSnapshot().clock.simulationTick).toBe(2);
  });

  it('preserves player, choice and danger reasons when focus returns', () => {
    const session = new ApplicationSession();
    session.setPaused('player', true); session.setPaused('choice', true); session.setPaused('danger', true);
    session.setForeground({ focused: false, visible: false });
    session.setForeground({ focused: true });
    expect(session.getSnapshot().clock.pauseReasons).toContain('hidden');
    session.setForeground({ visible: true });
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['player', 'choice', 'danger']);
    session.setPaused('choice', false); session.togglePlayerPause();
    session.frame(0); session.frame(100_000);
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['danger']);
  });

  it('retains incomplete pre-pause time but consumes none of the pause itself', () => {
    const session = new ApplicationSession();
    session.frame(0); session.frame(25);
    session.togglePlayerPause(); session.frame(100_000); session.togglePlayerPause();
    session.frame(200_000); session.frame(200_025);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
  });

  it('keeps a browser writer lock out of exported world data and rejects commands while locked', () => {
    const session = new ApplicationSession();
    session.setStorageReadOnly(true);
    session.frame(0); session.frame(10_000);
    expect(session.getSnapshot().clock.pauseReasons).toContain('danger');
    expect(session.exportWorld().clock.pauseReasons).not.toContain('danger');
    expect(session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: adult(session) } }).status).toBe('rejected');
    expect(session.exportWorld().transactions).toEqual({});
    session.setStorageReadOnly(false);
    session.frame(100_000); session.frame(100_050);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
  });

  it('restores safety reasons and pauses on load without importing stale hidden elapsed', () => {
    const session = new ApplicationSession();
    const loaded = createWorld('loaded');
    loaded.clock = setPauseReason(setPauseReason(loaded.clock, 'danger', true), 'hidden', true);
    session.frame(0); session.frame(1000);
    session.replaceWorld(loaded);
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['player', 'danger']);
    session.setPaused('danger', false); session.setPaused('player', false);
    session.frame(100_000);
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
    session.frame(100_050);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    loaded.inventory.wood.owned = 2;
    expect(session.exportWorld().inventory.wood.owned).not.toBe(2);
  });
});

describe('application command port', () => {
  it('submits authoritative start/cancel commands at complete boundaries even during player pause', () => {
    const session = new ApplicationSession();
    const workerId = adult(session);
    session.setPaused('player', true);
    const before = session.exportWorld().inventory.wood.owned;
    const started = session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId } });
    expect(started.status).toBe('accepted');
    expect(session.exportWorld().inventory.wood).toMatchObject({ owned: before, reserved: 3 });
    expect(session.getSnapshot().disciples.find((entry) => entry.id === workerId)!.assignmentTransactionId).toBe(started.transactionId);
    const cancelled = session.dispatch({ kind: 'production.cancel', payload: { transactionId: started.transactionId! } });
    expect(cancelled.status).toBe('accepted');
    expect(session.exportWorld().inventory.wood).toMatchObject({ owned: before, reserved: 0 });
    expect(session.exportWorld().transactions[started.transactionId!]!.state).toBe('Cancelled');
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
  });

  it('copies command payloads, exposes typed rejection and uses unique IDs after save/load', () => {
    const session = new ApplicationSession();
    const payload = { recipeId: 'gather.wood', workerId: adult(session) };
    const first = session.dispatch({ kind: 'production.start', payload });
    payload.recipeId = 'unknown';
    expect(session.getSnapshot().transactions[0]!.recipeId).toBe('gather.wood');
    const blocked = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.herbs', workerId: adult(session) } });
    expect(blocked.rejection?.code).toBe('WORKER_UNAVAILABLE');
    const restored = new ApplicationSession(session.exportWorld());
    const cancelled = restored.dispatch({ kind: 'production.cancel', payload: { transactionId: first.transactionId! } });
    expect(cancelled.status).toBe('accepted');
    expect(cancelled.commandId).not.toBe(first.commandId);
    expect(cancelled.commandId).not.toBe(blocked.commandId);
    expect(Object.isFrozen(cancelled)).toBe(true);
  });
});

class FakeWindow extends EventTarget {
  callbacks = new Map<number, FrameRequestCallback>();
  next = 0;
  requestAnimationFrame(callback: FrameRequestCallback) { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  cancelAnimationFrame(id: number) { this.callbacks.delete(id); }
  frame(timestamp: number) { const callbacks = [...this.callbacks.values()]; this.callbacks.clear(); for (const callback of callbacks) callback(timestamp); }
}
class FakeDocument extends EventTarget { visibilityState = 'visible'; focused = true; hasFocus() { return this.focused; } }

describe('browser lifecycle adapter', () => {
  it('pauses on blur/visibility, resumes safely and removes RAF and every listener', () => {
    const session = new ApplicationSession();
    const host = new FakeWindow(); const page = new FakeDocument();
    const dispose = attachBrowserRuntime(session, host as unknown as Window, page as unknown as Document);
    host.frame(0); host.frame(50);
    host.dispatchEvent(new Event('blur'));
    host.frame(100_000);
    expect(session.getSnapshot().clock.simulationTick).toBe(1);
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
    host.dispatchEvent(new Event('focus'));
    expect(session.getSnapshot().paused).toBe(true);
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
    host.frame(200_000); host.frame(200_050);
    expect(session.getSnapshot().clock.simulationTick).toBe(2);
    dispose();
    expect(host.callbacks.size).toBe(0);
    host.dispatchEvent(new Event('blur'));
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
    expect(session.getSnapshot().paused).toBe(false);
  });

  it('does not repeat a held pause key or trigger behind a modal', () => {
    const event = { code: 'Space', repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: null };
    expect(shouldHandlePause(event, false)).toBe(true);
    expect(shouldHandlePause({ ...event, repeat: true }, false)).toBe(false);
    expect(shouldHandlePause(event, true)).toBe(false);
    expect(shouldHandlePause({ ...event, code: 'Enter' }, false)).toBe(false);
  });
});
