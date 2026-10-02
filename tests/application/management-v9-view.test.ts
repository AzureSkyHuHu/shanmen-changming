import { describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ApplicationSessionV9, type BreakthroughProposalV9 } from '../../src/application/session-v9';
import { attachManagementReviewEscapeV9, createManagementUiHoldScopeV9, managementRiskCurrentV9, MANAGEMENT_BASE_RECIPES_V9, MANAGEMENT_RESEARCH_V9, MANAGEMENT_SECT_RECIPES_V9,
  managementBlockedV9, managementHasResourcesV9, managementIntentGuardV9, managementPhaseKeyV9,
  managementReasonV9, managementResourceTextV9, managementResultV9, managementWorkerAvailableV9, type ManagementSnapshotV9,
} from '../../src/application/management-v9-contract';
import { ManagementCarePatientV9, SectManagementPanelV9 } from '../../src/app/SectManagementPanelV9';
import { ManagementSaveSummaryV9 } from '../../src/app/ManagementSavePanelV9';
import { IDBFactory } from 'fake-indexeddb';
import { ManagementSaveControllerV9 } from '../../src/application/management-v9-save-controller';
import { IndexedDbSaveRepository, MANAGEMENT_V9_DATABASE_NAME, openSaveRepository } from '../../src/platform/persistence';
import { STARTER_RECIPES } from '../../src/core/economy/recipes';
import { RUNTIME_VIEW_LIMITS_V9, type RuntimeReadonlyV9 } from '../../src/core/world/runtime-view-types-v9';
import { createTranslator, messageSpecifications, translate, type TextKey, type TranslationParams } from '../../src/i18n';
import { zhCN } from '../../src/content/locales/zh-CN';
import { en } from '../../src/content/locales/en';

const t = (key: TextKey, parameters?: TranslationParams) => translate('zh-CN', key, parameters);
function withSession(run: (session: ApplicationSessionV9) => void) {
  const session = new ApplicationSessionV9();
  try { run(session); } finally { session.close(); }
}

