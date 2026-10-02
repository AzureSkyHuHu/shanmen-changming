import { useEffect, useId, useState } from 'react';
import { STARTER_RECIPES } from '../core/economy/recipes';
import { SECT_V9_CANDIDATE } from '../content/sect-v9/catalog';
import type { SectResourceLine } from '../content/sect-v9/types';
import type { RuntimeReadonlyV9, RuntimeExpansionJobV9 } from '../core/world/runtime-view-types-v9';
import type { BreakthroughProposalV9, SessionCommandResultV9 } from '../application/session-v9';
import { MANAGEMENT_BASE_RECIPES_V9, MANAGEMENT_RESEARCH_V9, MANAGEMENT_SECT_RECIPES_V9,
  managementBlockedV9, managementContentTextV9, managementHasResourcesV9, managementIntentGuardV9,
  managementPhaseKeyV9, managementReasonV9, managementRiskCurrentV9, managementResourceTextV9, managementResultV9, managementWorkerAvailableV9,
  type ManagementDomainV9, type ManagementSessionV9, type ManagementSnapshotV9, type ManagementTextV9, type ManagementTranslatorV9,
} from '../application/management-v9-contract';
import type { TextKey } from '../i18n';

export interface SectManagementPanelV9Props {
  session: ManagementSessionV9; snapshot: ManagementSnapshotV9; readOnly: boolean; getReadOnly: () => boolean;
  t: ManagementTranslatorV9; onFeedback: (message: ManagementTextV9) => void;
}

interface ManagementCarePatientV9Props {
  session: Pick<ManagementSessionV9, 'isProposalCurrent'>; snapshot: ManagementSnapshotV9;
  risk: RuntimeReadonlyV9<BreakthroughProposalV9> | null; blocked: boolean;
  name: string; costId: string; t: ManagementTranslatorV9; onStartCare: () => void;
}
/** Keep the actionable subtree ahead of the effect-refreshed, optional preview. */
export function ManagementCarePatientV9({ session, snapshot, risk, blocked, name, costId, t, onStartCare }: ManagementCarePatientV9Props) {
  const selected = snapshot.cultivation.selected;
  if (!selected) return <p>{t('managementV9.selectPatient')}</p>;
  return <div className="management-v9-care-patient">
    <div className="management-v9-care-controls">
      <h3>{name}</h3><p>{t('managementV9.injury', { injury: selected.injury })}</p>
      <p id={costId}>{t('managementV9.careCost')}</p>
      <button type="button" aria-describedby={costId}
        disabled={blocked || selected.injury <= 0 || selected.lifeState !== 'alive' || selected.activityLocked || selected.workOwner !== null || !snapshot.expansion.stock.some(row => row.resourceId === 'wound-powder' && row.available > 0)}
        onClick={onStartCare}>{t('managementV9.startCare')}</button>
    </div>
    {/* Invalid risk disappears immediately, but never moves the care controls. */}
    <div className="management-v9-care-risk">
      {risk && managementRiskCurrentV9(risk, snapshot) && session.isProposalCurrent(risk) && <p>{t('managementV9.risk', { success: risk.view.preview.successBps / 10000, death: risk.view.preview.overallDeathBps / 10000 })}</p>}
    </div>
  </div>;
}

