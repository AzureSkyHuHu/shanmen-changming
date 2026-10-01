import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CampaignRouteMap, canPrepareCampaignRoute, prepareCampaignRoute, type CampaignRouteMapProps } from '../../src/app/CampaignRouteMap';
import { translate, type TextKey } from '../../src/i18n';
function props(): CampaignRouteMapProps { return {
  sessionEpoch: 2, basisStamp: 'basis-a', completed: false, activeRun: false, readOnly: false,
  routes: [
    { routeId: 'route.qingfeng-trial', nameKey: 'campaign.route.qingfeng.name', descriptionKey: 'campaign.route.qingfeng.description', counterplayKey: 'campaign.route.qingfeng.counterplay', state: 'available', prerequisiteNameKeys: [], rewardNameKeys: ['campaign.equipment.trailRobe.name'], final: false },
    { routeId: 'route.miasma-seal', nameKey: 'campaign.route.miasma.name', descriptionKey: 'campaign.route.miasma.description', counterplayKey: 'campaign.route.miasma.counterplay', state: 'locked', prerequisiteNameKeys: ['campaign.route.qingfeng.name'], rewardNameKeys: ['campaign.equipment.apothecaryVessel.name'], final: false },
  ], t: (key, values) => translate('zh-CN', key as TextKey, values), onPrepare: () => ({ ok: true }),
}; }
const guard = { sessionEpoch: 2, basisStamp: 'basis-a' };
describe('campaign planning route map', () => {
  it('shows localized objectives, real route states and counterplay without claiming unearned rewards', () => {
    const html = renderToStaticMarkup(createElement(CampaignRouteMap, props()));
    expect(html).toContain('行历山川'); expect(html).toContain('青峰初试'); expect(html).toContain('尚未开启');
    expect(html).toContain('先准备四个月的行粮'); expect(html).toContain('真正胜利并完成返程后');
    expect(html).toContain('aria-current="location"'); expect(html).toContain('<details');
    expect(html).not.toContain('campaign.ui.'); expect(html).not.toContain('campaign.route.');
  });
  it.each(['readOnly', 'activeRun'] as const)('blocks preparing while %s but keeps route inspection visible', flag => {
    const value = { ...props(), [flag]: true, onPrepare: vi.fn(() => ({ ok: true })) };
    expect(prepareCampaignRoute(value, 'route.qingfeng-trial', guard)).toEqual({ ok: false });
    expect(value.onPrepare).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(CampaignRouteMap, value))).toContain('disabled');
  });
  it('rejects locked/unknown routes, stale campaign epochs and changes in the authority basis', () => {
    const value = { ...props(), onPrepare: vi.fn(() => ({ ok: true })) };
    expect(canPrepareCampaignRoute(value, 'route.miasma-seal', guard)).toBe(false);
    expect(canPrepareCampaignRoute(value, 'route.everbright-finale', guard)).toBe(false);
    expect(prepareCampaignRoute(value, 'route.qingfeng-trial', { ...guard, sessionEpoch: 1 }).ok).toBe(false);
    expect(prepareCampaignRoute(value, 'route.qingfeng-trial', { ...guard, basisStamp: 'old' }).ok).toBe(false);
    expect(value.onPrepare).not.toHaveBeenCalled();
    expect(prepareCampaignRoute(value, 'route.qingfeng-trial', guard).ok).toBe(true);
    expect(value.onPrepare).toHaveBeenCalledWith('route.qingfeng-trial', guard);
  });
  it('allows a cleared route to be replayed, displays English, and keeps completion distinct from route selection', () => {
    const value = props();
    const routes = value.routes.map(route => ({ ...route, state: 'cleared' as const }));
    const next = { ...value, routes, completed: true, t: (key: string, values?: Record<string, string | number>) => translate('en', key as TextKey, values) };
    const html = renderToStaticMarkup(createElement(CampaignRouteMap, next));
    expect(html).toContain('Beyond the Mountain'); expect(html).toContain('This campaign is complete');
    expect(html).toContain('Cleared'); expect(canPrepareCampaignRoute(next, 'route.miasma-seal', guard)).toBe(true);
  });
  it('has a safe empty-content state instead of an invented route', () => {
    const html = renderToStaticMarkup(createElement(CampaignRouteMap, { ...props(), routes: [] }));
    expect(html).toContain('当前内容版本未提供可用路线'); expect(html).not.toContain('campaign-depart');
  });
});