describe('limited v9 management presentation', () => {
  it('maps only supported first-slice actions and real catalog recipes', () => {
    expect(MANAGEMENT_BASE_RECIPES_V9).toHaveLength(6);
    for (const recipeId of MANAGEMENT_BASE_RECIPES_V9) expect(STARTER_RECIPES[recipeId]).toBeDefined();
    expect(MANAGEMENT_SECT_RECIPES_V9.map(row => row.recipeId)).toEqual(['gather.stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'craft.wound-powder.v9']);
    expect(MANAGEMENT_RESEARCH_V9.id).toBe('basic-medicine.v9');
    expect(managementPhaseKeyV9('TravellingToStorage')).toBe('managementV9.phase.delivery');
    expect(managementPhaseKeyV9('AwaitingDelivery')).toBe('managementV9.phase.awaitingDelivery');
    expect(managementPhaseKeyV9('to-storage')).toBe('managementV9.phase.toStorage');
  });
  it('uses bounded projections and displays actual first-slice state without starting work', () => withSession(session => {
    const before = session.getSnapshot();
    const html = renderToStaticMarkup(createElement(SectManagementPanelV9, { session, snapshot: before,
      readOnly: false, getReadOnly: () => false, t, onFeedback: () => {} }));
    expect(before.frame.disciples.length).toBeLessThanOrEqual(RUNTIME_VIEW_LIMITS_V9.livePeople);
    expect(before.expansion.jobs.length).toBeLessThanOrEqual(RUNTIME_VIEW_LIMITS_V9.activeJobs);
    expect(html).toContain('基础药理'); expect(html).toContain('采石'); expect(html).toContain('整理基础心得');
    expect(html).toContain('制伤药'); expect(html).toContain('只有实际送达仓库后');
    expect(html).not.toContain('草木替代方'); expect(html).not.toContain('药性配伍');
    expect(html).not.toContain('恢复维护'); expect(session.getSnapshot()).toBe(before);
  }));
  it('rechecks epoch, selection, domain revision, storage, read-only and stop at the event boundary', () => withSession(session => {
    const basis = session.getSnapshot();
    expect(managementIntentGuardV9(basis, basis, false, 'construction')).toBeNull();
    expect(managementIntentGuardV9(basis, { ...basis, sessionEpoch: basis.sessionEpoch + 1 }, false, 'construction')).toBe('managementV9.stale');
    expect(managementIntentGuardV9(basis, { ...basis, selection: null }, false, 'construction')).toBe('managementV9.stale');
    expect(managementIntentGuardV9(basis, { ...basis, expansion: { ...basis.expansion, revisions: { ...basis.expansion.revisions, construction: basis.expansion.revisions.construction + 1 } } }, false, 'construction')).toBe('managementV9.stale');
    expect(managementIntentGuardV9(basis, { ...basis, holds: { ...basis.holds, storageBusy: true } }, false)).toBe('managementV9.busy');
    expect(managementIntentGuardV9(basis, basis, true)).toBe('managementV9.readOnly');
    expect(managementBlockedV9({ ...basis, closed: true }, false)).toBe('managementV9.stopped');
    expect(managementBlockedV9({ ...basis, holds: { ...basis.holds, review: true } }, false)).toBe('managementV9.reviewHeld');
    expect(managementBlockedV9({ ...basis, holds: { ...basis.holds, review: true } }, false, true)).toBeNull();
  }));
  it('uses available rather than owned stock in both ledgers, preserving zero', () => withSession(session => {
    const snapshot = session.getSnapshot();
    const bounded = { ...snapshot, frame: { ...snapshot.frame, resources: snapshot.frame.resources.map(row => ({ ...row, owned: 99, reserved: 99, available: 0 })) },
      expansion: { ...snapshot.expansion, stock: snapshot.expansion.stock.map(row => ({ ...row, owned: 99, reserved: 99, available: 0 })) } };
    expect(managementHasResourcesV9(bounded, [])).toBe(true);
    expect(managementHasResourcesV9(bounded, [{ ledger: 'base', resourceId: 'wood', quantity: 1 }])).toBe(false);
    expect(managementHasResourcesV9(bounded, [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }])).toBe(false);
    expect(managementResourceTextV9([{ ledger: 'base', resourceId: 'wood', quantity: 8 }, { ledger: 'sect', resourceId: 'basic-insight', quantity: 2 }], t)).toContain('基础心得');
  }));
  it('rejects a second click against the pre-command boundary and excludes newly busy workers', () => withSession(session => {
    const before = session.getSnapshot(); const workerId = before.frame.disciples.find(row => managementWorkerAvailableV9(before, row.id))!.id;
    const started = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId } });
    expect(started.ok && started.result.status).toBe('accepted');
    expect(managementIntentGuardV9(before, session.getSnapshot(), false)).toBe('managementV9.stale');
    expect(managementWorkerAvailableV9(session.getSnapshot(), workerId)).toBe(false);
  }));
  it('keeps domain rejection and runtime failures distinct from accepted work', () => {
    expect(managementResultV9({ ok: false, kind: 'session-rejection', code: 'PREVIEW_STALE' }).key).toBe('managementV9.stale');
    expect(managementResultV9({ ok: true, kind: 'command', published: false, result: { commandId: 'test', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'SECT_EXPANSION_REJECTED', detail: 'INSUFFICIENT_INVENTORY' } } }).key).toBe('managementV9.reason.resources');
    expect(managementReasonV9('FUTURE_UNKNOWN_REASON')).toEqual({ key: 'managementV9.reason.unknown', parameters: { code: 'FUTURE_UNKNOWN_REASON' } });
  });
  it('states manual-only persistence and the first-save requirement without fabricating autosave', () => {
    const html = renderToStaticMarkup(createElement(ManagementSaveSummaryV9, { t, status: {
      mode: 'browser', busy: false, slots: [], boundSlot: null, readOnly: false, lastSavedAt: null, notice: null, dirty: true, autosave: 'manual-only',
      import: { selectionId: 0, phase: 'idle', filename: null, seed: null, savedAt: null, migrated: false, target: null, notice: null },
    } }));
    expect(html).toContain('请先手动保存到空位'); expect(html).toContain('不会自动保存'); expect(html).toContain('有未保存进度');
  });
  it('retains Chinese fallback with exact shared parameters for all new keys', () => {
    const translator = createTranslator({ baseCatalog: zhCN, englishCatalog: { ...en, 'managementV9.careResult': '' }, specifications: messageSpecifications });
    expect(translator('en', 'managementV9.careResult', { name: 'Elder', before: 25, after: 5 })).toContain('25 → 5');
    expect(translator('en', 'managementV9.careResult', { name: 'Elder', before: 25, after: 5 })).toContain('已完成照护');
    const keys = Object.keys(messageSpecifications).filter(key => key.startsWith('managementV9.'));
    for (const key of keys) { expect(Object.hasOwn(zhCN, key)).toBe(true); expect(Object.hasOwn(en, key)).toBe(true); }
  });
  it('keeps presentation off authority exports and routes storage only through its controller', () => {
    for (const file of ['ManagementAppV9.tsx', 'SectManagementPanelV9.tsx', 'ManagementSavePanelV9.tsx']) {
      const source = readFileSync(new URL(`../../src/app/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/exportWorld\(|\.snapshot\(|as\s+(?:unknown\s+as\s+)?WorldState/);
      expect(source).not.toMatch(/openSaveRepository|indexedDB\.|localStorage\./);
    }
    const saveSource = readFileSync(new URL('../../src/app/ManagementSavePanelV9.tsx', import.meta.url), 'utf8');
    expect(saveSource).toContain('controller.commitImport'); expect(saveSource).toContain('sameBoundary');
    expect(saveSource).toContain('expectedRevision: chosen.revision');
    expect(saveSource).toContain('controller.load(chosen.slotId, chosen.takeover, chosen.slotRevision)');
  });
});

// Reconciliation-slot and semantic markup regressions; pointer geometry still
// requires a real-browser check, since the Node test environment has no layout.
describe('v9 care controls during risk refresh', () => {
  const element = (node: ReactNode) => {
    if (!isValidElement<{ children?: ReactNode; [key: string]: unknown }>(node)) throw new Error('Expected a presentation element');
    return node;
  };
  it.each(['zh-CN', 'en'] as const)('keeps the same care button slot and preceding content through pending/current/stale/replaced risk in %s', locale => withSession(session => {
    const translator = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
    const onStartCare = vi.fn();
    const before = session.getSnapshot(); const prepared = session.prepareBreakthrough(before.cultivation.selected!.discipleId);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const render = (snapshot: ManagementSnapshotV9, risk: RuntimeReadonlyV9<BreakthroughProposalV9> | null, visible: boolean) => {
      const tree = ManagementCarePatientV9({ session, snapshot, risk, blocked: false, name: 'Patient', costId: 'care-cost', t: translator, onStartCare });
      const regions = Children.toArray(tree.props.children).map(element);
      expect(regions.map(region => region.props.className)).toEqual(['management-v9-care-controls', 'management-v9-care-risk']);
      const controls = regions[0]!; const nodes = Children.toArray(controls.props.children).map(element);
      expect(nodes.map(node => node.type)).toEqual(['h3', 'p', 'p', 'button']);
      const button = nodes[3]!;
      expect(button.props.onClick).toBe(onStartCare); expect(button.props.type).toBe('button');
      expect(button.props['aria-describedby']).toBe('care-cost'); expect(nodes[2]!.props.id).toBe('care-cost');
      expect(button.props.children).toBe(translator('managementV9.startCare'));
      const riskMarkup = renderToStaticMarkup(regions[1]!);
      if (visible && risk) expect(riskMarkup).toContain(translator('managementV9.risk', { success: risk.view.preview.successBps / 10000, death: risk.view.preview.overallDeathBps / 10000 }));
      else expect(riskMarkup).toBe('<div class="management-v9-care-risk"></div>');
      // Same parent/type/key/index is React's DOM-node reconciliation identity.
      return { controlsType: controls.type, controlsKey: controls.key, buttonType: button.type, buttonKey: button.key,
        controlsMarkup: renderToStaticMarkup(controls) };
    };
    const pending = render(before, null, false);
    expect(render(before, prepared.value, true)).toEqual(pending);
    expect(session.frame(0).ok).toBe(true); expect(session.frame(50).ok).toBe(true);
    const after = session.getSnapshot();
    expect(after.stamp.publication).toBeGreaterThan(before.stamp.publication);
    expect(render(after, prepared.value, false)).toEqual(pending);
    expect(render(after, null, false)).toEqual(pending);
    const replacement = session.prepareBreakthrough(after.cultivation.selected!.discipleId);
    expect(replacement.ok).toBe(true); if (!replacement.ok) return;
    expect(render(after, replacement.value, true)).toEqual(pending);
    expect(onStartCare).not.toHaveBeenCalled();
  }));
  it('removes every stale risk basis and refuses a copied or foreign proposal without replacing the controls', () => withSession(session => {
    const snapshot = session.getSnapshot(); const prepared = session.prepareBreakthrough(snapshot.cultivation.selected!.discipleId);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const onStartCare = vi.fn(); const isProposalCurrent = vi.fn(() => true);
    const staleSnapshots: ManagementSnapshotV9[] = [
      { ...snapshot, sessionEpoch: snapshot.sessionEpoch + 1 },
      { ...snapshot, stamp: { ...snapshot.stamp, generation: snapshot.stamp.generation + 1 } },
      { ...snapshot, stamp: { ...snapshot.stamp, publication: snapshot.stamp.publication + 1 } },
      { ...snapshot, cultivation: { ...snapshot.cultivation, revision: snapshot.cultivation.revision + 1 } },
      { ...snapshot, cultivation: { ...snapshot.cultivation, resourceStamp: 'new-resource-basis' } },
      { ...snapshot, cultivation: { ...snapshot.cultivation, selected: { ...snapshot.cultivation.selected!, discipleId: 'other-patient' } } },
    ];
    const render = (current: ManagementSnapshotV9, risk: RuntimeReadonlyV9<BreakthroughProposalV9>, owner: Pick<ApplicationSessionV9, 'isProposalCurrent'>) => renderToStaticMarkup(createElement(ManagementCarePatientV9,
      { session: owner, snapshot: current, risk, blocked: false, name: 'Patient', costId: 'care-cost', t, onStartCare }));
    const withoutRisk = render(snapshot, { ...prepared.value }, session);
    expect(withoutRisk).toContain('<div class="management-v9-care-risk"></div>');
    for (const stale of staleSnapshots) expect(render(stale, prepared.value, { isProposalCurrent })).toBe(withoutRisk);
    expect(isProposalCurrent).not.toHaveBeenCalled();
    const otherSession = new ApplicationSessionV9();
    try { expect(render(snapshot, prepared.value, otherSession)).toBe(withoutRisk); } finally { otherSession.close(); }
    expect(onStartCare).not.toHaveBeenCalled();
  }));
  it('keeps treatment availability independent of risk and lets trailing risk text grow without clipping', () => withSession(session => {
    const snapshot = session.getSnapshot();
    // Presentation-only stock/patient inputs exercise the existing disabled gates.
    const available: ManagementSnapshotV9 = { ...snapshot, cultivation: { ...snapshot.cultivation, selected: { ...snapshot.cultivation.selected!, injury: 25, activityLocked: false, workOwner: null } },
      expansion: { ...snapshot.expansion, stock: [{ resourceId: 'wound-powder', owned: 1, reserved: 0, available: 1, capacity: 99 }] } };
    const props = { session, snapshot: available, risk: null, blocked: false, name: 'Patient', costId: 'care-cost', t, onStartCare: vi.fn() };
    expect(renderToStaticMarkup(createElement(ManagementCarePatientV9, props))).not.toContain('disabled=');
    const selectedPatches: Partial<NonNullable<ManagementSnapshotV9['cultivation']['selected']>>[] = [
      { injury: 0 }, { activityLocked: true }, { workOwner: { kind: 'care', id: 'job:occupied', workerId: snapshot.cultivation.selected!.discipleId } },
    ];
    for (const patch of [{ blocked: true }, { snapshot: { ...available, expansion: { ...available.expansion, stock: [] } } },
      ...selectedPatches.map(selected => ({ snapshot: { ...available, cultivation: { ...available.cultivation, selected: { ...available.cultivation.selected!, ...selected } } } }))]) {
      expect(renderToStaticMarkup(createElement(ManagementCarePatientV9, { ...props, ...patch }))).toContain('disabled=""');
    }
    const css = readFileSync(new URL('../../src/app/management-v9.css', import.meta.url), 'utf8');
    const riskRule = /\.management-v9-care-risk\s*\{([^}]+)\}/.exec(css)?.[1];
    expect(riskRule).toContain('display: flow-root');
    expect(riskRule).not.toMatch(/(?:max-)?height\s*:|overflow\s*:\s*(?:hidden|clip)|line-clamp/);
  }));
});


describe('v9 UI asynchronous lifecycle and reviewed boundaries', () => {
  it.each(['save', 'load', 'import'] as const)('releases UI holds after unmount during a real asynchronous %s', async operation => {
    const session = new ApplicationSessionV9(); const controller = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() });
    const scope = createManagementUiHoldScopeV9(session);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
    let pending: Promise<unknown> | null = null; let restore = () => {};
    try {
      await controller.start(); if (operation === 'load') await controller.save('campaign-1');
      const file = controller.exportCurrent();
      if (operation === 'import') {
        expect(await controller.selectImportFile({ name: file.filename, size: file.text.length, text: async () => file.text })).toBe(true);
        expect(controller.selectImportTarget('campaign-1')).toBe(true);
      }
      if (operation === 'load') {
        const original = IndexedDbSaveRepository.prototype.loadSlot;
        const spy = vi.spyOn(IndexedDbSaveRepository.prototype, 'loadSlot').mockImplementation(async function (this: IndexedDbSaveRepository, slotId) { arrived(); await gate; return original.call(this, slotId); });
        restore = () => spy.mockRestore();
      } else {
        const original = IndexedDbSaveRepository.prototype.importSave;
        const spy = vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbSaveRepository, text, options) { arrived(); await gate; return original.call(this, text, options); });
        restore = () => spy.mockRestore();
      }
      expect(scope.setOverlayPaused(true).ok).toBe(true); expect(scope.setReviewPaused(true).ok).toBe(true);
      const preview = controller.getSnapshot().import;
      pending = operation === 'save' ? controller.save('campaign-1') : operation === 'load' ? controller.load('campaign-1', false, 1)
        : controller.commitImport({ selectionId: preview.selectionId, slotId: 'campaign-1', expectedRevision: preview.target!.revision, overwriteConfirmed: false });
      await entered; expect(session.getSnapshot().holds.storageBusy).toBe(true);
      scope.dispose(); controller.stop(); await Promise.resolve();
      expect(session.getSnapshot().holds.overlay).toBe(true); expect(session.getSnapshot().holds.review).toBe(true);
      release(); await pending; await Promise.resolve(); await Promise.resolve();
      expect(session.getSnapshot().holds).toMatchObject({ storageBusy: false, overlay: false, review: false });
      expect(session.getSnapshot().paused).toBe(false);
    } finally { release(); controller.stop(); if (pending) await pending; scope.dispose(); restore(); session.close(); }
  });
  it('does not let an older deferred teardown clear a newer mount or dialog', async () => {
    const session = new ApplicationSessionV9(); const oldMount = createManagementUiHoldScopeV9(session);
    const newerMount = createManagementUiHoldScopeV9(session);
    try {
      oldMount.setOverlayPaused(true); session.setStorageBusy(true); oldMount.dispose(); await Promise.resolve();
      session.setStorageBusy(false);
      // A fresh dialog claims the existing UI-owned hold before the queued release.
      expect(newerMount.setOverlayPaused(true).ok).toBe(true); await Promise.resolve(); await Promise.resolve();
      expect(session.getSnapshot().holds.overlay).toBe(true);
      newerMount.setOverlayPaused(false); newerMount.setOverlayPaused(true); await Promise.resolve();
      expect(session.getSnapshot().holds.overlay).toBe(true);
      newerMount.dispose(); await Promise.resolve(); expect(session.getSnapshot().holds.overlay).toBe(false);
    } finally { oldMount.dispose(); newerMount.dispose(); session.close(); }
  });
  it('cleans the deferred subscription on Session close and does not bypass an exclusive publication', async () => {
    const session = new ApplicationSessionV9(); const original = session.subscribe; let active = 0;
    const subscription = vi.spyOn(session, 'subscribe').mockImplementation(listener => {
      active++; const unsubscribe = original(listener); let removed = false;
      return () => { if (!removed) { removed = true; active--; unsubscribe(); } };
    });
    const scope = createManagementUiHoldScopeV9(session);
    try {
      scope.setReviewPaused(true); session.setStorageBusy(true); scope.dispose(); await Promise.resolve();
      expect(active).toBe(1); session.close(); await Promise.resolve(); await Promise.resolve();
      expect(active).toBe(0); expect(scope.setReviewPaused(true)).toMatchObject({ ok: false, code: 'CLOSED' });
    } finally { scope.dispose(); subscription.mockRestore(); session.close(); }
  });
  it('leaves player, readonly and unrelated holds intact and releases only UI-owned holds', async () => {
    const session = new ApplicationSessionV9(); const scope = createManagementUiHoldScopeV9(session);
    try {
      session.setPaused('player', true); session.setStorageReadOnly(true); scope.setOverlayPaused(true); session.setStorageBusy(true);
      scope.dispose(); await Promise.resolve(); session.setStorageBusy(false); await Promise.resolve(); await Promise.resolve();
      expect(session.getSnapshot().holds).toMatchObject({ overlay: false, storage: true, storageBusy: false });
      expect(session.getSnapshot().frame.clock.pauseReasons).toContain('player'); expect(session.getSnapshot().paused).toBe(true);
      // A hold not acquired by this UI coordinator is not ours to clear.
      session.setReviewPaused(true); const other = createManagementUiHoldScopeV9(session); other.setReviewPaused(true); other.dispose();
      await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(true);
    } finally { scope.dispose(); session.close(); }
  });
  it('rejects risk from an old epoch, stamp, resource basis or selection before effect refresh', () => withSession(session => {
    const snapshot = session.getSnapshot(); const proposal = session.prepareBreakthrough(snapshot.cultivation.selected!.discipleId);
    expect(proposal.ok).toBe(true); if (!proposal.ok) return;
    expect(managementRiskCurrentV9(proposal.value, snapshot)).toBe(true);
    expect(managementRiskCurrentV9(proposal.value, { ...snapshot, sessionEpoch: snapshot.sessionEpoch + 1 })).toBe(false);
    expect(managementRiskCurrentV9(proposal.value, { ...snapshot, stamp: { ...snapshot.stamp, publication: snapshot.stamp.publication + 1 } })).toBe(false);
    expect(managementRiskCurrentV9(proposal.value, { ...snapshot, cultivation: { ...snapshot.cultivation, resourceStamp: 'new-resource-basis' } })).toBe(false);
    expect(managementRiskCurrentV9(proposal.value, { ...snapshot, cultivation: { ...snapshot.cultivation, selected: null } })).toBe(false);
  }));
  it('handles Escape on the document-like event target, respects busy/modal guards and disposes listeners', () => {
    const documentTarget = new EventTarget(); let blocked = false; let cancelled = 0;
    const dispose = attachManagementReviewEscapeV9(documentTarget, () => blocked, () => cancelled++);
    const escape = () => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' }); documentTarget.dispatchEvent(event); return event; };
    expect(escape().defaultPrevented).toBe(true); expect(cancelled).toBe(1);
    blocked = true; expect(escape().defaultPrevented).toBe(false); expect(cancelled).toBe(1);
    blocked = false; dispose(); expect(escape().defaultPrevented).toBe(false); expect(cancelled).toBe(1);
  });
  it('keeps a reviewed slot revision fenced when a different writer changes the actual repository', async () => {
    const indexedDB = new IDBFactory(); const session = new ApplicationSessionV9(); const controller = new ManagementSaveControllerV9(session, { indexedDB });
    let repository: IndexedDbSaveRepository | null = null;
    try {
      await controller.start(); await controller.save('campaign-1');
      const reviewedRevision = controller.getSnapshot().slots.find(row => row.slotId === 'campaign-1')!.slot!.revision;
      const basis = session.getSnapshot(); const originalBinding = controller.getSnapshot().boundSlot; const file = controller.exportCurrent();
      repository = await openSaveRepository({ indexedDB, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
      const writer = await repository.acquireLease('campaign-1', 'writer-after-dialog', { takeover: true });
      await repository.saveText('campaign-1', file.text, { lease: writer, expectedRevision: reviewedRevision }); await repository.releaseLease(writer);
      // The controller's cached list still matches the UI review, but storage does not.
      expect(controller.getSnapshot().slots.find(row => row.slotId === 'campaign-1')!.slot!.revision).toBe(reviewedRevision);
      await controller.load('campaign-1', false, reviewedRevision);
      expect(controller.getSnapshot().notice).toBe('save.error.conflict'); expect(controller.getSnapshot().boundSlot).toBe(originalBinding);
      expect(session.getSnapshot().sessionEpoch).toBe(basis.sessionEpoch); expect(session.getSnapshot().worldRevision).toBe(basis.worldRevision);
    } finally { controller.stop(); repository?.close(); session.close(); }
  });
});
