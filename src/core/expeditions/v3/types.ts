import type { ExpeditionData as LegacyData, ExpeditionReceipt, ExpeditionAdapterEffect, ExpeditionError, Immutable, ExpeditionCatalog } from '../types';
import type { GameContentIdentity } from '../../../content/registry';
import type { ExpeditionEncounterDefinition } from '../encounter-catalog';
export * from '../types';
export interface ExpeditionData extends Omit<LegacyData, 'schemaVersion' | 'simulationVersion'> {
  schemaVersion: 3; simulationVersion: 'expedition-3'; identity: GameContentIdentity;
}
export type ExpeditionState = Immutable<ExpeditionData>;
export type ExpeditionTransition =
  | { ok: true; state: ExpeditionState; receipt: Immutable<ExpeditionReceipt>; effects: Immutable<ExpeditionAdapterEffect[]>; replayed: boolean }
  | { ok: false; state: ExpeditionState; code: ExpeditionError };
export interface ReleaseExpeditionContext {
  identity: Readonly<GameContentIdentity>; catalog: ExpeditionCatalog;
  encounters: readonly Immutable<ExpeditionEncounterDefinition>[];
  expeditionProtocol: 'expedition-3'; admissionProtocol: 'release-eligibility-candidate.1';
}
