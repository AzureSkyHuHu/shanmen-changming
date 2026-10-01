import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createInventoryDiscardSubmitter, InventoryDiscardReview, InventoryPanel, inventoryDiscardIsCurrent,
  inventoryDiscardQuantity, prepareInventoryDiscard, type InventoryPanelProps,
} from '../../src/app/InventoryPanel';
import { createInventory } from '../../src/core/economy/inventory';
import { discardAvailable } from '../../src/core/economy/discard';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { createTranslator, messageSpecifications, translate, validateLocales, type Locale, type TextKey } from '../../src/i18n';
import type { MessageSpecifications } from '../../src/i18n/types';
import { zhCN } from '../../src/content/locales/zh-CN';
import { en } from '../../src/content/locales/en';
import localeFixture from './locales.fixture.json';

const keys = Object.keys(localeFixture.entries) as (keyof typeof localeFixture.entries)[];
const fixtureZhCN = Object.fromEntries(keys.map(key => [key, localeFixture.entries[key][0]!])) as Record<string, string>;
const fixtureEn = Object.fromEntries(keys.map(key => [key, localeFixture.entries[key][1]!])) as Record<string, string>;
const parameters = localeFixture.parameters as Record<string, unknown>;
const fixtureSpecifications = Object.fromEntries(keys.map(key => [key, { parameters: parameters[key] ?? {} }])) as MessageSpecifications;
const fixtureTranslate = createTranslator({ baseCatalog: { ...zhCN, ...fixtureZhCN }, englishCatalog: { ...en, ...fixtureEn }, specifications: { ...messageSpecifications, ...fixtureSpecifications } });
const t = (locale: Locale = 'zh-CN') => (key: TextKey, params?: Parameters<typeof translate>[2]) => fixtureTranslate(locale, key, params);
const resources = () => Object.values(createInventory()).map(resource => ({ ...resource, ...(resource.resourceId === 'wood' ? { reserved: 3 } : {}), available: resource.owned - (resource.resourceId === 'wood' ? 3 : resource.reserved) }));
const propsFor = (overrides: Partial<InventoryPanelProps> = {}): InventoryPanelProps => ({ resources: resources(), sessionEpoch: 7, readOnly: false, t: t(), onDiscard: () => ({ ok: true }), ...overrides });
const confirmationFor = (props = propsFor(), quantity = '4') => prepareInventoryDiscard(props, { resourceId: 'wood', quantity })!;
const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const render = (overrides: Partial<InventoryPanelProps> = {}) => renderToStaticMarkup(<InventoryPanel {...propsFor(overrides)} />);
const changedStock = (props: InventoryPanelProps, patch: Partial<InventoryPanelProps['resources'][number]>) => ({ ...props, resources: props.resources.map(resource => resource.resourceId === 'wood' ? { ...resource, ...patch } : resource) });

