import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createWorldV8 } from '../../src/core/kernel/v8';
import { createWorld } from '../../src/core/world/create-world';
import { expeditionDepartureRequest, departureFormMatches } from '../../src/app/ExpeditionPanel';
import { CAMPAIGN_ROUTE_IDS } from '../../src/core/campaign/types';

describe('selected campaign route preparation', () => {
  it('uses each real selected route without replacing it with the starter route', () => {
    for (const routeId of CAMPAIGN_ROUTE_IDS) {
      const request = expeditionDepartureRequest(['entity:1', 'entity:2'], '6', routeId);
      expect(request).toEqual({ routeId, squadIds: ['entity:1', 'entity:2'], supplies: [{ resourceId: 'meal', quantity: 6 }] });
    }
    expect(expeditionDepartureRequest(['entity:1'], '')?.routeId).toBe('route.qingfeng-trial');
  });
  it('invalidates consent when route, roster, or supplies differ from the actual preview', () => {
    const session = new ApplicationSession(createWorldV8('route-consent'));
    const request = expeditionDepartureRequest(['entity:1', 'entity:2'], '6', 'route.qingfeng-trial')!;
    const before = JSON.stringify(session.exportWorld());
    const proposal = session.prepareExpedition(request);
    expect(departureFormMatches(proposal, request.squadIds, '6', 'route.qingfeng-trial')).toBe(true);
    expect(departureFormMatches(proposal, request.squadIds, '6', 'route.miasma-seal')).toBe(false);
    expect(departureFormMatches(proposal, ['entity:1'], '6', 'route.qingfeng-trial')).toBe(false);
    expect(departureFormMatches(proposal, request.squadIds, '', 'route.qingfeng-trial')).toBe(false);
    expect(JSON.stringify(session.exportWorld())).toBe(before);
  });
  it('keeps real route locks and legacy availability in the authoritative preview', () => {
    const current = new ApplicationSession(createWorldV8('route-locked'));
    const request = expeditionDepartureRequest(['entity:1', 'entity:2'], '', 'route.miasma-seal')!;
    const before = JSON.stringify(current.exportWorld());
    expect(current.prepareExpedition(request).preview.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(current.exportWorld())).toBe(before);
    const legacy = new ApplicationSession(createWorld('route-legacy'));
    expect(() => legacy.prepareExpedition(request)).toThrow('unavailable in a legacy campaign');
    expect(legacy.getEngineVersion()).toBe(7);
  });
});
