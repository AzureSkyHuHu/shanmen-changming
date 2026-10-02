import {
  createVersionedSaveEnvelope, parseVersionedSave, serializeVersionedSave,
  parseSaveForRoute, type SaveRoutePolicy, type SaveMetadata, type VersionedParseSaveResult, type VersionedSaveEnvelope, type VersionedWorldState,
} from '../save-codec';

/** File-size limit is UTF-8 bytes, shared by every platform read/write path. */
export { MAX_SAVE_FILE_BYTES } from '../save-codec';
export interface SaveFile {
  filename: string;
  mimeType: 'application/json';
  text: string;
}

/** Validate without changing source bytes. Legacy migrations stop at v7; v8/v9 retain their exact identities. */
export function parseSaveFile(text: string, route?: SaveRoutePolicy): VersionedParseSaveResult { return route ? parseSaveForRoute(text, route) : parseVersionedSave(text); }

/** A serializable download description; the UI owns creating/revoking any Blob URL. */
export function describeSaveFile(text: string, envelope: VersionedSaveEnvelope): SaveFile {
  const timestamp = envelope.savedAt.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return { filename: `shanmen-changming-${timestamp}.json`, mimeType: 'application/json', text };
}

/** Works even when browser storage is unavailable. Snapshots must be taken at a tick boundary. */
export function exportWorldSave(world: VersionedWorldState, metadata: SaveMetadata): SaveFile {
  const envelope = createVersionedSaveEnvelope(world, metadata);
  const text = serializeVersionedSave(envelope);
  const validation = parseSaveFile(text);
  if (!validation.ok) throw new TypeError(`Cannot export save: ${validation.error.code}`);
  return describeSaveFile(text, validation.envelope);
}
