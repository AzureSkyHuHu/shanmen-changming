import { useMemo } from 'react';
import type { ApplicationSession, DeepReadonly, SessionProjection } from '../application/session';
import type { GameContentBundle } from '../content/registry';
import type { CampaignPlayerRequest, WorldCampaignPreview, WorldCampaignProjection } from '../core/world/campaign-types';
import type { Immutable, CampaignRecruitDefinition } from '../core/campaign/types';
import type { ResourceLine } from '../core/kernel';
import { translate, type Locale, type TextKey } from '../i18n';
import { buildDefinitionName } from './BuildPanel';
import { CampaignRouteMap, type CampaignRouteView, type CampaignRouteGuard } from './CampaignRouteMap';
import { CampaignGrowthPanel, type CampaignGrowthPanelProps, type CampaignGrowthText, type CampaignGrowthRequest, type CampaignGrowthGuard, type CampaignGrowthResult } from './CampaignGrowthPanel';

type GrowthViews = Pick<CampaignGrowthPanelProps, 'equipment' | 'manuals' | 'invitations' | 'relief' | 'recovery' | 'estate'>;
export interface CampaignViewModel { readonly routes: readonly CampaignRouteView[]; readonly growth: GrowthViews; readonly labels: Readonly<Record<string, string>> }
export interface CampaignViewSource {
  readonly projection: DeepReadonly<WorldCampaignProjection>;
  readonly content: Immutable<GameContentBundle>;
  readonly resources: DeepReadonly<SessionProjection['resources']>;
  readonly buildingNameKeys: readonly string[];
  readonly deceasedIds: readonly string[];
  readonly retainedEquipment: readonly { readonly definitionId: string }[];
  readonly nameFor: (id: string) => string;
  readonly equipmentName: (id: string) => string;
  readonly preview: (request: CampaignPlayerRequest) => DeepReadonly<WorldCampaignPreview> | null;
  readonly t: CampaignGrowthPanelProps['t'];
}
/** Bounded presentation records only. No histories, random streams or prospective entity IDs. */
export function campaignViewModel(source: CampaignViewSource): CampaignViewModel {
  const { projection: p, content, t } = source;
  const catalog = content.campaign;
  if (!catalog) throw new TypeError('Campaign content is unavailable');
  const labels: Record<string, string> = {};
  const line = (key: string, parameters?: Record<string, string | number>): CampaignGrowthText => ({ key, ...(parameters ? { parameters } : {}) });
  const reason = (code: string | undefined) => code ? { blockedReason: line(`campaign.error.${code}`) } : {};
  const costs = (lines: readonly ResourceLine[]) => lines.map(cost => ({ ...cost, nameKey: `resource.${cost.resourceId}`, available: source.resources.find(resource => resource.resourceId === cost.resourceId)?.available ?? 0 }));
  const disciples = (ids: readonly string[]) => ids.map(discipleId => ({ discipleId, name: source.nameFor(discipleId) }));
  const eligible = (request: (id: string) => CampaignPlayerRequest) => disciples(p.recipients.filter(recipient => source.preview(request(recipient.discipleId))?.blockers.length === 0).map(recipient => recipient.discipleId));
  const schools = (profiles: readonly DeepReadonly<CampaignRecruitDefinition>[]) => profiles.map(profile => ({ school: profile.school, schoolNameKey: `buildView.school.${profile.school}`, nameKey: profile.nameKey, ageMonths: profile.ageMonths, lifespanMonths: profile.lifespanMonths, aptitude: profile.aptitude }));
  const equipmentKey = (id: string) => {
    const definition = content.buildRules.equipment.find(entry => entry.id === id);
    if (!definition) throw new TypeError('Unregistered campaign equipment');
    const metadata = definition as typeof definition & { nameKey?: string };
    if (metadata.nameKey) return metadata.nameKey;
    // Legacy equipment uses the existing registered build presentation adapter, never raw IDs.
    const key = `campaign.view.equipment.${id}`; labels[key] = source.equipmentName(id); return key;
  };
  const equipmentDescription = (id: string) => {
    const definition = content.buildRules.equipment.find(entry => entry.id === id) as { descriptionKey?: string } | undefined;
    return definition?.descriptionKey ?? 'campaign.view.equipmentDescription';
  };
  const routes: CampaignRouteView[] = p.routes.map(route => {
    const definition = catalog.routes.find(entry => entry.id === route.routeId);
    if (!definition) throw new TypeError('Unregistered campaign route');
    return { routeId: route.routeId, nameKey: route.nameKey, descriptionKey: route.descriptionKey, counterplayKey: route.counterplayKey,
      state: route.cleared ? 'cleared' : route.available ? 'available' : 'locked', final: route.final,
      prerequisiteNameKeys: route.prerequisites.map(id => { const prerequisite = catalog.routes.find(entry => entry.id === id); if (!prerequisite) throw new TypeError('Unregistered prerequisite'); return prerequisite.nameKey; }),
      rewardNameKeys: [...(definition.firstClear.equipmentId ? [equipmentKey(definition.firstClear.equipmentId)] : []), ...definition.firstClear.knowledgeIds.map(id => {
        const knowledge = catalog.knowledge.find(entry => entry.id === id); if (!knowledge) throw new TypeError('Unregistered knowledge'); return knowledge.nameKey;
      }), ...(definition.firstClear.recruitInvitation ? ['campaign.view.invitationReward'] : [])] };
  });
  const invitations = p.recruitInvitations.map(invitation => {
    const route = catalog.routes.find(entry => entry.id === invitation.routeId);
    if (!route) throw new TypeError('Unregistered invitation');
    const previews = p.recruitProfiles.map(profile => source.preview({ kind: 'campaign.recruit', routeId: invitation.routeId, school: profile.school }));
    const profiles = previews.flatMap(preview => preview?.blockers.length === 0 ? preview.recruitProfiles : []);
    return { routeId: invitation.routeId, routeNameKey: route.nameKey, costs: costs(invitation.costs), schools: schools(profiles),
      ...(!profiles.length ? reason(previews.find(preview => preview?.blockers.length)?.blockers[0] ?? 'DISCIPLE_UNAVAILABLE') : {}) };
  });
  const reliefPreviews = p.recruitProfiles.map(profile => source.preview({ kind: 'campaign.relief', school: profile.school }));
  const recovery = source.preview({ kind: 'campaign.recover', acknowledgeLoss: true });
  const retained: CampaignGrowthText[] = [line('campaign.view.retainedProgress', { count: p.routes.filter(route => route.cleared).length })];
  for (const nameKey of source.buildingNameKeys) retained.push(line('campaign.view.retainedBuilding', { name: t(nameKey) }));
  for (const resource of source.resources) retained.push(line('campaign.view.retainedResource', { name: t(`resource.${resource.resourceId}`), quantity: resource.owned }));
  for (const lesson of p.lessons) retained.push(line('campaign.view.retainedManual', { name: t(lesson.nameKey) }));
  for (const item of source.retainedEquipment) retained.push(line('campaign.view.retainedEquipment', { name: source.equipmentName(item.definitionId) }));
  return { routes, labels, growth: {
    equipment: p.equipmentClaims.map(claim => ({ routeId: claim.routeId, nameKey: claim.nameKey, descriptionKey: claim.descriptionKey,
      eligibleDisciples: eligible(discipleId => ({ kind: 'campaign.equipment.claim', routeId: claim.routeId, discipleId })) })),
    manuals: p.lessons.map(lesson => ({ knowledgeId: lesson.knowledgeId, nameKey: lesson.nameKey, descriptionKey: lesson.descriptionKey, costs: costs(lesson.costs),
      eligibleStudents: eligible(discipleId => ({ kind: 'campaign.lesson.learn', knowledgeId: lesson.knowledgeId, discipleId })), learnedBy: disciples(lesson.learnedDiscipleIds) })),
    invitations,
    relief: p.mode === 'standard' ? { costs: costs(p.relief.costs), schools: schools(reliefPreviews.flatMap(preview => preview?.blockers.length === 0 ? preview.recruitProfiles : [])),
      ...reason(p.relief.blockers[0]), conditions: [line('campaign.view.reliefConditions', { count: catalog.reliefPolicy.requiredLivingCount, months: catalog.reliefPolicy.cooldownMonths }),
        ...(p.relief.nextEligibleMonth === null ? [] : [line('campaign.view.reliefMonth', { month: p.relief.nextEligibleMonth })])] } : null,
    recovery: p.mode === 'standard' ? {
      ...reason(recovery?.blockers[0] ?? (recovery ? undefined : 'RECOVERY_UNAVAILABLE')),
      losses: source.deceasedIds.length ? [...new Set(source.deceasedIds)].map(id => line('campaign.view.finalizedDeath', { name: source.nameFor(id) })) : [line('campaign.view.noFinalizedDeaths')],
      retained,
      grants: [...(recovery?.recruitProfiles ?? []).map(profile => line('campaign.growth.recruits.profile', { name: t(profile.nameKey), ageYears: Math.floor(profile.ageMonths / 12), ageMonths: profile.ageMonths % 12,
        lifespanYears: Math.floor(profile.lifespanMonths / 12), lifespanMonths: profile.lifespanMonths % 12, aptitude: profile.aptitude })),
      ...(recovery?.grantedResources ?? []).map(resource => line('campaign.view.grantedResource', { name: t(`resource.${resource.resourceId}`), quantity: resource.quantity }))],
    } : null,
    estate: p.estateItems.filter(item => item.owner.kind === 'sect-estate').map(item => ({ itemInstanceId: item.itemInstanceId, nameKey: equipmentKey(item.definitionId), descriptionKey: equipmentDescription(item.definitionId),
      ...reason(item.pendingRelease ? 'ESTATE_UNAVAILABLE' : undefined), provenance: [line('campaign.view.estateOrigin', { name: source.nameFor(item.deceasedDiscipleId) })],
      eligibleDisciples: item.pendingRelease ? [] : eligible(discipleId => ({ kind: 'estate.assign', itemInstanceId: item.itemInstanceId, discipleId })) })),
  } };
}

