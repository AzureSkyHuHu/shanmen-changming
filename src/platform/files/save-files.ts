import {
  createSaveEnvelope,
  MAX_SAVE_CHARACTERS,
  parseSave,
  serializeSave,
  type ParseSaveResult,
  type SaveEnvelope,
  type SaveMetadata,
} from '../../core/kernel/save';
import type { WorldState } from '../../core/world/types';

/** File-size limit is bytes, in addition to the core's JSON character limit. */
export const MAX_SAVE_FILE_BYTES = 4 * 1024 * 1024;
export interface SaveFile {
  filename: string;
  mimeType: 'application/json';
  text: string;
}

/** Validate before offering an import target. Only core-registered migrations run, without changing input text. */
export function parseSaveFile(text: string): ParseSaveResult {
  if (typeof text !== 'string') return parseSave(text);
  if (text.length > MAX_SAVE_CHARACTERS || new TextEncoder().encode(text).byteLength > MAX_SAVE_FILE_BYTES) {
    return { ok: false, error: { code: 'TOO_LARGE', message: 'Save file exceeds the byte limit' } };
  }
  return parseSave(text);
}

/** A serializable download description; the UI owns creating/revoking any Blob URL. */
export function describeSaveFile(text: string, envelope: SaveEnvelope): SaveFile {
  const timestamp = envelope.savedAt.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return { filename: `shanmen-changming-${timestamp}.json`, mimeType: 'application/json', text };
}

/** Works even when browser storage is unavailable. Snapshots must be taken at a tick boundary. */
export function exportWorldSave(world: WorldState, metadata: SaveMetadata): SaveFile {
  const envelope = createSaveEnvelope(world, metadata);
  const text = serializeSave(envelope);
  const validation = parseSaveFile(text);
  if (!validation.ok) throw new TypeError(`Cannot export save: ${validation.error.code}`);
  return describeSaveFile(text, validation.envelope);
}
