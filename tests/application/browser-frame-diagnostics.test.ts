import { describe, expect, it, vi } from 'vitest';
import { BrowserFrameDiagnostics, FRAME_DIAGNOSTICS_MAX_FRAMES, FRAME_DIAGNOSTICS_MAX_LONG_TASKS, frameDiagnosticsEnabled,
  type DiagnosticFrameResult, type FrameDiagnosticPorts, type FrameDiagnosticSession, type FrameDiagnosticView, type LongTaskConnection } from '../../src/application/browser-frame-diagnostics';

/** Scalar probe fixture only; not an admitted World or gameplay/performance evidence. */
function fixture() {
  let view: FrameDiagnosticView = { sessionEpoch: 0, paused: false, closed: false, stopped: null, runtimeFailure: null,
    holds: { storageBusy: false, storage: false, overlay: false, review: false, player: false, hidden: false },
    frame: { clock: { speed: 1, mode: 'management', simulationTick: 0, pauseReasons: [] }, disciples: [null, null, null, null], transactions: [] }, expansion: { jobs: [null] } };
  let pending = 17_000; let baseline: number | null = null; let now = 0; let cost = 2; let visible = true; let focused = true;
  let insideFrame: (() => void) | null = null; const listeners = new Set<() => void>();
  const update = (patch: Partial<FrameDiagnosticView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
  const ports: FrameDiagnosticPorts = { now: () => now, isVisible: () => visible, isFocused: () => focused };
  const session: FrameDiagnosticSession = {
    getSnapshot: vi.fn(() => view), getFrameDiagnostics: vi.fn(() => Object.freeze({ pendingMicroseconds: pending, baselineEstablished: baseline !== null })),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    frame: vi.fn((timestamp): DiagnosticFrameResult => {
      if (insideFrame) insideFrame();
      let advanced = 0;
      if (baseline !== null && !view.paused) { pending += Math.floor((timestamp - baseline) * 1000); advanced = Math.min(20, Math.floor(pending / 50_000)); pending -= advanced * 50_000; }
      baseline = view.paused ? null : timestamp; now += cost;
      if (advanced) update({ frame: { ...view.frame, clock: { ...view.frame.clock, simulationTick: view.frame.clock.simulationTick + advanced } } });
      return Object.freeze({ ok: true, value: advanced });
    }),
  };
  const diagnostic = new BrowserFrameDiagnostics(session, 'v10', ports);
  const unsubscribe = session.subscribe(diagnostic.observeSession);
  return { session, ports, diagnostic, update, view: () => view,
    step: (timestamp: number) => { now = timestamp; return diagnostic.frame(timestamp); },
    time: (value: number) => { now = value; }, cost: (value: number) => { cost = value; }, pending: (value: number) => { pending = value; }, baseline: (value: number | null) => { baseline = value; },
    visible: (value: boolean) => { visible = value; }, focused: (value: boolean) => { focused = value; }, inside: (fn: (() => void) | null) => { insideFrame = fn; },
    cleanup: () => { unsubscribe(); diagnostic.dispose(); },
  };
}

describe('opt-in actual-frame scalar diagnostics', () => {
  it('requires the independent exact build flag and one exact query value, with no host restriction', () => {
    for (const flag of [undefined, '', false, true, 1, 'true', '0']) expect(frameDiagnosticsEnabled(flag, '?frameDiagnostics=local')).toBe(false);
    for (const query of ['', '?frameDiagnostics=true', '?frameDiagnostics=LOCAL', '?frameDiagnostics=local&frameDiagnostics=local', '?frameDiagnostics=local&frameDiagnostics=no']) expect(frameDiagnosticsEnabled('1', query)).toBe(false);
    expect(frameDiagnosticsEnabled('1', '?frameDiagnostics=local&locale=en')).toBe(true);
  });
  it('does no diagnostic reads, clock reads, observers or publications before explicit Start', () => {
    const f = fixture(); const now = vi.spyOn(f.ports, 'now'); const observer = vi.fn(); f.ports.observeLongTasks = observer;
    const listener = vi.fn(); f.diagnostic.subscribe(listener); const before = f.diagnostic.getSnapshot();
    f.step(0); f.step(16); expect(f.session.frame).toHaveBeenCalledTimes(2);
    expect(f.session.getSnapshot).not.toHaveBeenCalled(); expect(f.session.getFrameDiagnostics).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(f.diagnostic.getSnapshot()).toBe(before); f.cleanup();
  });
  it('never reports page age as captured wall time when stopped before the anchor', () => {
    const f = fixture(); f.time(100_000); f.diagnostic.start(); f.time(105_000); f.diagnostic.stop();
    const r = f.diagnostic.getSnapshot(); expect(r.wallMilliseconds).toBe(0); expect(r.rafSpanMilliseconds).toBe(0); expect(r.durationOverrunMilliseconds).toBe(0); expect(r.frames).toBe(0); f.cleanup();
  });
  it('a rejected restart clears old capture data instead of relabeling it', () => {
    const f = fixture(); f.diagnostic.start(); f.step(0); f.step(50); f.diagnostic.stop(); expect(f.diagnostic.getSnapshot().frames).toBe(1);
    f.update({ paused: true }); expect(f.diagnostic.start()).toBe(false); const r = f.diagnostic.getSnapshot();
    expect(r.reason).toBe('paused'); expect(r.frames).toBe(0); expect(r.advancedTicks).toBe(0); expect(r.wallMilliseconds).toBe(0); expect(r.rafIntervals.count).toBe(0); f.cleanup();
  });
  it('anchors without resetting or attributing pre-start demand, then conserves floored demand and pending backlog', () => {
    const f = fixture(); f.baseline(0); f.pending(17_000); f.time(1000);
    expect(f.diagnostic.start()).toBe(true); f.step(1000); // 20 pre-start ticks excluded, remainder retained.
    f.step(1016.625); f.step(1033.25); f.step(1066.5); f.diagnostic.stop();
    const report = f.diagnostic.getSnapshot();
    expect(report.startingTick).toBe(20); expect(report.initialPendingMicroseconds).toBe(17_000);
    expect(report.frames).toBe(3); expect(report.demandMicroseconds).toBe(66_500);
    expect(report.advancedTicks).toBe(1); expect(report.endingPendingMicroseconds).toBe(33_500);
    expect(report.accountingResidualMicroseconds).toBe(0); expect(report.tickDeltaMismatch).toBe(0);
    expect(report.sessionMilliseconds).toBe(6); expect(report.anchorSessionMilliseconds).toBe(2); expect(report.zeroTickFrames).toBe(2);
    expect(report.rafIntervals.count).toBe(3); expect(report.sessionDurations.p95).toBe(2); expect(report.initialActiveJobs).toBe(1); f.cleanup();
  });
  it('uses actual long rAF demand and the returned 20-tick cap without dropping backlog', () => {
    const f = fixture(); f.pending(0); f.diagnostic.start(); f.step(0); f.step(2500); f.diagnostic.stop();
    const r = f.diagnostic.getSnapshot(); expect(r.advancedTicks).toBe(20); expect(r.multiTickFrames).toBe(1);
    expect(r.demandMicroseconds).toBe(2_500_000); expect(r.endingPendingMicroseconds).toBe(1_500_000); expect(r.maximumPendingMicroseconds).toBe(1_500_000); expect(r.accountingResidualMicroseconds).toBe(0); f.cleanup();
  });
  it('completes a real 60-second monotonic window and reports the final expensive call overrun', () => {
    const f = fixture(); f.pending(0); f.diagnostic.start(); f.step(0);
    for (let timestamp = 50; timestamp < 60_000; timestamp += 50) f.step(timestamp);
    f.cost(87); f.step(60_000); const r = f.diagnostic.getSnapshot();
    expect(r.reason).toBe('completed'); expect(r.frames).toBe(1200); expect(r.advancedTicks).toBe(1200);
    expect(r.rafSpanMilliseconds).toBe(60_000); expect(r.wallMilliseconds).toBe(60_087); expect(r.durationOverrunMilliseconds).toBe(87);
    expect(r.sessionOver50Milliseconds).toBe(1); expect(r.segments.map(row => row.frames)).toEqual([399, 400, 401]);
    expect(r.segments.reduce((sum, row) => sum + row.advancedTicks, 0)).toBe(r.advancedTicks);
    expect(r.longTasks.status).toBe('unavailable'); f.cleanup();
  });
  it('publishes at most once a second during capture, then exactly one final result', () => {
    const f = fixture(); const listener = vi.fn(); f.diagnostic.subscribe(listener); f.diagnostic.start(); listener.mockClear(); f.step(0);
    const armed = f.diagnostic.getSnapshot(); for (let timestamp = 10; timestamp < 1000; timestamp += 10) f.step(timestamp);
    expect(listener).not.toHaveBeenCalled(); expect(f.diagnostic.getSnapshot()).toBe(armed);
    f.step(1000); expect(listener).toHaveBeenCalledTimes(1); expect(f.diagnostic.getSnapshot().sessionDurations.p95).toBeNull();
    for (let timestamp = 1010; timestamp < 2000; timestamp += 10) f.step(timestamp);
    expect(listener).toHaveBeenCalledTimes(1); f.diagnostic.stop(); expect(listener).toHaveBeenCalledTimes(2); f.diagnostic.stop(); expect(listener).toHaveBeenCalledTimes(2); f.cleanup();
  });
  it.each(['hidden', 'blurred', 'paused', 'held', 'epoch-changed', 'speed-changed', 'runtime-changed', 'runtime-stopped'] as const)('interrupts immediately on %s without changing the game', reason => {
    const f = fixture(); f.diagnostic.start(); f.step(0); f.step(50);
    if (reason === 'hidden') f.visible(false);
    if (reason === 'blurred') f.focused(false);
    if (reason === 'paused') f.update({ paused: true });
    if (reason === 'held') f.update({ holds: { ...f.view().holds, overlay: true } });
    if (reason === 'epoch-changed') f.update({ sessionEpoch: 1 });
    if (reason === 'speed-changed') f.update({ frame: { ...f.view().frame, clock: { ...f.view().frame.clock, speed: 3 } } });
    if (reason === 'runtime-changed') f.update({ frame: { ...f.view().frame, clock: { ...f.view().frame.clock, mode: 'combat' } } });
    if (reason === 'runtime-stopped') f.update({ runtimeFailure: 'test-failure' });
    f.diagnostic.observeSession(); expect(f.diagnostic.getSnapshot().reason).toBe(reason);
    expect(f.session.frame).toHaveBeenCalledTimes(2); f.cleanup();
  });
  it('rejects Start while held and never automatically resumes or clears the hold', () => {
    const f = fixture(); f.update({ holds: { ...f.view().holds, review: true } });
    expect(f.diagnostic.start()).toBe(false); expect(f.diagnostic.getSnapshot().reason).toBe('held'); expect(f.view().holds.review).toBe(true); expect(f.session.frame).not.toHaveBeenCalled(); f.cleanup();
  });
  it('retains the final partial batch when a domain pause discards allocated ticks', () => {
    const f = fixture(); f.pending(0); f.diagnostic.start(); f.step(0);
    vi.mocked(f.session.frame).mockImplementationOnce(() => { f.time(1005); f.pending(0); f.baseline(null); f.update({ paused: true, frame: { ...f.view().frame, clock: { ...f.view().frame.clock, simulationTick: 3, pauseReasons: ['choice'] } } }); return { ok: true, value: 3 }; });
    f.step(1000); const r = f.diagnostic.getSnapshot(); expect(r.reason).toBe('paused'); expect(r.frames).toBe(1); expect(r.advancedTicks).toBe(3); expect(r.accountingResidualMicroseconds).toBe(850_000); expect(r.tickDeltaMismatch).toBe(0); f.cleanup();
  });
  it('stops on baseline loss, backwards timestamps and out-of-band advancement', () => {
    for (const kind of ['baseline', 'time', 'tick'] as const) {
      const f = fixture(); f.diagnostic.start(); f.step(10);
      if (kind === 'baseline') f.baseline(null);
      if (kind === 'tick') f.update({ frame: { ...f.view().frame, clock: { ...f.view().frame.clock, simulationTick: 1 } } });
      f.step(kind === 'time' ? 9 : 20);
      expect(f.diagnostic.getSnapshot().reason).toBe(kind === 'baseline' ? 'baseline-reset' : kind === 'time' ? 'invalid-time' : 'runtime-changed');
      expect(f.session.frame).toHaveBeenCalledTimes(2); f.cleanup();
    }
  });
  it('preserves the identical thrown frame error and never retries a Session call', () => {
    const f = fixture(); f.diagnostic.start(); f.step(0); const error = new Error('sentinel');
    vi.mocked(f.session.frame).mockImplementationOnce(() => { throw error; });
    expect(() => f.step(16)).toThrow(error); expect(f.session.frame).toHaveBeenCalledTimes(2); expect(f.diagnostic.getSnapshot().reason).toBe('frame-exception'); f.cleanup();
    const unhealthy = fixture(); unhealthy.diagnostic.start(); unhealthy.visible(false);
    vi.mocked(unhealthy.session.frame).mockImplementationOnce(() => { throw error; });
    expect(() => unhealthy.step(0)).toThrow(error); expect(unhealthy.session.frame).toHaveBeenCalledTimes(1); unhealthy.cleanup();
  });
  it('diagnostic read errors fall back to exactly one existing frame call', () => {
    const f = fixture(); f.diagnostic.start(); vi.mocked(f.session.getFrameDiagnostics).mockImplementationOnce(() => { throw new Error('probe only'); });
    expect(f.step(0)).toEqual({ ok: true, value: 0 }); expect(f.diagnostic.getSnapshot().reason).toBe('probe-error'); expect(f.session.frame).toHaveBeenCalledTimes(1); f.cleanup();
  });
  it('records rejected results, isolates listener exceptions, and exposes immutable reports', () => {
    const f = fixture(); f.diagnostic.subscribe(() => { throw new Error('view only'); }); expect(f.diagnostic.start()).toBe(true); f.step(0);
    const refusal = Object.freeze({ ok: false as const }); vi.mocked(f.session.frame).mockReturnValueOnce(refusal);
    expect(f.step(50)).toBe(refusal); const r = f.diagnostic.getSnapshot(); expect(r.reason).toBe('frame-rejected');
    expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.segments)).toBe(true); expect(Object.isFrozen(r.longTasks)).toBe(true); f.cleanup();
  });
  it('never introduces an extra frame during reentrancy and terminates that capture', () => {
    const f = fixture(); f.diagnostic.start(); f.step(0);
    f.inside(() => { f.inside(null); f.diagnostic.frame(16); });
    f.step(16); expect(f.session.frame).toHaveBeenCalledTimes(3); expect(f.diagnostic.getSnapshot().reason).toBe('reentrant'); f.cleanup();
  });
  it('bounds frame storage and keeps game calls running after diagnostic exhaustion', () => {
    const f = fixture(); f.cost(0); f.diagnostic.start(); f.step(0);
    for (let i = 1; i <= FRAME_DIAGNOSTICS_MAX_FRAMES + 1; i++) f.step(i / 10);
    const r = f.diagnostic.getSnapshot(); expect(r.frames).toBe(FRAME_DIAGNOSTICS_MAX_FRAMES); expect(r.reason).toBe('frame-buffer-full');
    expect(f.session.frame).toHaveBeenCalledTimes(FRAME_DIAGNOSTICS_MAX_FRAMES + 2); f.cleanup();
  });
  it('bounds scalar long-task storage, drains and disconnects, with no attribution fields', () => {
    const f = fixture(); let receive: ((start: number, duration: number) => void) | null = null;
    const connection: LongTaskConnection = { drain: vi.fn(), disconnect: vi.fn() };
    f.ports.observeLongTasks = callback => { receive = callback; return connection; };
    f.diagnostic.start(); f.step(0);
    for (let i = 0; i <= FRAME_DIAGNOSTICS_MAX_LONG_TASKS; i++) receive!(1 + i, 51);
    const r = f.diagnostic.getSnapshot(); expect(r.reason).toBe('long-task-buffer-full'); expect(r.longTasks.count).toBe(FRAME_DIAGNOSTICS_MAX_LONG_TASKS);
    expect(connection.drain).toHaveBeenCalledTimes(1); expect(connection.disconnect).toHaveBeenCalledTimes(1);
    receive!(4000, 90); expect(f.diagnostic.getSnapshot()).toBe(r); expect(Object.keys(r.longTasks)).toEqual(['status', 'count', 'milliseconds', 'maximumMilliseconds']); f.cleanup();
  });
  it('explicitly labels absent/throwing Long Tasks support unavailable and continues capturing', () => {
    for (const observer of [undefined, () => null, () => { throw new Error('unsupported'); }]) {
      const f = fixture(); if (observer) f.ports.observeLongTasks = observer;
      f.diagnostic.start(); f.step(0); f.step(1000); expect(f.diagnostic.getSnapshot().longTasks.status).toBe('unavailable'); expect(f.diagnostic.getSnapshot().state).toBe('capturing'); f.cleanup();
    }
  });
  it('terminal disposal clears observers/listeners and a StrictMode-style fresh mount has separate ownership', () => {
    const f = fixture(); const disconnect = vi.fn(); f.ports.observeLongTasks = () => ({ drain: () => {}, disconnect });
    const listener = vi.fn(); f.diagnostic.subscribe(listener); f.diagnostic.start(); f.step(0); listener.mockClear();
    f.diagnostic.dispose(); f.diagnostic.dispose(); expect(disconnect).toHaveBeenCalledTimes(1); expect(listener).not.toHaveBeenCalled(); expect(f.diagnostic.start()).toBe(false);
    const next = new BrowserFrameDiagnostics(f.session, 'v10', f.ports); expect(next.start()).toBe(true); next.frame(16); f.diagnostic.dispose(); expect(next.getSnapshot().state).toBe('armed');
    next.stop(); expect(next.getSnapshot().reason).toBe('manual'); next.dispose(); f.cleanup();
  });
  it('honors disposal during a synchronous Session publication without publishing after cleanup', () => {
    const f = fixture(); const listener = vi.fn(); f.diagnostic.subscribe(listener); f.diagnostic.start(); f.step(0); listener.mockClear();
    f.inside(() => f.diagnostic.dispose()); f.step(50); expect(f.diagnostic.getSnapshot().reason).toBe('disposed'); expect(listener).not.toHaveBeenCalled(); expect(f.session.frame).toHaveBeenCalledTimes(2); f.cleanup();
  });
});
