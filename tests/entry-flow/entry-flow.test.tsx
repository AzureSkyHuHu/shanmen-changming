import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApplicationSession } from '../../src/application/session';
import { SaveController, type SaveStatus } from '../../src/application/save-controller';
import { createWorld } from '../../src/core/kernel';
import { App } from '../../src/app/App';
import { CampaignEntry, DEFAULT_CAMPAIGN_SEED, campaignSeed, entryCancelAction, entryIntentCurrent, entryLoadOutcome } from '../../src/app/CampaignEntry';
import type { Locale } from '../../src/i18n';
import { shouldHandlePause } from '../../src/input/actions';

const noop = () => undefined;
const idle: Pick<SaveStatus, 'mode' | 'busy' | 'readOnly' | 'notice'> = { mode: 'browser', busy: false, readOnly: false, notice: 'save.loadedPaused' };
function menu(statusPatch: Partial<SaveStatus> = {}, hasCampaign = false, locale: Locale = 'zh-CN'): string {
  const session = new ApplicationSession();
  const controller = new SaveController(session);
  const status = { ...controller.getSnapshot(), mode: 'browser' as const, ...statusPatch };
  Object.defineProperty(controller, 'getSnapshot', { value: () => status });
  return renderToStaticMarkup(<CampaignEntry controller={controller} session={session} locale={locale} hasCampaign={hasCampaign} onEnter={noop} onCampaignAvailable={noop} onManageSaves={noop} onLocaleChange={noop} />);
}

// These are semantic HTML assertions, not a substitute for browser focus/Canvas acceptance.
describe('campaign entry semantic HTML', () => {
  it('renders one named modal with saved-game, seed and help routes in Chinese', () => {
    const html = menu();
    expect(html.match(/<dialog/g)).toHaveLength(1);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('山门启程');
    expect(html).toContain('新建战役');
    expect(html).toContain('继续存档');
    expect(html).toContain('还没有存档');
    expect(html).toContain('<details class="entry-help">');
    expect(html).toContain('存档管理与导入');
    expect(html).toContain(`value="${DEFAULT_CAMPAIGN_SEED}"`);
    expect(html).toContain('maxLength="256"');
    expect(html).not.toContain('class="entry-resume"');
  });
  it('keeps scope, loss risks and explicit manual-saving guidance in the help disclosure', () => {
    const html = menu();
    for (const text of ['宗门选择可劳动的成年弟子', '突破前查看条件', '出征前选择队伍', '永久树', '陨落', '定期导出备份', '真实浏览器验收仍未完成']) expect(html).toContain(text);
    expect(html).not.toContain('自动保存成功');
  });
  it('renders English labels without changing seed or save identity', () => {
    const html = menu({}, false, 'en');
    expect(html).toContain('Enter the sect');
    expect(html).toContain('Manage saves &amp; import');
    expect(html).toContain('value="en" selected');
    expect(html).toContain(`value="${DEFAULT_CAMPAIGN_SEED}"`);
    expect(html).not.toContain('entry.help.');
  });
  it('shows resume only for an existing campaign and readonly viewing without a resume promise', () => {
    expect(menu({}, true)).toContain('返回当前战役');
    const readOnly = menu({ readOnly: true, notice: 'save.recoveredReadOnly' }, true);
    expect(readOnly).toContain('查看只读战役');
    expect(readOnly).toContain('当前载入为只读或恢复状态');
    expect(readOnly).not.toContain('>返回当前战役<');
  });
  it('renders the actual occupied slot and revision without offering to overwrite it', () => {
    const html = menu({ slots: [{ slotId: 'campaign-2', slot: { recordVersion: 1, slotId: 'campaign-2', revision: 7, currentSnapshotId: 'snapshot-7', autoSnapshotIds: [], manualSnapshotId: 'snapshot-7', checkpointSnapshotId: null, savedAt: '2026-10-01T01:02:03.000Z' } }], boundSlot: 'campaign-2' }, true);
    expect(html).toContain('载入此存档');
    expect(html).toContain('7');
    expect(html).not.toContain('还没有存档');
    expect(html).not.toContain('>写入<');
    expect(html).toContain('新战役不会自动绑定或覆盖旧存档');
  });
  it('disables starting while persistence opens and all action exits while processing', () => {
    const opening = menu({ mode: 'opening' });
    expect(opening).toMatch(/<input[^>]*disabled/);
    expect(opening).toMatch(/<button disabled="">开启山门/);
    const pending = menu({ busy: true }, true);
    expect(pending).toContain('正在处理，请稍候');
    expect(pending).toMatch(/class="entry-resume" disabled/);
    expect(pending).toMatch(/<select[^>]*disabled/);
  });
  it('surfaces memory fallback and controller failures instead of claiming entry succeeded', () => {
    const html = menu({ mode: 'memory', notice: 'save.error.invalid' });
    expect(html).toContain('role="status"');
    expect(html).toContain('内存');
    expect(html).not.toContain('class="entry-resume"');
  });
  it('renders the initial App with one entry modal and an inert underlying game', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('class="campaign-world" inert=""');
    expect(html.match(/<dialog/g)).toHaveLength(1);
    expect(html).toContain('菜单与帮助');
    expect(html).not.toContain('class="save-dialog"');
  });
});

