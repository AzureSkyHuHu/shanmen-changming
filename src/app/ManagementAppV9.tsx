import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApplicationSessionV9, PlacementProposalV9 } from '../application/session-v9';
import type { ManagementSaveControllerV9 } from '../application/management-v9-save-controller';
import { createManagementV9RendererSource } from '../application/management-v9-renderer';
import { attachManagementReviewEscapeV9, createManagementUiHoldScopeV9, managementBlockedV9, managementContentTextV9, managementIntentGuardV9, managementReasonV9,
  managementResourceTextV9, managementResultV9, type ManagementSnapshotV9, type ManagementTextV9, type ManagementUiHoldScopeV9 } from '../application/management-v9-contract';
import type { SectPlacementRequest, SectRotation } from '../core/sect-expansion/types';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { DEFAULT_LOCALE, readLocalePreference, translate, writeLocalePreference, type Locale, type TextKey, type TranslationParams } from '../i18n';
import { SECT_V9_CANDIDATE } from '../content/sect-v9/catalog';
import { PhaserWorld } from '../phaser/PhaserWorld';
import { SectManagementPanelV9 } from './SectManagementPanelV9';
import { ManagementCultivationPanelV9 } from './ManagementCultivationPanelV9';
import { ManagementBuildPanelV9 } from './ManagementBuildPanelV9';
import { ManagementSavePanelV9, ManagementSaveSummaryV9 } from './ManagementSavePanelV9';
import './app.css';
import './management-v9.css';
import './management-v9-navigation.css';