// Semantic HTML and pure command-boundary tests; actual browser interaction is a separate acceptance step.
describe('storage recovery presentation', () => {
  it('keeps the secondary drawer collapsed and displays actual held/capacity/available/reserved totals', () => {
    const props = propsFor(); const before = canonicalStringify(props.resources); const onDiscard = vi.fn();
    const markup = renderToStaticMarkup(<InventoryPanel {...props} onDiscard={onDiscard} />); const text = visible(markup);
    expect(markup).toMatch(/^<details class="inventory-panel">/);
    expect(text).toContain('仓储管理'); expect(text).toContain('现有 24/999'); expect(text).toContain('可用 21'); expect(text).toContain('已预留 3');
    expect(text).toContain('生产、突破等已预留的物资不在可丢弃数量内');
    expect(markup.match(/<li>/g)).toHaveLength(6); expect(onDiscard).not.toHaveBeenCalled();
    expect(canonicalStringify(props.resources)).toBe(before);
  });
  it('starts without an amount, labels every field and requires separate review/confirmation', () => {
    const markup = render();
    expect(markup).toContain('type="text" inputMode="numeric" pattern="[0-9]*"');
    expect(markup).toMatch(/<input[^>]*value=""/); expect(markup).toMatch(/class="secondary inventory-review" disabled/);
    expect(markup).not.toContain('class="inventory-confirm"'); expect(markup).toContain('aria-live="polite"');
    for (const field of markup.match(/<(?:input|select)\b[^>]*\bid="[^"]+"[^>]*>/g) ?? []) {
      const id = /id="([^"]+)"/.exec(field)?.[1]; expect(markup).toContain(`for="${id}"`);
    }
    for (const button of markup.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('type="button"');
  });
  it('shows explicit irreversible resource/quantity and reserved exclusion in both locales', () => {
    const props = propsFor(); const confirmation = confirmationFor(props);
    for (const locale of ['zh-CN', 'en'] as const) {
      const markup = renderToStaticMarkup(<InventoryDiscardReview confirmation={confirmation} stale={false} blocked={false} t={t(locale)} onConfirm={() => {}} onCancel={() => {}} />);
      const text = visible(markup);
      expect(text).toContain(locale === 'zh-CN' ? '丢弃 4 份木材' : 'Discard 4 Wood');
      expect(text).toContain(locale === 'zh-CN' ? '无法撤销' : 'cannot be recovered');
      expect(text).toContain(locale === 'zh-CN' ? '现有库存为 20' : 'Held stock will be 20');
      expect(text).toContain(locale === 'zh-CN' ? '已预留的 3 份保持不变' : '3 reserved units will remain unchanged');
      expect(markup).toContain('role="group"'); expect(markup).not.toContain('role="dialog"');
      expect(text).not.toContain('文本暂不可用');
    }
  });
  it('renders readonly/busy restrictions and keeps stale confirmations disabled', () => {
    for (const flags of [{ readOnly: true }, { busy: true }]) {
      const markup = render(flags); expect(markup).toMatch(/class="inventory-fields" disabled/);
      expect(visible(markup)).toContain(flags.readOnly ? '只读' : '正在处理存档');
    }
    const confirmation = confirmationFor();
    for (const flags of [{ stale: true, blocked: false }, { stale: false, blocked: true }]) {
      const markup = renderToStaticMarkup(<InventoryDiscardReview confirmation={confirmation} {...flags} t={t()} onConfirm={() => {}} onCancel={() => {}} />);
      expect(markup).toMatch(/class="inventory-confirm" disabled/);
      if (flags.stale) { expect(visible(markup)).toContain('这次确认已失效'); expect(markup).toContain('role="alert"'); }
    }
  });
  it('opens for actual supplied overflow, shows fill-only suggestions and never dispatches while rendering', () => {
    const onDiscard = vi.fn(); const markup = render({ suggestedDiscard: [{ resourceId: 'herbs', quantity: 2 }], onDiscard });
    expect(markup).toMatch(/^<details class="inventory-panel" open="">/);
    expect(visible(markup)).toContain('灵草：还需腾出 2'); expect(visible(markup)).toContain('填入数量不会立即丢弃');
    expect(markup).toMatch(/<input[^>]*value=""/); expect(onDiscard).not.toHaveBeenCalled();
    const unavailable = render({ suggestedDiscard: [{ resourceId: 'wood', quantity: 22 }] });
    expect(unavailable).toMatch(/<button type="button" class="secondary" disabled="">填入此数量/);
  });
  it('remounts all local state after epoch replacement and has no simulation-pause props', () => {
    expect(InventoryPanel(propsFor()).key).not.toBe(InventoryPanel(propsFor({ sessionEpoch: 8 })).key);
    expect(Object.keys(propsFor())).not.toContain('pauseReasons'); expect(Object.keys(propsFor())).not.toContain('setPaused');
  });
});

