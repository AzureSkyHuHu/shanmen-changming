/** Explicit candidate engine. Existing v7 entrypoints keep their frozen behavior. */
export { createWorldV8, SIMULATION_VERSION_V8 } from '../world/create-world-v8';
export { dispatchCommandV8, enqueueCommandsV8 } from './commands-v8';
export { isCommandV8 } from './command-shape-v8';
export { advanceTicksV8, advanceTicksWithStatusV8, domainHashV8 } from './simulation-v8';
export type { AdvanceTicksResultV8 } from './simulation-v8';
export { createSaveEnvelopeV8, serializeSaveV8, parseSaveV8, SAVE_VERSION_V8 } from './save-v8';
export type { SaveEnvelopeV8, ParseSaveResultV8 } from './save-v8';
export { validateWorldStateV8 } from './validation';
export { migrateWorldV7ToV8 } from './migrate-v7';
export { previewWorldBreakthroughV8 } from '../world/cultivation-bridge-v8';
export { previewWorldExpeditionV8, projectWorldExpeditionV8, previewWorldEmergencyRetreatV8 } from '../expeditions/v8-world-adapter';
export { projectWorldCampaign, previewWorldCampaign } from '../world/campaign-queries';
export { previewWorldAutomaticWorkV8 } from '../world/automatic-work-bridge-v8';
export type { WorldStateV8 } from '../world/v8-types';
export type { CommandV8 } from './contracts-v8';
export type { PlayerExpeditionCommandV8, ExpeditionDepartureRequestV8, WorldExpeditionPreviewV8, WorldExpeditionProjectionV8, WorldEmergencyRetreatPreview } from '../expeditions/v8-world-types';
export type { CampaignPlayerRequest, PlayerCampaignCommand, WorldCampaignPreview, WorldCampaignProjection, WorldCampaignResult, WorldCampaignError } from '../world/campaign-types';
