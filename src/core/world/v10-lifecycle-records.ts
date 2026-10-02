import { isManagementV10Identity, managementV10BuildContext, MANAGEMENT_V10_CONTENT_VERSION } from '../../content/sect-v10/world-content';
import { validateBuildFrameV2 } from '../builds/v2';
import { createCampaignStateV2 } from '../campaign/v2';
import { validateCultivationFrameV3 } from '../cultivation/v3';
import { REALMS } from '../cultivation/types';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { canonicalStringify } from '../kernel/serialization';
import { canonicalUtf8ByteLength } from '../save-budget';
import { inspectEstateIdentityRecords, inspectEstateSettlementRecords } from './estate-records';
import { lookupEvent } from './history-access';
import { validateWorldLifecycleSources } from './lifecycle-source-proof';
import { inspectV10CultivationClockRecords } from './v10-cultivation-clock-records';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { EMPTY_V9_EXPEDITION } from './v9-lifecycle-records';

const evidence: unique symbol = Symbol('v10 lifecycle records');
export interface V10LifecycleRecordEvidence { readonly [evidence]: true }
export interface V10HistoricalDeathFact {
  readonly discipleId: string;
  readonly deathId: string;
  readonly cause: 'lifespan' | 'breakthrough';
  readonly unavailableEventId: string;
  readonly unavailableKind: 'cultivation.expiryPending' | 'cultivation.died';
  readonly unavailableTick: number;
  readonly unavailableCalendarTick: number;
  readonly diedEventId: string | null;
  readonly diedTick: number | null;
  readonly archived: boolean;
}
const sources = new WeakMap<V10LifecycleRecordEvidence, {
  readonly world: WorldStateV10; readonly canonical: string; readonly facts: readonly V10HistoricalDeathFact[];
}>();
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
/** Version-owned lifecycle stage. It authenticates real domain records and mirrored death
 * history only; it is neither a whole-World validator nor a save/capacity certificate. */
