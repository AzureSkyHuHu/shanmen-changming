export * from './clock';
export * from './commands';
export * from './contracts';
export * from './ids';
export * from './numeric';
export * from './random';
export * from './save';
export * from './serialization';
export * from './simulation';
// Preserve the existing validation surface; the new captured-inspection factory
// and its handle type belong only to direct internal composition imports.
export { validateWorldState, validateLegacyWorldStateV1, validateLegacyWorldStateV2,
  validateLegacyWorldStateV3, validateLegacyWorldStateV4, validateLegacyWorldStateV5,
  validateLegacyWorldStateV6, validateLegacyWorldStateV7, validateWorldStateV8,
  inspectUnregisteredWorldV9Records, inspectUnregisteredWorldV10Records, isWorldState } from './validation';
export * from '../world/create-world';
export * from '../world/types';
export * from '../economy/types';
export * from '../economy/inventory';
export * from '../economy/production';
export * from '../economy/recipes';

export { cultivationFrame, previewWorldBreakthrough, dispatchWorldCultivation, hasCultivationDecision, isCultivationWorkerAvailable } from '../world/cultivation-bridge';

export { dispatchWorldBuild, reconcileWorldRealmMilestones } from '../world/build-bridge';
export type { WorldBuildResult } from '../world/build-bridge';

export { dispatchWorldSectEconomy, WORLD_AUTO_START_ALLOWANCE } from '../world/sect-economy-bridge';
export type { WorldSectEconomyResult } from '../world/sect-economy-bridge';

export { lookupProduction, lookupCommandReceipt, lookupEvent, recentWorldEvents, worldEventCursor, worldEventsSince, restoreWorldHistory, cloneWorldWithSharedHistory } from '../world/history-access';

export { lookupLiveProduction, classifyAutomaticHandle } from '../economy/automatic-production';
export type { AutomaticJobId, AutomaticProductionState, AutomaticProductionNotice, ProductionOrigin, ProductionWork } from '../economy/automatic-types';
export { previewWorldAutomaticWork } from '../world/automatic-work-bridge';
export { getWorldContent, getWorldRunContent, getWorldBuildContentContext, getWorldCombatCatalog,
  getWorldRunCombatCatalog, getWorldRunEncounter } from '../world/content-access';
export type { CampaignPlayerRequest, PlayerCampaignCommand, WorldCampaignProjection, WorldCampaignPreview,
  WorldCampaignResult, WorldCampaignError } from '../world/campaign-types';
