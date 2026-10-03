import { describe, expect, it, vi } from 'vitest';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { ApplicationSessionV10 } from '../../src/application/session-v10';

describe('read-only fresh frame scalars', () => {
  it.each([ApplicationSessionV9, ApplicationSessionV10])('retains fresh remainder visibility without publishing or exposing timing ownership', Session => {
    const session = new Session();
    try {
      const listener = vi.fn(); const unsubscribe = session.subscribe(listener); const before = session.getSnapshot();
      const initial = session.getFrameDiagnostics(); expect(initial).toEqual({ pendingMicroseconds: 0, baselineEstablished: false });
      session.frame(0); session.frame(16.667);
      expect(session.getSnapshot()).toBe(before); expect(listener).not.toHaveBeenCalled();
      const first = session.getFrameDiagnostics(); const second = session.getFrameDiagnostics();
      expect(first).toEqual({ pendingMicroseconds: 16_667, baselineEstablished: true }); expect(second).toEqual(first); expect(second).not.toBe(first);
      expect(Object.isFrozen(first)).toBe(true); expect(Reflect.set(first, 'pendingMicroseconds', 0)).toBe(false);
      session.frame(33.334); expect(session.getFrameDiagnostics().pendingMicroseconds).toBe(33_334); expect(first.pendingMicroseconds).toBe(16_667);
      session.resetFrameBaseline(); expect(session.getFrameDiagnostics()).toEqual({ pendingMicroseconds: 33_334, baselineEstablished: false });
      expect(Object.keys(first)).toEqual(['pendingMicroseconds', 'baselineEstablished']); unsubscribe();
    } finally { session.close(); }
  });
});
