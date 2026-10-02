import { isManagementV9Identity, managementV9BuildContext, MANAGEMENT_V9_CONTENT_VERSION } from '../../content/sect-v9/world-content';
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
import { inspectV9CultivationClockRecords } from './v9-cultivation-clock-records';
import type { WorldStateV9 } from './v9-types';

const evidence: unique symbol = Symbol('v9 lifecycle records');
export interface V9LifecycleRecordEvidence { readonly [evidence]: true }
export interface V9HistoricalDeathFact { readonly discipleId: string; readonly tick: number; readonly calendarMinimum: number; readonly calendarMaximum: number }
const sources = new WeakMap<V9LifecycleRecordEvidence, readonly V9HistoricalDeathFact[]>();
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
export const EMPTY_V9_EXPEDITION = Object.freeze({ schemaVersion: 2 as const, run: null, travel: null, battle: null,
  effectReceipts: Object.freeze([]), deathMappings: Object.freeze([]), history: Object.freeze([]), forcedWithdrawal: false, blockedReason: null,
  contentIdentity: null, protocol: null, routeId: null });

/** Version-owned lifecycle stage. It authenticates real domain records and mirrored death
 * history only; it is neither a whole-World validator nor a save/capacity certificate. */
export function inspectV9LifecycleRecords(world: WorldStateV9): V9LifecycleRecordEvidence {
  canonicalUtf8ByteLength(world); // reject accessors before any domain reads
  if (world.simulationVersion !== '0.9.0' || world.runtimeProtocol !== 'fresh-management-v9-unregistered.3'
    || world.contentVersion !== MANAGEMENT_V9_CONTENT_VERSION || !isManagementV9Identity(world.contentIdentity)
    || world.clock.mode !== 'management' || world.clock.encounterTick !== 0 || world.clock.calendarTick !== world.clock.simulationTick
    || !same(world.expedition, EMPTY_V9_EXPEDITION)
    || !same(world.campaign, { schemaVersion: 2, progress: createCampaignStateV2('standard'), clearEvidence: [], settledRunEvidence: [] })
    || world.builds.migration !== null || world.legacy.migrationLifecycle !== null) throw new TypeError('Unsupported internal v9 management boundary');
  const errors = validateCultivationFrameV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences });
  if (errors.length) throw new TypeError(`Invalid v9 cultivation: ${errors[0]}`);
  validateBuildFrameV2({ builds: world.builds, sequences: world.sequences }, managementV9BuildContext(world.contentIdentity));
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
  if (world.cultivation.disciples.some(profile => profile.lifeState === 'dead') || world.legacy.estates.some(estate => estate.settledMonth === null)) throw new TypeError('Internal v9 lifecycle settlement is incomplete');
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
  inspectV9CultivationClockRecords(world);
  const deaths = world.legacy.archivedIdentities.map(identity => {
    const event = world.cultivation.events.find(event => event.kind === 'cultivation.died' && event.relatedId === identity.deathId && event.discipleId === identity.discipleId)!;
    const tick = lookupEvent(world, event.eventId)!.tick;
    // This management-only protocol advances both clocks together, so the actual mirror is exact.
    return Object.freeze({ discipleId: identity.discipleId, tick, calendarMinimum: tick, calendarMaximum: tick });
  });
  const token = Object.freeze({ [evidence]: true as const }); sources.set(token, Object.freeze(deaths)); return token;
}
/** Internal synchronous consumer. JSON, a constructor or alleged ID list cannot forge evidence. */
export function historicalDeathsOfV9LifecycleEvidence(token: V9LifecycleRecordEvidence): readonly V9HistoricalDeathFact[] {
  const facts = sources.get(token); if (!facts) throw new TypeError('Unauthenticated v9 lifecycle evidence'); return facts;
}
