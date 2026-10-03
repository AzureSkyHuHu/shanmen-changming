import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { SectManagementPanelV9 } from '../../src/app/SectManagementPanelV9';
import { ManagementWorkspace, managementWorkspaceFocusIndex, managementWorkspaceNextSection, focusManagementWorkspacePanel, type ManagementWorkspaceSection } from '../../src/app/ManagementWorkspace';
import { translate, type TextKey, type TranslationParams } from '../../src/i18n';

const t = (key: TextKey, parameters?: TranslationParams) => translate('zh-CN', key, parameters);
const sectionIds: readonly ManagementWorkspaceSection[] = ['overview', 'roster', 'cultivation', 'build', 'placement', 'production', 'jobs', 'research', 'upgrade', 'care', 'maintenance'];

describe('compact management workspace presentation', () => {
  it.each(sectionIds)('keeps one selected tab and both mounted surfaces for %s', active => {
    const html = renderToStaticMarkup(createElement(ManagementWorkspace, {
      id: 'workspace', active, tabs: sectionIds.map(id => ({ id, label: id, ...(id === 'jobs' ? { count: 3 } : {}) })),
      navigationLabel: 'Sections', locked: false, reviewLabel: 'Review first', onSelect: vi.fn(),
      map: createElement('div', { 'data-mounted-map': true }, 'Map'),
      children: createElement('input', { defaultValue: 'Retained draft', 'data-mounted-editor': true }),
    }));
    expect(html.match(/role="tab"/g)).toHaveLength(sectionIds.length);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain(`id="workspace-tab-${active}" aria-selected="true"`);
    expect(html).toContain(`data-section="${active}"`);
    expect(html).toContain('data-mounted-map="true"'); expect(html).toContain('data-mounted-editor="true"');
    expect(html).toContain('value="Retained draft"'); expect(html).toContain('management-workspace-count">3');
    expect(html).toContain('id="workspace-detail"'); expect(html).toContain('id="workspace-map"');
  });

  it('pins the review owner for every attempted section change and releases normally', () => {
    for (const owner of sectionIds) for (const next of sectionIds) {
      expect(managementWorkspaceNextSection(owner, next, true)).toBe(owner);
      expect(managementWorkspaceNextSection(owner, next, false)).toBe(next);
    }
    const html = renderToStaticMarkup(createElement(ManagementWorkspace, {
      id: 'locked', active: 'build', tabs: [{ id: 'build', label: 'Build' }, { id: 'jobs', label: 'Jobs' }],
      navigationLabel: 'Sections', locked: true, reviewLabel: 'Review first', onSelect: vi.fn(), map: null, children: null,
    }));
    expect(html).toContain('aria-describedby="locked-review-lock"');
    expect(html).toContain('id="locked-tab-jobs" aria-selected="false" aria-controls="locked-detail" aria-disabled="true"');
    expect(html).toContain('id="locked-review-lock" class="management-workspace-review-lock" role="status">Review first');
  });

  it('supports wrapping arrow keys and Home/End without automatically committing a tab', () => {
    expect(managementWorkspaceFocusIndex(0, 4, 'ArrowLeft')).toBe(3);
    expect(managementWorkspaceFocusIndex(3, 4, 'ArrowRight')).toBe(0);
    expect(managementWorkspaceFocusIndex(2, 4, 'Home')).toBe(0);
    expect(managementWorkspaceFocusIndex(2, 4, 'End')).toBe(3);
    expect(managementWorkspaceFocusIndex(2, 4, 'Escape')).toBeNull();
    expect(managementWorkspaceFocusIndex(2, 4, 'Enter')).toBeNull();
    expect(managementWorkspaceFocusIndex(0, 0, 'Home')).toBeNull();
  });

  it.each(['production', 'jobs', 'research', 'placement', 'care', 'maintenance'] as const)('shows only the chosen sect category and preserves its worker access: %s', activeSection => {
    const session = new ApplicationSessionV9();
    try {
      const before = session.getSnapshot(); const dispatch = vi.spyOn(session, 'dispatch'); const select = vi.spyOn(session, 'select');
      const html = renderToStaticMarkup(createElement(SectManagementPanelV9, { activeSection, session, snapshot: before, readOnly: false, getReadOnly: () => false, t, onFeedback: vi.fn() }));
      const sections = [...html.matchAll(/<section id="management-v9-([^"]+)"([^>]*)>/g)];
      expect(sections).toHaveLength(6);
      const visible = sections.filter(match => !match[2]!.includes('hidden=""')).map(match => match[1]);
      expect(visible).toEqual([activeSection === 'placement' ? 'blueprints' : activeSection]);
      const picker = /<div class="management-workspace-worker"([^>]*)>/.exec(html);
      expect(picker?.[1]?.includes('hidden=""')).toBe(!['production', 'research', 'placement'].includes(activeSection));
      expect(html.match(new RegExp(`<label class="management-v9-field">${t('production.worker')}`, 'g'))).toHaveLength(1);
      expect(session.getSnapshot()).toBe(before); expect(dispatch).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    } finally { session.close(); }
  });

  it('moves focus only for the roster activation that owns the newly visible panel', () => {
    const focus = vi.fn();
    const panel = { isConnected: true, focus } as unknown as HTMLElement;
    const opener = { isConnected: true } as HTMLElement;
    const body = {} as HTMLElement;
    const request = { section: 'cultivation' as const, opener };
    expect(focusManagementWorkspacePanel(request, 'cultivation', panel, { activeElement: opener, body })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    // Some browsers move focus to body as soon as the roster becomes hidden.
    expect(focusManagementWorkspacePanel(request, 'cultivation', panel, { activeElement: body, body })).toBe(true);
    const laterControl = {} as HTMLElement;
    expect(focusManagementWorkspacePanel(request, 'cultivation', panel, { activeElement: laterControl, body })).toBe(false);
    expect(focusManagementWorkspacePanel(request, 'jobs', panel, { activeElement: body, body })).toBe(false);
    expect(focusManagementWorkspacePanel({ ...request, opener: { isConnected: false } as HTMLElement }, 'cultivation', panel, { activeElement: body, body })).toBe(false);
    expect(focusManagementWorkspacePanel(request, 'cultivation', { isConnected: false, focus } as unknown as HTMLElement, { activeElement: body, body })).toBe(false);
    expect(focus).toHaveBeenCalledTimes(2);
    for (const version of ['V9', 'V10']) {
      const app = readFileSync(new URL(`../../src/app/ManagementApp${version}.tsx`, import.meta.url), 'utf8');
      expect(app).toContain("onClick={event => choose({ kind: 'disciple', id: actor.id }, event.currentTarget)}");
      expect(app).toContain('if (opener && document.activeElement === opener) setWorkspaceFocus({ section: next, opener });');
      expect(app).toContain('focusRequest={workspaceFocus}');
    }
    const workspace = readFileSync(new URL('../../src/app/ManagementWorkspace.tsx', import.meta.url), 'utf8');
    expect(workspace).toContain('consumedFocus.current === focusRequest');
    expect(workspace).toContain('}, [focusRequest, active]);');
  });

  it('keeps layout, visibility and listeners separate from authoritative state', () => {
    const workspace = readFileSync(new URL('../../src/app/ManagementWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../src/app/management-workspace.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../src/app/ManagementAppV9.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../src/app/ManagementBuildPanelV9.tsx', import.meta.url), 'utf8');
    const cultivation = readFileSync(new URL('../../src/app/ManagementCultivationPanelV9.tsx', import.meta.url), 'utf8');
    expect(workspace).not.toMatch(/session\.|dispatch\(|setPaused\(|exportWorld\(/);
    expect(workspace).toContain('observer?.disconnect()');
    expect(workspace).toContain("window.removeEventListener('resize', measure)");
    expect(css).toContain('overflow: auto; scrollbar-gutter: stable');
    expect(css).toContain('@media (max-width: 60rem)');
    expect(css).toContain('block-size: auto; min-block-size: 0');
    expect(css).toContain('[hidden] { display: none !important; }');
    expect(css).not.toMatch(/line-clamp|text-overflow:\s*ellipsis/);
    expect(app).toContain('onReviewChange={setBuildReviewOpen}');
    expect(app).toContain('snapshot.holds.review || review !== null || buildReviewOpen');
    expect(app).toContain('snapshot.cultivation.decisions.length > 0');
    expect(app).toContain("hidden={activeSection !== 'build'}");
    expect(app).not.toContain("activeSection === 'build' &&");
    expect(build).toContain('if (!active || !draft && !review) return;');
    expect(build).toContain('return () => onReviewChange?.(false)');
    expect(build).toContain('onReviewChange?.(review !== null)');
    expect(cultivation).toContain('if (!active || !review) return;');
    const v10 = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    expect(v10).toContain('if (!active || !draft) return;');
    expect(v10).toContain('<ReviewPanelV10 context={context} review={review} locale={locale} />');
  });
});
