/** Local observational adapter. No World, persistence, command or clock-control port. */
export const FRAME_DIAGNOSTICS_DURATION_MS = 60_000;
export const FRAME_DIAGNOSTICS_MAX_FRAMES = 32_768;
export const FRAME_DIAGNOSTICS_MAX_LONG_TASKS = 2_048;
const TICK_US = 50_000;
export interface FrameTimingScalars { readonly pendingMicroseconds: number; readonly baselineEstablished: boolean }
export interface FrameDiagnosticView {
  readonly sessionEpoch: number; readonly paused: boolean; readonly closed: boolean;
  readonly stopped: unknown; readonly runtimeFailure: unknown;
  readonly holds: { readonly storageBusy: boolean; readonly storage: boolean; readonly overlay: boolean; readonly review: boolean; readonly player: boolean; readonly hidden: boolean; readonly staging?: boolean };
  readonly frame: { readonly clock: { readonly speed: number; readonly mode: string; readonly simulationTick: number; readonly pauseReasons: readonly string[] }; readonly disciples: readonly unknown[]; readonly transactions: readonly { readonly state: string }[] };
  readonly expansion: { readonly jobs: readonly unknown[] };
}
export type DiagnosticFrameResult = { readonly ok: true; readonly value: number } | { readonly ok: false };
export interface FrameDiagnosticSession {
  getSnapshot(): FrameDiagnosticView;
  getFrameDiagnostics(): FrameTimingScalars;
  frame(timestamp: number): DiagnosticFrameResult;
  subscribe(listener: () => void): () => void;
}
export type DiagnosticStopReason = 'completed' | 'manual' | 'hidden' | 'blurred' | 'paused' | 'held' | 'epoch-changed' | 'speed-changed' | 'runtime-changed' | 'runtime-stopped' | 'baseline-reset' | 'frame-rejected' | 'frame-exception' | 'probe-error' | 'invalid-time' | 'reentrant' | 'frame-buffer-full' | 'long-task-buffer-full' | 'disposed';
export interface LongTaskConnection { drain(): void; disconnect(): void }
export interface FrameDiagnosticPorts {
  now(): number;
  isVisible(): boolean;
  isFocused(): boolean;
  /** Browser implementation connects only after an explicit Start. Null means unavailable. */
  observeLongTasks?: (record: (start: number, duration: number) => void) => LongTaskConnection | null;
}
export interface DiagnosticDistribution { readonly count: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null }
export interface DiagnosticSegment { readonly frames: number; readonly advancedTicks: number; readonly activeWorkFrames: number; readonly demandMicroseconds: number; readonly endingPendingMicroseconds: number }
export interface FrameDiagnosticReport {
  readonly runtime: 'v9' | 'v10'; readonly state: 'idle' | 'armed' | 'capturing' | 'finished'; readonly reason: DiagnosticStopReason | null;
  readonly targetMilliseconds: number; readonly rafSpanMilliseconds: number; readonly wallMilliseconds: number; readonly durationOverrunMilliseconds: number;
  readonly frames: number; readonly advancedTicks: number; readonly zeroTickFrames: number; readonly multiTickFrames: number;
  readonly sessionMilliseconds: number; readonly anchorSessionMilliseconds: number; readonly sessionOver50Milliseconds: number;
  readonly initialPendingMicroseconds: number; readonly endingPendingMicroseconds: number; readonly maximumPendingMicroseconds: number;
  readonly demandMicroseconds: number; readonly accountingResidualMicroseconds: number; readonly tickDeltaMismatch: number;
  readonly startingTick: number; readonly endingTick: number; readonly disciples: number; readonly initialActiveJobs: number;
  readonly rafIntervals: DiagnosticDistribution; readonly sessionDurations: DiagnosticDistribution;
  readonly segments: readonly DiagnosticSegment[];
  readonly longTasks: { readonly status: 'not-started' | 'observing' | 'unavailable'; readonly count: number; readonly milliseconds: number; readonly maximumMilliseconds: number };
}
const emptyDistribution = (): DiagnosticDistribution => Object.freeze({ count: 0, p50: null, p95: null, max: null });
function distribution(values: Float64Array, count: number): DiagnosticDistribution {
  if (!count) return emptyDistribution();
  // Called only after the captured window closes, never in measured Session work.
  const ordered = values.slice(0, count).sort();
  return Object.freeze({ count, p50: ordered[Math.ceil(count * .5) - 1]!, p95: ordered[Math.ceil(count * .95) - 1]!, max: ordered[count - 1]! });
}
export function frameDiagnosticsEnabled(buildFlag: unknown, search: string): boolean {
  if (buildFlag !== '1') return false;
  const values = new URLSearchParams(search).getAll('frameDiagnostics');
  return values.length === 1 && values[0] === 'local';
}
function activeJobs(view: FrameDiagnosticView): number {
  let count = view.expansion.jobs.length;
  for (const job of view.frame.transactions) if (job.state !== 'Committed' && job.state !== 'Cancelled') count++;
  return count;
}
function unhealthy(view: FrameDiagnosticView): DiagnosticStopReason | null {
  if (view.closed || view.stopped || view.runtimeFailure) return 'runtime-stopped';
  if (view.frame.clock.speed !== 1) return 'speed-changed';
  if (view.frame.clock.mode !== 'management') return 'runtime-changed';
  const h = view.holds;
  if (h.storageBusy || h.storage || h.overlay || h.review || h.player || h.hidden || h.staging) return 'held';
  if (view.paused || view.frame.clock.pauseReasons.length) return 'paused';
  return null;
}

