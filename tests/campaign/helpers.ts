import { combatCatalog } from '../../src/content/definitions';
import { acknowledgeCampaignClaim, campaignRoute, createCampaignState, prepareCampaignClaim, recordCampaignVictory } from '../../src/core/campaign';
import type { CampaignClaimAcknowledgement, CampaignClaimPlan, CampaignClaimRequest, CampaignContext, CampaignRouteId, CampaignState, Immutable } from '../../src/core/campaign';
import { createExpedition } from '../../src/core/expeditions';
import { copy } from '../../src/core/campaign/shared';
import { fallback, finishReturn, options, winEncounter } from '../expeditions/fixtures';

export const catalog = combatCatalog;
export function settled(routeId: CampaignRouteId = 'route.qingfeng-trial', runId = `campaign-${routeId}`) {
  let run = createExpedition(options({ runId, route: copy(campaignRoute(routeId)!.specification) }), catalog);
  for (let index = 0; index < run.route.length; index++) {
    run = winEncounter(run); if (run.phase === 'RewardPending') run = fallback(run);
  }
  return finishReturn(run);
}
export function clear(state: CampaignState, routeId: CampaignRouteId = 'route.qingfeng-trial') {
  const result = recordCampaignVictory(state, routeId, settled(routeId), catalog);
  if (!result.ok) throw new Error(result.code); return result.state;
}
export function cleared() { return clear(createCampaignState()); }
export function context(): CampaignContext {
  return { revision: 12, calendarMonth: 250, activeExpedition: false, terminalLossId: null, archivedDiscipleIds: [],
    disciples: [
      { discipleId: 'entity:1', school: 'sword', lifeState: 'alive', deathId: null, available: true, learnedSkillIds: ['skill.liuhen-jian', 'skill.guifeng', 'skill.jianxin'] },
      { discipleId: 'entity:2', school: 'body', lifeState: 'alive', deathId: null, available: true, learnedSkillIds: ['skill.baoyue', 'skill.zhenbu', 'skill.xujin'] },
      { discipleId: 'entity:3', school: 'alchemy', lifeState: 'alive', deathId: null, available: true, learnedSkillIds: ['skill.qingwu', 'skill.huichun', 'skill.yaoli'] },
      { discipleId: 'entity:4', school: 'talisman', lifeState: 'alive', deathId: null, available: true, learnedSkillIds: ['skill.yinlei', 'skill.fenzhang', 'skill.fumai'] },
    ], availableResources: [{ resourceId: 'meal', quantity: 12 }, { resourceId: 'herbs', quantity: 12 }, { resourceId: 'stone', quantity: 12 }] };
}
export function lostContext(): CampaignContext {
  const value = context(); value.terminalLossId = 'death:4';
  value.disciples = value.disciples.map((disciple, index) => ({ ...disciple, lifeState: 'dead', deathId: `death:${index + 1}`, available: false }));
  value.availableResources = []; return value;
}
export function plan(state: CampaignState, request: CampaignClaimRequest, world = context()) {
  const result = prepareCampaignClaim(state, request, world); if (!result.ok) throw new Error(result.code); return result.plan;
}
export function ack(prepared: Immutable<CampaignClaimPlan>, transactionId = `transaction:${prepared.expectedRevision + 1}`): CampaignClaimAcknowledgement {
  return { kind: 'campaignEffectsCommitted', claimId: prepared.claimId, planHash: prepared.planHash, transactionId,
    acquisitionIds: prepared.grants.map(grant => grant.acquisitionId) };
}
export function claim(state: CampaignState, request: CampaignClaimRequest, world = context()) {
  const prepared = plan(state, request, world); const result = acknowledgeCampaignClaim(state, prepared, world, ack(prepared));
  if (!result.ok) throw new Error(result.code); return result.state;
}
