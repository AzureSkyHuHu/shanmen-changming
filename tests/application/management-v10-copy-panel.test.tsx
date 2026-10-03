import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ManagementCopyPanelV10, managementCopyMessagesV10, managementCopyMessageSpecificationsV10,
  createManagementCopyTranslatorV10, focusManagementCopyElementV10, createManagementCopyAttachmentV10 } from '../../src/app/ManagementCopyPanelV10';
import type { ManagementCopyEntryV10, ManagementCopyStatusV10, CopyReviewV10 } from '../../src/application/management-v10-copy-entry';
import { validateLocales } from '../../src/i18n';

const source = Object.freeze({ slotId: 'campaign-1' as const, revision: 3, savedAt: '2026-10-03T05:00:00Z' });
const review: CopyReviewV10 = Object.freeze({ source, targetSlotId: 'campaign-2', dirty: true, blockers: Object.freeze([]) });
function controller(patch: Partial<ManagementCopyStatusV10> = {}, current = true) {
  const state: ManagementCopyStatusV10 = { phase: 'idle', busy: false, sources: [source, { slotId: 'campaign-2', revision: null, savedAt: null }],
    targets: [{ slotId: 'campaign-1', revision: 2, savedAt: source.savedAt }, { slotId: 'campaign-2', revision: null, savedAt: null }],
    selectedSource: null, loadedSource: null, selectedTarget: null, review: null, notice: null, sourceNotice: null, committed: null, cleanup: [], ...patch };
  const methods = { getSnapshot: () => state, subscribe: vi.fn(() => () => {}), isReviewCurrent: vi.fn(() => current),
    open: vi.fn(async () => true), readSource: vi.fn(async () => true), selectSource: vi.fn(() => true), selectTarget: vi.fn(() => true),
    review: vi.fn(async () => true), confirm: vi.fn(async () => true), cancel: vi.fn(async () => {}) };
  return { value: methods as unknown as ManagementCopyEntryV10, methods };
}
function render(value: ManagementCopyEntryV10) { return renderToStaticMarkup(createElement(ManagementCopyPanelV10, { controller: value, locale: 'en' })); }

