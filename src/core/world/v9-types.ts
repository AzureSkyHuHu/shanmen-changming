import type { GameContentIdentity } from '../../content/registry';
import type { BuildDataV2 } from '../builds/v2-types';
import type { CultivationState } from '../cultivation/v3';
import type { SectExpansionOwnedRecordsV9 } from '../sect-expansion/care-types';
import type { WorldCampaignState, WorldLegacyState } from './campaign-state';
import type { V9CultivationClockRecords } from './v9-cultivation-clock-types';
import type { WorldStateBase } from './types';
import type { WorldDiscipleV8, WorldExpeditionStateV8 } from './v8-types';

/** Executable internal management prototype, NOT a registered save format. No codec,
 * application engine, migration or expedition admission may publish this as a save. */
export interface WorldStateV9 extends WorldStateBase<WorldDiscipleV8> {
  simulationVersion: '0.9.0';
  runtimeProtocol: 'fresh-management-v9-unregistered.3';
  contentIdentity: GameContentIdentity;
  cultivation: CultivationState;
  cultivationClock: V9CultivationClockRecords;
  builds: BuildDataV2;
  /** Kept empty by this version's admission. No v8 exit certificate is borrowed. */
  expedition: WorldExpeditionStateV8;
  campaign: WorldCampaignState;
  legacy: WorldLegacyState;
  sectExpansion: SectExpansionOwnedRecordsV9;
}
