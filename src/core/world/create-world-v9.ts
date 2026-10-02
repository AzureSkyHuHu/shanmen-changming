import { copy } from '../expeditions/shared';
import { MANAGEMENT_V9_CONTENT_VERSION, MANAGEMENT_V9_GENESIS, MANAGEMENT_V9_IDENTITY, managementV9BuildContext } from '../../content/sect-v9/world-content';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../content/sect-v9/catalog';
import { createBuildFrameV2 } from '../builds/v2';
import { createCampaignStateV2 } from '../campaign/v2';
import { createCultivationStateV3 } from '../cultivation/v3';
import { cloneJson } from '../kernel/serialization';
import { inspectUnregisteredWorldV9Records } from '../kernel/validation';
import { createWorld } from './create-world';
import { EMPTY_V9_EXPEDITION } from './v9-lifecycle-records';
import type { PersistentPresentationId } from './v8-types';
import type { WorldStateV9 } from './v9-types';

/** Fresh only, internal only. The old constructor supplies deterministic bootstrap map,
 * roster and RNG; no v8 World validator, v8 command engine or old save is adapted. */
export function createUnregisteredWorldV9(seed: string | number = 'shanmen-001'): WorldStateV9 {
  const initial = createWorld(seed);
  if (!initial.builds.origin.sequences) throw new TypeError('Missing fresh build origin');
  const builds = createBuildFrameV2({ disciples: cloneJson(initial.builds.origin.disciples), contentMode: 'experimental',
    sequences: cloneJson(initial.builds.origin.sequences) }, managementV9BuildContext(MANAGEMENT_V9_IDENTITY));
  const world: WorldStateV9 = { ...initial, simulationVersion: '0.9.0', runtimeProtocol: 'fresh-management-v9-unregistered.2',
    contentVersion: MANAGEMENT_V9_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V9_IDENTITY),
    disciples: initial.disciples.map((actor, index) => ({ ...actor, presentationId: `disciple-${index % 4}` as PersistentPresentationId })),
    builds: copy(builds.builds), sequences: cloneJson(builds.sequences), cultivation: createCultivationStateV3(initial.cultivation.disciples.map(profile => profile.discipleId === MANAGEMENT_V9_GENESIS.patientId ? { ...profile, injury: MANAGEMENT_V9_GENESIS.injury } : profile)),
    expedition: copy(EMPTY_V9_EXPEDITION), campaign: { schemaVersion: 2, progress: copy(createCampaignStateV2('standard')), clearEvidence: [], settledRunEvidence: [] },
    legacy: { schemaVersion: 1, archivedIdentities: [], estates: [], migrationLifecycle: null },
    sectExpansion: { schemaVersion: 1,
      construction: { schemaVersion: 1, catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY), revision: 0, nextId: 1, blueprints: [], jobs: [], buildings: [], receipts: [] },
      stock: { 'spirit-stone': { owned: 0, reserved: 0, capacity: 99 }, 'basic-insight': { owned: 0, reserved: 0, capacity: 99 }, 'wound-powder': { owned: 0, reserved: 0, capacity: 99 } },
      reservations: [], production: { revision: 0, nextId: 1, jobs: [], receipts: [] }, research: { revision: 0, nextId: 1, jobs: [], receipts: [] }, maintenance: { nextId: 1, payments: [] }, care: { revision: 0, nextId: 1, jobs: [], receipts: [] } } };
  const errors = inspectUnregisteredWorldV9Records(world); if (errors.length) throw new TypeError(`Invalid fresh v9 records: ${errors.join('; ')}`);
  return world;
}
