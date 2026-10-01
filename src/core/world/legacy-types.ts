import type { WorldStateBase, Disciple } from './types';
import type { BuildData } from '../builds/types';
import type { CultivationState } from '../cultivation/types';
import type { ExpeditionState } from '../expeditions/types';
import type { WorldTravelCheckpoint, WorldEncounter, WorldExpeditionEffectReceipt, EncounterDeathMapping, WorldRunHistory, WorldExpeditionError } from '../expeditions/world-types';
export type LegacyDiscipleV7 = Omit<Disciple, 'presentationId'>;
export type LegacyWorldRunHistory = Omit<WorldRunHistory, 'routeId' | 'contentIdentity' | 'protocol'>;
export interface LegacyWorldExpeditionStateV1 {
  schemaVersion: 1; run: ExpeditionState | null; travel: WorldTravelCheckpoint | null; battle: WorldEncounter | null;
  effectReceipts: WorldExpeditionEffectReceipt[]; deathMappings: EncounterDeathMapping[]; history: LegacyWorldRunHistory[];
  forcedWithdrawal: boolean; blockedReason: WorldExpeditionError | null;
}
export interface LegacyWorldStateV7 extends WorldStateBase<LegacyDiscipleV7> {
  builds: BuildData; cultivation: CultivationState; expedition: LegacyWorldExpeditionStateV1; disciples: LegacyDiscipleV7[];
}
export type LegacyCultivationWorld = Omit<LegacyWorldStateV7, 'builds' | 'expedition' | 'sectEconomy' | 'history' | 'automaticProduction'>;
