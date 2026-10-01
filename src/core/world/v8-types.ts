import type { GameContentIdentity } from '../../content/registry';
import type { BuildDataV2 } from '../builds/v2-types';
import type { CultivationState } from '../cultivation/v3/types';
import type { CampaignRouteId } from '../campaign/types';
import type { RegisteredExpedition } from '../expeditions/versioned';
import type { WorldExpeditionState, WorldRunHistory } from '../expeditions/world-types';
import type { WorldCampaignState, WorldLegacyState } from './campaign-state';
import type { Disciple, WorldStateBase } from './types';
export type PersistentPresentationId = 'disciple-0' | 'disciple-1' | 'disciple-2' | 'disciple-3';
export interface WorldDiscipleV8 extends Disciple { presentationId: PersistentPresentationId }
export interface WorldRunHistoryV8 extends WorldRunHistory {
  routeId: CampaignRouteId; contentIdentity: GameContentIdentity; protocol: RegisteredExpedition['protocol'];
}
export interface WorldExpeditionStateV8 extends Omit<WorldExpeditionState, 'schemaVersion' | 'run' | 'history'> {
  schemaVersion: 2;
  run: RegisteredExpedition['run'] | null;
  contentIdentity: GameContentIdentity | null;
  protocol: RegisteredExpedition['protocol'] | null;
  routeId: CampaignRouteId | null;
  history: WorldRunHistoryV8[];
}
export interface WorldStateV8 extends WorldStateBase<WorldDiscipleV8> {
  contentIdentity: GameContentIdentity;
  cultivation: CultivationState;
  builds: BuildDataV2;
  expedition: WorldExpeditionStateV8;
  campaign: WorldCampaignState;
  legacy: WorldLegacyState;
}