describe('exact discard drafts and selected-resource freshness', () => {
  it.each(['', ' ', '0', '-1', '+1', '1.1', '1e1', 'Infinity', 'NaN', '9007199254740992', '22', '1 0'])('rejects invalid or excessive raw quantity %s without clamping', quantity => {
    expect(inventoryDiscardQuantity(quantity, 21)).toBeNull();
    const props = propsFor(); const before = canonicalStringify(props.resources);
    expect(prepareInventoryDiscard(props, { resourceId: 'wood', quantity })).toBeNull(); expect(canonicalStringify(props.resources)).toBe(before);
  });
  it.each(['1', '21', '004'])('accepts an exact positive integer %s and freezes a detached review basis', quantity => {
    const props = propsFor(); const confirmation = confirmationFor(props, quantity);
    expect(confirmation.request).toEqual({ resourceId: 'wood', quantity: Number(quantity) });
    expect(confirmation.guard).toEqual({ sessionEpoch: 7, resourceId: 'wood', owned: 24, reserved: 3, capacity: 999 });
    expect(Object.isFrozen(confirmation)).toBe(true); expect(Object.isFrozen(confirmation.request)).toBe(true); expect(Object.isFrozen(confirmation.guard)).toBe(true);
  });
  it('rejects missing/forged/inconsistent resources and exhausted available stock', () => {
    const props = propsFor();
    for (const resourceId of ['not.real', '__proto__', 'constructor']) expect(prepareInventoryDiscard(props, { resourceId, quantity: '1' })).toBeNull();
    for (const patch of [{ owned: -1 }, { reserved: 25 }, { owned: 1000 }, { available: 24 }, { reserved: 24, available: 0 }, { owned: NaN }]) {
      expect(prepareInventoryDiscard(changedStock(props, patch), { resourceId: 'wood', quantity: '1' })).toBeNull();
    }
    expect(prepareInventoryDiscard({ ...props, resources: [] }, { resourceId: 'wood', quantity: '1' })).toBeNull();
  });
  it('expires on campaign or selected stock/reservation/capacity changes, but ignores other stock changes', () => {
    const props = propsFor(); const confirmation = confirmationFor(props);
    expect(inventoryDiscardIsCurrent(props, confirmation)).toBe(true);
    for (const next of [{ ...props, sessionEpoch: 8 }, changedStock(props, { owned: 25, available: 22 }), changedStock(props, { reserved: 4, available: 20 }), changedStock(props, { capacity: 998 })]) {
      expect(inventoryDiscardIsCurrent(next, confirmation)).toBe(false);
    }
    const unrelated = { ...props, resources: props.resources.map(resource => resource.resourceId === 'herbs' ? { ...resource, owned: 7, available: 7 } : resource) };
    expect(inventoryDiscardIsCurrent(unrelated, confirmation)).toBe(true);
    expect(inventoryDiscardIsCurrent(props, { ...confirmation, request: { resourceId: 'herbs', quantity: 4 } })).toBe(false);
  });
});

