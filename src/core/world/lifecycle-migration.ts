import { canonicalStringify, stableHash } from '../kernel/serialization';
import type { WorldStateV8 } from './v8-types';
const exact = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const same = (left: unknown, right: unknown) => canonicalStringify(left) === canonicalStringify(right);
/** Bind the explicit old exceptions to unchanged retained legacy prefixes and
 * their build migration allocation boundary. A new death cannot become old merely
 * by enlarging a saved count or recomputing the outer save checksum. */
export function validateWorldLifecycleMigration(world: Pick<WorldStateV8, 'legacy' | 'builds' | 'cultivation'>): string[] {
  try {
    const metadata = world.legacy.migrationLifecycle; const boundary = world.builds.migration;
    if (!boundary) return metadata === null ? [] : ['Fresh World cannot claim legacy lifecycle exceptions'];
    if (!metadata || !exact(metadata, ['kind', 'sourceBuildBoundaryHash', 'sourceCultivationRevision', 'sourceCalendarMonth', 'receiptCount', 'eventCount', 'deathCount', 'prefixHash', 'finalizedDeaths', 'pendingDeaths'])
      || metadata.kind !== 'legacy-v7' || metadata.sourceBuildBoundaryHash !== stableHash(boundary)
      || !integer(metadata.sourceCultivationRevision) || metadata.sourceCultivationRevision > world.cultivation.revision
      || !integer(metadata.sourceCalendarMonth) || metadata.sourceCalendarMonth > world.cultivation.calendarMonth
      || ![metadata.receiptCount, metadata.eventCount, metadata.deathCount].every(integer)
      || metadata.receiptCount > world.cultivation.receipts.length || metadata.eventCount > world.cultivation.events.length || metadata.deathCount > world.cultivation.deaths.length
      || !Array.isArray(metadata.finalizedDeaths) || !Array.isArray(metadata.pendingDeaths) || metadata.finalizedDeaths.length + metadata.pendingDeaths.length > 36
      || metadata.finalizedDeaths.length !== metadata.deathCount) return ['Invalid legacy lifecycle boundary'];
    const receipts = world.cultivation.receipts.slice(0, metadata.receiptCount); const events = world.cultivation.events.slice(0, metadata.eventCount);
    const deaths = world.cultivation.deaths.slice(0, metadata.deathCount); const originals = [...metadata.finalizedDeaths, ...metadata.pendingDeaths];
    if (new Set(originals.map(death => death.deathId)).size !== originals.length || !same(metadata.finalizedDeaths, deaths.map(({ deathId, discipleId, cause, month }) => ({ deathId, discipleId, cause, month })))) return ['Legacy death summary differs from retained source'];
    for (const death of originals) if (!exact(death, ['deathId', 'discipleId', 'cause', 'month']) || !integer(death.month) || death.month > metadata.sourceCalendarMonth
      || !/^instance:[1-9][0-9]*$/.test(death.deathId) || Number(death.deathId.slice(9)) >= boundary.sequencesAtMigration.nextInstance) return ['Legacy death crosses the source allocation boundary'];
    if (metadata.prefixHash !== stableHash({ receipts, events, deaths, pendingDeaths: metadata.pendingDeaths })) return ['Legacy lifecycle prefix was rewritten'];
    if (events.some(event => Number(event.eventId.slice(6)) >= boundary.sequencesAtMigration.nextEvent || Number(event.rootActionId.slice(7)) >= boundary.sequencesAtMigration.nextAction)) return ['Legacy lifecycle event crosses migration'];
    for (const receipt of receipts) {
      const command: { expectedRevision?: unknown } = JSON.parse(receipt.fingerprint);
      if (typeof command.expectedRevision !== 'number' || !integer(command.expectedRevision) || command.expectedRevision >= metadata.sourceCultivationRevision) return ['Legacy receipt crosses migration revision'];
    }
    const oldDeaths = new Set(metadata.finalizedDeaths.map(death => death.deathId));
    if (world.cultivation.events.slice(metadata.eventCount).some(event => event.kind === 'cultivation.died' && event.relatedId !== null && oldDeaths.has(event.relatedId))) return ['New death borrowed an old lifecycle exception'];
    for (const pending of metadata.pendingDeaths) {
      const retained = [...world.cultivation.pendingDeaths, ...world.cultivation.deaths].find(death => death.deathId === pending.deathId);
      if (!retained || retained.discipleId !== pending.discipleId || retained.cause !== pending.cause || retained.month < pending.month) return ['Legacy pending death responsibility disappeared'];
    }
    return [];
  } catch { return ['Malformed legacy lifecycle boundary']; }
}
