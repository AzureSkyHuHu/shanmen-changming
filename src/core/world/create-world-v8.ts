import { contentIdentity, RELEASE_V8_CANDIDATE } from '../../content/registry';
import { resolveBuildContentContext } from '../../content/registry/build-context';
import { createBuildFrameV2 } from '../builds/v2';
import { createCampaignStateV2 } from '../campaign/v2';
import type { CampaignMode } from '../campaign/types';
import { createCultivationStateV3 } from '../cultivation/v3';
import { copy } from '../expeditions/shared';
import { createWorld } from './create-world';
import type { PersistentPresentationId, WorldStateV8 } from './v8-types';
export const SIMULATION_VERSION_V8 = '0.8.0';
/** Fresh seeded World only; this never upgrades or resets an existing campaign. */
export function createWorldV8(seed: string | number = 'shanmen-001', options: { mode?: CampaignMode } = {}): WorldStateV8 {
  const initial = createWorld(seed); const identity = contentIdentity(RELEASE_V8_CANDIDATE);
  const context = resolveBuildContentContext(identity, { allowCandidate: true });
  if (!context || !initial.builds.origin.sequences) throw new TypeError('Missing fresh versioned build context');
  // Reuse only the deterministic fresh map/roster bootstrap. No legacy history or
  // allocated legacy build branch is published; v2 starts from its original seed counters.
  const builds = createBuildFrameV2({ disciples: copy(initial.builds.origin.disciples), contentMode: 'experimental', sequences: copy(initial.builds.origin.sequences) }, context);
  return { ...initial, simulationVersion: SIMULATION_VERSION_V8, contentVersion: RELEASE_V8_CANDIDATE.worldContentVersion, contentIdentity: copy(identity),
    disciples: initial.disciples.map((actor, index) => ({ ...actor, presentationId: `disciple-${index % 4}` as PersistentPresentationId })),
    builds: copy(builds.builds), sequences: copy(builds.sequences), cultivation: createCultivationStateV3(initial.cultivation.disciples),
    expedition: { ...initial.expedition, schemaVersion: 2, contentIdentity: null, protocol: null, routeId: null, history: [] },
    campaign: { schemaVersion: 2, progress: copy(createCampaignStateV2(options.mode ?? 'standard')), clearEvidence: [], settledRunEvidence: [] },
    legacy: { schemaVersion: 1, archivedIdentities: [], estates: [], migrationLifecycle: null } };
}
