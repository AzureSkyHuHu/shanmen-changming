import { useId, useRef, useState } from 'react';
import type { CampaignRouteId } from '../core/campaign/types';
import './campaign-route-map.css';

export interface CampaignRouteView {
  readonly routeId: CampaignRouteId;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly counterplayKey: string;
  readonly state: 'locked' | 'available' | 'cleared';
  readonly prerequisiteNameKeys: readonly string[];
  readonly rewardNameKeys: readonly string[];
  readonly final: boolean;
}
export interface CampaignRouteGuard { readonly sessionEpoch: number; readonly basisStamp: string }
export interface CampaignRouteMapProps {
  readonly sessionEpoch: number;
  readonly basisStamp: string;
  readonly routes: readonly CampaignRouteView[];
  readonly completed: boolean;
  readonly activeRun: boolean;
  readonly readOnly: boolean;
  readonly t: (key: string, parameters?: Record<string, string | number>) => string;
  /** Selection only; the existing departure preview still owns supply/risk confirmation. */
  readonly onPrepare: (routeId: CampaignRouteId, guard: CampaignRouteGuard) => { ok: boolean };
}
export function canPrepareCampaignRoute(props: CampaignRouteMapProps, routeId: CampaignRouteId, guard: CampaignRouteGuard): boolean {
  const route = props.routes.find(entry => entry.routeId === routeId);
  return !props.readOnly && !props.activeRun && !!route && route.state !== 'locked'
    && guard.sessionEpoch === props.sessionEpoch && guard.basisStamp === props.basisStamp;
}
/** Detached route-selection handler: stale campaign frames can never begin preparation. */
export function prepareCampaignRoute(props: CampaignRouteMapProps, routeId: CampaignRouteId, guard: CampaignRouteGuard): { ok: boolean } {
  if (!canPrepareCampaignRoute(props, routeId, guard)) return { ok: false };
  try { return props.onPrepare(routeId, { ...guard }); }
  catch { return { ok: false }; }
}

/** This separate planning screen does not cover the battle canvas or advance simulation. */
export function CampaignRouteMap(props: CampaignRouteMapProps) {
  const { t, routes } = props;
  const prefix = useId(); const latest = useRef(props); latest.current = props;
  const [chosen, setChosen] = useState<CampaignRouteId | null>(null);
  const [failed, setFailed] = useState(false);
  const selected = routes.find(route => route.routeId === chosen) ?? routes.find(route => route.state === 'available') ?? routes[0];
  const guard = { sessionEpoch: props.sessionEpoch, basisStamp: props.basisStamp };
  const count = routes.filter(route => route.state === 'cleared').length;
  return <section className="campaign-scroll" aria-labelledby={`${prefix}-title`} onKeyDown={event => event.stopPropagation()}>
    <header className="campaign-scroll-header"><div><p className="section-eyebrow">{t('campaign.ui.eyebrow')}</p><h2 id={`${prefix}-title`}>{t('campaign.ui.title')}</h2></div>
      <span className="campaign-progress">{t('campaign.ui.progress', { current: count, total: routes.length })}</span></header>
    {props.completed && <p className="campaign-victory" role="status">{t('campaign.completed')}</p>}
    {props.activeRun && <p className="notice" role="status">{t('campaign.ui.activeRun')}</p>}
    {props.readOnly && <p className="notice">{t('campaign.ui.readOnly')}</p>}
    {!selected ? <p className="notice">{t('campaign.ui.unavailable')}</p> : <div className="campaign-map-layout">
      <nav className="campaign-route-path" aria-label={t('campaign.ui.routes')}><ol>{routes.map((route, index) => <li key={route.routeId} data-state={route.state}>
        <button className="campaign-route-node" aria-current={route.routeId === selected.routeId ? 'location' : undefined}
          aria-controls={`${prefix}-detail`} onClick={() => { setChosen(route.routeId); setFailed(false); }}>
          <span className="campaign-route-seal" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <span><strong>{t(route.nameKey)}</strong><small>{t(`campaign.ui.state.${route.state}`)}</small></span>
          {route.final && <span className="campaign-final-mark" aria-label={t('campaign.ui.finalRoute')}>✦</span>}
        </button></li>)}</ol></nav>
      <article className="campaign-route-detail" id={`${prefix}-detail`} aria-labelledby={`${prefix}-route-name`}>
        <div className="campaign-landscape" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/campaign/jade-mountain-route-v1.png`} alt="" loading="lazy" decoding="async" /></div>
        <div className="campaign-route-copy"><p className="section-eyebrow">{t(`campaign.ui.state.${selected.state}`)}</p><h3 id={`${prefix}-route-name`}>{t(selected.nameKey)}</h3>
          <p>{t(selected.descriptionKey)}</p>
          <h4>{t('campaign.ui.counterplay')}</h4><p className="campaign-counterplay">{t(selected.counterplayKey)}</p>
          {selected.state === 'locked' && <p className="notice">{t('campaign.ui.requirements', { routes: selected.prerequisiteNameKeys.map(key => t(key)).join(t('campaign.ui.separator')) })}</p>}
          <details className="campaign-rewards"><summary>{t('campaign.ui.firstClearRewards')}</summary>
            {selected.rewardNameKeys.length ? <ul>{selected.rewardNameKeys.map(key => <li key={key}>{t(key)}</li>)}</ul> : <p>{t('campaign.ui.finalReward')}</p>}
            <p className="footnote">{t('campaign.ui.rewardTiming')}</p></details>
          <button className="campaign-depart" disabled={!canPrepareCampaignRoute(props, selected.routeId, guard)} onClick={() => {
            const result = prepareCampaignRoute(latest.current, selected.routeId, guard); setFailed(!result.ok);
          }}>{t('campaign.ui.prepare')}</button>
          {failed && <p className="notice" role="status">{t('campaign.ui.stale')}</p>}
        </div>
      </article>
    </div>}
  </section>;
}
