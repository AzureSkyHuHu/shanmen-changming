import { canonicalStringify, stableHash } from '../../kernel/serialization';
import { createExpedition, applyExpeditionCommand } from './expedition';
import { MAX_COMMANDS, assertPlainJson } from './shared';
import { validateReleaseExpeditionContext } from './context';
import type { ExpeditionData, ExpeditionState, ReleaseExpeditionContext } from './types';
export const MAX_RELEASE_EXPEDITION_SNAPSHOT_CHARACTERS = 4_000_000;
export function serializeReleaseExpedition(state: ExpeditionState): string {
  const text = canonicalStringify({ format: 'shanmen-expedition', version: 3, state, checksum: stableHash(state) });
  if (text.length > MAX_RELEASE_EXPEDITION_SNAPSHOT_CHARACTERS) throw new RangeError('Expedition snapshot exceeds limit'); return text;
}
export function restoreReleaseExpedition(text: string, context: ReleaseExpeditionContext): ExpeditionState {
  validateReleaseExpeditionContext(context);
  if (typeof text !== 'string' || text.length > MAX_RELEASE_EXPEDITION_SNAPSHOT_CHARACTERS) throw new TypeError('Invalid expedition snapshot size');
  const value: unknown = JSON.parse(text); assertPlainJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checksum,format,state,version') throw new TypeError('Invalid expedition snapshot');
  const envelope = value as { format: string; version: number; state: ExpeditionData; checksum: string };
  if (envelope.format !== 'shanmen-expedition' || envelope.version !== 3 || !envelope.state || envelope.state.schemaVersion !== 3
    || envelope.state.simulationVersion !== 'expedition-3' || envelope.checksum !== stableHash(envelope.state)
    || canonicalStringify(envelope.state.identity) !== canonicalStringify(context.identity)
    || !Array.isArray(envelope.state.commandLog) || envelope.state.commandLog.length > MAX_COMMANDS) throw new TypeError('Invalid expedition envelope');
  let replay = createExpedition(envelope.state.origin, context);
  for (const command of envelope.state.commandLog) {
    const result = applyExpeditionCommand(replay, command, context);
    if (!result.ok || result.replayed) throw new TypeError('Invalid expedition command history'); replay = result.state;
  }
  if (canonicalStringify(replay) !== canonicalStringify(envelope.state)) throw new TypeError('Expedition state diverges from selected protocol');
  return replay;
}
