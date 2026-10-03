import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { ManagementSaveControllerV9 } from '../../src/application/management-v9-save-controller';
import { managementBlockedV9, type ManagementSnapshotV9 } from '../../src/application/management-v9-contract';
import { ManagementAppV9 } from '../../src/app/ManagementAppV9';
import { ManagementCarePatientV9, SectManagementPanelV9 } from '../../src/app/SectManagementPanelV9';
import { translate, type TextKey, type TranslationParams } from '../../src/i18n';

// Node checks markup and source contracts only. Canvas, scrolling, sticky
// geometry, zoom, pointer hit-testing and focus restoration need browser QA.
vi.mock('../../src/phaser/PhaserWorld', () => ({ PhaserWorld: () => null }));

const t = (key: TextKey, parameters?: TranslationParams) => translate('zh-CN', key, parameters);
function withSession(run: (session: ApplicationSessionV9) => void) {
  const session = new ApplicationSessionV9();
  try { run(session); } finally { session.close(); }
}

const sectionIds = ['overview', 'roster', 'cultivation', 'build', 'production', 'jobs', 'research', 'care', 'maintenance'];
const commandBarMarkup = (html: string) => /<div class="management-v9-command-bar"[^>]*>[\s\S]*?<\/p><\/div>/.exec(html)?.[0] ?? '';
describe('v9 long-page navigation semantics', () => {
  it.each(['zh-CN', 'en'] as const)('retains links to unique focusable named sections in a native disclosure in %s', locale => withSession(session => {
    const saves = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    try {
      const before = session.getSnapshot();
      const html = renderToStaticMarkup(createElement(ManagementAppV9, { session, saves, initialLocale: locale }));
      const nav = /<nav class="management-v9-section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[0] ?? '';
      expect(html).toContain(`<details class="management-v9-navigation-disclosure"><summary>${translate(locale, 'managementV9.navigation')}</summary>${nav}</details>`);
      expect(nav).toContain(`aria-label="${translate(locale, 'managementV9.navigation')}"`);
      for (const suffix of sectionIds) {
        const id = `management-v9-${suffix}`;
        expect(nav).toContain(`href="#${id}"`);
        expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
        expect(html).toMatch(new RegExp(`<section id="${id}"[^>]*tabindex="-1"[^>]*aria-label(?:ledby)?=`));
      }
      expect(html).not.toMatch(/\bhidden(?:="")?|display:\s*none/);
      expect(session.getSnapshot()).toBe(before);
    } finally { saves.stop(); }
  }));

  it('keeps one run/save control pair and separates the quiet calendar from action-only live feedback', () => withSession(session => {
    const saves = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    try {
      const html = renderToStaticMarkup(createElement(ManagementAppV9, { session, saves }));
      const commandBar = commandBarMarkup(html);
      expect(commandBar).not.toBe('');
      expect(commandBar).toContain(`>${t('managementV9.pause')}</button>`);
      expect(commandBar).toContain(`>${t('save.open')}</button>`);
      expect(commandBar).toContain('class="management-v9-feedback" role="status" aria-live="polite" aria-atomic="true"');
      expect(commandBar).toContain(t('managementV9.feedbackReady'));
      expect(commandBar).not.toContain(t('managementV9.loopHint'));
      const feedback = /<p class="management-v9-feedback"[^>]*>([\s\S]*?)<\/p>/.exec(commandBar)?.[0] ?? '';
      expect(feedback).not.toContain(t('live.tick', { tick: 0 }));
      expect(html.split(`>${t('save.open')}</button>`)).toHaveLength(2);
      const clock = /<div class="management-v9-clock">([\s\S]*?)<\/div>/.exec(html)?.[0] ?? '';
      expect(clock).toContain(t('live.tick', { tick: session.getSnapshot().frame.clock.simulationTick }));
      expect(clock).not.toMatch(/aria-live|role="status"/);
    } finally { saves.stop(); }
  }));

  it('places actual tasks immediately after the production column, before research and care in DOM order', () => withSession(session => {
    const html = renderToStaticMarkup(createElement(SectManagementPanelV9, { session, snapshot: session.getSnapshot(), readOnly: false, getReadOnly: () => false, t, onFeedback: vi.fn() }));
    const order = [...html.matchAll(/<section id="management-v9-([^"]+)"/g)].map(match => match[1]);
    expect(order).toEqual(['production', 'jobs', 'research', 'care', 'maintenance']);
    expect(html.match(/class="management-v9-panel-column"/g)).toHaveLength(2);
    expect(html).toContain('<div class="management-v9-panel-column"><section id="management-v9-jobs"');
    expect(html).toContain(t('managementV9.noJobs'));
  }));

  it('blocks the shell clock and save controls during a child-owned review', () => withSession(session => {
    const saves = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    try {
      expect(session.setReviewPaused(true).ok).toBe(true);
      const html = renderToStaticMarkup(createElement(ManagementAppV9, { session, saves }));
      const bar = commandBarMarkup(html);
      expect(bar).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t('managementV9.pause')}</button>`));
      expect(bar).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t('save.open')}</button>`));
      expect(session.getSnapshot().holds.review).toBe(true);
      const app = readFileSync(new URL('../../src/app/ManagementAppV9.tsx', import.meta.url), 'utf8');
      expect(app).toContain("managementIntentGuardV9(snapshot, current, getReadOnly(), 'construction', review !== null)");
    } finally { saves.stop(); }
  }));

  it('uses wrapping, natural-height styles and measured anchor clearance without CSS visual reordering', () => {
    const css = readFileSync(new URL('../../src/app/management-v9-navigation.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../src/app/ManagementAppV9.tsx', import.meta.url), 'utf8');
    expect(css).toContain('position: sticky');
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain('var(--management-v9-toolbar-height');
    expect(css).not.toMatch(/(?:^|[;{])\s*(?:order|grid-area|grid-row|height|max-height)\s*:|line-clamp|overflow\s*:\s*(?:hidden|clip)/);
    expect(app).toContain('new ResizeObserver(measure)');
    expect(app).toContain('observer?.disconnect()');
    expect(app).toContain("window.removeEventListener('resize', measure)");
    expect(app).toContain('managementIntentGuardV9(review.basis, current, getReadOnly()');
    const baseCss = readFileSync(new URL('../../src/app/management-v9.css', import.meta.url), 'utf8');
    expect(baseCss).toContain('.management-v9-panel .management-v9-feedback { color: #eee7d1; }');
  });
});