export function CampaignViews({ session, world, projection, locale, view, readOnly, busy, onPrepare, onCommand }: {
  readonly session: ApplicationSession; readonly world: DeepReadonly<SessionProjection>; readonly projection: DeepReadonly<WorldCampaignProjection>;
  readonly locale: Locale; readonly view: 'routes' | 'growth'; readonly readOnly: boolean; readonly busy: boolean;
  readonly onPrepare: (routeId: CampaignRouteView['routeId'], guard: CampaignRouteGuard) => { ok: boolean };
  readonly onCommand: (request: CampaignGrowthRequest, guard: CampaignGrowthGuard) => CampaignGrowthResult;
}) {
  const model = useMemo(() => {
    const context = session.getBuildContentContext();
    const content = session.getWorldContent();
    if (!content?.campaign) return null;
    const frame = session.getBuildFrame();
    const t: CampaignGrowthPanelProps['t'] = (key, parameters) => translate(locale, key as TextKey, parameters);
    return campaignViewModel({ projection, content, resources: world.resources, buildingNameKeys: world.buildings.map(building => building.nameKey),
      deceasedIds: [...world.disciples.filter(disciple => disciple.lifeState === 'dead').map(disciple => disciple.id), ...(frame.builds.schemaVersion === 2 ? frame.builds.retiredDisciples.map(disciple => disciple.discipleId) : [])],
      retainedEquipment: frame.builds.equipment, nameFor: id => { const key = session.getDiscipleNameKey(id); return key ? t(key) : t('campaign.view.unknownDisciple'); },
      equipmentName: id => buildDefinitionName(locale, id, content.combat, context), preview: request => session.prepareCampaign(request)?.preview ?? null, t });
    // The Session projection identity changes with every relevant authoritative basis change.
    // Do not copy bounded presentation records again for selection changes or visual ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, projection, world.sessionEpoch, locale]);
  if (!model) return <p className="notice">{translate(locale, 'campaign.ui.unavailable')}</p>;
  const t: CampaignGrowthPanelProps['t'] = (key, parameters) => model.labels[key] ?? translate(locale, key as TextKey, parameters);
  const common = { sessionEpoch: world.sessionEpoch, basisStamp: projection.basisStamp, activeRun: projection.activeRun, readOnly, t };
  return view === 'routes' ? <CampaignRouteMap {...common} readOnly={readOnly || busy} routes={model.routes} completed={projection.completed} onPrepare={onPrepare} />
    : <CampaignGrowthPanel {...common} {...model.growth} busy={busy} managementActionsAvailable={projection.managementActionsAvailable} onCommand={onCommand} />;
}

/** Recheck external save/overlay gates at click time before preparing the exact request. */
export function submitCampaignViewCommand(
  session: Pick<ApplicationSession, 'getSnapshot' | 'getCampaignProjection' | 'prepareCampaign' | 'confirmCampaign'>,
  storage: () => { readonly busy: boolean; readonly readOnly: boolean }, blocked: () => boolean,
  request: CampaignGrowthRequest, guard: CampaignGrowthGuard,
): CampaignGrowthResult {
  const current = session.getCampaignProjection(); const snapshot = session.getSnapshot(); const save = storage();
  if (blocked() || save.busy || save.readOnly || snapshot.clock.pauseReasons.includes('error') || snapshot.sessionEpoch !== guard.sessionEpoch
    || !current || current.basisStamp !== guard.basisStamp) return { ok: false, code: 'STALE_OR_BLOCKED' };
  const proposal = session.prepareCampaign(request);
  if (!proposal || proposal.sessionEpoch !== guard.sessionEpoch || proposal.basisStamp !== guard.basisStamp) return { ok: false, code: 'PREVIEW_STALE' };
  if (proposal.preview.blockers.length) return { ok: false, code: proposal.preview.blockers[0]!, message: { key: `campaign.error.${proposal.preview.blockers[0]}` } };
  // A getter/observer may synchronously change a lease or open a modal while preparing.
  const latest = storage();
  if (blocked() || latest.busy || latest.readOnly) return { ok: false, code: 'STALE_OR_BLOCKED' };
  const result = session.confirmCampaign(proposal);
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}
