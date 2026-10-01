import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../content/registry';
import { resolveBuildContentContext } from '../../content/registry/build-context';
import { upgradeLegacyBuildFrameV1 } from '../builds/v2';
import { upgradeCultivationFrameV2 } from '../cultivation/v3';
import { createCampaignStateV2, recordCampaignVictoryV2 } from '../campaign/v2';
import { pinLegacyExpedition } from '../expeditions/versioned';
import { cloneWorldWithSharedHistory } from '../world/history-access';
import type { WorldState } from '../world/types';
import type { LegacyWorldStateV7 } from '../world/legacy-types';
import type { PersistentPresentationId, WorldStateV8 } from '../world/v8-types';
import type { WorldCampaignState, WorldEstateRecord } from '../world/campaign-state';
import { cloneJson, stableHash } from './serialization';
import { copy } from '../expeditions/shared';

/** The caller has verified the original envelope checksum and frozen v7 World schema.
 * Structural conversion allocates no ID and preserves all old RNG, source receipts and active run internals. */
export function migrateWorldV7ToV8(value: unknown): WorldStateV8 {
  const input = value as LegacyWorldStateV7;
  if (input.simulationVersion !== '0.7.0' || input.contentVersion !== LEGACY_V7_CONTENT.worldContentVersion
    || ['contentIdentity', 'campaign', 'legacy'].some(key => Object.hasOwn(input, key))) throw new TypeError('Unexpected legacy World identity');
  const source = cloneWorldWithSharedHistory(input as WorldState) as LegacyWorldStateV7;
  const identity = contentIdentity(RELEASE_V8_CANDIDATE);
  const context = resolveBuildContentContext(identity, { allowCandidate: true });
  if (!context) throw new TypeError('Unregistered current build context');
  const builds = upgradeLegacyBuildFrameV1({ builds: source.builds, sequences: source.sequences }, context);
  const cultivation = upgradeCultivationFrameV2({ cultivation: source.cultivation, inventory: source.inventory,
    randomStreams: source.randomStreams, sequences: source.sequences });
  const registered = source.expedition.run ? pinLegacyExpedition(source.expedition.run) : null;
  const legacyIdentity = contentIdentity(LEGACY_V7_CONTENT);
  const campaign: WorldCampaignState = { schemaVersion: 2, progress: copy(createCampaignStateV2('standard')), clearEvidence: [], settledRunEvidence: [] };
  if (registered?.run.phase === 'Ended' && registered.run.settlement?.reason === 'victory' && registered.run.settlement.committed) {
    const imported = recordCampaignVictoryV2(campaign.progress, 'route.qingfeng-trial', registered.run, LEGACY_V7_CONTENT.combat);
    if (!imported.ok) throw new TypeError(`Legacy clear evidence rejected: ${imported.code}`);
    campaign.progress = copy(imported.state); campaign.clearEvidence.push({ routeId: 'route.qingfeng-trial', runId: registered.run.runId }); campaign.settledRunEvidence.push(registered);
  }
  const estates: WorldEstateRecord[] = cultivation.cultivation.deaths.map(death => ({
    estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId: death.discipleId, beneficiaryId: death.beneficiaryId,
    itemInstanceIds: builds.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === death.discipleId).map(item => item.instanceId),
    pendingRunId: cultivation.cultivation.disciples.find(member => member.discipleId === death.discipleId)?.activityOwner?.runId ?? null,
    transferCommandIds: [], recordedMonth: death.month, settledMonth: null, settledOwner: null,
  }));
  return { ...source, simulationVersion: '0.8.0', contentVersion: RELEASE_V8_CANDIDATE.worldContentVersion,
    contentIdentity: cloneJson(identity), disciples: source.disciples.map((disciple, index) => ({ ...disciple,
      presentationId: `disciple-${index % 4}` as PersistentPresentationId })),
    builds: copy(builds.builds), cultivation: cultivation.cultivation, campaign,
    legacy: { schemaVersion: 1, archivedIdentities: [], estates, migrationLifecycle: { kind: 'legacy-v7',
      sourceBuildBoundaryHash: stableHash(builds.builds.migration), sourceCultivationRevision: source.cultivation.revision, sourceCalendarMonth: source.cultivation.calendarMonth,
      receiptCount: source.cultivation.receipts.length, eventCount: source.cultivation.events.length, deathCount: source.cultivation.deaths.length,
      prefixHash: stableHash({ receipts: source.cultivation.receipts, events: source.cultivation.events, deaths: source.cultivation.deaths, pendingDeaths: source.cultivation.pendingDeaths }),
      finalizedDeaths: source.cultivation.deaths.map(({ deathId, discipleId, cause, month }) => ({ deathId, discipleId, cause, month })), pendingDeaths: copy(source.cultivation.pendingDeaths) } },
    expedition: { ...source.expedition, schemaVersion: 2, run: registered?.run ?? null,
      contentIdentity: registered ? cloneJson(registered.identity) : null, protocol: registered?.protocol ?? null,
      routeId: registered ? 'route.qingfeng-trial' : null,
      history: source.expedition.history.map(history => ({ ...history, routeId: 'route.qingfeng-trial',
        contentIdentity: cloneJson(legacyIdentity), protocol: 'legacy-v2' })) },
  };
}
