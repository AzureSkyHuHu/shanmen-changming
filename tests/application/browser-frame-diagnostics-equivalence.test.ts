import { describe, expect, it } from 'vitest';
import { BrowserFrameDiagnostics } from '../../src/application/browser-frame-diagnostics';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { ApplicationSessionV10 } from '../../src/application/session-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';

const runtimes = [
  { runtime: 'v9' as const, create: () => new ApplicationSessionV9(createUnregisteredWorldV9('diagnostic-equivalence')) },
  { runtime: 'v10' as const, create: () => new ApplicationSessionV10(createUnregisteredWorldV10('diagnostic-equivalence')) },
];

describe('real Session state equivalence with browser frame capture', () => {
  it.each(runtimes)('$runtime preserves full exports and cached views through capture and UI holds', ({ runtime, create }) => {
    // Independent admitted owners, not two wrappers around the same World or a
    // scalar mock. Only public commands, detached exports and cached DTOs below.
    const direct = create();
    const observed = create();
    let now = 0;
    let visible = true;
    const diagnostics = new BrowserFrameDiagnostics(observed, runtime, {
      now: () => now, isVisible: () => visible, isFocused: () => true,
    });
    const unsubscribeDiagnostics = observed.subscribe(diagnostics.observeSession);
    let directPublications = 0;
    let observedPublications = 0;
    const unsubscribeDirect = direct.subscribe(() => { directPublications++; });
    const unsubscribeObserved = observed.subscribe(() => { observedPublications++; });

    const equivalent = () => {
      const directView = direct.getSnapshot();
      const observedView = observed.getSnapshot();
      expect(observedView).toEqual(directView); // Includes frame, cultivation, build and expansion.
      expect(observedView.stopped).toBeNull();
      expect(observedView.runtimeFailure).toBeNull();
      expect(observed.getFrameDiagnostics()).toEqual(direct.getFrameDiagnostics());
      expect(observedPublications).toBe(directPublications);
      // Cold exports happen after frame() returns, never inside the collector's
      // measured callback; compare every field, including RNG and receipts.
      const directWorld = direct.exportWorld();
      const observedWorld = observed.exportWorld();
      expect(directWorld.ok).toBe(true);
      expect(observedWorld.ok).toBe(true);
      expect(observedWorld).toEqual(directWorld);
      expect(direct.getSnapshot()).toBe(directView);
      expect(observed.getSnapshot()).toBe(observedView);
    };
    const frame = (timestamp: number, ticks: number) => {
      now = timestamp;
      expect(direct.frame(timestamp)).toEqual({ ok: true, value: ticks });
      expect(diagnostics.frame(timestamp)).toEqual({ ok: true, value: ticks });
      equivalent();
    };

    try {
      for (const session of [direct, observed]) {
        expect(session.select({ kind: 'disciple', id: 'entity:2' }).ok).toBe(true);
        expect(session.dispatch({ kind: 'production.start', payload: {
          recipeId: 'gather.wood', workerId: 'entity:2',
        } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
      }
      equivalent();
      frame(0, 0);
      frame(17, 0); // A real pre-capture baseline and incomplete tick survive Start.
      expect(diagnostics.start()).toBe(true);
      equivalent();
      frame(67, 1); // Anchor advances the existing Session, but is excluded from capture totals.
      const directAnchor = direct.getSnapshot();
      const observedAnchor = observed.getSnapshot();
      frame(83, 0);
      expect(direct.getSnapshot()).toBe(directAnchor);
      expect(observed.getSnapshot()).toBe(observedAnchor);
      frame(183, 2);
      diagnostics.stop();
      expect(diagnostics.getSnapshot()).toMatchObject({
        state: 'finished', reason: 'manual', frames: 2, advancedTicks: 2,
        zeroTickFrames: 1, multiTickFrames: 1, startingTick: 1, endingTick: 3,
        initialPendingMicroseconds: 17_000, endingPendingMicroseconds: 33_000,
        accountingResidualMicroseconds: 0, tickDeltaMismatch: 0, initialActiveJobs: 1,
      });
      equivalent();
      frame(200, 1); // Finished diagnostics still forward exactly the ordinary frame.

      expect(diagnostics.start()).toBe(true);
      frame(216, 0);
      for (const session of [direct, observed]) expect(session.setOverlayPaused(true).ok).toBe(true);
      expect(diagnostics.getSnapshot().reason).toBe('held');
      equivalent();
      frame(5_000, 0);
      for (const session of [direct, observed]) expect(session.setOverlayPaused(false).ok).toBe(true);
      equivalent();
      expect(diagnostics.start()).toBe(true);
      frame(5_100, 0); // Resume establishes a new baseline; held wall time is discarded.
      frame(5_134, 1); // The pre-hold 16ms remainder is retained by both Sessions.

      visible = false;
      for (const session of [direct, observed]) expect(session.setForeground({ visible: false }).ok).toBe(true);
      expect(diagnostics.getSnapshot().reason).toBe('hidden');
      equivalent();
      frame(10_000, 0);
      visible = true;
      for (const session of [direct, observed]) expect(session.setForeground({ visible: true }).ok).toBe(true);
      equivalent();
      expect(diagnostics.start()).toBe(true);
      frame(10_100, 0);
      frame(10_150, 1);
      unsubscribeDiagnostics();
      diagnostics.dispose();
      diagnostics.dispose(); // Effect cleanup is harmless when repeated.
      expect(diagnostics.getSnapshot().reason).toBe('disposed');
      equivalent();
      frame(10_200, 1);
      expect(observed.getSnapshot().frame.clock.simulationTick).toBe(7);
    } finally {
      unsubscribeDiagnostics();
      unsubscribeDirect();
      unsubscribeObserved();
      diagnostics.dispose();
      direct.close();
      observed.close();
    }
  }, 30_000);
});
