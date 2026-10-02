import {
  createSaveEnvelope, MAX_SAVE_CHARACTERS, parseSave, SAVE_VERSION, serializeSave,
  type ParseSaveResult, type SaveEnvelope, type SaveMetadata,
} from '../core/kernel/save';
import {
  createSaveEnvelopeV8, parseSaveV8, SAVE_VERSION_V8, serializeSaveV8,
  type ParseSaveResultV8, type SaveEnvelopeV8,
} from '../core/kernel/save-v8';
import { createSaveEnvelopeV9, parseSaveV9, SAVE_VERSION_V9, SAVE_SIMULATION_VERSION_V9, serializeSaveV9,
  type ParseSaveResultV9, type SaveEnvelopeV9 } from '../core/kernel/save-v9';
import type { WorldStateV9 } from '../core/world/v9-types';
import { SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../core/save-budget';
import { SIMULATION_VERSION } from '../core/world/create-world';
import { SIMULATION_VERSION_V8 } from '../core/world/create-world-v8';
import type { WorldState } from '../core/world/types';
import type { WorldStateV8 } from '../core/world/v8-types';

export const MAX_SAVE_FILE_BYTES = SAVE_FILE_LIMIT_BYTES;
export type LegacyVersionedWorldState = WorldState | WorldStateV8;
export type VersionedWorldState = LegacyVersionedWorldState | WorldStateV9;
export type VersionedSaveEnvelope = SaveEnvelope | SaveEnvelopeV8 | SaveEnvelopeV9;
export type LegacyParseSaveResult = ParseSaveResult | ParseSaveResultV8;
export type VersionedParseSaveResult = LegacyParseSaveResult | ParseSaveResultV9;
export type VersionedSaveFailure = Extract<VersionedParseSaveResult, { ok: false }>;
type SaveData<T> = T extends { ok: true } ? Omit<T, 'ok'> : never;
/** Correlated envelope/World pairs; v9 is never cast into a legacy World. */
export type VersionedSaveData = SaveData<VersionedParseSaveResult>;
export type LegacySaveData = SaveData<LegacyParseSaveResult>;
export type SaveRoutePolicy = 'legacy-v7-v8' | 'v7' | 'v8' | 'management-v9';
/** Route policy controls consumers; global parser recognition grants no write authority. */
export function saveVersionMatchesRoute(version: SupportedSaveVersion, route: SaveRoutePolicy): boolean {
  if (route === 'management-v9') return version === 9;
  if (route === 'v8') return version === 8;
  if (route === 'v7') return version <= 7;
  return route === 'legacy-v7-v8' && version <= 8;
}
export function isLegacySaveData(data: VersionedSaveData): data is LegacySaveData { return data.envelope.saveVersion !== 9; }
export type SupportedSaveVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type SaveVersionPeekResult = { ok: true; saveVersion: SupportedSaveVersion } | VersionedSaveFailure;
export type { SaveMetadata } from '../core/kernel/save';

function failure(code: VersionedSaveFailure['error']['code'], message: string): VersionedSaveFailure {
  return { ok: false, error: { code, message } };
}

type SaveSourceInspection = { ok: true; saveVersion: SupportedSaveVersion; hasV8ContentIdentity: boolean; hasV9Authority: boolean } | VersionedSaveFailure;

/** Inspect only the original bounded JSON, before any legacy migration can drop fields. */
function inspectSaveSource(text: string): SaveSourceInspection {
  if (typeof text !== 'string') return failure('INVALID_JSON', 'Save must be JSON text');
  if (text.length > MAX_SAVE_CHARACTERS || utf8ByteLength(text) > MAX_SAVE_FILE_BYTES) {
    return failure('TOO_LARGE', 'Save file exceeds the byte limit');
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return failure('INVALID_JSON', 'Save is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('INVALID_ENVELOPE', 'Save envelope must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate.saveVersion;
  const payload = candidate.payload;
  const hasV8ContentIdentity = payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'contentIdentity');
  const hasV9Authority = payload !== null && typeof payload === 'object'
    && ['runtimeProtocol', 'sectExpansion', 'cultivationClock'].some(key => Object.hasOwn(payload, key));
  switch (version) {
    case 1: case 2: case 3: case 4: case 5: case 6: case SAVE_VERSION: case SAVE_VERSION_V8: case SAVE_VERSION_V9:
      return { ok: true, saveVersion: version, hasV8ContentIdentity, hasV9Authority };
    default:
      return failure('UNSUPPORTED_SAVE_VERSION', 'This save version is not supported');
  }
}

/** Bounded routing only. A successful peek is NOT checksum or World validation. */
export function peekSaveVersion(text: string): SaveVersionPeekResult {
  const source = inspectSaveSource(text);
  return source.ok ? { ok: true, saveVersion: source.saveVersion } : source;
}

/** Source version selects exactly one codec. Invalid v8 never retries as legacy. */
export function parseVersionedSave(text: string): VersionedParseSaveResult {
  const source = inspectSaveSource(text);
  if (!source.ok) return source;
  if (source.saveVersion === SAVE_VERSION_V9) return parseSaveV9(text);
  // Inspect original v1–v8 bytes before migration can discard reserved authority.
  if (source.hasV9Authority) return failure('INVALID_WORLD', 'Legacy World cannot carry v9 management authority');
  if (source.saveVersion === SAVE_VERSION_V8) return parseSaveV8(text);
  // Frozen legacy validators permit unknown fields. This v8 authority field is
  // reserved: accepting it would select conflicting content in runtime queries.
  // Reject the original source instead of migrating, stripping, or retrying it.
  if (source.hasV8ContentIdentity) return failure('INVALID_WORLD', 'Legacy World cannot carry a v8 content identity');
  return parseSave(text);
}

/** Refuse an incompatible source before selecting its codec, preserving old routes. */
export function parseSaveForRoute(text: string, route: SaveRoutePolicy): VersionedParseSaveResult {
  const version = peekSaveVersion(text);
  if (!version.ok) return version;
  if (!saveVersionMatchesRoute(version.saveVersion, route)) return failure('UNSUPPORTED_SAVE_VERSION', 'Save version is incompatible with this entry');
  return parseVersionedSave(text);
}
export function parseLegacySaveFile(text: string, route: Exclude<SaveRoutePolicy, 'management-v9'> = 'legacy-v7-v8'): LegacyParseSaveResult {
  const parsed = parseSaveForRoute(text, route);
  if (!parsed.ok) return { ok: false, error: { code: parsed.error.code === 'UNSUPPORTED_SCOPE' ? 'UNSUPPORTED_SAVE_VERSION' : parsed.error.code, message: parsed.error.message } };
  if (isLegacySaveData(parsed)) return parsed;
  return { ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION', message: 'Legacy entry cannot load v9' } };
}

// Most-specific first: WorldStateV9 structurally extends the v8 base.
export function createVersionedSaveEnvelope(world: WorldStateV9, metadata: SaveMetadata): SaveEnvelopeV9;
export function createVersionedSaveEnvelope(world: WorldStateV8, metadata: SaveMetadata): SaveEnvelopeV8;
export function createVersionedSaveEnvelope(world: WorldState, metadata: SaveMetadata): SaveEnvelope;
export function createVersionedSaveEnvelope(world: VersionedWorldState, metadata: SaveMetadata): VersionedSaveEnvelope;
/** The selected core creator validates the entire World, including its content identity. */
export function createVersionedSaveEnvelope(world: VersionedWorldState, metadata: SaveMetadata): VersionedSaveEnvelope {
  // Read only the routing descriptor. V9 admission itself captures all data before property reads.
  const version = world && Object.getOwnPropertyDescriptor(world, 'simulationVersion')?.value;
  if (version === SAVE_SIMULATION_VERSION_V9) return createSaveEnvelopeV9(world, metadata);
  if (world && ['runtimeProtocol', 'sectExpansion', 'cultivationClock'].some(key => Object.hasOwn(world, key))) {
    throw new TypeError('Legacy World cannot carry v9 management authority');
  }
  if (world && version === SIMULATION_VERSION_V8 && 'contentIdentity' in world) {
    return createSaveEnvelopeV8(world as WorldStateV8, metadata);
  }
  if (world && version === SIMULATION_VERSION && !('contentIdentity' in world)) {
    return createSaveEnvelope(world as WorldState, metadata);
  }
  throw new TypeError('Cannot snapshot an unsupported World identity/version');
}

export function serializeVersionedSave(envelope: VersionedSaveEnvelope): string {
  let text: string;
  const version = envelope && Object.getOwnPropertyDescriptor(envelope, 'saveVersion')?.value;
  if (version === SAVE_VERSION_V9) text = serializeSaveV9(envelope as SaveEnvelopeV9);
  else if (version === SAVE_VERSION_V8) text = serializeSaveV8(envelope as SaveEnvelopeV8);
  else if (version === SAVE_VERSION) text = serializeSave(envelope as SaveEnvelope);
  else throw new TypeError('Cannot serialize an unsupported save version');
  if (text.length > MAX_SAVE_CHARACTERS || utf8ByteLength(text) > MAX_SAVE_FILE_BYTES) throw new RangeError('Save exceeds the file size limit');
  return text;
}
