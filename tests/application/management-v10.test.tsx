import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ApplicationSessionV10 } from '../../src/application/session-v10';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { cloneJson } from '../../src/core/kernel/serialization';
import { managementV9BuildContext } from '../../src/content/sect-v9/world-content';
import { managementBuildNameV9 } from '../../src/app/ManagementBuildPanelV9';
import { ManagementAppV10, ManagementSectPanelsV10, createManagementHoldsV10, createManagementReviewV10,
  createManagementTranslatorV10, managementMessagesV10, managementMessageSpecificationsV10, managementBoundaryV10,
  managementBlockedV10, managementHasResourcesV10, managementResultV10, managementReasonV10, projectManagementRendererV10,
  ManagementBuildReviewDetailsV10, attachManagementDraftEscapeV10, restoreManagementDraftFocusV10, managementCareReasonV10,
  managementReviewFocusOwnerV10, managementBuildEquipmentLabelV10, focusManagementReviewV10,
  resumeManagementV10, type ManagementSnapshotV10, type ManagementReviewV10, type ManagementStorageStatusV10 } from '../../src/app/ManagementAppV10';
import { validateLocales } from '../../src/i18n/validation';

const sessions: ApplicationSessionV10[] = [];
function fresh() { const session = new ApplicationSessionV10(); sessions.push(session); return session; }
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); });
const placement = { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } as const;

