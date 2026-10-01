import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createWorld } from '../../src/core/kernel';
import { createWorldV8, migrateWorldV7ToV8 } from '../../src/core/kernel/v8';
import type { WorldState } from '../../src/core/world/types';
import { campaignViewModel, submitCampaignViewCommand, type CampaignViewSource } from '../../src/app/CampaignViews';
import { buildDefinitionName } from '../../src/app/BuildPanel';
import { translate, SAFE_TRANSLATION_MESSAGE } from '../../src/i18n/translate';
import type { Locale, TextKey } from '../../src/i18n';

function source(session: ApplicationSession, locale: Locale = 'zh-CN'): CampaignViewSource {
  const snapshot = session.getSnapshot(); const context = session.getBuildContentContext(); const content = session.getWorldContent();
  return { projection: session.getCampaignProjection()!, content, resources: snapshot.resources,
    buildingNameKeys: snapshot.buildings.map(building => building.nameKey), deceasedIds: [], retainedEquipment: session.getBuildFrame().builds.equipment,
    nameFor: id => translate(locale, (session.getDiscipleNameKey(id) ?? 'campaign.view.unknownDisciple') as TextKey),
    equipmentName: id => buildDefinitionName(locale, id, content.combat, context), preview: request => session.prepareCampaign(request)?.preview ?? null,
    t: (key, parameters) => translate(locale, key as TextKey, parameters) };
}
function earnedSession() {
  const fixture = JSON.parse(readFileSync(new URL('../integration/fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: WorldState };
  return new ApplicationSession(migrateWorldV7ToV8(fixture.payload));
}
const request = { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' } as const;

describe('campaign projection presentation', () => {
  it('keeps legacy Sessions outside the campaign surface and defaults unchanged', () => {
    expect(new ApplicationSession(createWorld('legacy-view')).getCampaignProjection()).toBeNull();
    expect(new ApplicationSession().getEngineVersion()).toBe(7);
  });

  it('uses the registered five routes, exact first-clear reward names and prerequisites without changing authority', () => {
    const session = new ApplicationSession(createWorldV8('campaign-view')); const before = session.exportWorld(); const input = source(session);
    const model = campaignViewModel(input);
    expect(model.routes).toHaveLength(5);
    expect(model.routes.map(route => route.routeId)).toEqual(input.content.campaign!.routes.map(route => route.id));
    expect(model.routes[0]!.state).toBe('available'); expect(model.routes[1]!.state).toBe('locked');
    expect(model.routes[1]!.prerequisiteNameKeys).toEqual([model.routes[0]!.nameKey]);
    for (const route of model.routes) for (const key of [route.nameKey, route.descriptionKey, route.counterplayKey, ...route.rewardNameKeys]) {
      expect(model.labels[key] ?? input.t(key)).not.toBe(SAFE_TRANSLATION_MESSAGE);
    }
    expect(model.growth.equipment).toEqual([]); expect(model.growth.invitations).toEqual([]);
    expect(session.exportWorld()).toEqual(before);
    expect(model).not.toHaveProperty('history'); expect(model).not.toHaveProperty('world');
  });

  it('filters each actual claim target through the exact authoritative preview', () => {
    const session = earnedSession(); const input = source(session); const model = campaignViewModel(input);
    expect(model.growth.equipment.length).toBeGreaterThan(0);
    for (const claim of model.growth.equipment) {
      const expected = input.projection.recipients.filter(recipient => !session.prepareCampaign({ kind: 'campaign.equipment.claim', routeId: claim.routeId, discipleId: recipient.discipleId })!.preview.blockers.length);
      expect(claim.eligibleDisciples.map(member => member.discipleId)).toEqual(expected.map(member => member.discipleId));
    }
    for (const lesson of model.growth.manuals) for (const member of lesson.eligibleStudents) {
      expect(session.prepareCampaign({ kind: 'campaign.lesson.learn', knowledgeId: lesson.knowledgeId, discipleId: member.discipleId })!.preview.blockers).toEqual([]);
    }
  });

  it('uses request preview recovery profiles and grants verbatim, never picks arbitrary catalog recruits', () => {
    const session = new ApplicationSession(createWorldV8('recovery-display')); const input = source(session);
    // Presentation seam: distinct granted profiles prove the adapter does not slice the general catalog.
    const profiles = [input.projection.recruitProfiles[3]!, input.projection.recruitProfiles[1]!];
    const model = campaignViewModel({ ...input, deceasedIds: ['entity:1', 'entity:2'], preview: action => action.kind === 'campaign.recover'
      ? { request: action, basisStamp: 'preview', costs: [], blockers: [], recruitProfiles: profiles, grantedResources: [{ resourceId: 'meal', quantity: 17 }] }
      : input.preview(action) });
    const recovery = model.growth.recovery!;
    expect(recovery.losses).toHaveLength(2);
    expect(recovery.losses.every(line => line.key === 'campaign.view.finalizedDeath')).toBe(true);
    expect(recovery.grants.map(line => line.parameters?.name)).toEqual([...profiles.map(profile => input.t(profile.nameKey)), input.t('resource.meal')]);
    expect(recovery.grants.at(-1)!.parameters?.quantity).toBe(17);
    expect(recovery.retained.filter(line => line.key === 'campaign.view.retainedBuilding')).toHaveLength(input.buildingNameKeys.length);
    expect(recovery.retained.filter(line => line.key === 'campaign.view.retainedEquipment')).toHaveLength(input.retainedEquipment.length);
    expect(recovery.retained.filter(line => line.key === 'campaign.view.retainedResource').map(line => line.parameters?.quantity)).toEqual(input.resources.map(resource => resource.owned));
  });

  it.each(['zh-CN', 'en'] as const)('renders every recovery and relief line in %s', locale => {
    const session = new ApplicationSession(createWorldV8('localized-campaign')); const input = source(session, locale);
    const model = campaignViewModel({ ...input, deceasedIds: ['entity:1'] });
    const lines = [...model.growth.recovery!.losses, ...model.growth.recovery!.retained, ...model.growth.recovery!.grants, ...model.growth.relief!.conditions];
    for (const line of lines) expect(input.t(line.key, line.parameters)).not.toBe(SAFE_TRANSLATION_MESSAGE);
    expect(input.t(model.growth.relief!.blockedReason!.key)).not.toBe(SAFE_TRANSLATION_MESSAGE);
  });
});

describe('campaign App dispatch boundary', () => {
  it.each(['busy', 'readOnly', 'modal', 'epoch', 'basis'] as const)('rejects fresh %s state before preparing or allocating IDs', blockedBy => {
    const session = earnedSession(); const before = session.exportWorld(); const prepare = vi.spyOn(session, 'prepareCampaign');
    const guard = { sessionEpoch: session.getSnapshot().sessionEpoch + (blockedBy === 'epoch' ? 1 : 0), basisStamp: blockedBy === 'basis' ? 'stale' : session.getCampaignProjection()!.basisStamp };
    const result = submitCampaignViewCommand(session, () => ({ busy: blockedBy === 'busy', readOnly: blockedBy === 'readOnly' }), () => blockedBy === 'modal', request, guard);
    expect(result.ok).toBe(false); expect(prepare).not.toHaveBeenCalled(); expect(session.exportWorld()).toEqual(before);
  });

  it('prepares and commits the selected request and rejects a second stale frame', () => {
    const session = earnedSession(); const guard = { sessionEpoch: session.getSnapshot().sessionEpoch, basisStamp: session.getCampaignProjection()!.basisStamp };
    const prepare = vi.spyOn(session, 'prepareCampaign'); const confirm = vi.spyOn(session, 'confirmCampaign');
    expect(submitCampaignViewCommand(session, () => ({ busy: false, readOnly: false }), () => false, request, guard).ok).toBe(true);
    expect(prepare).toHaveBeenCalledWith(request); expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0].basisStamp).toBe(guard.basisStamp);
    expect(confirm.mock.calls[0]![0].preview.basisStamp).not.toBe(guard.basisStamp);
    const after = session.exportWorld();
    expect(submitCampaignViewCommand(session, () => ({ busy: false, readOnly: false }), () => false, request, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(after); expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('rechecks storage after prepare and never confirms a newly busy save', () => {
    const session = earnedSession(); const before = session.exportWorld(); const confirm = vi.spyOn(session, 'confirmCampaign'); let reads = 0;
    const guard = { sessionEpoch: session.getSnapshot().sessionEpoch, basisStamp: session.getCampaignProjection()!.basisStamp };
    const result = submitCampaignViewCommand(session, () => ({ busy: ++reads > 1, readOnly: false }), () => false, request, guard);
    expect(result.ok).toBe(false); expect(confirm).not.toHaveBeenCalled(); expect(session.exportWorld()).toEqual(before);
  });
});
