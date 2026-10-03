import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { BrowserFrameDiagnostics, browserFrameDiagnosticPorts, frameDiagnosticsEnabled,
  type DiagnosticStopReason, type FrameDiagnosticReport, type FrameDiagnosticSession } from '../application/browser-frame-diagnostics';
import { createTranslator, type Locale } from '../i18n';
import type { MessageSpecifications } from '../i18n/types';
import './frame-diagnostics.css';

/** Private opt-in text keys; no shared locale ownership or simulation strings. */
export const frameDiagnosticMessages = {
  title: ['本标签页帧诊断', 'This-tab frame diagnostics'],
  start: ['开始 60 秒采集', 'Start 60-second capture'], stop: ['停止采集', 'Stop capture'],
  scope: ['仅记录当前标签页的数值，不联网、不保存。请在前台、正常 1 倍速运行；采集不会操作或暂停游戏。', 'Numbers remain in this tab, with no network or persistence. Run in the foreground at 1×; capture never controls or pauses the game.'],
  caveat: ['测量含观察器开销。50ms 是 20Hz 模拟容量警示，不是完整 DD-13 验收：36 弟子、常规 60fps / 低画质 30fps、指定设备与完整场景仍需另测。严格完整状态对照必须另行进行。', 'Observer overhead is included. 50 ms is a 20 Hz simulation-capacity warning, not full DD-13 acceptance: 36 disciples, 60 fps normal / 30 fps low quality, specified hardware and complete scenarios still need separate testing. Run strict full-state comparisons separately.'],
  status: ['状态：{state} · {reason}', 'State: {state} · {reason}'],
  idle: ['未开始', 'Idle'], armed: ['等待首帧锚点', 'Waiting for frame anchor'], capturing: ['采集中', 'Capturing'], finished: ['已结束', 'Finished'], none: ['无结束原因', 'No stop reason'],
  elapsed: ['rAF 跨度 {raf}ms · 实际用时 {wall}ms · 超时 {overrun}ms', 'rAF span {raf} ms · wall time {wall} ms · overrun {overrun} ms'],
  counts: ['{frames} 帧 · 实际前进 {ticks} 刻 · 零刻帧 {zero} · 多刻帧 {multi}', '{frames} frames · {ticks} ticks advanced · {zero} zero-tick frames · {multi} multi-tick frames'],
  population: ['起始弟子 {disciples} · 起始活动工作 {jobs} · 模拟刻 {start} → {end}', 'Starting disciples {disciples} · active jobs {jobs} · simulation tick {start} → {end}'],
  timing: ['Session 累计 {total}ms · 锚点 {anchor}ms（单列）· 超过 50ms 的帧 {over}', 'Session total {total} ms · anchor {anchor} ms (separate) · frames over 50 ms: {over}'],
  interval: ['rAF 间隔 p50 / p95 / 最大：{p50} / {p95} / {max} ms', 'rAF interval p50 / p95 / max: {p50} / {p95} / {max} ms'],
  duration: ['Session 耗时 p50 / p95 / 最大：{p50} / {p95} / {max} ms', 'Session duration p50 / p95 / max: {p50} / {p95} / {max} ms'],
  pending: ['待处理时间 起始 / 结束 / 最大：{start} / {end} / {max} μs', 'Pending time start / end / max: {start} / {end} / {max} μs'],
  demand: ['新增时间需求 {demand}μs · 余额误差 {residual}μs · 返回刻数与时钟差 {mismatch}', 'New time demand {demand} μs · conservation residual {residual} μs · returned-tick/clock mismatch {mismatch}'],
  accounting: ['余额 = 起始待处理 + 每帧向下取整的时间需求 − 结束待处理 − 实际前进刻数×50000。中断时余额可能含领域暂停弃置的已分配刻，不能判为通过。', 'Residual = initial pending + per-frame floored time demand − ending pending − advanced ticks × 50000. Interrupted captures may include allocated ticks discarded at domain pauses; this is not a pass result.'],
  early: ['前段 0–20 秒', 'Early 0–20 s'], middle: ['中段 20–40 秒', 'Middle 20–40 s'], late: ['后段 40 秒至结束', 'Late 40 s–end'],
  segment: ['{label}：{frames} 帧 / {ticks} 刻 / 有活动工作 {active} 帧 / 需求 {demand}μs / 末尾待处理 {pending}μs', '{label}: {frames} frames / {ticks} ticks / {active} active-work frames / demand {demand} μs / ending pending {pending} μs'],
  longTasks: ['长任务：{status} · {count} 次 · 累计 {total}ms · 最大 {max}ms', 'Long tasks: {status} · {count} entries · total {total} ms · max {max} ms'],
  unavailable: ['不可用；不是零次', 'Unavailable; not zero'], observing: ['已观察到的条目', 'Delivered observations'], notStarted: ['未启动', 'Not started'],
  finalOnly: ['分位数仅在结束后计算；长任务仅含观察器已送达与可排空的条目，可能不含最后回调。', 'Percentiles are computed only after capture. Long tasks include delivered/drainable entries and may omit the terminal callback.'],
  details: ['数值与限制', 'Numbers and limitations'],
  completed: ['到达 60 秒窗口（不代表验收通过）', 'Reached 60-second window (not an acceptance pass)'], manual: ['手动停止', 'Stopped manually'],
  hidden: ['页面隐藏', 'Page hidden'], blurred: ['窗口失焦', 'Window blurred'], paused: ['游戏暂停', 'Game paused'], held: ['会话暂停权生效', 'Session hold active'],
  'epoch-changed': ['会话已替换', 'Session replaced'], 'speed-changed': ['速度不是 1 倍', 'Speed is not 1×'], 'runtime-changed': ['运行状态变更', 'Runtime changed'], 'runtime-stopped': ['运行停止或失败', 'Runtime stopped or failed'],
  'baseline-reset': ['时钟基线重置', 'Frame baseline reset'], 'frame-rejected': ['帧调用被拒绝', 'Frame call rejected'], 'frame-exception': ['帧调用抛出异常', 'Frame call threw'],
  'probe-error': ['诊断读取失败', 'Diagnostic read failed'], 'invalid-time': ['时间戳无效', 'Invalid timestamp'], reentrant: ['帧调用重入', 'Reentrant frame call'],
  'frame-buffer-full': ['帧缓冲已满', 'Frame buffer full'], 'long-task-buffer-full': ['长任务缓冲已满', 'Long-task buffer full'], disposed: ['诊断已清理', 'Diagnostics disposed'],
} as const;
type MessageKey = keyof typeof frameDiagnosticMessages;
const textParameter = { type: 'string', format: 'text' } as const;
export const frameDiagnosticSpecifications: MessageSpecifications = Object.fromEntries(Object.entries(frameDiagnosticMessages).map(([key, values]) => [key, {
  parameters: Object.fromEntries([...values[0].matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => [match[1]!, textParameter])),
}]));
const localTranslator = createTranslator({ specifications: frameDiagnosticSpecifications,
  baseCatalog: Object.fromEntries(Object.entries(frameDiagnosticMessages).map(([key, values]) => [key, values[0]])),
  englishCatalog: Object.fromEntries(Object.entries(frameDiagnosticMessages).map(([key, values]) => [key, values[1]])),
});
export const translateFrameDiagnostic = (locale: Locale, key: MessageKey, parameters?: Record<string, string>): string => localTranslator(locale, key, parameters);
const reasonKeys: Record<DiagnosticStopReason, MessageKey> = {
  completed: 'completed', manual: 'manual', hidden: 'hidden', blurred: 'blurred', paused: 'paused', held: 'held',
  'epoch-changed': 'epoch-changed', 'speed-changed': 'speed-changed', 'runtime-changed': 'runtime-changed', 'runtime-stopped': 'runtime-stopped',
  'baseline-reset': 'baseline-reset', 'frame-rejected': 'frame-rejected', 'frame-exception': 'frame-exception', 'probe-error': 'probe-error', 'invalid-time': 'invalid-time', reentrant: 'reentrant',
  'frame-buffer-full': 'frame-buffer-full', 'long-task-buffer-full': 'long-task-buffer-full', disposed: 'disposed',
};

