import { migrateWorldV6ToV7 } from './migrate-v6';
import { cloneWorldWithSharedHistory, migrateWorldHistory, restoreWorldHistory } from '../world/history-access';
import { migrateWorldV4ToV5 } from './migrate-v4';
import { migrateWorldV3ToV4 } from './migrate-v3';
import { migrateWorldV2ToV3 } from './migrate-v2';
import { migrateWorldV1ToV2 } from '../agents/migrate-v1';
import { CONTENT_VERSION, SIMULATION_VERSION } from '../world/create-world';
import type { WorldState } from '../world/types';
import { canonicalStringify, stableHash } from './serialization';
import { validateLegacyWorldStateV1, validateLegacyWorldStateV2, validateLegacyWorldStateV3, validateLegacyWorldStateV4, validateLegacyWorldStateV5, validateLegacyWorldStateV6, validateWorldState } from './validation';

export const SAVE_VERSION = 7;
/** Character limit is conservative for UTF-16 strings; file adapters should also cap byte count. */
export const MAX_SAVE_CHARACTERS = 4 * 1024 * 1024;
export interface SaveMetadata { buildId: string; savedAt: string }
export interface SaveEnvelope extends SaveMetadata {
  saveVersion: typeof SAVE_VERSION;
  simulationVersion: string;
  contentVersion: string;
  seed: string;
  checksum: string;
  payload: WorldState;
}
export type SaveErrorCode = 'TOO_LARGE' | 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'UNSUPPORTED_SAVE_VERSION' | 'UNSUPPORTED_SIMULATION_VERSION' | 'UNSUPPORTED_CONTENT_VERSION' | 'CHECKSUM_MISMATCH' | 'INVALID_WORLD';
export type SaveMigration = { sourceSaveVersion: 1; sourceSimulationVersion: '0.1.1'; sourceChecksum: string }
  | { sourceSaveVersion: 2; sourceSimulationVersion: '0.2.0'; sourceChecksum: string }
  | { sourceSaveVersion: 3; sourceSimulationVersion: '0.3.0'; sourceChecksum: string }
  | { sourceSaveVersion: 4; sourceSimulationVersion: '0.4.0'; sourceChecksum: string }
  | { sourceSaveVersion: 5; sourceSimulationVersion: '0.5.0'; sourceChecksum: string }
  | { sourceSaveVersion: 6; sourceSimulationVersion: '0.6.0'; sourceChecksum: string };
export type ParseSaveResult = { ok: true; envelope: SaveEnvelope; world: WorldState; migration: SaveMigration | null } | { ok: false; error: { code: SaveErrorCode; message: string } };

function checksumEnvelope(envelope: Omit<SaveEnvelope, 'checksum'>): string { return stableHash(envelope); }

/** Caller supplies display timestamp. No runtime clock or persistence API is used here. */
export function createSaveEnvelope(world: WorldState, metadata: SaveMetadata): SaveEnvelope {
  const errors = validateWorldState(world);
  if (errors.length) throw new TypeError(`Cannot snapshot invalid world: ${errors.join('; ')}`);
  if (typeof metadata.buildId !== 'string' || metadata.buildId.length === 0 || metadata.buildId.length > 128 || typeof metadata.savedAt !== 'string' || metadata.savedAt.length === 0 || metadata.savedAt.length > 64) throw new TypeError('Invalid save metadata');
  const envelope = { saveVersion: SAVE_VERSION, simulationVersion: SIMULATION_VERSION, contentVersion: CONTENT_VERSION, seed: world.seed, buildId: metadata.buildId, savedAt: metadata.savedAt, payload: cloneWorldWithSharedHistory(world) } as const;
  return { ...envelope, checksum: checksumEnvelope(envelope) };
}

export function serializeSave(envelope: SaveEnvelope): string { return canonicalStringify(envelope); }