describe('private v10 management component', () => {
  it('renders real bounded views and both formulas without exporting or starting a World', () => {
    const session = fresh(); const before = session.getSnapshot(); const world = vi.spyOn(session, 'exportWorld'); const dispatch = vi.spyOn(session, 'dispatch');
    const html = renderToStaticMarkup(createElement(ManagementAppV10, { session, initialLocale: 'zh-CN' }));
    expect(html).toContain('药性配伍'); expect(html).toContain('草木替代方'); expect(html).toContain('基础药理');
    expect(html).toContain('升级不追收'); expect(html).toContain('v10 存档控制器尚未接入');
    expect(html).toContain('management-v10-upgrade'); expect(html).toContain('management-v10-cultivation'); expect(html).toContain('management-v10-build');
    expect(html).not.toContain('文本暂不可用'); expect(session.getSnapshot()).toBe(before);
    expect(world).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
  it('uses stable parameter schemas and Chinese per-key fallback for local keys', () => {
    const zhCN = Object.fromEntries(Object.entries(managementMessagesV10).map(([key, values]) => [key, values[0]]));
    const en = Object.fromEntries(Object.entries(managementMessagesV10).map(([key, values]) => [key, values[1]]));
    expect(Object.keys(managementMessageSpecificationsV10)).toEqual(Object.keys(managementMessagesV10));
    const t = createManagementTranslatorV10('en', { ...en, 'managementV10.currentPeriod': '' });
    expect(t('managementV10.currentPeriod', { level: 1, paid: 0, due: 1200 })).toContain('当前已付期间按 L1');
    expect(t('managementV10.nextMaintenance', { cost: '2 wood + 1 herb' })).toContain('2 wood + 1 herb');
    expect(zhCN['managementV10.upgradeHalf']).toContain('{cost}');
    // Test the same production validator used by the global catalog, for this private catalog.
    expect(validateLocales(zhCN, en, managementMessageSpecificationsV10).valid).toBe(true);
  });
  it('strictly fences epoch, root stamp, world and selection without trusting a query DTO', () => {
    const before = fresh().getSnapshot(); expect(managementBoundaryV10(before, before)).toBe(true);
    for (const next of [ { ...before, revision: before.revision + 1 }, { ...before, sessionEpoch: before.sessionEpoch + 1 },
      { ...before, worldRevision: before.worldRevision + 1 }, { ...before, stamp: { ...before.stamp, publication: before.stamp.publication + 1 } }, { ...before, selection: null } ]) expect(managementBoundaryV10(before, next)).toBe(false);
    expect(managementBlockedV10({ ...before, holds: { ...before.holds, staging: true } }, false)).toBe('managementV9.busy');
    expect(managementBlockedV10(before, true)).toBe('managementV9.readOnly');
    expect(managementBlockedV10({ ...before, holds: { ...before.holds, review: true } }, false)).toBe('managementV9.reviewHeld');
  });
  it('consumes a real placement review once, before the second synchronous confirm', async () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start();
    const spy = vi.spyOn(session, 'confirmPlacement');
    expect(controller.prepare(session.getSnapshot(), () => session.preparePlacement(placement), { key: 'managementV9.placement' })).toBeNull();
    const review = controller.getSnapshot()!; expect(review.kind).toBe('proposal'); expect(session.getSnapshot().holds.review).toBe(true);
    const first = controller.confirm(review, false); const second = controller.confirm(review, false);
    expect(await first).toEqual({ key: 'managementV9.accepted' }); expect(await second).toEqual({ key: 'managementV9.stale' });
    expect(spy).toHaveBeenCalledTimes(1); expect(session.getSnapshot().expansion.blueprints).toHaveLength(1);
    await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(false); controller.stop();
  });
  it('keeps a negative upgrade preview advisory, with no command and no synthetic building', async () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start();
    const dispatch = vi.spyOn(session, 'confirmUpgrade');
    expect(controller.prepare(session.getSnapshot(), () => session.prepareUpgrade({ buildingId: 'sect-building:1', workerId: 'entity:2' }), { key: 'managementV10.upgrade' })).toBeNull();
    const review = controller.getSnapshot()!; expect(review.kind === 'proposal' && review.proposal.kind === 'upgrade' && review.proposal.view.scope).toBe('upgrade-start-conditions');
    expect(await controller.confirm(review, false)).not.toEqual({ key: 'managementV9.accepted' }); expect(dispatch).not.toHaveBeenCalled();
    expect(session.getSnapshot().expansion.buildings).toHaveLength(0); controller.cancel(); await Promise.resolve(); controller.stop();
  });
  it('drops stale reviews on selection and refuses copied review ownership', async () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start();
    controller.prepare(session.getSnapshot(), () => session.preparePlacement(placement), { key: 'managementV9.placement' }); const review = controller.getSnapshot()!;
    expect(await controller.confirm({ ...review }, false)).toEqual({ key: 'managementV9.stale' });
    expect(controller.getSnapshot()).toBe(review); session.select(null); expect(controller.getSnapshot()).toBeNull();
    expect(await controller.confirm(review, false)).toEqual({ key: 'managementV9.stale' }); await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(false); controller.stop();
  });
  it('deep-captures ordinary command reviews and rechecks after its own hold is released', async () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start();
    const before = session.getSnapshot(); const selected = before.cultivation.selected!;
    const request = { kind: 'cultivation.command' as const, payload: { command: { kind: 'training.set' as const, discipleId: selected.discipleId, mode: 'rest' as const, expectedRevision: before.cultivation.revision } } };
    expect(controller.open(before, request, { key: 'cultivation.mode.rest' })).toBeNull(); const review = controller.getSnapshot()!;
    request.payload.command.discipleId = 'absent'; expect(review.kind === 'command' && review.request.kind === 'cultivation.command' && 'discipleId' in review.request.payload.command && review.request.payload.command.discipleId).toBe(selected.discipleId);
    expect(Object.isFrozen(review.kind === 'command' ? review.request.payload : null)).toBe(true);
    const promise = controller.confirm(review, false); expect(controller.getSnapshot()).toBeNull();
    expect(await promise).toEqual({ key: 'managementV9.accepted' }); expect(session.getSnapshot().cultivation.selected?.trainingMode).toBe('rest'); controller.stop();
  });
  it('cancels ordinary confirmation if teardown occurs during deferred hold release', async () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start(); const before = session.getSnapshot();
    controller.open(before, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', discipleId: before.cultivation.selected!.discipleId, mode: 'rest', expectedRevision: before.cultivation.revision } } }, { key: 'cultivation.mode.rest' });
    const dispatch = vi.spyOn(session, 'dispatch'); const promise = controller.confirm(controller.getSnapshot()!, false); controller.stop();
    expect(await promise).toEqual({ key: 'managementV9.stale' }); expect(dispatch).not.toHaveBeenCalled();
  });
  it('defers old mount cleanup during storage busy and does not clear a newer claim', async () => {
    const session = fresh(); const first = createManagementHoldsV10(session); first.set('overlay', true); session.setStorageBusy(true); first.dispose();
    await Promise.resolve(); expect(session.getSnapshot().holds.overlay).toBe(true);
    session.setStorageBusy(false); const newer = createManagementHoldsV10(session); newer.set('overlay', true); await Promise.resolve();
    expect(session.getSnapshot().holds.overlay).toBe(true); newer.dispose(); await Promise.resolve(); expect(session.getSnapshot().holds.overlay).toBe(false);
  });
  it('resumes hidden/player only on the explicit path and preserves domain pauses', () => {
    const source = cloneJson(createUnregisteredWorldV10()); source.clock.pauseReasons = ['hidden', 'player', 'choice', 'save-capacity'];
    const session = new ApplicationSessionV10(source); sessions.push(session); const before = session.getSnapshot();
    session.setForeground({ visible: false }); session.setForeground({ visible: true }); expect(session.getSnapshot().frame.clock.pauseReasons).toEqual(source.clock.pauseReasons);
    expect(resumeManagementV10(session, before)).toMatchObject({ ok: false });
    expect(resumeManagementV10(session, session.getSnapshot())).toMatchObject({ ok: true }); expect(session.getSnapshot().frame.clock.pauseReasons).toEqual(['choice', 'save-capacity']);
    expect(session.getSnapshot().paused).toBe(true);
  });
  it('renders recorded checkpoint and refund summaries separately from checkpoint policy', () => {
    const session = fresh(); const original = session.getSnapshot();
    // Presentation-only fixture: never admitted, dispatched, persisted or used as World evidence.
    const snapshot: ManagementSnapshotV10 = { ...original, expansion: { ...original.expansion,
      jobs: [{ domain: 'upgrade', jobId: 'recorded-upgrade', buildingId: 'recorded-alchemy', workerId: 'entity:2', fromLevel: 1, toLevel: 2, phase: 'working', activeTicks: 237, requiredTicks: 400, blocked: null,
        checkpoints: [{ checkpointId: 'construction.half', activeTicks: 200, tick: 777, consumed: [{ ledger: 'base', resourceId: 'stone', quantity: 3 }] }] }],
      recentTerminals: [{ domain: 'upgrade', jobId: 'cancelled-upgrade', kind: 'cancelled', tick: 780, actorId: 'entity:2', beforeInjury: null, afterInjury: null, resultLevel: 1, doseSource: null,
        consumed: [{ ledger: 'base', resourceId: 'stone', quantity: 3 }], released: [{ ledger: 'base', resourceId: 'plank', quantity: 3 }] }],
    } };
    const t = createManagementTranslatorV10('en'); const reviews = createManagementReviewV10(session, () => false);
    const html = renderToStaticMarkup(createElement(ManagementSectPanelsV10, { context: { session, snapshot, readOnly: false, getReadOnly: () => false, t, reviews, feedback: () => {} } }));
    expect(html).toContain('actual progress 237'); expect(html).toContain('work tick 200 (simulation tick 777)'); expect(html).toContain('Actually consumed'); expect(html).toContain('Actually released reservations');
    expect(html).not.toContain('simulation tick 237'); expect(session.getSnapshot()).toBe(original);
  });
  it('renders supplied care sources and preserves paid-L1 versus next-L2 maintenance', () => {
    const session = fresh(); const original = session.getSnapshot();
    // DTO-only rendering fixture. The authenticated runtime selector owns these
    // facts in production; this fixture is never a source for domain admission.
    const upgradedSite = { kind: 'placed' as const, siteId: 'sect-building:77', sourceJobId: 'construction-origin:41', level: 2 as const, upgradeJobId: 'completed-upgrade:81' };
    const snapshot: ManagementSnapshotV10 = { ...original, expansion: { ...original.expansion,
      buildings: [{ definitionId: 'alchemy.v9', buildingId: upgradedSite.siteId, anchor: { x: 1, y: 1 }, rotation: 0,
        footprint: { cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }], entrance: { x: 1, y: 3 } }, level: 2,
        levelEvidence: { level: 2, constructionJobId: upgradedSite.sourceJobId, upgradeJobId: upgradedSite.upgradeJobId }, activeUpgradeJobId: null,
        maintenance: { buildingId: upgradedSite.siteId, operational: true, dueCalendarTick: 1200, deficits: [], renewalBlock: null, paid: true,
          currentPeriod: { paymentId: 'l1-payment:12', level: 1, upgradeJobId: null, paidTick: 0, paidCalendarTick: 0, dueCalendarTick: 1200 },
          nextMaintenanceCosts: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }] } }],
      jobs: [{ domain: 'care', jobId: 'active-care:22', patientId: 'entity:2', phase: 'working', activeTicks: 7, requiredTicks: 40, blocked: null,
        doseSource: { productionJobId: 'actual-alt-production:91', recipeId: 'craft.wound-powder-alt.v9', site: upgradedSite } }],
      recentTerminals: [{ domain: 'care', jobId: 'completed-care:21', kind: 'completed', tick: 90, actorId: 'entity:2', beforeInjury: 25, afterInjury: 5, resultLevel: null,
        doseSource: { productionJobId: 'actual-base-production:51', recipeId: 'craft.wound-powder.v9', site: { ...upgradedSite, level: 1, upgradeJobId: null } } }],
    } };
    const html = renderToStaticMarkup(createElement(ManagementSectPanelsV10, { context: { session, snapshot, readOnly: false, getReadOnly: () => false,
      t: createManagementTranslatorV10('en'), reviews: createManagementReviewV10(session, () => false), feedback: () => {} } }));
    expect(html).toContain('production job actual-alt-production:91'); expect(html).toContain('production job actual-base-production:51');
    expect(html).toContain('Actual site: sect-building:77 · L2 · construction construction-origin:41 · upgrade completed-upgrade:81');
    expect(html).toContain('Actual site: sect-building:77 · L1 · construction construction-origin:41 · upgrade None');
    expect(html).toContain('Current paid period uses the L1 rate: calendar tick 0 → 1,200');
    expect(html).not.toContain('Current paid period uses the L2 rate');
    expect(html).toContain('Next maintenance cost: 2 Wood · 1 Herbs');
    expect(html).toContain('neither back-charges the current L1 period nor resets its due tick');
    expect(html).not.toContain('文本暂不可用'); expect(session.getSnapshot()).toBe(original);
  });
  it('uses available stock and renders upgrade work without changing source objects', () => {
    const before = fresh().getSnapshot(); const constrained = { ...before, frame: { ...before.frame, resources: before.frame.resources.map(row => ({ ...row, owned: 99, reserved: 99, available: 0 })) } };
    expect(managementHasResourcesV10(constrained, [{ ledger: 'base', resourceId: 'wood', quantity: 1 }])).toBe(false);
    const snapshot: ManagementSnapshotV10 = { ...before, expansion: { ...before.expansion, workOwners: [{ kind: 'upgrade', id: 'upgrade:1', workerId: 'entity:2' }], jobs: [{ domain: 'upgrade', jobId: 'upgrade:1', buildingId: 'alchemy:1', workerId: 'entity:2', fromLevel: 1, toLevel: 2, phase: 'working', activeTicks: 199, requiredTicks: 400, blocked: null, checkpoints: [] }] } };
    const rendered = projectManagementRendererV10(snapshot); expect(rendered.disciples.find(row => row.id === 'entity:2')?.work).toEqual({ kind: 'upgrade', ownerId: 'upgrade:1', activeTicks: 199, requiredTicks: 400, blocked: false });
    expect(Object.isFrozen(rendered)).toBe(true); expect(before.expansion.jobs).toHaveLength(0);
  });
  it('does not flatten command rejection into accepted, and contains no authority exports or entry activation', () => {
    expect(managementResultV10({ ok: true, kind: 'command', published: false, result: { commandId: 'test', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'SECT_EXPANSION_REJECTED', detail: 'MAINTENANCE_UNPAID' } } }).key).not.toBe('managementV9.accepted');
    const source = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/exportWorld\(|\.snapshot\(|indexedDB\.|as\s+(?:unknown\s+as\s+)?(?:WorldState|ApplicationSessionV9)/);
    expect(source).not.toContain('ManagementSaveControllerV9'); expect(source).not.toContain('commitImport(');
    const css = readFileSync(new URL('../../src/app/management-v10.css', import.meta.url), 'utf8'); expect(css).toContain('max-width: 32rem'); expect(css).toContain('max-height: 20rem');
  });
});