export class BrowserFrameDiagnostics {
  readonly #session: FrameDiagnosticSession; readonly #ports: FrameDiagnosticPorts; readonly #runtime: 'v9' | 'v10';
  readonly #listeners = new Set<() => void>();
  #state: FrameDiagnosticReport['state'] = 'idle'; #anchored = false; #reason: DiagnosticStopReason | null = null; #disposed = false; #inside = false;
  #pendingStop: DiagnosticStopReason | null = null; #connection: LongTaskConnection | null = null;
  #intervals: Float64Array | null = null; #durations: Float64Array | null = null; #samples: Float64Array | null = null; #tasks: Float64Array | null = null;
  #count = 0; #ticks = 0; #zero = 0; #multi = 0; #sessionMs = 0; #anchorMs = 0; #over50 = 0;
  #firstTimestamp = 0; #lastTimestamp = 0; #wallStart = 0; #wallEnd = 0; #lastPublish = 0;
  #initialPending = 0; #pending = 0; #maxPending = 0; #demand = 0; #mismatch = 0; #firstTick = 0; #lastTick = 0;
  #epoch = 0; #disciples = 0; #jobs = 0;
  #segments = new Float64Array(15); #taskCount = 0; #taskMs = 0; #taskMax = 0;
  #longTaskStatus: FrameDiagnosticReport['longTasks']['status'] = 'not-started';
  #rafStats = emptyDistribution(); #sessionStats = emptyDistribution(); #snapshot: FrameDiagnosticReport;
  constructor(session: FrameDiagnosticSession, runtime: 'v9' | 'v10', ports: FrameDiagnosticPorts) {
    this.#session = session; this.#runtime = runtime; this.#ports = ports; this.#snapshot = this.#report();
  }
  readonly getSnapshot = (): FrameDiagnosticReport => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => { if (!this.#disposed) this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #active(): boolean { return this.#state === 'armed' || this.#state === 'capturing'; }
  #report(): FrameDiagnosticReport {
    const wall = this.#anchored ? Math.max(0, this.#wallEnd - this.#wallStart) : 0;
    const segments: DiagnosticSegment[] = [];
    for (let i = 0; i < 3; i++) { const n = i * 5; segments.push(Object.freeze({ frames: this.#segments[n]!, advancedTicks: this.#segments[n + 1]!, activeWorkFrames: this.#segments[n + 2]!, demandMicroseconds: this.#segments[n + 3]!, endingPendingMicroseconds: this.#segments[n + 4]! })); }
    return Object.freeze({ runtime: this.#runtime, state: this.#state, reason: this.#reason, targetMilliseconds: FRAME_DIAGNOSTICS_DURATION_MS,
      rafSpanMilliseconds: this.#anchored ? Math.max(0, this.#lastTimestamp - this.#firstTimestamp) : 0, wallMilliseconds: wall, durationOverrunMilliseconds: Math.max(0, wall - FRAME_DIAGNOSTICS_DURATION_MS),
      frames: this.#count, advancedTicks: this.#ticks, zeroTickFrames: this.#zero, multiTickFrames: this.#multi, sessionMilliseconds: this.#sessionMs, anchorSessionMilliseconds: this.#anchorMs, sessionOver50Milliseconds: this.#over50,
      initialPendingMicroseconds: this.#initialPending, endingPendingMicroseconds: this.#pending, maximumPendingMicroseconds: this.#maxPending, demandMicroseconds: this.#demand,
      accountingResidualMicroseconds: this.#initialPending + this.#demand - this.#pending - this.#ticks * TICK_US, tickDeltaMismatch: this.#mismatch,
      startingTick: this.#firstTick, endingTick: this.#lastTick, disciples: this.#disciples, initialActiveJobs: this.#jobs,
      rafIntervals: this.#rafStats, sessionDurations: this.#sessionStats, segments: Object.freeze(segments),
      longTasks: Object.freeze({ status: this.#longTaskStatus, count: this.#taskCount, milliseconds: this.#taskMs, maximumMilliseconds: this.#taskMax }) });
  }
  #publish(): void {
    this.#snapshot = this.#report();
    // Presentation failures cannot change Session advancement or frame-loop ownership.
    for (const listener of this.#listeners) { try { listener(); } catch { /* Local observer only. */ } }
  }
  #condition(view: FrameDiagnosticView): DiagnosticStopReason | null {
    if (!this.#ports.isVisible()) return 'hidden';
    if (!this.#ports.isFocused()) return 'blurred';
    if (view.sessionEpoch !== this.#epoch) return 'epoch-changed';
    return unhealthy(view);
  }
  start(): boolean {
    if (this.#disposed || this.#active() || this.#inside) return false;
    let view: FrameDiagnosticView;
    this.#segments.fill(0); this.#count = this.#ticks = this.#zero = this.#multi = this.#sessionMs = this.#anchorMs = this.#over50 = 0;
    this.#initialPending = this.#pending = this.#maxPending = this.#demand = this.#mismatch = this.#firstTick = this.#lastTick = 0;
    this.#firstTimestamp = this.#lastTimestamp = this.#wallStart = this.#wallEnd = this.#lastPublish = 0;
    this.#taskCount = this.#taskMs = this.#taskMax = 0; this.#rafStats = emptyDistribution(); this.#sessionStats = emptyDistribution();
    this.#reason = this.#pendingStop = null; this.#state = 'idle'; this.#anchored = false; this.#disciples = this.#jobs = 0;
    this.#longTaskStatus = 'not-started';
    try {
      view = this.#session.getSnapshot(); this.#epoch = view.sessionEpoch;
      const reason = this.#condition(view);
      if (reason) { this.#reason = reason; this.#state = 'finished'; this.#publish(); return false; }
      // All variable-size allocation is bounded and happens before capture.
      this.#intervals = new Float64Array(FRAME_DIAGNOSTICS_MAX_FRAMES); this.#durations = new Float64Array(FRAME_DIAGNOSTICS_MAX_FRAMES);
      this.#samples = new Float64Array(FRAME_DIAGNOSTICS_MAX_FRAMES * 4); this.#tasks = new Float64Array(FRAME_DIAGNOSTICS_MAX_LONG_TASKS * 2);
      this.#state = 'armed'; this.#disciples = view.frame.disciples.length; this.#jobs = activeJobs(view);
      this.#longTaskStatus = 'unavailable';
      try { this.#connection = this.#ports.observeLongTasks?.((start, duration) => this.#recordTask(start, duration)) ?? null; } catch { this.#connection = null; }
      if (this.#connection) this.#longTaskStatus = 'observing';
      this.#publish(); return true;
    } catch { this.#state = 'finished'; this.#reason = 'probe-error'; this.#publish(); return false; }
  }
  /** Session publications outside a frame catch even a brief pause/hold/epoch change. */
  readonly observeSession = (): void => {
    if (!this.#active()) return;
    try { const reason = this.#condition(this.#session.getSnapshot()); if (reason) this.stop(reason); }
    catch { this.stop('probe-error'); }
  };
  #recordTask(start: number, duration: number): void {
    if (this.#state !== 'capturing' || !Number.isFinite(start) || !Number.isFinite(duration) || duration < 0 || start < this.#wallStart) return;
    if (this.#taskCount === FRAME_DIAGNOSTICS_MAX_LONG_TASKS) { this.stop('long-task-buffer-full'); return; }
    const n = this.#taskCount++ * 2; this.#tasks![n] = start; this.#tasks![n + 1] = duration; this.#taskMs += duration; this.#taskMax = Math.max(this.#taskMax, duration);
  }
  stop(reason: DiagnosticStopReason = 'manual'): void {
    if (!this.#active()) return;
    if (this.#inside) { this.#pendingStop ??= reason; return; }
    this.#finish(reason);
  }
  #finish(reason: DiagnosticStopReason): void {
    if (!this.#active()) return;
    // Drain while guarded so a full observer buffer cannot recursively finish.
    this.#inside = true;
    try { this.#wallEnd = this.#ports.now(); } catch { reason = 'probe-error'; }
    try { this.#connection?.drain(); } catch { this.#longTaskStatus = 'unavailable'; }
    try { this.#connection?.disconnect(); } catch { /* Best-effort observer cleanup. */ }
    this.#connection = null; this.#inside = false;
    this.#reason = this.#pendingStop ?? reason; this.#pendingStop = null; this.#state = 'finished';
    // Final sorting/React work is explicitly outside the capture window.
    this.#rafStats = this.#intervals ? distribution(this.#intervals, this.#count) : emptyDistribution();
    this.#sessionStats = this.#durations ? distribution(this.#durations, this.#count) : emptyDistribution();
    this.#publish();
  }
  /** Calls precisely the existing Session.frame once; does not own/schedule frames. */
  frame(timestamp: number): DiagnosticFrameResult {
    if (!this.#active() || this.#disposed) return this.#session.frame(timestamp);
    if (this.#inside) { this.#pendingStop ??= 'reentrant'; return this.#session.frame(timestamp); }
    let before: FrameDiagnosticView; let timing: FrameTimingScalars; let start: number; let skip: DiagnosticStopReason | null;
    try {
      before = this.#session.getSnapshot(); timing = this.#session.getFrameDiagnostics();
      skip = this.#condition(before);
      if (!Number.isFinite(timestamp) || this.#state === 'capturing' && timestamp < this.#lastTimestamp) skip ??= 'invalid-time';
      if (this.#state === 'capturing' && !timing.baselineEstablished) skip ??= 'baseline-reset';
      if (this.#count === FRAME_DIAGNOSTICS_MAX_FRAMES) skip ??= 'frame-buffer-full';
      start = this.#ports.now();
    } catch { this.stop('probe-error'); return this.#session.frame(timestamp); }
    if (skip) { this.stop(skip); return this.#session.frame(timestamp); }
    this.#inside = true;
    let result: DiagnosticFrameResult;
    try { result = this.#session.frame(timestamp); }
    catch (error) { this.#inside = false; this.#pendingStop = 'frame-exception'; this.#finish('frame-exception'); throw error; }
    let end: number;
    try {
      end = this.#ports.now(); // The measured interval brackets only the existing frame call.
      const after = this.#session.getSnapshot(); const afterTiming = this.#session.getFrameDiagnostics();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isSafeInteger(afterTiming.pendingMicroseconds) || afterTiming.pendingMicroseconds < 0) this.#pendingStop ??= 'probe-error';
      const reason = this.#condition(after); if (reason) this.#pendingStop ??= reason;
      if (!result.ok) this.#pendingStop ??= 'frame-rejected';
      const advanced = result.ok && Number.isSafeInteger(result.value) && result.value >= 0 ? result.value : 0;
      if (result.ok && advanced !== result.value) this.#pendingStop ??= 'probe-error';
      if (this.#state === 'armed') {
        // Existing baseline is deliberately left untouched. The first frame is
        // an anchor: its pre-click demand/advanced ticks are excluded from totals.
        this.#state = 'capturing'; this.#anchored = true; this.#firstTimestamp = this.#lastTimestamp = timestamp;
        this.#wallStart = start; this.#wallEnd = end; this.#lastPublish = end; this.#anchorMs = end - start;
        this.#firstTick = this.#lastTick = after.frame.clock.simulationTick;
        this.#initialPending = this.#pending = this.#maxPending = afterTiming.pendingMicroseconds;
      } else {
        const elapsed = timestamp - this.#lastTimestamp; const demand = Math.floor(elapsed * 1000);
        const duration = end - start; const n = this.#count; const scalar = n * 4;
        this.#intervals![n] = elapsed; this.#durations![n] = duration;
        this.#samples![scalar] = timestamp; this.#samples![scalar + 1] = advanced; this.#samples![scalar + 2] = afterTiming.pendingMicroseconds;
        this.#samples![scalar + 3] = timing.pendingMicroseconds + demand - afterTiming.pendingMicroseconds - advanced * TICK_US;
        this.#mismatch += Math.abs(after.frame.clock.simulationTick - before.frame.clock.simulationTick - advanced);
        if (before.frame.clock.simulationTick !== this.#lastTick || timing.pendingMicroseconds !== this.#pending) this.#pendingStop ??= 'runtime-changed';
        this.#count++; this.#ticks += advanced; this.#zero += Number(advanced === 0); this.#multi += Number(advanced > 1);
        this.#sessionMs += duration; this.#over50 += Number(duration > 50); this.#demand += demand;
        this.#pending = afterTiming.pendingMicroseconds; this.#maxPending = Math.max(this.#maxPending, this.#pending);
        this.#lastTick = after.frame.clock.simulationTick; this.#lastTimestamp = timestamp; this.#wallEnd = end;
        // Fixed 0–20s / 20–40s / 40s–end buckets, classified by ending rAF time.
        const segment = Math.min(2, Math.floor((timestamp - this.#firstTimestamp) / 20_000)) * 5;
        this.#segments[segment] = this.#segments[segment]! + 1; this.#segments[segment + 1] = this.#segments[segment + 1]! + advanced;
        this.#segments[segment + 2] = this.#segments[segment + 2]! + Number(activeJobs(before) > 0); this.#segments[segment + 3] = this.#segments[segment + 3]! + demand; this.#segments[segment + 4] = this.#pending;
      }
      if (!afterTiming.baselineEstablished && !this.#pendingStop) this.#pendingStop = 'baseline-reset';
    } catch { this.#pendingStop ??= 'probe-error'; end = start; }
    this.#inside = false;
    if (this.#pendingStop) this.#finish(this.#pendingStop);
    else if (end - this.#wallStart >= FRAME_DIAGNOSTICS_DURATION_MS) this.#finish('completed');
    else if (end - this.#lastPublish >= 1000) { this.#lastPublish = end; this.#publish(); }
    return result;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#listeners.clear(); this.stop('disposed'); this.#disposed = true;
  }
}

/** No observer registration, DOM listeners, or animation loop until the UI opts in. */
export function browserFrameDiagnosticPorts(): FrameDiagnosticPorts & { updateForeground(visible: boolean, focused: boolean): void } {
  let visible = document.visibilityState !== 'hidden'; let focused = document.hasFocus();
  return {
    now: () => performance.now(), isVisible: () => visible, isFocused: () => focused,
    updateForeground: (nextVisible, nextFocused) => { visible = nextVisible; focused = nextFocused; },
    observeLongTasks: record => {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return null;
      const receive = (entries: readonly PerformanceEntry[]) => { for (const entry of entries) record(entry.startTime, entry.duration); };
      const observer = new PerformanceObserver(list => receive(list.getEntries()));
      try { observer.observe({ type: 'longtask', buffered: false }); } catch { observer.disconnect(); return null; }
      return { drain: () => receive(observer.takeRecords()), disconnect: () => observer.disconnect() };
    },
  };
}