export function inspectV10LifecycleRecords(world: WorldStateV10): V10LifecycleRecordEvidence {
  canonicalUtf8ByteLength(world); // reject accessors before any domain reads
  if (world.simulationVersion !== '0.10.0' || world.runtimeProtocol !== 'management-v10-alchemy-upgrade.1'
    || world.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION || !isManagementV10Identity(world.contentIdentity)
    || world.clock.mode !== 'management' || world.clock.encounterTick !== 0 || world.clock.calendarTick !== world.clock.simulationTick
    || !same(world.expedition, EMPTY_V9_EXPEDITION)
    || !same(world.campaign, { schemaVersion: 2, progress: createCampaignStateV2('standard'), clearEvidence: [], settledRunEvidence: [] })
    || world.builds.migration !== null || world.legacy.migrationLifecycle !== null) throw new TypeError('Unsupported management v10 management boundary');
  const errors = validateCultivationFrameV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences });
  if (errors.length) throw new TypeError(`Invalid v10 cultivation: ${errors[0]}`);
  validateBuildFrameV2({ builds: world.builds, sequences: world.sequences }, managementV10BuildContext(world.contentIdentity));
  if (world.cultivation.calendarMonth !== Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH)
    || world.cultivation.disciples.length !== world.disciples.length || world.builds.disciples.length !== world.disciples.length) throw new TypeError('Lifecycle identity projection differs');
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id);
    const build = world.builds.disciples.find(member => member.discipleId === actor.id);
    if (!profile || !build || profile.ageMonths !== actor.ageMonths || profile.lifeState !== actor.lifeState || profile.aptitude !== actor.aptitude
      || profile.activityOwner !== null || build.lock !== null || (profile.lifeState !== 'alive' && actor.canWork)) throw new TypeError('Lifecycle active identity differs');
  }
  const lifecycle = validateWorldLifecycleSources(world); if (lifecycle.length) throw new TypeError(lifecycle[0]);
  inspectEstateIdentityRecords(world); inspectEstateSettlementRecords(world);
  if (world.cultivation.disciples.some(profile => profile.lifeState === 'dead') || world.legacy.estates.some(estate => estate.settledMonth === null)) throw new TypeError('Management v10 lifecycle settlement is incomplete');
  for (const event of world.cultivation.events) {
    const mirrored = lookupEvent(world, event.eventId);
    if (!mirrored || mirrored.kind !== event.kind || mirrored.rootActionId !== event.rootActionId || mirrored.parentEventId !== null
      || !Number.isSafeInteger(mirrored.tick) || mirrored.tick < 0 || mirrored.tick > world.clock.simulationTick
      || Math.floor(mirrored.tick / CALENDAR_TICKS_PER_MONTH) !== event.month
      || !same(mirrored.payload, { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month })) throw new TypeError('Lifecycle event lacks its actual World mirror');
  }
  for (const profile of [...world.cultivation.disciples, ...world.cultivation.archivedDisciples]) {
    const expected = REALMS.slice(1, REALMS.indexOf(profile.realm) + 1);
    const awarded = world.builds.awards.filter(award => award.discipleId === profile.discipleId);
    if (expected.length !== awarded.length || expected.some(realm => !awarded.some(award => award.ruleId === `realm.${realm}`))) throw new TypeError('Realm milestones differ');
  }
  // There is no campaign acquisition or permanent archive teaching in this fresh boundary.
  // Ordinary schema-3 teaching is still executable; a future paid lesson owner must be added explicitly.
  for (const entry of world.builds.history) if (entry.authority) {
    const command = entry.command;
    if (command.kind === 'milestone.award') {
      const profile = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(member => member.discipleId === command.discipleId);
      if (!profile || !command.ruleId.startsWith('realm.') || !REALMS.slice(1, REALMS.indexOf(profile.realm) + 1).some(realm => command.ruleId === `realm.${realm}`)
        || command.commandId !== `system/realm/${command.discipleId}/${command.ruleId.slice(6)}`) throw new TypeError('Unsupported milestone source');
    } else if (command.kind === 'disciple.retire') {
      if (!world.legacy.estates.some(estate => estate.deathId === command.deathId && estate.discipleId === command.discipleId && estate.settledMonth !== null)) throw new TypeError('Retirement lacks estate');
    } else if (command.kind === 'equipment.transfer' && command.reason.kind === 'death') {
      if (!world.legacy.estates.some(estate => estate.transferCommandIds.includes(command.commandId))) throw new TypeError('Transfer lacks estate');
    } else throw new TypeError('Unsupported fresh management growth authority');
  }
  for (const receipt of world.cultivation.authorityReceipts) {
    const command = receipt.command;
    if (command.kind !== 'disciple.archive' || !world.legacy.archivedIdentities.some(identity => identity.discipleId === command.discipleId && identity.deathId === command.deathId)) throw new TypeError('Unsupported cultivation authority');
  }
  inspectV10CultivationClockRecords(world);
  const deaths: V10HistoricalDeathFact[] = [...world.cultivation.pendingDeaths, ...world.cultivation.deaths].map(death => {
    if (death.cause !== 'lifespan' && death.cause !== 'breakthrough') throw new TypeError('Unsupported management death source');
    const expiry = world.cultivation.events.find(event => event.kind === 'cultivation.expiryPending'
      && event.relatedId === death.deathId && event.discipleId === death.discipleId);
    const died = world.cultivation.events.find(event => event.kind === 'cultivation.died'
      && event.relatedId === death.deathId && event.discipleId === death.discipleId);
    const unavailable = expiry ?? died;
    if (!unavailable || death.cause === 'lifespan' && !expiry) throw new TypeError('Death lacks unavailable event');
    const tick = lookupEvent(world, unavailable.eventId)!.tick;
    const diedTick = died ? lookupEvent(world, died.eventId)!.tick : null;
    if (diedTick !== null && diedTick !== tick) throw new TypeError('Death settlement left its paused boundary');
    return Object.freeze({ discipleId: death.discipleId, deathId: death.deathId, cause: death.cause,
      unavailableEventId: unavailable.eventId, unavailableKind: unavailable.kind as V10HistoricalDeathFact['unavailableKind'],
      unavailableTick: tick, unavailableCalendarTick: tick, diedEventId: died?.eventId ?? null, diedTick,
      archived: world.legacy.archivedIdentities.some(identity => identity.discipleId === death.discipleId && identity.deathId === death.deathId) });
  });
  if (new Set(deaths.map(death => death.deathId)).size !== deaths.length) throw new TypeError('Duplicate lifecycle death');
  const token = Object.freeze({ [evidence]: true as const });
  sources.set(token, { world, canonical: canonicalStringify(world), facts: Object.freeze(deaths) }); return token;
}
/** Exact source-bound record proof. This cannot authorize pre-work cancellation. */
export function historicalDeathsOfV10LifecycleEvidence(token: V10LifecycleRecordEvidence, world: WorldStateV10): readonly V10HistoricalDeathFact[] {
  const source = sources.get(token);
  if (!source || source.world !== world) throw new TypeError('Unauthenticated v10 lifecycle evidence');
  canonicalUtf8ByteLength(world);
  if (canonicalStringify(world) !== source.canonical) throw new TypeError('Changed v10 lifecycle evidence source');
  return source.facts;
}
