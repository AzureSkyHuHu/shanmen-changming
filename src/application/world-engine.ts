import { dispatchCommand } from '../core/kernel/commands';
import { advanceTicksWithStatus } from '../core/kernel/simulation';
import { dispatchCommandV8, advanceTicksWithStatusV8, previewWorldAutomaticWorkV8, type CommandV8 } from '../core/kernel/v8';
import { previewWorldAutomaticWork } from '../core/world/automatic-work-bridge';
import type { BreakthroughPreparation } from '../core/cultivation/types';
import type { CampaignPlayerRequest } from '../core/world/campaign-types';
import type { ExpeditionDepartureRequestV8 } from '../core/expeditions/v8-world-types';
import { previewWorldBreakthrough } from '../core/world/cultivation-bridge';
import { previewWorldBreakthroughV8 } from '../core/world/cultivation-bridge-v8';
import { previewWorldExpedition, projectWorldExpedition } from '../core/expeditions/world-adapter';
import { previewWorldExpeditionV8, projectWorldExpeditionV8 } from '../core/expeditions/v8-world-adapter';
import { STARTER_ROUTE_ID } from '../core/expeditions/encounter-catalog';
import { projectWorldCampaign, previewWorldCampaign } from '../core/world/campaign-queries';
import type { WorldState } from '../core/world/types';
import type { WorldStateV8 } from '../core/world/v8-types';
import type { BuildStateFrame } from '../core/builds';
import type { BuildStateFrameV2 } from '../core/builds/v2-types';
import { validateWorldState, validateWorldStateV8 } from '../core/kernel/validation';
import { cloneWorldWithSharedHistory } from '../core/world/history-access';
import { canonicalUtf8ByteLength } from '../core/save-budget/canonical-bytes';

export type SessionWorld = WorldState | WorldStateV8;
/** The discriminant belongs to this validated owner, not to an unchecked save header. */
export type OwnedSessionWorld = { readonly version: 7; readonly world: WorldState }
  | { readonly version: 8; readonly world: WorldStateV8 };
export type SessionBuildFrame = BuildStateFrame | BuildStateFrameV2;

function validV7(value: unknown): value is WorldState { return validateWorldState(value).length === 0; }
function validV8(value: unknown): value is WorldStateV8 { return validateWorldStateV8(value).length === 0; }
/** No migration, ID allocation, history truncation or stored-byte write occurs here. */
export function ownSessionWorld(value: unknown): OwnedSessionWorld {
  // Reject executable properties before either domain validator reads fields.
  canonicalUtf8ByteLength(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid session World');
  const version = Object.getOwnPropertyDescriptor(value, 'simulationVersion')?.value;
  if (version === '0.8.0') {
    if (!validV8(value)) throw new TypeError('Invalid version 8 session World');
    return { version: 8, world: cloneWorldWithSharedHistory(value) };
  }
  if (version !== '0.7.0' || Object.hasOwn(value, 'contentIdentity') || !validV7(value)) throw new TypeError('Invalid version 7 session World');
  return { version: 7, world: cloneWorldWithSharedHistory(value) };
}
export function exportSessionWorld(state: OwnedSessionWorld): SessionWorld {
  return state.version === 7 ? cloneWorldWithSharedHistory(state.world) : cloneWorldWithSharedHistory(state.world);
}
export function sessionBuildFrame(state: OwnedSessionWorld): SessionBuildFrame {
  return state.version === 7
    ? { builds: state.world.builds, sequences: { ...state.world.sequences } }
    : { builds: state.world.builds, sequences: { ...state.world.sequences } };
}
export function sessionSaveMetadata(state: OwnedSessionWorld): { saveVersion: 7 | 8; simulationVersion: string; contentVersion: string } {
  return { saveVersion: state.version, simulationVersion: state.world.simulationVersion, contentVersion: state.world.contentVersion };
}

/** Queries share the selected engine without upgrading an older running slot. */
export function engineBreakthroughPreview(state: OwnedSessionWorld, discipleId: string, preparation?: BreakthroughPreparation) {
  return state.version === 7
    ? previewWorldBreakthrough(state.world, discipleId, preparation)
    : previewWorldBreakthroughV8(state.world, discipleId, preparation);
}
export function engineExpeditionProjection(state: OwnedSessionWorld) {
  if (state.version === 8) return projectWorldExpeditionV8(state.world);
  const legacy = projectWorldExpedition(state.world);
  return { ...legacy, routeId: legacy.runId === null ? null : STARTER_ROUTE_ID };
}
export function engineDeparturePreview(state: OwnedSessionWorld, request: ExpeditionDepartureRequestV8) {
  if (state.version === 8) return previewWorldExpeditionV8(state.world, request);
  if (request.routeId !== STARTER_ROUTE_ID) throw new TypeError('This route is unavailable in a legacy campaign');
  return previewWorldExpedition(state.world, { ...request, routeId: STARTER_ROUTE_ID });
}
export function engineCampaignProjection(state: OwnedSessionWorld) {
  return state.version === 8 ? projectWorldCampaign(state.world) : null;
}
export function engineCampaignPreview(state: OwnedSessionWorld, request: CampaignPlayerRequest) {
  return state.version === 8 ? previewWorldCampaign(state.world, request) : null;
}

export type SessionEngineCommand = CommandV8;
export function dispatchEngineCommand(state: OwnedSessionWorld, command: SessionEngineCommand) {
  if (state.version === 7) {
    const outcome = dispatchCommand(state.world, command);
    return { state: { version: 7 as const, world: outcome.world }, result: outcome.result };
  }
  const outcome = dispatchCommandV8(state.world, command);
  return { state: { version: 8 as const, world: outcome.world }, result: outcome.result };
}
export function advanceEngineTicks(state: OwnedSessionWorld, ticks: number) {
  if (state.version === 7) {
    const outcome = advanceTicksWithStatus(state.world, ticks);
    return { state: { version: 7 as const, world: outcome.world }, capacityStop: outcome.capacityStop, invariantStop: outcome.invariantStop };
  }
  const outcome = advanceTicksWithStatusV8(state.world, ticks);
  return { state: { version: 8 as const, world: outcome.world }, capacityStop: outcome.capacityStop, invariantStop: outcome.invariantStop };
}
export function withSessionClock(state: OwnedSessionWorld, clock: WorldState['clock']): OwnedSessionWorld {
  return state.version === 7 ? { version: 7, world: { ...state.world, clock } } : { version: 8, world: { ...state.world, clock } };
}
export function engineAutomaticWorkPreview(state: OwnedSessionWorld) {
  return state.version === 7 ? previewWorldAutomaticWork(state.world) : previewWorldAutomaticWorkV8(state.world);
}