describe('v10 explicit copy panel', () => {
  it('uses stable validated bilingual keys and per-key Chinese fallback', () => {
    const zh = Object.fromEntries(Object.entries(managementCopyMessagesV10).map(([key, values]) => [key, values[0]]));
    const en = Object.fromEntries(Object.entries(managementCopyMessagesV10).map(([key, values]) => [key, values[1]]));
    expect(validateLocales(zh, en, managementCopyMessageSpecificationsV10).valid).toBe(true);
    expect(createManagementCopyTranslatorV10('en', { ...en, 'copyV10.backup': '' })('copyV10.backup')).toBe(zh['copyV10.backup']);
  });
  it('renders an explicit unopened flow without reading, starting, subscribing or copying during render', () => {
    const h = controller(); const html = render(h.value);
    expect(html).toContain('List v9 sources and v10 targets'); expect(html).not.toContain('<select');
    expect(h.methods.open).not.toHaveBeenCalled(); expect(h.methods.readSource).not.toHaveBeenCalled();
    expect(h.methods.confirm).not.toHaveBeenCalled(); expect(h.methods.subscribe).not.toHaveBeenCalled();
  });
  it('requires a separately read source, disables empty sources and occupied targets, and leaves targets unselected', () => {
    const unread = render(controller({ phase: 'selecting', selectedSource: 'campaign-1' }).value);
    expect(unread).toContain('Read selected source for review'); expect(unread).not.toContain('Choose an empty v10 target');
    const html = render(controller({ phase: 'selecting', selectedSource: 'campaign-1', loadedSource: source }).value);
    expect(html).toMatch(/<option value="campaign-2" disabled="">v9 save 2/);
    expect(html).toMatch(/<option value="campaign-1" disabled="">v10 save 1/);
    expect(html).toContain('Choose an empty v10 target'); expect(html).toContain('does not force takeover');
  });
  it('shows quiet review, immutable-source scope and unchecked dirty acknowledgement before allowing confirmation', () => {
    const html = render(controller({ phase: 'review', selectedSource: 'campaign-1', loadedSource: source, selectedTarget: 'campaign-2', review }).value);
    expect(html).toContain('quiet-boundary review'); expect(html).toContain('Later saves do not replace this backup');
    expect(html).toContain('I confirm replacing current unsaved v10 progress');
    expect(html).toMatch(/<button type="button" disabled="">Confirm copy and enter v10/);
    expect(html).toContain('tabindex="-1"'); expect(html).toContain('aria-live="polite"');
  });
  it('shows actionable quiet-boundary blockers and never offers automatic settlement', () => {
    const html = render(controller({ phase: 'review', loadedSource: source, selectedTarget: 'campaign-2', review: { ...review, blockers: ['AUTOMATIC_WORK_ENABLED', 'ACTIVE_PROGRESSION'] } }).value);
    expect(html).toContain('Automatic management is still enabled'); expect(html).toContain('Breakthrough, seclusion, teaching or build locks');
    expect(html).toContain('does not cancel work or settle it for you'); expect(html).toMatch(/disabled="">Confirm copy and enter v10/);
  });
  it('keeps cancel reachable while busy and represents committed-but-unmounted separately from success', () => {
    const html = render(controller({ phase: 'review', busy: true, review, committed: { slotId: 'campaign-2', revision: 1, mounted: false } }, false).value);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('not mounted in the current game');
    expect(html).toMatch(/<button type="button" class="secondary">Cancel copy<\/button>/); expect(html).not.toContain('Entered the v9 copy');
    const done = render(controller({ phase: 'completed', committed: { slotId: 'campaign-2', revision: 1, mounted: true } }).value);
    expect(done).toContain('Entered the v9 copy'); expect(done).toContain('manual saves'); expect(done).not.toContain('Cancel copy</button>');
  });
  it('renders persistent cleanup diagnostics independently of the last action notice', () => {
    const html = render(controller({ phase: 'idle', notice: 'cancelled', cleanup: ['SOURCE_CLEANUP_UNCONFIRMED', 'SOURCE_PROTECTION_FAILED'],
      committed: { slotId: 'campaign-2', revision: 1, mounted: false } }).value);
    expect(html).toContain('Some cleanup could not be confirmed'); expect(html).toContain('Source retirement cleanup is unconfirmed');
    expect(html).toContain('Source read-only protection could not be confirmed'); expect(html).toContain('not mounted in the current game');
  });
  it('immediately disables confirmation and explains a reviewed source becoming read-only', () => {
    const html = render(controller({ phase: 'review', selectedSource: 'campaign-1', loadedSource: source, selectedTarget: 'campaign-2',
      notice: 'source-readonly', review: { ...review, dirty: false, blockers: ['READ_ONLY_SOURCE'] } }, false).value);
    expect(html).toContain('The source is protected read-only'); expect(html).toContain('The read-only source cannot grant safe copy ownership');
    expect(html).toMatch(/<button type="button" disabled="">Confirm copy and enter v10/);
  });
  it('focuses only a connected element still owned by this mounted flow', () => {
    const focus = vi.fn(); const node = { isConnected: true, focus } as unknown as HTMLElement;
    expect(focusManagementCopyElementV10(null, () => true)).toBe(false);
    expect(focusManagementCopyElementV10(node, () => false)).toBe(false); expect(focus).not.toHaveBeenCalled();
    expect(focusManagementCopyElementV10(node, () => true)).toBe(true); expect(focus).toHaveBeenCalledOnce();
    expect(focusManagementCopyElementV10({ isConnected: false, focus } as unknown as HTMLElement, () => true)).toBe(false);
  });
  it('tolerates StrictMode replay but cancels a real unmount and a replaced controller', async () => {
    const cancel = vi.fn(async () => {}); const attachment = createManagementCopyAttachmentV10(cancel);
    const first = attachment.attach(); first(); const replay = attachment.attach(); await Promise.resolve(); expect(cancel).not.toHaveBeenCalled();
    replay(); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
    const oldCancel = vi.fn(async () => {}); const nextCancel = vi.fn(async () => {});
    const old = createManagementCopyAttachmentV10(oldCancel); const next = createManagementCopyAttachmentV10(nextCancel);
    old.attach()(); next.attach(); await Promise.resolve(); expect(oldCancel).toHaveBeenCalledOnce(); expect(nextCancel).not.toHaveBeenCalled();
  });
});
