import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { BattlePanel } from '../../src/app/BattlePanel';
import { BuildPanel } from '../../src/app/BuildPanel';
import { ExpeditionPanel, defaultExpeditionSquad } from '../../src/app/ExpeditionPanel';
import { WorkspaceTabs, workspacePanel, workspaceTabIndex } from '../../src/app/WorkspaceTabs';
import { ApplicationSession } from '../../src/application/session';
import { LEGACY_V7_CONTENT } from '../../src/content/registry';
import { createBuildFrame } from '../../src/core/builds';
import { createBattle, serializeBattle } from '../../src/core/combat';
import { createCombatController } from '../../src/core/combat/ai';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { translate } from '../../src/i18n';

const noop = () => undefined;
const panelTags = (html: string) => [...html.matchAll(/<[^>]+role="tabpanel"[^>]*>/g)].map(match => match[0]);
// DOM shape and pure navigation contracts only. Browser interaction, layout,
// Canvas selection and 150% zoom remain the integration owner's acceptance work.
describe('campaign workspace navigation', () => {
  it('wraps arrow navigation, supports Home/End and leaves Escape/Space to their existing owners', () => {
    expect(workspaceTabIndex('ArrowRight', 3, 4)).toBe(0);
    expect(workspaceTabIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(workspaceTabIndex('Home', 2, 4)).toBe(0);
    expect(workspaceTabIndex('End', 0, 4)).toBe(3);
    for (const key of ['Escape', ' ', 'Enter', 'Tab', 'ArrowDown']) expect(workspaceTabIndex(key, 1, 4)).toBeNull();
    expect(workspaceTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
  it('gives the active tab the only roving tab stop and retains every panel identity', () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(<WorkspaceTabs id="unit-workspace" label="Fixture" selected="two" onSelect={onSelect} tabs={[{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]} />);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/id="unit-workspace-tab-one"[^>]+aria-controls="unit-workspace-panel-one"[^>]+aria-selected="false"[^>]+tabindex="-1"/);
    expect(html).toMatch(/id="unit-workspace-tab-two"[^>]+aria-controls="unit-workspace-panel-two"[^>]+aria-selected="true"[^>]+tabindex="0"/);
    expect(workspacePanel('unit-workspace', 'one', 'two')).toEqual({ id: 'unit-workspace-panel-one', role: 'tabpanel', 'aria-labelledby': 'unit-workspace-tab-one', hidden: true, tabIndex: 0 });
    expect(workspacePanel('unit-workspace', 'two', 'two').hidden).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it.each(['zh-CN', 'en'] as const)('keeps map and live totals foremost with one mounted sect category in %s', locale => {
    const session = new ApplicationSession(); const before = session.getSnapshot();
    const html = renderToStaticMarkup(<App session={session} initialLocale={locale} />);
    const panels = panelTags(html);
    expect(panels).toHaveLength(4); expect(panels.filter(tag => tag.includes('hidden=""'))).toHaveLength(3);
    expect(html).toMatch(/<details class="campaign-ledger">/);
    const totals = html.slice(html.indexOf('class="campaign-resource-totals"'), html.indexOf('</summary>'));
    for (const resource of before.resources) {
      expect(totals).toContain(translate(locale, `resource.${resource.resourceId}`));
      expect(totals).toContain(`<strong>${resource.owned}</strong>`);
    }
    expect(html.indexOf('class="world-panel"')).toBeLessThan(html.indexOf('class="sect-workbench"'));
    for (const key of ['live.inspect', 'live.disciples', 'live.buildings', 'live.events'] as const) expect(html).toContain(translate(locale, key));
    expect(html).not.toContain('文本暂不可用'); expect(session.getSnapshot()).toBe(before);
  });
  it.each(['zh-CN', 'en'] as const)('places the current expedition checkpoint before the folded itinerary in %s', locale => {
    const session = new ApplicationSession();
    const proposal = session.prepareExpedition({ squadIds: defaultExpeditionSquad(session.getSnapshot()), routeId: 'route.qingfeng-trial' });
    expect(session.confirmDeparture(proposal).status).toBe('accepted');
    const before = canonicalStringify(session.exportWorld());
    const html = renderToStaticMarkup(<ExpeditionPanel session={session} world={session.getSnapshot()} controller={session.getBattleController()} locale={locale} readOnly={false} onReturnSect={noop} />);
    expect(html.indexOf('class="expedition-checkpoint"')).toBeLessThan(html.indexOf('class="expedition-briefing"'));
    expect(html).toContain('<details class="expedition-briefing">');
    expect(html).toContain('class="expedition-run-summary"');
    expect(html).toContain(translate(locale, 'expedition.ui.squad'));
    expect(canonicalStringify(session.exportWorld())).toBe(before);
  });
  it.each(['zh-CN', 'en'] as const)('keeps one battle support pane visible without dropping skills or keyboard rosters in %s', locale => {
    const catalog = LEGACY_V7_CONTENT.combat;
    const battle = createBattle(catalog, { seed: 'workspace-panel', contentMode: 'experimental', entities: [
      { id: 'entity:1', team: 'party', position: { x: 0, y: 0 }, stats: { attack: 100, maxHealth: 1000 }, skills: ['skill.baoyue', 'skill.liuhen-jian'] },
      { id: 'entity:2', team: 'enemy', position: { x: 80, y: 0 }, stats: { attack: 100, maxHealth: 1000 } },
    ] });
    const controller = createCombatController(catalog, battle, { playerTeam: 'party', arena: { origin: { x: 0, y: 0 }, widthCells: 12, heightCells: 5, cellSizeUnits: 20, blockedCells: [] } });
    const before = serializeBattle(controller.battle); const onTacticalOrder = vi.fn();
    const html = renderToStaticMarkup(<BattlePanel controller={controller} catalog={catalog} locale={locale} paused speed={1} onPausedChange={noop} onSpeedChange={noop} onTacticalOrder={onTacticalOrder} />);
    const panels = panelTags(html);
    expect(panels).toHaveLength(4); expect(panels.filter(tag => tag.includes('hidden=""'))).toHaveLength(3);
    expect(panels.find(tag => tag.includes('-panel-command'))).not.toContain('hidden');
    expect(html.indexOf('class="battle-playfield"')).toBeLessThan(html.indexOf('class="battle-workbench"'));
    for (const className of ['battle-unit-button', 'battle-inspector', 'battle-log', 'battle-skills', 'battle-command-strip', 'battle-target-summary']) expect(html).toContain(`class="${className}"`);
    expect(html).toContain('data-skill-id="skill.baoyue"'); expect(html).toContain('data-skill-id="skill.liuhen-jian"');
    expect(html).not.toContain('文本暂不可用'); expect(onTacticalOrder).not.toHaveBeenCalled(); expect(serializeBattle(controller.battle)).toBe(before);
  });
  it('opts ordinary builds into categories while the default management consumer keeps all sections', () => {
    const catalog = LEGACY_V7_CONTENT.combat;
    const frame = createBuildFrame({ disciples: [{ discipleId: 'entity:1', school: 'sword' }], contentMode: 'experimental' }, catalog);
    const before = canonicalStringify(frame); const onCommand = vi.fn(() => ({ ok: true }));
    const props = { frame, catalog, discipleId: 'entity:1', locale: 'en' as const, onCommand };
    const legacy = renderToStaticMarkup(<BuildPanel {...props} />);
    const compact = renderToStaticMarkup(<BuildPanel {...props} workspace />);
    expect(panelTags(legacy)).toHaveLength(0); expect(panelTags(compact)).toHaveLength(3);
    expect(panelTags(compact).filter(tag => tag.includes('hidden=""'))).toHaveLength(2);
    expect(panelTags(compact).find(tag => tag.includes('-panel-loadout'))).not.toContain('hidden');
    for (const name of ['build-tree-section', 'build-loadout-section', 'build-library']) { expect(legacy).toContain(`class="${name}"`); expect(compact).toContain(`class="${name}"`); }
    expect(compact.match(/<select\b/g)).toHaveLength(legacy.match(/<select\b/g)!.length);
    expect(canonicalStringify(frame)).toBe(before); expect(onCommand).not.toHaveBeenCalled();
  });
  it('keeps hidden controls unreachable and gives overflow, list focus and drafts explicit owners', () => {
    const tabsCss = readFileSync(new URL('../../src/app/workspace-tabs.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../src/app/App.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../src/app/BuildPanel.tsx', import.meta.url), 'utf8');
    expect(tabsCss).toContain('[role="tabpanel"][hidden] { display: none !important; }');
    expect(app).toContain('resourceLedger.current.open = true');
    expect(app).toContain('sectDetailFocus.current = true; session.select');
    expect(app).toContain('sectDetail.current.focus()');
    expect(build).toContain('category !== currentDraft.kind');
    expect(build).toContain('onSelect={setCategory}');
    expect(build).not.toContain("addEventListener('keydown'");
    expect(build).not.toContain('setCategory(category); setDraft(null)');
  });
});
