import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { ApplicationSession } from '../../src/application/session';
import { CandidatePreviewNotice } from '../../src/candidate';
import { translate, type Locale } from '../../src/i18n';

// These checks cover markup and presentation inputs only. Real layout, zoom,
// Canvas hit targets and dialog focus restoration still require browser QA.
describe('public shell presentation contracts', () => {
  it.each(['zh-CN', 'en'] as const)('resolves one preview notice in the active entry locale %s', locale => {
    const requestedLocales: Locale[] = [];
    const html = renderToStaticMarkup(createElement(App, {
      initialLocale: locale,
      previewNotice: currentLocale => {
        requestedLocales.push(currentLocale);
        return createElement(CandidatePreviewNotice, { locale: currentLocale });
      },
    }));
    const otherLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    expect(requestedLocales).toEqual([locale]);
    expect(html.match(/class="candidate-preview-notice"/g)).toHaveLength(1);
    const entry = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
    expect(entry).toContain(translate(locale, 'candidate.banner'));
    expect(entry).not.toContain(translate(otherLocale, 'candidate.banner'));
    expect(html.slice(0, html.indexOf('<dialog'))).not.toContain(translate(locale, 'candidate.banner'));
    expect(html).toContain('class="campaign-world" inert=""');
    expect(html).not.toContain(translate(locale, 'live.phase'));
  });

  it('retains ReactNode notice callers without duplicating the active notice', () => {
    const html = renderToStaticMarkup(createElement(App, {
      initialLocale: 'en',
      previewNotice: createElement('aside', { 'data-preview-fixture': 'legacy-node' }, 'Preview fixture'),
    }));
    expect(html.match(/data-preview-fixture="legacy-node"/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('<dialog'))).toContain('Preview fixture');
  });

  it.each(['zh-CN', 'en'] as const)('keeps map-first order, real resources and equivalent controls in %s', locale => {
    const session = new ApplicationSession();
    const before = session.getSnapshot();
    const html = renderToStaticMarkup(createElement(App, { session, initialLocale: locale }));
    const map = html.indexOf('class="world-panel"');
    const inspector = html.indexOf('class="inspector"');
    const roster = html.indexOf('class="sect-roster"');
    expect(map).toBeGreaterThan(-1);
    expect(inspector).toBeGreaterThan(map);
    expect(roster).toBeGreaterThan(inspector);
    expect(html).toContain(translate(locale, 'live.phase'));
    for (const resource of before.resources) {
      expect(html).toContain(`class="resource resource-${resource.resourceId}"`);
      expect(html).toContain(translate(locale, 'live.available', { available: resource.available, reserved: resource.reserved }));
    }
    const pauseKey = before.clock.pauseReasons.includes('player') ? 'time.resume' : 'time.pause';
    for (const key of [pauseKey, 'time.normal', 'time.fast', 'save.open', 'entry.open', 'live.zoomOut', 'live.zoomIn', 'live.resetView'] as const) {
      expect(html).toContain(translate(locale, key).replaceAll('&', '&amp;'));
    }
    expect(session.getSnapshot()).toBe(before);
    expect(session.getEngineVersion()).toBe(7);
    expect(html).not.toContain('candidate-preview-notice');
  });
});
