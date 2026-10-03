import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrowserFrameDiagnostics, type FrameDiagnosticSession } from '../../src/application/browser-frame-diagnostics';
import { FrameDiagnosticsView, frameDiagnosticMessages, frameDiagnosticSpecifications, translateFrameDiagnostic } from '../../src/app/FrameDiagnosticsPanel';
import { validateLocales } from '../../src/i18n';

describe('local-only frame diagnostics presentation', () => {
  it('validates stable bilingual keys and parameter contracts', () => {
    const cn = Object.fromEntries(Object.entries(frameDiagnosticMessages).map(([key, values]) => [key, values[0]]));
    const en = Object.fromEntries(Object.entries(frameDiagnosticMessages).map(([key, values]) => [key, values[1]]));
    expect(validateLocales(cn, en, frameDiagnosticSpecifications).valid).toBe(true);
    for (const key of Object.keys(frameDiagnosticMessages) as (keyof typeof frameDiagnosticMessages)[]) {
      const parameters = Object.fromEntries(Object.keys(frameDiagnosticSpecifications[key]!.parameters).map(name => [name, '1']));
      expect(translateFrameDiagnostic('zh-CN', key, parameters)).not.toContain('文本暂不可用'); expect(translateFrameDiagnostic('en', key, parameters)).not.toContain('文本暂不可用');
    }
  });
  it('renders compact closed details, explicit capture controls and no acceptance badge', () => {
    const diagnostic = new BrowserFrameDiagnostics({} as FrameDiagnosticSession, 'v9', { now: () => 0, isVisible: () => true, isFocused: () => true });
    const html = renderToStaticMarkup(createElement(FrameDiagnosticsView, { report: diagnostic.getSnapshot(), locale: 'en', onStart: () => {}, onStop: () => {} }));
    expect(html).toContain('<details class="frame-diagnostics">'); expect(html).not.toContain('<details open');
    expect(html).toContain('Start 60-second capture'); expect(html).toContain('disabled=""');
    expect(html).toContain('not full DD-13 acceptance'); expect(html).toContain('36 disciples'); expect(html).toContain('60 fps normal / 30 fps low quality');
    expect(html).toContain('no network or persistence'); expect(html).toContain('Run strict full-state comparisons separately'); diagnostic.dispose();
  });
  it('keeps entry activation independent and instrumentation on the one existing callback only', () => {
    const panel = readFileSync(new URL('../../src/app/FrameDiagnosticsPanel.tsx', import.meta.url), 'utf8');
    const collector = readFileSync(new URL('../../src/application/browser-frame-diagnostics.ts', import.meta.url), 'utf8');
    expect(panel).toContain('import.meta.env.VITE_ENABLE_FRAME_DIAGNOSTICS'); expect(panel).not.toContain('VITE_ENABLE_V10_MANAGEMENT');
    expect(panel).toContain('owned.dispose()'); expect(panel).toContain("removeEventListener('blur', blur)");
    for (const code of [panel, collector]) expect(code).not.toMatch(/requestAnimationFrame\(|setInterval\(|fetch\(|localStorage|indexedDB|exportWorld\(|JSON\.stringify|console\./);
    for (const version of ['V9', 'V10']) {
      const app = readFileSync(new URL(`../../src/app/ManagementApp${version}.tsx`, import.meta.url), 'utf8');
      expect(app).toContain('if (frameDiagnostics.current) frameDiagnostics.current.frame(timestamp); else session.frame(timestamp);');
      expect(app).toContain('{diagnosticController && <FrameDiagnosticsPanel');
      expect(app.match(/const tick = \(timestamp: number\)/g)).toHaveLength(1);
    }
    const css = readFileSync(new URL('../../src/app/frame-diagnostics.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/line-clamp|text-overflow:\s*ellipsis/); expect(css).toContain('overflow-wrap: anywhere');
  });
  it('allows opt-in Pages instrumentation without enabling the newer candidate', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("VITE_ENABLE_FRAME_DIAGNOSTICS: '1'");
    expect(workflow).not.toContain('VITE_ENABLE_V10_MANAGEMENT');
    expect(workflow.indexOf('npm run check')).toBeLessThan(workflow.indexOf('VITE_ENABLE_FRAME_DIAGNOSTICS'));
    expect(workflow).toContain('Reject deployment of an outdated main commit');
  });
});

describe('frame diagnostic browser event ownership', () => {
  it('removes all first-mount listeners before a StrictMode-style second mount, without touching Session', async () => {
    const { vi } = await import('vitest');
    const { connectFrameDiagnostics } = await import('../../src/app/FrameDiagnosticsPanel');
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true }); const window = new EventTarget();
    const documentAdd = vi.spyOn(document, 'addEventListener'); const documentRemove = vi.spyOn(document, 'removeEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener'); const windowRemove = vi.spyOn(window, 'removeEventListener');
    const unsubscribe = vi.fn(); const session = { subscribe: vi.fn(() => unsubscribe) } as unknown as FrameDiagnosticSession;
    const ports = { now: () => 0, isVisible: () => true, isFocused: () => true }; const update = vi.fn();
    const first = new BrowserFrameDiagnostics(session, 'v9', ports); const firstObserve = vi.spyOn(first, 'observeSession');
    const firstStop = vi.spyOn(first, 'stop'); const cleanFirst = connectFrameDiagnostics(first, session, update, document, window);
    cleanFirst(); cleanFirst(); firstStop.mockClear();
    const second = new BrowserFrameDiagnostics(session, 'v9', ports); const secondObserve = vi.spyOn(second, 'observeSession');
    const secondStop = vi.spyOn(second, 'stop'); const cleanSecond = connectFrameDiagnostics(second, session, update, document, window);
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'));
    expect(firstObserve).not.toHaveBeenCalled(); expect(firstStop).not.toHaveBeenCalled(); expect(secondObserve).toHaveBeenCalledTimes(2); expect(secondStop).toHaveBeenCalledWith('blurred');
    cleanSecond(); expect(unsubscribe).toHaveBeenCalledTimes(2); expect(documentAdd).toHaveBeenCalledTimes(2); expect(documentRemove).toHaveBeenCalledTimes(2);
    expect(windowAdd).toHaveBeenCalledTimes(4); expect(windowRemove).toHaveBeenCalledTimes(4);
    expect(update).toHaveBeenCalledWith(true, false);
  });
});