// SSR/source contracts do not prove Canvas, native disclosure, zoom or browser
// focus behavior. The integration owner must still perform those interactions.
describe('v10 map-first presentation', () => {
  it.each(['zh-CN', 'en'] as const)('retains test-build identity, full ledgers and map-before-placement order in %s', locale => {
    const session = fresh(); const before = session.getSnapshot(); const t = createManagementTranslatorV10(locale);
    const html = renderToStaticMarkup(createElement(ManagementAppV10, { session, initialLocale: locale }));
    expect(html).toContain('class="management-v9 management-v9-map-first management-v9-workspace management-v10"');
    const scope = /<details class="management-v9-scope">([\s\S]*?)<\/details>/.exec(html)?.[0] ?? '';
    expect(scope).toContain(t('managementV10.candidate')); expect(scope).toContain(t('managementV10.scope'));
    expect(scope).toContain(locale === 'en' ? 'v10 management test build' : 'v10 经营测试版');
    expect(scope).not.toMatch(/私有|Private/);
    expect(html).toContain(t('managementV10.subtitle'));
    const summary = /<section id="management-v10-overview"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[0] ?? '';
    const ledger = /<details class="management-v9-ledger">([\s\S]*?)<\/details>/.exec(html)?.[0] ?? '';
    const rows = [...before.frame.resources, ...before.expansion.stock];
    expect(summary.match(/<article>/g)).toHaveLength(rows.length); expect(ledger.match(/<article>/g)).toHaveLength(rows.length);
    expect(summary).not.toContain('<p>'); expect(ledger).toContain(t('inventory.stockTitle'));
    for (const row of rows) {
      expect(summary).toContain(`<strong>${row.owned}</strong>`);
      expect(ledger).toContain(t('live.available', { available: row.available, reserved: row.reserved }));
      expect(ledger).toContain(t('live.capacity', { capacity: row.capacity }));
    }
    const mapAt = html.indexOf('<section class="management-v9-world"');
    const placementAt = html.indexOf('<section class="management-v9-panel management-v9-placement"');
    expect(mapAt).toBeGreaterThan(0); expect(placementAt).toBeGreaterThan(mapAt);
    expect(html.indexOf('<section id="management-v10-roster"')).toBeGreaterThan(placementAt);
    expect(html).toContain(`<h2 id="management-v10-selection">${t('managementV9.people')}</h2>`);
    expect(html).toContain(`aria-description="${t('managementV9.selection')}"`);
    const placementMarkup = html.slice(placementAt, html.indexOf('</section>', placementAt));
    expect(placementMarkup).toContain('aria-labelledby="management-v10-placement-heading"');
    expect(placementMarkup).toContain('class="management-v9-placement-fields"');
    expect(placementMarkup.match(/type="number"/g)).toHaveLength(2);
    expect(placementMarkup).toContain(t('managementV9.preview')); expect(session.getSnapshot()).toBe(before);
  });
  it.each(['zh-CN', 'en'] as const)('keeps all v10 categories in the compact tab navigation in %s', locale => {
    const session = fresh(); const t = createManagementTranslatorV10(locale);
    const html = renderToStaticMarkup(createElement(ManagementAppV10, { session, initialLocale: locale }));
    const navigation = /<div class="management-workspace-navigation"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[0] ?? '';
    expect(navigation).toContain(`aria-label="${t('managementV9.navigation')}"`);
    for (const suffix of ['overview', 'roster', 'cultivation', 'build', 'production', 'jobs', 'placement', 'research', 'upgrade', 'care', 'maintenance']) {
      expect(navigation).toContain(`id="management-v10-workspace-tab-${suffix}"`);
    }
    expect(navigation.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('<section id="management-v10-upgrade" hidden=""');
  });
  it.each(['slot', 'session'] as const)('keeps manual-only, dirty, %s read-only and storage notices outside collapsed content', origin => {
    const session = fresh(); if (origin === 'session') session.setStorageReadOnly(true);
    const before = session.getSnapshot(); const t = createManagementTranslatorV10('zh-CN');
    const status: ManagementStorageStatusV10 = { busy: false, readOnly: origin === 'slot', summary: { key: 'managementV9.unsaved' }, notice: { key: 'save.error.quota' } };
    const renderBody = vi.fn(() => null); const storage = { subscribe: () => () => {}, getSnapshot: () => status, renderBody };
    const html = renderToStaticMarkup(createElement(ManagementAppV10, { session, storage, initialLocale: 'zh-CN' }));
    const persistent = html.slice(html.indexOf('</header>'), html.indexOf('<section id="management-v10-overview"'));
    expect(persistent).not.toContain('<details'); expect(persistent).toContain(t('managementV9.unsaved'));
    expect(persistent).toContain(t('managementV9.manualOnly')); expect(persistent).toContain(t('save.readOnly'));
    expect(persistent).toContain(t('save.error.quota')); expect(persistent).toContain('class="management-v10-storage-state"');
    expect(persistent).not.toContain(t('managementV10.storageUnavailable'));
    expect(renderBody).not.toHaveBeenCalled(); expect(session.getSnapshot()).toBe(before);
  });
  it('keeps the explicit resume and save controls beside a quiet clock, outside action-only announcements', () => {
    const source = cloneJson(createUnregisteredWorldV10()); source.clock.pauseReasons = ['hidden', 'player', 'choice'];
    const session = new ApplicationSessionV10(source); sessions.push(session); const before = session.getSnapshot(); const t = createManagementTranslatorV10('en');
    const html = renderToStaticMarkup(createElement(ManagementAppV10, { session, initialLocale: 'en' }));
    const bar = /<div class="management-v9-command-bar"[^>]*>[\s\S]*?<\/p><\/div>/.exec(html)?.[0] ?? '';
    expect(bar).toContain(`>${t('managementV10.resumeExplicit')}</button>`); expect(bar).toContain(`>${t('save.open')}</button>`);
    const clock = /<div class="management-v9-clock">([\s\S]*?)<\/div>/.exec(bar)?.[0] ?? '';
    expect(clock).toContain(t('live.tick', { tick: before.frame.clock.simulationTick }));
    expect(clock).toContain(t('managementV9.speed', { speed: before.frame.clock.speed })); expect(clock).not.toMatch(/aria-live|role="status"/);
    const feedback = /<p class="management-v9-feedback"[^>]*>([\s\S]*?)<\/p>/.exec(bar)?.[0] ?? '';
    expect(feedback).toContain('aria-live="polite"'); expect(feedback).toContain(t('managementV9.feedbackReady'));
    expect(feedback).not.toContain(t('live.tick', { tick: before.frame.clock.simulationTick }));
    expect(html).toContain(t('managementV10.hiddenPause')); expect(session.getSnapshot()).toBe(before);
    expect(before.frame.clock.pauseReasons).toEqual(['hidden', 'player', 'choice']);
  });
  it('keeps the global review outside disclosures and placement fields mounted through a live preview', () => {
    const source = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    const shell = source.slice(source.indexOf('return <main className="management-v9 management-v9-map-first management-v9-workspace management-v10"'));
    const beforeReview = shell.slice(0, shell.indexOf('<ReviewPanelV10'));
    expect(shell.match(/<ReviewPanelV10/g)).toHaveLength(1);
    expect(beforeReview.match(/<details\b/g)?.length).toBe(beforeReview.match(/<\/details>/g)?.length);
    expect(shell.indexOf('<ReviewPanelV10')).toBeLessThan(shell.indexOf('className="management-v9-utilities"'));
    expect(shell).toContain("hidden={activeSection !== 'placement'}");
    expect(source).toContain('setPlacement(next); if (placementReview) prepare(next)');
    expect(source).not.toContain("activeSection === 'placement' &&"); expect(shell).not.toContain('.focus(');
    expect(source).toContain('}, [focus, region, session])');
    const css = readFileSync(new URL('../../src/app/management-v10.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 48rem), (max-height: 34rem)');
    expect(css).toContain('.management-v10 .management-v10-review { scroll-margin-block-start: 1rem; }');
  });
  it('does not move focus away from a placement field when another review presentation is requested', () => {
    const opener = {} as HTMLElement; const input = {} as HTMLElement; const body = {} as HTMLElement; const focus = vi.fn();
    const region = { isConnected: true, contains: () => false, querySelector: () => ({ focus }) } as unknown as HTMLElement;
    const restore = focusManagementReviewV10({ region, focus: { opener }, document: { activeElement: input, body }, canEnter: () => true, canRestore: () => true });
    expect(focus).not.toHaveBeenCalled(); restore(); expect(focus).not.toHaveBeenCalled();
  });
});

describe('v10 independent UI review regressions', () => {
  it('rejects queued focus restoration into a different Session with identical scalar boundaries', () => {
    const session = fresh(); const basis = session.getSnapshot(); const otherOwner = { getSnapshot: () => basis };
    expect(managementReviewFocusOwnerV10(session, session, basis)).toBe(true);
    expect(managementReviewFocusOwnerV10(session, otherOwner, basis)).toBe(false);
    session.select(null); expect(managementReviewFocusOwnerV10(session, session, basis)).toBe(false);
    const source = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    expect(source).toContain('managementReviewFocusOwnerV10(session, latestSession.current, opened.basis)');
  });
  it('numbers equipment copies per definition consistently across dropdown and review', () => {
    const equipment = [{ instanceId: 'a-1', definitionId: 'sword-a' }, { instanceId: 'b-1', definitionId: 'sword-b' },
      { instanceId: 'a-2', definitionId: 'sword-a' }, { instanceId: 'c-1', definitionId: 'sword-c' }];
    const t = createManagementTranslatorV10('en'); const name = (id: string) => id;
    expect(managementBuildEquipmentLabelV10(equipment, 'a-1', name, t)).toBe(t('buildView.itemCopy', { name: 'sword-a', number: 1 }));
    expect(managementBuildEquipmentLabelV10(equipment, 'a-2', name, t)).toBe(t('buildView.itemCopy', { name: 'sword-a', number: 2 }));
    expect(managementBuildEquipmentLabelV10(equipment, 'b-1', name, t)).toBe('sword-b');
    const source = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    expect(source).toContain('managementBuildEquipmentLabelV10(selected.equipment, id, name, t)');
    expect(source).toContain('managementBuildEquipmentLabelV10(items, item.instanceId, name, t)');
  });
  it.each(['stop', 'selection', 'readonly'] as const)('rechecks proposal ownership after synchronous %s subscriber mutation', async change => {
    const session = fresh(); let readonly = false; const controller = createManagementReviewV10(session, () => readonly); controller.start();
    controller.prepare(session.getSnapshot(), () => session.preparePlacement(placement), { key: 'managementV9.placement' }); const review = controller.getSnapshot()!;
    const confirm = vi.spyOn(session, 'confirmPlacement'); let armed = true;
    const stop = controller.subscribe(() => {
      if (controller.getSnapshot() || !armed) return; armed = false;
      if (change === 'stop') controller.stop(); else if (change === 'selection') session.select(null); else readonly = true;
    });
    expect(await controller.confirm(review, false)).toEqual({ key: change === 'readonly' ? 'managementV9.readOnly' : 'managementV9.stale' });
    expect(confirm).not.toHaveBeenCalled(); expect(session.getSnapshot().expansion.blueprints).toHaveLength(0);
    stop(); controller.stop(); await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(false);
  });
  it('keeps the explicit focus scope through placement coordinate refreshes', () => {
    const session = fresh(); const controller = createManagementReviewV10(session, () => false); controller.start();
    const focus = { opener: {} as HTMLElement };
    controller.prepare(session.getSnapshot(), () => session.preparePlacement(placement), { key: 'managementV9.placement' }, false, focus);
    const first = controller.getSnapshot()!;
    controller.prepare(session.getSnapshot(), () => session.preparePlacement({ ...placement, anchor: { x: 2, y: 1 } }), { key: 'managementV9.placement' });
    const second = controller.getSnapshot()!; expect(second).not.toBe(first); expect(second.focus).toBe(first.focus); expect(second.focus).toBe(focus);
    expect(second.kind === 'proposal' && second.proposal.kind === 'placement' && second.proposal.view.request.anchor.x).toBe(2);
    const source = readFileSync(new URL('../../src/app/ManagementAppV10.tsx', import.meta.url), 'utf8');
    expect(source).toContain('}, [focus, region, session])'); expect(source).toContain('opener: event.currentTarget'); controller.stop();
  });
  it('discards a draft on Escape once, respects modal ownership and restores only safe focus', () => {
    const target = new EventTarget(); let draft = true, modal = true; const focus = vi.fn(); const discard = vi.fn(() => { draft = false; });
    const stop = attachManagementDraftEscapeV10({ target, canDiscard: () => draft && !modal, discard });
    const press = () => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' }); target.dispatchEvent(event); return event; };
    expect(press().defaultPrevented).toBe(false); expect(discard).not.toHaveBeenCalled();
    modal = false; expect(press().defaultPrevented).toBe(true); press(); expect(discard).toHaveBeenCalledTimes(1);
    stop(); draft = true; press(); expect(discard).toHaveBeenCalledTimes(1);
    const body = {} as HTMLElement; const inside = {} as HTMLElement; const outside = {} as HTMLElement;
    let activeElement: Element | null = inside; let allowed = true, disabled = false;
    // This bounded DOM double only answers the helper's disabled-selector query;
    // preserve the platform overload on the test method, not a wider production port.
    const matches = (() => disabled) as unknown as HTMLElement['matches'];
    const restore = () => restoreManagementDraftFocusV10({ opener: { isConnected: true, matches, focus }, region: { contains: node => node === inside },
      document: { body, get activeElement() { return activeElement; } }, canRestore: () => allowed });
    restore(); expect(focus).toHaveBeenCalledTimes(1); activeElement = outside; restore(); expect(focus).toHaveBeenCalledTimes(1);
    activeElement = body; allowed = false; restore(); expect(focus).toHaveBeenCalledTimes(1);
    allowed = true; disabled = true; restore(); expect(focus).toHaveBeenCalledTimes(1);
  });
  it('shows frozen loadout before/after changes even after the live selection changes', () => {
    const session = fresh(); session.setPaused('player', true); const before = session.getSnapshot(); const selected = before.build.selected!;
    const registry = managementV9BuildContext(before.build.contentIdentity); const t = createManagementTranslatorV10('en');
    const controller = createManagementReviewV10(session, () => false); controller.start();
    const loadout = { ...selected.loadout, activeSkillIds: [selected.loadout.activeSkillIds[1], selected.loadout.activeSkillIds[0]] as [string, string] };
    expect(controller.open(before, { kind: 'build.command', payload: { command: { kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: before.build.revision, loadout } } }, { key: 'managementV9.buildConfirmChanges' }, null, false, 'build')).toBeNull();
    const review = controller.getSnapshot()!; loadout.activeSkillIds[0] = 'caller-mutation';
    const render = () => renderToStaticMarkup(createElement(ManagementBuildReviewDetailsV10, { review, locale: 'en', t }));
    const html = render();
    expect(html).toContain('data-build-change="active-0"'); expect(html).toContain('data-build-change="active-1"');
    expect(html).toContain(`${managementBuildNameV9(registry, 'en', selected.loadout.activeSkillIds[0])} → ${managementBuildNameV9(registry, 'en', selected.loadout.activeSkillIds[1])}`);
    expect(html).not.toContain('caller-mutation'); session.select(null); expect(render()).toBe(html); controller.stop();
  });
  it('shows tree additions/removals and distinguishes equipment copies in confirmation', () => {
    const snapshot = fresh().getSnapshot(); const selected = snapshot.build.selected!; const registry = managementV9BuildContext(snapshot.build.contentIdentity);
    const nodes = registry.catalog.treeNodes.filter(node => node.treeId === selected.treeId); const first = nodes[0]!, second = nodes[1]!;
    const weapon = selected.equipment.find(item => item.instanceId === selected.loadout.equipment.weaponId)!;
    const basis: ManagementSnapshotV10 = { ...snapshot, build: { ...snapshot.build, selected: { ...selected, allocatedNodeIds: [first.id],
      equipment: [...selected.equipment, { instanceId: 'different-owned-copy', definitionId: weapon.definitionId }] } } };
    // Bounded presentation fixture, not a claim that this fabricated respec is admitted.
    const review: ManagementReviewV10 = { kind: 'command', basis, policy: 'build', title: { key: 'managementV9.buildConfirmChanges' }, warning: null, acknowledge: false, focus: null,
      request: { kind: 'build.command', payload: { command: { kind: 'tree.respec', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, nodeIds: [second.id] } } } };
    const t = createManagementTranslatorV10('en');
    const tree = renderToStaticMarkup(createElement(ManagementBuildReviewDetailsV10, { review, locale: 'en', t }));
    expect(tree).toContain(`Before: ${managementBuildNameV9(registry, 'en', first.id)}`); expect(tree).toContain(`After: ${managementBuildNameV9(registry, 'en', second.id)}`);
    expect(tree).toContain(`Added nodes: ${managementBuildNameV9(registry, 'en', second.id)}`); expect(tree).toContain(`Removed nodes: ${managementBuildNameV9(registry, 'en', first.id)}`);
    const gear: ManagementReviewV10 = { ...review, request: { kind: 'build.command', payload: { command: { kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision,
      loadout: { ...selected.loadout, equipment: { ...selected.loadout.equipment, weaponId: 'different-owned-copy' } } } } } };
    const html = renderToStaticMarkup(createElement(ManagementBuildReviewDetailsV10, { review: gear, locale: 'en', t })); expect(html).toContain('data-build-change="weapon"');
    expect(html).toContain(t('buildView.itemCopy', { name: managementBuildNameV9(registry, 'en', weapon.definitionId), number: 1 }));
    expect(html).toContain(t('buildView.itemCopy', { name: managementBuildNameV9(registry, 'en', weapon.definitionId), number: 2 }));
  });
  it.each(['healthy', 'busy', 'powder'] as const)('explains the disabled care button for %s with an accessible description', kind => {
    const session = fresh(); const before = session.getSnapshot(); const selected = before.cultivation.selected!;
    const snapshot: ManagementSnapshotV10 = { ...before, cultivation: { ...before.cultivation, selected: { ...selected, lifeState: 'alive', injury: kind === 'healthy' ? 0 : 25, activityLocked: false,
      workOwner: kind === 'busy' ? { kind: 'upgrade', id: 'upgrade:11', workerId: selected.discipleId } : null } }, expansion: { ...before.expansion,
      stock: before.expansion.stock.map(row => row.resourceId === 'wound-powder' ? { ...row, available: 0 } : row) } };
    const reason = kind === 'healthy' ? 'managementV9.careHealthy' : kind === 'busy' ? 'managementV9.careOccupied' : 'managementV9.carePowderMissing';
    expect(managementCareReasonV10(snapshot, false)).toBe(reason); const t = createManagementTranslatorV10('en');
    const html = renderToStaticMarkup(createElement(ManagementSectPanelsV10, { context: { session, snapshot, readOnly: false, getReadOnly: () => false, t, reviews: createManagementReviewV10(session, () => false), feedback: () => {} } }));
    expect(html).toContain(t(reason)); const cost = html.match(/<p id="([^"]+-care-cost)"/); expect(cost).not.toBeNull(); expect(html).toContain(`aria-describedby="${cost![1]}" disabled=""`);
  });
  it('preserves localized cultivation/build codes and upgrade rejection reasons', () => {
    expect(managementResultV10({ ok: true, kind: 'command', published: false, result: { commandId: 'reject.cultivation', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: 'INSUFFICIENT_RESOURCES' } } })).toEqual({ key: 'cultivation.error.INSUFFICIENT_RESOURCES' });
    expect(managementResultV10({ ok: true, kind: 'command', published: false, result: { commandId: 'reject.build', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'BUILD_REJECTED', buildCode: 'INSUFFICIENT_LEARNING_CREDITS' } } })).toEqual({ key: 'buildView.insufficientCredits' });
    const t = createManagementTranslatorV10('en');
    for (const code of ['UNSUPPORTED_UPGRADE', 'ALREADY_UPGRADED', 'UPGRADE_ACTIVE', 'BUILDING_BUSY', 'MAINTENANCE_UNPAID', 'INVALID_RESERVATION', 'UNKNOWN_BUILDING', 'UNKNOWN_JOB', 'SITE_UNAVAILABLE', 'UNSAFE_POSITION']) {
      const message = managementReasonV10(code); expect(message.key).not.toBe('managementV9.reason.unknown'); expect(t(message.key, message.parameters)).not.toContain(code);
    }
  });
});