export function SectManagementPanelV9({ session, snapshot, readOnly, getReadOnly, t, onFeedback }: SectManagementPanelV9Props) {
  const id = useId();
  const [workerId, setWorkerId] = useState(() => snapshot.frame.disciples.find(row => managementWorkerAvailableV9(snapshot, row.id))?.id ?? '');
  const [risk, setRisk] = useState<RuntimeReadonlyV9<BreakthroughProposalV9> | null>(null);
  const selected = snapshot.cultivation.selected;
  useEffect(() => {
    if (!selected) { setRisk(null); return; }
    const result = session.prepareBreakthrough(selected.discipleId, { method: 'standard', arraySupport: 0 });
    setRisk(result.ok ? result.value : null);
  }, [session, snapshot.sessionEpoch, selected?.discipleId, snapshot.cultivation.revision, snapshot.cultivation.resourceStamp, snapshot.stamp.generation, snapshot.stamp.publication]);
  useEffect(() => { if (!snapshot.frame.disciples.some(row => row.id === workerId)) setWorkerId(''); }, [snapshot.sessionEpoch, snapshot.frame.disciples, workerId]);
  const blocked = managementBlockedV9(snapshot, readOnly);
  const workerAvailable = managementWorkerAvailableV9(snapshot, workerId);
  const name = (actorId: string) => { const actor = snapshot.frame.disciples.find(row => row.id === actorId); return actor ? managementContentTextV9(actor.nameKey, t) : t('managementV9.unknownPerson'); };
  const showReason = (code: string) => { const reason = managementReasonV9(code); return t(reason.key, reason.parameters); };
  const perform = (domain: ManagementDomainV9 | undefined, action: (current: ManagementSnapshotV9) => SessionCommandResultV9) => {
    const current = session.getSnapshot(); const denied = managementIntentGuardV9(snapshot, current, getReadOnly(), domain);
    if (denied) { onFeedback({ key: denied }); session.refresh(); return; }
    onFeedback(managementResultV9(action(current)));
  };
  const performStart = (domain: ManagementDomainV9 | undefined, action: (current: ManagementSnapshotV9) => SessionCommandResultV9) => perform(domain, current => {
    if (!managementWorkerAvailableV9(current, workerId)) return { ok: false, kind: 'session-rejection', code: 'PREVIEW_STALE' };
    return action(current);
  });
  const costs = (lines: readonly SectResourceLine[]) => managementResourceTextV9(lines, t);
  const jobName = (job: RuntimeReadonlyV9<RuntimeExpansionJobV9>) => job.domain === 'production'
    ? managementContentTextV9(SECT_V9_CANDIDATE.recipes.find(row => row.recipeId === job.recipeId)?.nameKey ?? '', t)
    : t(job.domain === 'construction' ? 'managementV9.construction' : job.domain === 'care' ? 'managementV9.care' : 'sectV9.research.basicMedicine');
  const cancelJob = (job: RuntimeReadonlyV9<RuntimeExpansionJobV9>) => perform(job.domain, current => {
    const revision = current.expansion.revisions[job.domain];
    if (job.domain === 'construction') return session.dispatchSect({ domain: 'construction', command: { kind: 'construction.cancel', blueprintId: job.blueprintId, expectedRevision: revision } });
    if (job.domain === 'production') return session.dispatchSect({ domain: 'production', command: { kind: 'production.cancel', jobId: job.jobId, expectedRevision: revision } });
    if (job.domain === 'research') return session.dispatchSect({ domain: 'research', command: { kind: 'research.cancel', jobId: job.jobId, expectedRevision: revision } });
    return session.dispatchSect({ domain: 'care', command: { kind: 'care.cancel', jobId: job.jobId, expectedRevision: revision } });
  });
  const startDisabled = !!blocked || !workerAvailable;
  return <div className="management-v9-panels">
    <section className="management-v9-panel" aria-labelledby={`${id}-work`}>
      <h2 id={`${id}-work`}>{t('managementV9.production')}</h2>
      <label className="management-v9-field">{t('production.worker')}
        <select value={workerId} disabled={!!blocked} onChange={event => setWorkerId(event.currentTarget.value)}>
          <option value="">{t('managementV9.chooseWorker')}</option>
          {snapshot.frame.disciples.map(actor => <option key={actor.id} value={actor.id} disabled={!managementWorkerAvailableV9(snapshot, actor.id)}>{name(actor.id)} · {t(managementWorkerAvailableV9(snapshot, actor.id) ? 'managementV9.availableWorker' : 'managementV9.busyWorker')}</option>)}
        </select>
      </label>
      {blocked && <p className="management-v9-notice">{t(blocked)}</p>}
      {!workerAvailable && !blocked && <p className="management-v9-notice">{t('managementV9.chooseWorker')}</p>}
      <p className="management-v9-help">{t('managementV9.deliveryHint')}</p>
      <div className="management-v9-recipe-list">
        {MANAGEMENT_BASE_RECIPES_V9.map(recipeId => {
          const recipe = STARTER_RECIPES[recipeId]!;
          const inputs: SectResourceLine[] = recipe.inputs.map(line => ({ ledger: 'base', ...line }));
          const outputs: SectResourceLine[] = recipe.outputs.map(line => ({ ledger: 'base', ...line }));
          const sufficient = managementHasResourcesV9(snapshot, inputs);
          return <article className="management-v9-card" key={recipeId}>
            <h3>{managementContentTextV9(recipe.nameKey, t)}</h3>
            <p>{t('production.recipeFlow', { inputs: costs(inputs), outputs: costs(outputs) })}</p>
            <p>{t('managementV9.workTicks', { ticks: recipe.workTicks })}</p>
            {!sufficient && <p className="management-v9-notice">{t('managementV9.reason.resources')}</p>}
            <button disabled={startDisabled || !sufficient} onClick={() => performStart(undefined, current => {
              if (!managementWorkerAvailableV9(current, workerId)) return { ok: false, kind: 'session-rejection', code: 'PREVIEW_STALE' };
              return session.dispatch({ kind: 'production.start', payload: { recipeId, workerId } });
            })}>{t('managementV9.start')}</button>
          </article>;
        })}
        {MANAGEMENT_SECT_RECIPES_V9.map(recipe => {
          const researchReady = recipe.requiredResearch.every(researchId => snapshot.expansion.completedResearch.some(row => row.researchId === researchId));
          const station = recipe.workstation;
          const stationReady = station.kind === 'placed'
            ? snapshot.expansion.buildings.some(row => row.definitionId === station.definitionId && row.level >= station.minimumLevel && row.maintenance.operational)
            : snapshot.frame.buildings.some(row => row.blueprintId === station.blueprintId && row.operational);
          const sufficient = managementHasResourcesV9(snapshot, recipe.inputs);
          const reason: TextKey | null = !researchReady ? 'managementV9.reason.research' : !stationReady ? 'managementV9.reason.station' : !sufficient ? 'managementV9.reason.resources' : null;
          return <article className="management-v9-card" key={recipe.recipeId}>
            <h3>{managementContentTextV9(recipe.nameKey, t)}</h3>
            <p>{t('production.recipeFlow', { inputs: costs(recipe.inputs), outputs: costs(recipe.outputs) })}</p>
            <p>{t('managementV9.workTicks', { ticks: recipe.workTicks })}</p>
            {reason && <p className="management-v9-notice">{t(reason)}</p>}
            <button disabled={startDisabled || !!reason} onClick={() => performStart('production', current => session.dispatchSect({ domain: 'production', command: { kind: 'production.start', recipeId: recipe.recipeId, workerId, expectedRevision: current.expansion.revisions.production } }))}>{t('managementV9.start')}</button>
          </article>;
        })}
      </div>
    </section>
    <section className="management-v9-panel" aria-labelledby={`${id}-research`}>
      <h2 id={`${id}-research`}>{t('managementV9.research')}</h2>
      <h3>{t('sectV9.research.basicMedicine')}</h3>
      <p>{costs(MANAGEMENT_RESEARCH_V9.costs)}</p><p>{t('managementV9.workTicks', { ticks: MANAGEMENT_RESEARCH_V9.workTicks })}</p>
      <p className="management-v9-help">{t('managementV9.researchHint')}</p>
      {snapshot.expansion.completedResearch.some(row => row.researchId === MANAGEMENT_RESEARCH_V9.id) ? <p>{t('managementV9.researched')}</p> : <>
        {!snapshot.expansion.buildings.some(row => row.definitionId === 'library.v9' && row.maintenance.operational) && <p className="management-v9-notice">{t('managementV9.reason.station')}</p>}
        <button disabled={startDisabled || !managementHasResourcesV9(snapshot, MANAGEMENT_RESEARCH_V9.costs) || !snapshot.expansion.buildings.some(row => row.definitionId === 'library.v9' && row.maintenance.operational) || snapshot.expansion.jobs.some(row => row.domain === 'research')}
          onClick={() => performStart('research', current => session.dispatchSect({ domain: 'research', command: { kind: 'research.start', researchId: 'basic-medicine.v9', workerId, expectedRevision: current.expansion.revisions.research } }))}>{t('managementV9.startResearch')}</button>
      </>}
      <h3 className="management-v9-subheading">{t('managementV9.blueprints')}</h3>
      {!snapshot.expansion.blueprints.length && <p className="management-v9-help">{t('managementV9.noBlueprints')}</p>}
      {snapshot.expansion.blueprints.map(blueprint => <article key={blueprint.blueprintId} className="management-v9-card">
        <h3>{t(blueprint.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')}</h3>
        <p>{t('managementV9.geometry', { x: blueprint.anchor.x, y: blueprint.anchor.y, rotation: blueprint.rotation, entranceX: blueprint.footprint.entrance.x, entranceY: blueprint.footprint.entrance.y })}</p>
        <p>{costs(SECT_V9_CANDIDATE.buildings.find(row => row.id === blueprint.definitionId)!.levels[0]!.costs)}</p>
        <p>{t(blueprint.status === 'planned' ? 'managementV9.blueprintPlanned' : 'managementV9.blueprintStarted')}</p>
        {blueprint.status === 'planned' && <div className="management-v9-actions">
          <button disabled={startDisabled} onClick={() => performStart('construction', current => session.dispatchSect({ domain: 'construction', command: { kind: 'construction.start', blueprintId: blueprint.blueprintId, workerId, expectedRevision: current.expansion.revisions.construction } }))}>{t('managementV9.startConstruction')}</button>
          <button className="secondary" disabled={!!blocked} onClick={() => perform('construction', current => session.dispatchSect({ domain: 'construction', command: { kind: 'construction.cancel', blueprintId: blueprint.blueprintId, expectedRevision: current.expansion.revisions.construction } }))}>{t('managementV9.cancelBlueprint')}</button>
        </div>}
      </article>)}
    </section>
    <section className="management-v9-panel" aria-labelledby={`${id}-care`}>
      <h2 id={`${id}-care`}>{t('managementV9.care')}</h2>
      <p className="management-v9-help">{t('managementV9.careHint')}</p>
      {selected ? <ManagementCarePatientV9 session={session} snapshot={snapshot} risk={risk} blocked={!!blocked}
        name={name(selected.discipleId)} costId={`${id}-care-cost`} t={t}
        onStartCare={() => perform('care', current => {
          if (current.cultivation.selected?.discipleId !== selected.discipleId || current.cultivation.selected.injury <= 0 || current.cultivation.selected.lifeState !== 'alive' || current.cultivation.selected.activityLocked || current.cultivation.selected.workOwner !== null) return { ok: false, kind: 'session-rejection', code: 'PREVIEW_STALE' };
          return session.dispatchSect({ domain: 'care', command: { kind: 'care.start', patientId: selected.discipleId, expectedRevision: current.expansion.revisions.care } });
        })} /> : <p>{t('managementV9.selectPatient')}</p>}
      {snapshot.expansion.recentTerminals.filter(row => row.domain === 'care' && row.beforeInjury !== null && row.afterInjury !== null).map(row => <p key={row.jobId} className="management-v9-success">{t('managementV9.careResult', { name: name(row.actorId), before: row.beforeInjury!, after: row.afterInjury! })}</p>)}
    </section>
    <section className="management-v9-panel" aria-labelledby={`${id}-jobs`}>
      <h2 id={`${id}-jobs`}>{t('managementV9.jobs')}</h2>
      <p className="management-v9-help">{t('managementV9.cancelHint')}</p>
      {snapshot.frame.transactions.filter(job => job.state !== 'Committed' && job.state !== 'Cancelled').map(job => <article key={job.transactionId} className="management-v9-card">
        <h3>{managementContentTextV9(STARTER_RECIPES[job.recipeId]?.nameKey ?? '', t)} · {name(job.workerId)}</h3>
        <p>{t(managementPhaseKeyV9(job.phase))}</p><p>{t('managementV9.owner', { id: job.transactionId })}</p>
        <progress value={job.activeTicks} max={job.requiredTicks} aria-label={t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })} />
        <p>{t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })}</p>
        {job.blockedReason && <p className="management-v9-notice">{showReason(job.blockedReason)}</p>}
        <button className="secondary" disabled={!!blocked} onClick={() => perform(undefined, () => session.dispatch({ kind: 'production.cancel', payload: { transactionId: job.transactionId } }))}>{t('managementV9.cancelJob')}</button>
      </article>)}
      {snapshot.expansion.jobs.map(job => <article key={job.jobId} className="management-v9-card">
        <h3>{jobName(job)} · {name(job.domain === 'care' ? job.patientId : job.workerId)}</h3>
        <p>{t(managementPhaseKeyV9(job.phase))}</p><p>{t('managementV9.owner', { id: job.jobId })}</p>
        <progress value={job.activeTicks} max={job.requiredTicks} aria-label={t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })} />
        <p>{t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })}</p>
        {job.blocked && <p className="management-v9-notice">{showReason(job.blocked)}</p>}
        <button className="secondary" disabled={!!blocked} onClick={() => cancelJob(job)}>{t('managementV9.cancelJob')}</button>
      </article>)}
      {!snapshot.expansion.jobs.length && !snapshot.frame.transactions.some(job => job.state !== 'Committed' && job.state !== 'Cancelled') && <p>{t('managementV9.noJobs')}</p>}
    </section>
    <section className="management-v9-panel" aria-labelledby={`${id}-maintenance`}>
      <h2 id={`${id}-maintenance`}>{t('managementV9.maintenance')}</h2><p className="management-v9-help">{t('managementV9.maintenanceHint')}</p>
      {snapshot.expansion.buildings.map(building => <article key={building.buildingId} className="management-v9-card">
        <h3>{t(building.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')} · {t('managementV9.level', { level: building.level })}</h3>
        <p>{t(building.maintenance.operational ? 'managementV9.operational' : 'managementV9.suspended')}</p>
        <p>{t('managementV9.maintenanceDue', { tick: building.maintenance.dueCalendarTick, remaining: Math.max(0, building.maintenance.dueCalendarTick - snapshot.frame.clock.calendarTick) })}</p>
        <p>{t('managementV9.maintenanceCost', { cost: costs(SECT_V9_CANDIDATE.buildings.find(row => row.id === building.definitionId)!.levels.find(row => row.level === building.level)!.maintenance.costs) })}</p>
        {!!building.maintenance.deficits.length && <p className="management-v9-notice">{t('managementV9.deficit', { cost: costs(building.maintenance.deficits) })}</p>}
        {building.maintenance.renewalBlock && <p className="management-v9-notice">{showReason(building.maintenance.renewalBlock)}</p>}
      </article>)}
      {!snapshot.expansion.buildings.length && <p>{t('managementV9.noBuildings')}</p>}
    </section>
  </div>;
}