describe('v9 map-first presentation', () => {
  it.each(['zh-CN', 'en'] as const)('keeps the map ahead of contextual placement and retains the complete ledger in %s', locale => withSession(session => {
    const saves = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    try {
      const before = session.getSnapshot();
      const html = renderToStaticMarkup(createElement(ManagementAppV9, { session, saves, initialLocale: locale }));
      expect(html).toContain('class="management-v9 management-v9-map-first"');
      const scope = /<details class="management-v9-scope">([\s\S]*?)<\/details>/.exec(html)?.[0] ?? '';
      expect(scope).toContain(translate(locale, 'managementV9.candidate'));
      expect(scope).toContain(translate(locale, 'managementV9.scope'));
      const summary = /<section id="management-v9-overview"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[0] ?? '';
      const ledger = /<details class="management-v9-ledger">([\s\S]*?)<\/details>/.exec(html)?.[0] ?? '';
      const rows = [...before.frame.resources, ...before.expansion.stock];
      expect(summary.match(/<article>/g)).toHaveLength(rows.length);
      expect(ledger.match(/<article>/g)).toHaveLength(rows.length);
      expect(summary).not.toContain('<p>');
      for (const row of rows) {
        expect(summary).toContain(`<strong>${row.owned}</strong>`);
        expect(ledger).toContain(translate(locale, 'live.available', { available: row.available, reserved: row.reserved }));
        expect(ledger).toContain(translate(locale, 'live.capacity', { capacity: row.capacity }));
      }
      const mapAt = html.indexOf('<section class="management-v9-world"');
      const placementAt = html.indexOf('<details class="management-v9-placement-disclosure">');
      const rosterAt = html.indexOf('<section id="management-v9-roster"');
      expect(mapAt).toBeGreaterThan(0);
      expect(placementAt).toBeGreaterThan(mapAt);
      expect(rosterAt).toBeGreaterThan(placementAt);
      expect(html).toContain(`<h2 id="management-v9-selection">${translate(locale, 'managementV9.people')}</h2>`);
      expect(html).toContain(`aria-description="${translate(locale, 'managementV9.selection')}"`);
      expect(html).toContain(translate(locale, 'managementV9.preview'));
      expect(session.getSnapshot()).toBe(before);
    } finally { saves.stop(); }
  }));

  it('keeps unsaved, read-only and storage-error facts outside collapsed disclosures', () => withSession(session => {
    const saves = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    const status = { ...saves.getSnapshot(), readOnly: true, dirty: true, notice: 'save.error.quota' as const };
    const getSnapshot = vi.spyOn(saves, 'getSnapshot').mockReturnValue(status);
    try {
      const html = renderToStaticMarkup(createElement(ManagementAppV9, { session, saves, initialLocale: 'zh-CN' }));
      const persistent = html.slice(html.indexOf('</header>'), html.indexOf('<section id="management-v9-overview"'));
      expect(persistent).toContain(t('save.readOnly'));
      expect(persistent).toContain(t('managementV9.unsaved'));
      expect(persistent).toContain(t('managementV9.manualOnly'));
      expect(persistent).toContain(t('save.error.quota'));
      expect(persistent).not.toContain('<details');
    } finally { getSnapshot.mockRestore(); saves.stop(); }
  }));

  it('opts into layout-only rules and keeps review fields mounted without moving keyboard focus', () => {
    const app = readFileSync(new URL('../../src/app/ManagementAppV9.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../src/app/management-v9.css', import.meta.url), 'utf8');
    const nav = readFileSync(new URL('../../src/app/management-v9-navigation.css', import.meta.url), 'utf8');
    expect(app).toContain('open={placementOpen || review !== null}');
    expect(app).toContain('if (review && !event.currentTarget.open) event.currentTarget.open = true');
    expect(app).toContain('if (review) event.preventDefault()');
    expect(app).toContain('setPlacementOpen(true); setRequest(next); if (review) prepare(next)');
    expect(app).not.toContain('placementOpen &&');
    expect(css).toContain('.management-v9-map-first .management-v9-map-layout { grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('.management-v9-map-first :is(button, select, input:not([type="checkbox"]):not([type="radio"]), summary) { min-height: 2.75rem; }');
    expect(css).toContain('.management-v9-map-first .management-v9-resources h2 { font-size: .875rem;');
    expect(nav).toContain('@media (max-width: 48rem), (max-height: 34rem)');
    expect(nav).toContain('.management-v9-map-first .management-v9-command-bar { position: static; }');
  });
});

describe('v9 adjacent care disabled reasons', () => {
  it.each(['zh-CN', 'en'] as const)('describes the exact disabled gate through the existing cost association in %s', locale => withSession(session => {
    const base = session.getSnapshot();
    // Presentation-only variations; these are not injected into the Session or
    // claimed as valid save worlds or browser interaction coverage.
    const available: ManagementSnapshotV9 = { ...base,
      cultivation: { ...base.cultivation, selected: { ...base.cultivation.selected!, lifeState: 'alive', injury: 25, activityLocked: false, workOwner: null } },
      expansion: { ...base.expansion, stock: [{ resourceId: 'wound-powder', owned: 1, reserved: 0, available: 1, capacity: 99 }] },
    };
    const translator = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
    const show = (snapshot: ManagementSnapshotV9, readOnly = false) => {
      const blocked = managementBlockedV9(snapshot, readOnly);
      return renderToStaticMarkup(createElement(ManagementCarePatientV9, { session, snapshot, risk: null, blocked: !!blocked, blockedReason: blocked,
        name: 'Patient', costId: 'care-cost', t: translator, onStartCare: vi.fn() }));
    };
    const variants: Array<{ snapshot: ManagementSnapshotV9; key: TextKey; readOnly?: boolean }> = [
      { snapshot: available, readOnly: true, key: 'managementV9.readOnly' },
      { snapshot: { ...available, holds: { ...available.holds, player: true } }, key: 'managementV9.pausedHint' },
      { snapshot: { ...available, holds: { ...available.holds, storageBusy: true } }, key: 'managementV9.busy' },
      { snapshot: { ...available, holds: { ...available.holds, review: true } }, key: 'managementV9.reviewHeld' },
      { snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, lifeState: 'dead' } } }, key: 'managementV9.careDead' },
      { snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, lifeState: 'pendingDeath' } } }, key: 'managementV9.carePendingDeath' },
      { snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, injury: 0 } } }, key: 'managementV9.careHealthy' },
      { snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, activityLocked: true } } }, key: 'managementV9.careOccupied' },
      { snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, workOwner: { kind: 'care', id: 'occupied', workerId: available.cultivation.selected!.discipleId } } } }, key: 'managementV9.careOccupied' },
      { snapshot: { ...available, expansion: { ...available.expansion, stock: [{ resourceId: 'wound-powder', owned: 1, reserved: 1, available: 0, capacity: 99 }] } }, key: 'managementV9.carePowderMissing' },
    ];
    for (const { snapshot, key, readOnly } of variants) {
      const html = show(snapshot, readOnly);
      expect(html).toContain('<span class="management-v9-care-reason">');
      const description = /<p id="care-cost">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
      expect(description).toContain(translator(key));
      expect(html).toContain('<button type="button" aria-describedby="care-cost" disabled=""');
      expect(html.indexOf('management-v9-care-risk')).toBeGreaterThan(html.indexOf('</button>'));
    }
    const ready = show(available);
    expect(ready).not.toContain('disabled=');
    expect(ready).toContain('<span class="management-v9-care-reason"></span>');
  }));
});