describe('one confirmed callback, no authority mutation', () => {
  it('passes exact typed request and separate guard once, retaining the rendered inventory', () => {
    const onDiscard = vi.fn(() => ({ ok: true })); const props = propsFor({ onDiscard }); const before = canonicalStringify(props.resources);
    const confirmation = confirmationFor(props); const submit = createInventoryDiscardSubmitter();
    expect(submit(props, confirmation)).toEqual({ ok: true });
    expect(onDiscard).toHaveBeenCalledWith({ resourceId: 'wood', quantity: 4 }, confirmation.guard);
    expect(submit(props, confirmation)).toEqual({ ok: false, code: 'DUPLICATE_CONFIRMATION' });
    expect(submit(props, confirmationFor(props))).toEqual({ ok: false, code: 'AWAITING_PROJECTION' });
    expect(onDiscard).toHaveBeenCalledTimes(1); expect(canonicalStringify(props.resources)).toBe(before);
  });
  it('prevents re-entrant callback clicks and detaches callback payloads from reviewed quantities', () => {
    const submit = createInventoryDiscardSubmitter(); const props = propsFor(); const confirmation = confirmationFor(props);
    const onDiscard = vi.fn((request: Parameters<InventoryPanelProps['onDiscard']>[0], guard: Parameters<InventoryPanelProps['onDiscard']>[1]): { ok: boolean } => {
      expect(submit({ ...props, onDiscard }, confirmation).ok).toBe(false);
      request.quantity = 1; guard.owned = 1; return { ok: true };
    });
    expect(submit({ ...props, onDiscard }, confirmation).ok).toBe(true);
    expect(onDiscard).toHaveBeenCalledTimes(1); expect(confirmation.request.quantity).toBe(4); expect(confirmation.guard.owned).toBe(24);
  });
  it('clears an acknowledged basis permanently even if later stock returns to the same amount', () => {
    const onDiscard = vi.fn(() => ({ ok: true })); const props = propsFor({ onDiscard }); const submit = createInventoryDiscardSubmitter();
    expect(submit(props, confirmationFor(props)).ok).toBe(true);
    submit.observe(changedStock(props, { owned: 20, available: 17 }));
    expect(submit(props, confirmationFor(props)).ok).toBe(true); expect(onDiscard).toHaveBeenCalledTimes(2);
  });
  it('guards readonly, busy, stale stock and epoch before calling the application', () => {
    const onDiscard = vi.fn(() => ({ ok: true })); const props = propsFor({ onDiscard }); const confirmation = confirmationFor(props);
    for (const next of [{ ...props, readOnly: true }, { ...props, busy: true }, { ...props, sessionEpoch: 8 }, changedStock(props, { owned: 23, available: 20 })]) {
      expect(createInventoryDiscardSubmitter()(next, confirmation).ok).toBe(false);
    }
    expect(onDiscard).not.toHaveBeenCalled();
  });
  it('keeps rejected attempts one-use and fails closed when callback outcome is unknown', () => {
    const rejected = propsFor({ onDiscard: vi.fn(() => ({ ok: false, code: 'STALE_INVENTORY' })) }); const confirmation = confirmationFor(rejected); const submit = createInventoryDiscardSubmitter();
    expect(submit(rejected, confirmation).code).toBe('STALE_INVENTORY'); expect(submit(rejected, confirmation).code).toBe('DUPLICATE_CONFIRMATION');
    expect(submit(rejected, confirmationFor(rejected)).code).toBe('STALE_INVENTORY');
    const throwing = propsFor({ onDiscard: vi.fn(() => { throw new Error('lost result'); }) }); const uncertain = createInventoryDiscardSubmitter();
    expect(uncertain(throwing, confirmationFor(throwing))).toEqual({ ok: false, code: 'CALLBACK_FAILED' });
    expect(uncertain(throwing, confirmationFor(throwing))).toEqual({ ok: false, code: 'AWAITING_PROJECTION' });
    expect(throwing.onDiscard).toHaveBeenCalledTimes(1);
  });
  it('requires a fresh application guard even if an old rendered panel has not received its update', () => {
    let inventory = createInventory(); inventory.wood.reserved = 3;
    const props = propsFor({ onDiscard: (request, guard) => {
      const current = inventory[request.resourceId];
      if (guard.owned !== current.owned || guard.reserved !== current.reserved || guard.capacity !== current.capacity) return { ok: false, code: 'STALE_INVENTORY' };
      const result = discardAvailable(inventory, request.resourceId, request.quantity);
      if (result.ok) inventory = result.inventory;
      return result;
    } });
    const first = createInventoryDiscardSubmitter(); expect(first(props, confirmationFor(props)).ok).toBe(true);
    const staleOtherPanel = createInventoryDiscardSubmitter(); expect(staleOtherPanel(props, confirmationFor(props))).toEqual({ ok: false, code: 'STALE_INVENTORY' });
    expect(inventory.wood).toMatchObject({ owned: 20, reserved: 3 });
  });
});

describe('bilingual inventory text contract', () => {
  it('provides all Chinese and English entries with precise parameter contracts', () => {
    expect(validateLocales(fixtureZhCN, fixtureEn, fixtureSpecifications)).toMatchObject({ valid: true, errors: [], missingEnglishKeys: [] });
    for (const key of keys) expect(fixtureZhCN[key]).toBeTruthy();
  });
  it('requires fixture keys to be registered in the actual application catalogs', () => {
    for (const key of keys) {
      expect(Object.hasOwn(messageSpecifications, key)).toBe(true); expect(Object.hasOwn(zhCN, key)).toBe(true); expect(Object.hasOwn(en, key)).toBe(true);
    }
  });
});