/** Explicit service injection keeps this candidate out of old entry/save/World factories. */
export interface ManagementAppV9Props { session: ApplicationSessionV9; saves: ManagementSaveControllerV9; initialLocale?: Locale }
type PlacementReview = { proposal: RuntimeReadonlyV9<PlacementProposalV9>; basis: ManagementSnapshotV9 };
export function ManagementAppV9({ session, saves, initialLocale }: ManagementAppV9Props) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const saveStatus = useSyncExternalStore(saves.subscribe, saves.getSnapshot, saves.getSnapshot);
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? (typeof window === 'undefined' ? DEFAULT_LOCALE : readLocalePreference()));
  const [feedback, setFeedback] = useState<ManagementTextV9 | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [request, setRequest] = useState<SectPlacementRequest>({ definitionId: 'library.v9', anchor: { x: 2, y: 2 }, rotation: 0 });
  const [review, setReview] = useState<PlacementReview | null>(null);
  const holdScope = useRef<ManagementUiHoldScopeV9 | null>(null);
  const shell = useRef<HTMLElement | null>(null);
  const commandBar = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<(cell: { x: number; y: number }) => void>(() => {});
  const source = useMemo(() => createManagementV9RendererSource(session, { onPlacementCell: cell => pointer.current(cell) }), [session]);
  const t = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
  const readOnly = saveStatus.readOnly || snapshot.holds.storage;
  const getReadOnly = () => saves.getSnapshot().readOnly;
  const blocked = managementBlockedV9(snapshot, readOnly);
  useEffect(() => {
    const scope = createManagementUiHoldScopeV9(session); holdScope.current = scope;
    return () => { if (holdScope.current === scope) holdScope.current = null; scope.dispose(); };
  }, [session]);
  useEffect(() => { void saves.start(); return () => saves.stop(); }, [saves]);
  // Anchor/focus clearance follows actual wrapped text, including language and zoom changes.
  // Measuring this presentation area never changes simulation state or announces clock ticks.
  useEffect(() => {
    const root = shell.current; const bar = commandBar.current; if (!root || !bar) return;
    const measure = () => root.style.setProperty('--management-v9-toolbar-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  // One owned frame loop. Browser visibility/focus only controls Session's explicit holds.
  useEffect(() => {
    let disposed = false; let frame = 0;
    const visibility = () => session.setForeground({ visible: document.visibilityState !== 'hidden' });
    const focus = () => session.setForeground({ focused: true });
    const blur = () => session.setForeground({ focused: false });
    const tick = (timestamp: number) => { if (disposed) return; session.frame(timestamp); frame = requestAnimationFrame(tick); };
    session.setForeground({ visible: document.visibilityState !== 'hidden', focused: document.hasFocus() });
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    frame = requestAnimationFrame(tick);
    return () => { disposed = true; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); session.resetFrameBaseline(); };
  }, [session]);
  useEffect(() => { setReview(null); source.setPlacementPreview(null); holdScope.current?.setReviewPaused(false); }, [snapshot.sessionEpoch, source]);
  useEffect(() => {
    source.setPlacementPreview(review ? { anchor: review.proposal.view.request.anchor, footprint: review.proposal.view.footprint, allowed: review.proposal.view.allowed } : null);
    return () => source.setPlacementPreview(null);
  }, [source, review]);
  const cancelPlacement = () => { setReview(null); source.setPlacementPreview(null); holdScope.current?.setReviewPaused(false); };
  const prepare = (next: SectPlacementRequest) => {
    const current = session.getSnapshot(); const denied = managementIntentGuardV9(snapshot, current, getReadOnly(), 'construction', review !== null);
    if (denied) { setFeedback({ key: denied }); return; }
    const held = holdScope.current?.setReviewPaused(true); if (!held) return; if (!held.ok) { setFeedback(managementResultV9(held)); return; }
    const result = session.preparePlacement(next);
    if (!result.ok) { setFeedback(managementResultV9(result)); cancelPlacement(); return; }
    setReview({ proposal: result.value, basis: session.getSnapshot() });
  };
  const changeRequest = (next: SectPlacementRequest) => { setRequest(next); if (review) prepare(next); };
  pointer.current = cell => { if (review) changeRequest({ ...request, anchor: cell }); };
  useEffect(() => {
    if (!review) return;
    return attachManagementReviewEscapeV9(document,
      () => saveOpen || saves.getSnapshot().busy || session.getSnapshot().holds.storageBusy || session.getSnapshot().holds.overlay,
      () => { setReview(null); source.setPlacementPreview(null); holdScope.current?.setReviewPaused(false); });
  }, [review, saves, session, source, saveOpen]);
  const confirmPlacement = () => {
    if (!review) return;
    const current = session.getSnapshot(); const denied = managementIntentGuardV9(review.basis, current, getReadOnly(), 'construction', true);
    if (denied || !session.isProposalCurrent(review.proposal)) { setFeedback({ key: denied ?? 'managementV9.stale' }); cancelPlacement(); session.refresh(); return; }
    if (!review.proposal.view.allowed) { setFeedback(managementReasonV9(review.proposal.view.code ?? 'INVALID_REQUEST')); return; }
    const result = session.confirmPlacement(review.proposal); setFeedback(managementResultV9(result));
    // Consume the review before a repeated event can submit it again.
    cancelPlacement();
  };
  const choose = (selection: NonNullable<ManagementSnapshotV9['selection']>) => {
    const current = session.getSnapshot();
    if (current.sessionEpoch !== snapshot.sessionEpoch || current.holds.storageBusy || current.closed) { setFeedback({ key: 'managementV9.stale' }); return; }
    if (review) cancelPlacement();
    const result = session.select(selection); if (!result.ok) setFeedback(managementResultV9(result));
  };
  return <main className="management-v9" lang={locale} ref={shell}>
    <header className="management-v9-header">
      <div><p className="management-v9-eyebrow">{t('managementV9.candidate')}</p><h1>{t('app.title')}</h1><p>{t('managementV9.subtitle')}</p></div>
      <div className="management-v9-header-controls">
        <label>{t('settings.language.label')}<select value={locale} onChange={event => { const next = event.currentTarget.value === 'en' ? 'en' : 'zh-CN'; setLocale(next); writeLocalePreference(next); }}>
          <option value="zh-CN">{t('settings.language.zh-CN')}</option><option value="en">{t('settings.language.en')}</option>
        </select></label>
      </div>
    </header>
    <p className="management-v9-scope">{t('managementV9.scope')}</p>
    <ManagementSaveSummaryV9 status={saveStatus} locale={locale} t={t} />
    <div className="management-v9-command-bar" ref={commandBar} role="region" aria-label={t('managementV9.controls')}>
      <div className="management-v9-command-row">
        <button className="secondary" aria-pressed={snapshot.frame.clock.pauseReasons.includes('player') || snapshot.holds.player} disabled={readOnly || saveStatus.busy || snapshot.holds.review || !!review || saveOpen || !!snapshot.stopped || snapshot.closed} onClick={() => {
          const current = session.getSnapshot(); if (current.sessionEpoch !== snapshot.sessionEpoch || current.holds.storageBusy || current.holds.review || getReadOnly() || current.stopped || current.closed) { setFeedback({ key: 'managementV9.stale' }); return; }
          setFeedback(managementResultV9(session.togglePlayerPause()));
        }}>{t(snapshot.frame.clock.pauseReasons.includes('player') || snapshot.holds.player ? 'managementV9.resume' : 'managementV9.pause')}</button>
        {snapshot.frame.clock.speed !== 1 && <button disabled={!!blocked} onClick={() => { if (!managementBlockedV9(session.getSnapshot(), getReadOnly())) setFeedback(managementResultV9(session.setSpeed(1))); }}>{t('managementV9.setNormalSpeed')}</button>}
        <button className="secondary" disabled={saveStatus.busy || snapshot.holds.review || !!review} onClick={() => { const current = session.getSnapshot(); if (current.sessionEpoch !== snapshot.sessionEpoch || current.holds.storageBusy || current.holds.review || current.closed) { setFeedback({ key: 'managementV9.stale' }); return; } const result = holdScope.current?.setOverlayPaused(true); if (!result) return; if (!result.ok) { setFeedback(managementResultV9(result)); return; } setSaveOpen(true); }}>{t('save.open')}</button>
        <span className="management-v9-run-state">{t(snapshot.paused ? 'managementV9.clockPaused' : 'managementV9.clockRunning')}</span>
      </div>
      <p className="management-v9-feedback" role="status" aria-live="polite" aria-atomic="true">{feedback ? t(feedback.key, feedback.parameters) : t('managementV9.feedbackReady')}</p>
    </div>
    <nav className="management-v9-section-nav" aria-label={t('managementV9.navigation')}>
      <a href="#management-v9-overview">{t('managementV9.overview')}</a>
      <a href="#management-v9-roster">{t('managementV9.people')}</a>
      <a href="#management-v9-cultivation">{t('cultivation.ui.title')}</a>
      <a href="#management-v9-build">{t('managementV9.buildTitle')}</a>
      <a href="#management-v9-production">{t('managementV9.production')}</a>
      <a href="#management-v9-jobs">{t('managementV9.jobs')}</a>
      <a href="#management-v9-research">{t('managementV9.research')}</a>
      <a href="#management-v9-care">{t('managementV9.care')}</a>
      <a href="#management-v9-maintenance">{t('managementV9.maintenance')}</a>
    </nav>
    <div className="management-v9-clock">
      <span>{t('live.calendar', { year: snapshot.frame.calendar.year, month: snapshot.frame.calendar.month })}</span>
      <span>{t('live.tick', { tick: snapshot.frame.clock.simulationTick })}</span>
      <span>{t('managementV9.speed', { speed: snapshot.frame.clock.speed })}</span>
    </div>
    {(snapshot.stopped || snapshot.runtimeFailure) && <p className="management-v9-notice" role="alert">{t('managementV9.stopped')}</p>}
    <section id="management-v9-overview" className="management-v9-resources management-v9-anchor" tabIndex={-1} aria-label={t('live.resources')}>
      {[...snapshot.frame.resources.map(row => ({ ...row, name: t(`resource.${row.resourceId}`), ledger: 'base' })), ...snapshot.expansion.stock.map(row => ({ ...row, name: managementContentTextV9(SECT_V9_CANDIDATE.resources.find(item => item.resourceId === row.resourceId)!.nameKey, t), ledger: 'sect' }))].map(row => <article key={`${row.ledger}:${row.resourceId}`}>
        <h2>{row.name}</h2><strong>{row.owned}</strong><p>{t('live.available', { available: row.available, reserved: row.reserved })}</p><p>{t('live.capacity', { capacity: row.capacity })}</p>
      </article>)}
    </section>
    <div className="management-v9-map-layout">
      <section className="management-v9-world" aria-label={t('live.worldLabel')}><PhaserWorld source={source} locale={locale} /></section>
      <section className="management-v9-panel management-v9-placement" aria-labelledby="management-v9-placement-heading">
        <h2 id="management-v9-placement-heading">{t('managementV9.placement')}</h2><p className="management-v9-help">{t('managementV9.placementHint')}</p>
        <label className="management-v9-field">{t('managementV9.buildingType')}<select value={request.definitionId} disabled={saveStatus.busy || readOnly} onChange={event => changeRequest({ ...request, definitionId: event.currentTarget.value === 'alchemy.v9' ? 'alchemy.v9' : 'library.v9' })}>
          <option value="library.v9">{t('sectV9.building.library')}</option><option value="alchemy.v9">{t('sectV9.building.alchemy')}</option>
        </select></label>
        <div className="management-v9-coordinates">{(['x', 'y'] as const).map(axis => <label key={axis}>{t(axis === 'x' ? 'managementV9.coordinateX' : 'managementV9.coordinateY')}<input type="number" step="1" min="0" max={axis === 'x' ? snapshot.frame.map.width - 1 : snapshot.frame.map.height - 1} value={request.anchor[axis]} disabled={saveStatus.busy || readOnly} onChange={event => { const value = Number(event.currentTarget.value); if (Number.isSafeInteger(value)) changeRequest({ ...request, anchor: { ...request.anchor, [axis]: value } }); }} /></label>)}</div>
        <label className="management-v9-field">{t('managementV9.rotation')}<select value={request.rotation} disabled={saveStatus.busy || readOnly} onChange={event => { const value = Number(event.currentTarget.value); if ([0, 90, 180, 270].includes(value)) changeRequest({ ...request, rotation: value as SectRotation }); }}>{([0, 90, 180, 270] as const).map(rotation => <option key={rotation} value={rotation}>{t('managementV9.degrees', { rotation })}</option>)}</select></label>
        <p>{t('managementV9.placementAdvisory')}</p>
        {review && <div className="management-v9-review" role="status">
          <p>{t(review.proposal.view.allowed ? 'managementV9.previewAllowed' : 'managementV9.previewRejected')}</p>
          {review.proposal.view.code && <p>{(() => { const reason = managementReasonV9(review.proposal.view.code); return t(reason.key, reason.parameters); })()}</p>}
          {review.proposal.view.footprint && <p>{t('managementV9.geometry', { x: review.proposal.view.request.anchor.x, y: review.proposal.view.request.anchor.y, rotation: review.proposal.view.request.rotation, entranceX: review.proposal.view.footprint.entrance.x, entranceY: review.proposal.view.footprint.entrance.y })}</p>}
          <p>{managementResourceTextV9(review.proposal.view.costs, t)}</p><p>{t('managementV9.workTicks', { ticks: review.proposal.view.requiredTicks })}</p>
        </div>}
        <div className="management-v9-actions">
          <button disabled={!!managementBlockedV9(snapshot, readOnly, true)} onClick={() => prepare(request)}>{t('managementV9.preview')}</button>
          {review && <><button disabled={!review.proposal.view.allowed || !!managementBlockedV9(snapshot, readOnly, true)} onClick={confirmPlacement}>{t('managementV9.placeBlueprint')}</button><button className="secondary" disabled={saveStatus.busy} onClick={cancelPlacement}>{t('managementV9.cancelPreview')}</button></>}
        </div>
      </section>
    </div>
    <section id="management-v9-roster" className="management-v9-panel management-v9-anchor" tabIndex={-1} aria-labelledby="management-v9-selection"><h2 id="management-v9-selection">{t('managementV9.selection')}</h2>
      <div className="management-v9-selection-list">{snapshot.frame.disciples.map(actor => <button key={actor.id} className="secondary" aria-pressed={snapshot.selection?.kind === 'disciple' && snapshot.selection.id === actor.id} disabled={saveStatus.busy} onClick={() => choose({ kind: 'disciple', id: actor.id })}>{managementContentTextV9(actor.nameKey, t)} · {t('live.position', actor.position)}</button>)}
        {snapshot.frame.buildings.map(building => <button className="secondary" key={building.id} aria-pressed={snapshot.selection?.kind === 'building' && snapshot.selection.id === building.id} disabled={saveStatus.busy} onClick={() => choose({ kind: 'building', id: building.id })}>{managementContentTextV9(building.nameKey, t)}</button>)}
        {snapshot.expansion.blueprints.map(blueprint => <button className="secondary" key={blueprint.blueprintId} aria-pressed={snapshot.selection?.kind === 'blueprint' && snapshot.selection.id === blueprint.blueprintId} disabled={saveStatus.busy} onClick={() => choose({ kind: 'blueprint', id: blueprint.blueprintId })}>{t('managementV9.blueprintLabel', { name: t(blueprint.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy') })}</button>)}
        {snapshot.expansion.buildings.map(building => <button className="secondary" key={building.buildingId} aria-pressed={snapshot.selection?.kind === 'sect-building' && snapshot.selection.id === building.buildingId} disabled={saveStatus.busy} onClick={() => choose({ kind: 'sect-building', id: building.buildingId })}>{t(building.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')}</button>)}
      </div>
    </section>
    <div className="management-v9-panels management-v9-disciple-panels">
      <ManagementCultivationPanelV9 session={session} snapshot={snapshot} readOnly={readOnly} getReadOnly={getReadOnly} t={t} onFeedback={setFeedback} />
      <ManagementBuildPanelV9 session={session} snapshot={snapshot} locale={locale} readOnly={readOnly} getReadOnly={getReadOnly} onFeedback={setFeedback} />
    </div>
    <SectManagementPanelV9 session={session} snapshot={snapshot} readOnly={readOnly} getReadOnly={getReadOnly} t={t} onFeedback={setFeedback} />
    {saveOpen && <ManagementSavePanelV9 controller={saves} session={session} locale={locale} onClose={() => { if (saves.getSnapshot().busy) return; setSaveOpen(false); holdScope.current?.setOverlayPaused(false); }} />}
  </main>;
}