describe('entry decision guards', () => {
  it('trims a stable editable seed and rejects empty or overlong seeds', () => {
    expect(DEFAULT_CAMPAIGN_SEED).toBe('shanmen-001');
    expect(campaignSeed('  mountain-2  ')).toBe('mountain-2');
    expect(campaignSeed('山门')).toBe('山门');
    expect(campaignSeed('')).toBeNull();
    expect(campaignSeed('   ')).toBeNull();
    expect(campaignSeed('a'.repeat(256))).toHaveLength(256);
    expect(campaignSeed('a'.repeat(257))).toBeNull();
  });
  it('requires an epoch change, an idle controller and explicit successful load notice', () => {
    expect(entryLoadOutcome(0, 0, idle)).toBe('unchanged');
    expect(entryLoadOutcome(0, 1, idle)).toBe('ready');
    expect(entryLoadOutcome(0, 1, { ...idle, notice: 'save.migratedPaused' })).toBe('ready');
    for (const patch of [{ busy: true }, { mode: 'opening' as const }, { notice: null }, { notice: 'save.error.invalid' as const }]) expect(entryLoadOutcome(0, 1, { ...idle, ...patch })).toBe('review');
  });
  it('keeps read-only, recovered and lease-busy loads for explicit review', () => {
    for (const notice of ['save.loadedPaused', 'save.recoveredReadOnly', 'save.error.leaseBusy'] as const) expect(entryLoadOutcome(3, 4, { ...idle, readOnly: true, notice })).toBe('review');
    expect(entryLoadOutcome(3, 3, { ...idle, notice: 'save.error.version' })).toBe('unchanged');
  });
  it('refuses stale, busy, opening or invalid new-campaign confirmations', () => {
    const intent = { kind: 'new' as const, seed: 'next', epoch: 4 };
    expect(entryIntentCurrent(intent, 4, idle)).toBe(true);
    expect(entryIntentCurrent(intent, 5, idle)).toBe(false);
    expect(entryIntentCurrent(intent, 4, { ...idle, busy: true })).toBe(false);
    expect(entryIntentCurrent(intent, 4, { ...idle, mode: 'opening' })).toBe(false);
    expect(entryIntentCurrent({ ...intent, seed: ' ' }, 4, idle)).toBe(false);
    expect(entryIntentCurrent({ ...intent, seed: ' next ' }, 4, idle)).toBe(false);
    expect(entryIntentCurrent({ kind: 'load', slotId: 'campaign-1', epoch: 4 }, 4, idle)).toBe(true);
  });
  it('Escape cancels confirmation before leaving; first entry and pending work cannot escape into a placeholder world', () => {
    expect(entryCancelAction(false, false, false)).toBe('stay');
    expect(entryCancelAction(false, true, true)).toBe('confirmation');
    expect(entryCancelAction(false, false, true)).toBe('campaign');
    expect(entryCancelAction(true, true, true)).toBe('blocked');
    expect(entryCancelAction(true, false, true)).toBe('blocked');
  });
  it('suppresses gameplay Space whenever any entry/save surface is active', () => {
    const key = { code: 'Space', repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: null };
    expect(shouldHandlePause(key, true)).toBe(false);
    expect(shouldHandlePause(key, false)).toBe(true);
  });
});

describe('overlay lifetime and integration contract', () => {
  it('holds the session before the first simulated frame and retains an independent player pause', () => {
    const session = new ApplicationSession();
    session.setPaused('player', true);
    session.setOverlayPaused(true);
    session.frame(0); session.frame(1000);
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
    session.setOverlayPaused(false);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.getSnapshot().clock.pauseReasons).not.toContain('choice');
  });
  it('holds a replacement world until the one App owner closes and preserves authoritative pauses', () => {
    const session = new ApplicationSession();
    session.setPaused('choice', true);
    session.setOverlayPaused(true);
    session.setOverlayPaused(true); // entry -> save manager has no second owner or release.
    session.setOverlayPaused(false);
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    session.setOverlayPaused(true);
    session.replaceWorld(createWorld('entry-replacement'));
    expect(session.getSnapshot().clock.pauseReasons).toContain('choice');
    expect(session.exportWorld().clock.pauseReasons).not.toContain('choice');
    session.frame(0); session.frame(2000);
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
    session.setOverlayPaused(false);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.getSnapshot().clock.pauseReasons).not.toContain('choice');
  });
  it('owns overlays centrally before runtime attachment and does not let dialogs persist a choice pause', () => {
    const source = readFileSync('src/app/App.tsx', 'utf8');
    expect(source.indexOf('session.setOverlayPaused(overlay !== null)')).toBeLessThan(source.indexOf('attachBrowserRuntime(session)'));
    expect(source).not.toContain("session.setPaused('choice'");
    expect(source).toContain("setOverlay(saveReturnToEntry || !hasCampaign ? 'entry' : null)");
    expect(source).toContain('overlayFocus.current?.isConnected');
    expect(source).toContain('target?.focus()');
    expect(source).toContain('disabled={!hasCampaign || !controller.canSave(slotId)}');
  });
  it('uses a synchronous operation gate, cancellation focus return and isolated modal keys', () => {
    const source = readFileSync('src/app/CampaignEntry.tsx', 'utf8');
    expect(source).toContain('running.current || !entryIntentCurrent');
    expect(source.indexOf('running.current = true')).toBeLessThan(source.indexOf('await controller.beginNewCampaign'));
    expect(source).toContain('confirmationCancel.current?.focus()');
    expect(source).toContain('returnFocus.current.focus()');
    expect(source).toContain('event.stopPropagation()');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('Date.now');
  });
  it('provides narrow-screen, keyboard-focus, scrolling and reduced-motion styling', () => {
    const source = readFileSync('src/app/campaign-entry.css', 'utf8');
    for (const text of ['max-height: calc(100dvh', 'overflow-y: auto', '@media (max-width: 620px)', '@media (max-width: 380px)', ':focus-visible', 'prefers-reduced-motion']) expect(source).toContain(text);
  });
});
