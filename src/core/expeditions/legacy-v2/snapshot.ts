// Frozen v7 expedition-2 protocol. Candidate eligibility must never enter this path.
import { canonicalStringify, stableHash } from '../../kernel/serialization';
import { applyExpeditionCommand, createExpedition } from './expedition';
import { MAX_COMMANDS, assertPlainJson } from './shared';
import type { ExpeditionCatalog, ExpeditionData, ExpeditionState } from './types';

export const MAX_EXPEDITION_SNAPSHOT_BYTES = 4_000_000;
/** Independent payload only. The integrating world must wrap it in its versioned atomic save. */
export function serializeExpedition(state: ExpeditionState): string {
  const text = canonicalStringify({ format: 'shanmen-expedition', version: 2, state, checksum: stableHash(state) });
  if (text.length > MAX_EXPEDITION_SNAPSHOT_BYTES) throw new RangeError('Expedition snapshot exceeds limit');
  return text;
}
/** Replays bounded accepted commands to validate every relationship, not merely a forged checksum. */
export function restoreExpedition(text: string, catalog: ExpeditionCatalog): ExpeditionState {
  if (typeof text !== 'string' || text.length > MAX_EXPEDITION_SNAPSHOT_BYTES) throw new TypeError('Invalid expedition snapshot size');
  const parsed: unknown = JSON.parse(text);
  assertPlainJson(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Invalid expedition snapshot');
  const envelope = parsed as { format: string; version: number; state: ExpeditionData; checksum: string };
  if (Object.keys(envelope).sort().join(',') !== 'checksum,format,state,version' || envelope.format !== 'shanmen-expedition' || envelope.version !== 2
    || !envelope.state || envelope.state.schemaVersion !== 2 || envelope.state.simulationVersion !== 'expedition-2'
    || envelope.checksum !== stableHash(envelope.state) || !Array.isArray(envelope.state.commandLog)
    || envelope.state.commandLog.length > MAX_COMMANDS || envelope.state.contentHash !== stableHash(catalog)) throw new TypeError('Invalid expedition snapshot envelope');
  let replay = createExpedition(envelope.state.origin, catalog);
  for (const command of envelope.state.commandLog) {
    const result = applyExpeditionCommand(replay, command, catalog);
    if (!result.ok || result.replayed) throw new TypeError('Invalid expedition command history');
    replay = result.state;
  }
  if (canonicalStringify(replay) !== canonicalStringify(envelope.state)) throw new TypeError('Expedition snapshot diverges from deterministic history');
  return replay;
}