/** Validate source checksum and frozen schema before each explicit chained migration; preserve original input. */
export function parseSave(text: string): ParseSaveResult {
  const fail = (code: SaveErrorCode, message: string): ParseSaveResult => ({ ok: false, error: { code, message } });
  if (typeof text !== 'string') return fail('INVALID_JSON', 'Save must be JSON text');
  if (text.length > MAX_SAVE_CHARACTERS) return fail('TOO_LARGE', 'Save exceeds the import size limit');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('INVALID_JSON', 'Save is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_ENVELOPE', 'Save envelope must be an object');
  const candidate = value as Record<string, unknown>;
  const sourceVersion = candidate.saveVersion;
  if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== 3 && sourceVersion !== 4 && sourceVersion !== 5 && sourceVersion !== 6 && sourceVersion !== SAVE_VERSION) return fail('UNSUPPORTED_SAVE_VERSION', 'This save version is not supported');
  if (candidate.simulationVersion !== (sourceVersion === 1 ? '0.1.1' : sourceVersion === 2 ? '0.2.0' : sourceVersion === 3 ? '0.3.0' : sourceVersion === 4 ? '0.4.0' : sourceVersion === 5 ? '0.5.0' : sourceVersion === 6 ? '0.6.0' : SIMULATION_VERSION)) return fail('UNSUPPORTED_SIMULATION_VERSION', 'This simulation version is not supported');
  if (candidate.contentVersion !== CONTENT_VERSION) return fail('UNSUPPORTED_CONTENT_VERSION', 'This content version is not supported');
  if (typeof candidate.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(candidate.checksum) || typeof candidate.seed !== 'string' || typeof candidate.savedAt !== 'string' || candidate.savedAt.length === 0 || candidate.savedAt.length > 64 || typeof candidate.buildId !== 'string' || candidate.buildId.length === 0 || candidate.buildId.length > 128 || !candidate.payload || typeof candidate.payload !== 'object') return fail('INVALID_ENVELOPE', 'Save metadata is invalid');
  const { checksum, ...body } = candidate;
  try {
    if (stableHash(body) !== checksum) return fail('CHECKSUM_MISMATCH', 'Save contents failed their checksum');
    // Own the archive once, only after authenticating the envelope bytes. Semantic validation
    // and the returned World reuse this detached, deeply frozen branch.
    if (sourceVersion >= 6) candidate.payload = restoreWorldHistory(candidate.payload as WorldState);
    const errors = sourceVersion === 1 ? validateLegacyWorldStateV1(candidate.payload) : sourceVersion === 2 ? validateLegacyWorldStateV2(candidate.payload) : sourceVersion === 3 ? validateLegacyWorldStateV3(candidate.payload) : sourceVersion === 4 ? validateLegacyWorldStateV4(candidate.payload) : sourceVersion === 5 ? validateLegacyWorldStateV5(candidate.payload) : sourceVersion === 6 ? validateLegacyWorldStateV6(candidate.payload) : validateWorldState(candidate.payload);
    if (errors.length) return fail('INVALID_WORLD', errors.join('; '));
  } catch { return fail('INVALID_WORLD', 'Save contains unsupported or excessively nested values'); }
  const envelope = candidate as unknown as SaveEnvelope;
  if (envelope.seed !== envelope.payload.seed || envelope.simulationVersion !== envelope.payload.simulationVersion || envelope.contentVersion !== envelope.payload.contentVersion) return fail('INVALID_WORLD', 'Envelope and world identity differ');
  if (sourceVersion !== SAVE_VERSION) {
    try {
      // The source schema already passed validation above. Validate each newly produced
      // intermediate once, never repeat the unchanged original (notably active battle restore).
      let intermediate: unknown = candidate.payload;
      if (sourceVersion === 1) {
        intermediate = migrateWorldV1ToV2(intermediate);
        if (validateLegacyWorldStateV2(intermediate).length) return fail('INVALID_WORLD', 'Intermediate migration failed frozen v2 validation');
      }
      if (sourceVersion <= 2) intermediate = migrateWorldV2ToV3(intermediate);
      if (sourceVersion <= 3) {
        if (sourceVersion < 3 && validateLegacyWorldStateV3(intermediate).length) return fail('INVALID_WORLD', 'Intermediate migration failed frozen v3 validation');
        intermediate = migrateWorldV3ToV4(intermediate);
      }
      if (sourceVersion <= 4) {
        if (sourceVersion < 4 && validateLegacyWorldStateV4(intermediate).length) return fail('INVALID_WORLD', 'Intermediate migration failed frozen v4 validation');
        intermediate = migrateWorldV4ToV5(intermediate);
      }
      if (sourceVersion <= 5) {
        if (sourceVersion < 5 && validateLegacyWorldStateV5(intermediate).length) return fail('INVALID_WORLD', 'Intermediate migration failed frozen v5 validation');
        intermediate = migrateWorldHistory(intermediate);
      }
      if (sourceVersion < 6 && validateLegacyWorldStateV6(intermediate).length) return fail('INVALID_WORLD', 'Intermediate migration failed frozen v6 validation');
      const world = migrateWorldV6ToV7(intermediate);
      const migratedEnvelope = createSaveEnvelope(world, { buildId: envelope.buildId, savedAt: envelope.savedAt });
      const migration: SaveMigration = sourceVersion === 1 ? { sourceSaveVersion: 1, sourceSimulationVersion: '0.1.1', sourceChecksum: envelope.checksum }
        : sourceVersion === 2 ? { sourceSaveVersion: 2, sourceSimulationVersion: '0.2.0', sourceChecksum: envelope.checksum }
          : sourceVersion === 3 ? { sourceSaveVersion: 3, sourceSimulationVersion: '0.3.0', sourceChecksum: envelope.checksum }
            : sourceVersion === 4 ? { sourceSaveVersion: 4, sourceSimulationVersion: '0.4.0', sourceChecksum: envelope.checksum }
              : sourceVersion === 5 ? { sourceSaveVersion: 5, sourceSimulationVersion: '0.5.0', sourceChecksum: envelope.checksum }
                : { sourceSaveVersion: 6, sourceSimulationVersion: '0.6.0', sourceChecksum: envelope.checksum };
      migratedEnvelope.payload = restoreWorldHistory(migratedEnvelope.payload);
      return { ok: true, envelope: migratedEnvelope, world: migratedEnvelope.payload, migration };
    } catch { return fail('INVALID_WORLD', 'Legacy world could not be migrated safely; original bytes were not changed'); }
  }
  envelope.payload = restoreWorldHistory(envelope.payload);
  return { ok: true, envelope, world: envelope.payload, migration: null };
}