interface DiagnosticEventTarget { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void }
interface DiagnosticDocument extends DiagnosticEventTarget { readonly visibilityState: string; hasFocus(): boolean }
/** Testable ownership boundary; cleanup never resets Session or touches its holds. */
export function connectFrameDiagnostics(owned: BrowserFrameDiagnostics, session: FrameDiagnosticSession,
  updateForeground: (visible: boolean, focused: boolean) => void, document: DiagnosticDocument, window: DiagnosticEventTarget): () => void {
  const foreground = () => { updateForeground(document.visibilityState !== 'hidden', document.hasFocus()); owned.observeSession(); };
  const blur = () => { updateForeground(document.visibilityState !== 'hidden', false); owned.stop('blurred'); };
  const unsubscribe = session.subscribe(owned.observeSession);
  document.addEventListener('visibilitychange', foreground); window.addEventListener('focus', foreground); window.addEventListener('blur', blur);
  let disposed = false;
  return () => {
    if (disposed) return; disposed = true;
    unsubscribe(); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground); window.removeEventListener('blur', blur); owned.dispose();
  };
}

/** A fresh controller per effect mount makes StrictMode cleanup terminal for its owner. */
export function useFrameDiagnostics(session: FrameDiagnosticSession, runtime: 'v9' | 'v10'): readonly [RefObject<BrowserFrameDiagnostics | null>, BrowserFrameDiagnostics | null] {
  const current = useRef<BrowserFrameDiagnostics | null>(null);
  const [controller, setController] = useState<BrowserFrameDiagnostics | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !frameDiagnosticsEnabled(import.meta.env.VITE_ENABLE_FRAME_DIAGNOSTICS, window.location.search)) return;
    const ports = browserFrameDiagnosticPorts(); const owned = new BrowserFrameDiagnostics(session, runtime, ports);
    current.current = owned; setController(owned);
    const disconnect = connectFrameDiagnostics(owned, session, ports.updateForeground, document, window);
    return () => { if (current.current === owned) current.current = null; disconnect(); };
  }, [session, runtime]);
  return [current, controller];
}
export function FrameDiagnosticsPanel({ controller, locale }: { controller: BrowserFrameDiagnostics; locale: Locale }) {
  const report = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <FrameDiagnosticsView report={report} locale={locale} onStart={() => controller.start()} onStop={() => controller.stop()} />;
}
export function FrameDiagnosticsView({ report, locale, onStart, onStop }: { report: FrameDiagnosticReport; locale: Locale; onStart: () => void; onStop: () => void }) {
  const t = (key: MessageKey, parameters?: Record<string, string>) => translateFrameDiagnostic(locale, key, parameters);
  const n = (value: number | null) => value === null ? '…' : value.toFixed(Number.isInteger(value) ? 0 : 2);
  const live = report.state === 'armed' || report.state === 'capturing';
  return <details className="frame-diagnostics"><summary>{t('title')} · {report.runtime}</summary>
    <p>{t('scope')}</p>
    <div className="frame-diagnostics-actions"><button type="button" disabled={live} onClick={onStart}>{t('start')}</button><button type="button" disabled={!live} onClick={onStop}>{t('stop')}</button></div>
    <p role="status" aria-live="polite">{t('status', { state: t(report.state), reason: t(report.reason ? reasonKeys[report.reason] : 'none') })}</p>
    <p>{t('elapsed', { raf: n(report.rafSpanMilliseconds), wall: n(report.wallMilliseconds), overrun: n(report.durationOverrunMilliseconds) })}</p>
    <p>{t('counts', { frames: n(report.frames), ticks: n(report.advancedTicks), zero: n(report.zeroTickFrames), multi: n(report.multiTickFrames) })}</p>
    <details><summary>{t('details')}</summary>
      <p>{t('population', { disciples: n(report.disciples), jobs: n(report.initialActiveJobs), start: n(report.startingTick), end: n(report.endingTick) })}</p>
      <p>{t('timing', { total: n(report.sessionMilliseconds), anchor: n(report.anchorSessionMilliseconds), over: n(report.sessionOver50Milliseconds) })}</p>
      <p>{t('interval', { p50: n(report.rafIntervals.p50), p95: n(report.rafIntervals.p95), max: n(report.rafIntervals.max) })}</p>
      <p>{t('duration', { p50: n(report.sessionDurations.p50), p95: n(report.sessionDurations.p95), max: n(report.sessionDurations.max) })}</p>
      <p>{t('pending', { start: n(report.initialPendingMicroseconds), end: n(report.endingPendingMicroseconds), max: n(report.maximumPendingMicroseconds) })}</p>
      <p>{t('demand', { demand: n(report.demandMicroseconds), residual: n(report.accountingResidualMicroseconds), mismatch: n(report.tickDeltaMismatch) })}</p>
      <p>{t('accounting')}</p>
      <ul>{report.segments.map((segment, i) => <li key={i}>{t('segment', { label: t((['early', 'middle', 'late'] as const)[i]!), frames: n(segment.frames), ticks: n(segment.advancedTicks), active: n(segment.activeWorkFrames), demand: n(segment.demandMicroseconds), pending: n(segment.endingPendingMicroseconds) })}</li>)}</ul>
      <p>{t('longTasks', { status: t(report.longTasks.status === 'not-started' ? 'notStarted' : report.longTasks.status), count: n(report.longTasks.count), total: n(report.longTasks.milliseconds), max: n(report.longTasks.maximumMilliseconds) })}</p>
      <p>{t('finalOnly')}</p><p>{t('caveat')}</p>
    </details>
  </details>;
}
