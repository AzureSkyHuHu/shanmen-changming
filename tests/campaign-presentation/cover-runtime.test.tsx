import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampaignRouteMap, type CampaignRouteMapProps } from '../../src/app/CampaignRouteMap';
import { translate, type TextKey } from '../../src/i18n';

const props: CampaignRouteMapProps = {
  sessionEpoch: 1, basisStamp: 'cover-runtime', completed: false, activeRun: false, readOnly: false,
  routes: [{
    routeId: 'route.qingfeng-trial', nameKey: 'campaign.route.qingfeng.name',
    descriptionKey: 'campaign.route.qingfeng.description', counterplayKey: 'campaign.route.qingfeng.counterplay',
    state: 'available', prerequisiteNameKeys: [], rewardNameKeys: ['campaign.equipment.trailRobe.name'], final: false,
  }],
  t: (key, values) => translate('zh-CN', key as TextKey, values),
  onPrepare: () => ({ ok: true }),
};

describe('campaign cover public runtime fallback', () => {
  it('renders an asset-free, accessibility-hidden decoration while retaining route information and navigation', () => {
    const html = renderToStaticMarkup(createElement(CampaignRouteMap, props));
    expect(html).toContain('<div class="campaign-landscape" aria-hidden="true"></div>');
    expect(html).not.toContain('<img');
    expect(html).toContain('行历山川');
    expect(html).toContain('青峰初试');
    expect(html).toContain('先准备四个月的行粮');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('class="campaign-depart"');
  });

  it('does not reference the excluded original in route presentation source or styles', () => {
    for (const filename of ['CampaignRouteMap.tsx', 'campaign-route-map.css']) {
      const source = readFileSync(new URL(`../../src/app/${filename}`, import.meta.url), 'utf8');
      expect(source).not.toContain('jade-mountain-route-v1.png');
      expect(source).not.toContain('assets/campaign/');
    }
  });

  it('keeps the jade decoration compact and independent of image loading', () => {
    const css = readFileSync(new URL('../../src/app/campaign-route-map.css', import.meta.url), 'utf8');
    const headerRule = css.match(/\.campaign-landscape\s*\{([^}]+)\}/)?.[1];
    expect(headerRule).toBeDefined();
    expect(headerRule).toContain('height: 64px');
    expect(headerRule).toContain('radial-gradient(');
    expect(headerRule).toContain('linear-gradient(');
    expect(css).toContain('.campaign-landscape { height: 48px; }');
    expect(css).not.toMatch(/url\s*\(/i);
    expect(css).not.toContain('.campaign-landscape img');
  });
});
