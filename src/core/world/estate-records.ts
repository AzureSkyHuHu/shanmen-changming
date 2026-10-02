import { canonicalStringify } from '../kernel/serialization';
import type { WorldStateV8 } from './v8-types';
/** Structural lifecycle records, independent of a selected World/content/save version. */
export type EstateRecordSource = Pick<WorldStateV8, 'legacy' | 'builds' | 'cultivation' | 'disciples'>;
const exact = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
export function inspectEstateIdentityRecords(world: EstateRecordSource): void {
    if (!exact(world.legacy, ['schemaVersion', 'archivedIdentities', 'estates', 'migrationLifecycle']) || world.legacy.schemaVersion !== 1
      || !Array.isArray(world.legacy.archivedIdentities) || !Array.isArray(world.legacy.estates)) throw new Error('Invalid deceased/estate authority');
    const archived = world.legacy.archivedIdentities;
    if (archived.length !== world.builds.retiredDisciples.length || archived.length !== world.cultivation.archivedDisciples.length
      || new Set(archived.map(entry => entry.discipleId)).size !== archived.length) throw new Error('Archived domain identity counts differ');
    for (const identity of archived) {
      const build = world.builds.retiredDisciples.find(entry => entry.discipleId === identity.discipleId);
      const profile = world.cultivation.archivedDisciples.find(entry => entry.discipleId === identity.discipleId);
      if (!exact(identity, ['discipleId', 'nameKey', 'presentationId', 'birthCalendarTick', 'ageMonths', 'aptitude', 'school', 'realm', 'deathId', 'archivedMonth'])
        || !build || !profile || build.school !== identity.school || build.deathId !== identity.deathId || profile.deathId !== identity.deathId
        || profile.realm !== identity.realm || profile.ageMonths !== identity.ageMonths || profile.aptitude !== identity.aptitude
        || typeof identity.nameKey !== 'string' || !/^disciple-[0-3]$/.test(identity.presentationId)
        || !Number.isSafeInteger(identity.birthCalendarTick) || !integer(identity.archivedMonth)
        || identity.archivedMonth > world.cultivation.calendarMonth || world.disciples.some(member => member.id === identity.discipleId)) throw new Error('Invalid deceased identity projection');
    }
}
export function inspectEstateSettlementRecords(world: EstateRecordSource): void {
  const archived = world.legacy.archivedIdentities;
  const allIds = new Set([...world.disciples.map(member => member.id), ...archived.map(member => member.discipleId)]);
    const estateDeaths = new Set<string>();
    if (world.builds.equipment.some(item => item.owner.kind === 'disciple'
      && !world.builds.disciples.some(member => member.discipleId === (item.owner as { discipleId: string }).discipleId))) throw new Error('Equipment remains owned by a retired identity');
    for (const estate of world.legacy.estates) {
      if (!exact(estate, ['estateId', 'deathId', 'discipleId', 'beneficiaryId', 'itemInstanceIds', 'pendingRunId', 'transferCommandIds', 'recordedMonth', 'settledMonth', 'settledOwner'])
        || estate.estateId !== `estate/${estate.deathId}` || estateDeaths.has(estate.deathId) || !allIds.has(estate.discipleId)
        || (estate.beneficiaryId !== null && !allIds.has(estate.beneficiaryId)) || !integer(estate.recordedMonth)
        || estate.recordedMonth > world.cultivation.calendarMonth || !world.cultivation.deaths.some(death => death.deathId === estate.deathId
          && death.discipleId === estate.discipleId && death.beneficiaryId === estate.beneficiaryId)
        || new Set(estate.itemInstanceIds).size !== estate.itemInstanceIds.length) throw new Error('Invalid estate fact');
      estateDeaths.add(estate.deathId);
      if (estate.settledMonth === null) {
        const member = world.builds.disciples.find(entry => entry.discipleId === estate.discipleId);
        if (!member || estate.settledOwner !== null || estate.transferCommandIds.length
          || (member.lock?.runId ?? null) !== estate.pendingRunId || !same(estate.itemInstanceIds,
            world.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === estate.discipleId).map(item => item.instanceId))) throw new Error('Pending estate changed locked ownership');
      } else {
        if (!integer(estate.settledMonth) || estate.settledMonth < estate.recordedMonth || estate.settledMonth > world.cultivation.calendarMonth
          || estate.pendingRunId !== null || estate.settledOwner === null || estate.transferCommandIds.length !== estate.itemInstanceIds.length
          || !archived.some(identity => identity.discipleId === estate.discipleId && identity.deathId === estate.deathId)) throw new Error('Incomplete settled estate');
        const transfers = world.builds.history.filter(entry => entry.authority && entry.command.kind === 'equipment.transfer'
          && entry.command.reason.kind === 'death' && entry.command.reason.deathId === estate.deathId);
        const commands = transfers.map(entry => entry.command);
        if (new Set(estate.transferCommandIds).size !== estate.transferCommandIds.length || transfers.length !== estate.itemInstanceIds.length
          || !same([...estate.transferCommandIds].sort(), commands.map(command => command.commandId).sort())
          || !same([...estate.itemInstanceIds].sort(), commands.map(command => command.kind === 'equipment.transfer' ? command.itemInstanceId : '').sort())
          || commands.some(command => command.kind !== 'equipment.transfer' || command.fromOwner.kind !== 'disciple'
            || command.fromOwner.discipleId !== estate.discipleId || !same(command.toOwner, estate.settledOwner))) throw new Error('Estate item/transfer proof is incomplete');
        // Existing equipment can leave a disciple only through this death transfer.
        // The earliest transfer's global event counter locates beneficiary life in
        // the same immutable chronology; a later death must not undo an old inheritance.
        const beforeEvent = Math.min(...transfers.map(entry => entry.sequencesBefore.nextEvent));
        const beneficiary = estate.beneficiaryId;
        let eligible = beneficiary !== null;
        if (beneficiary !== null) {
          const profile = [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(member => member.discipleId === beneficiary);
          const lifeEvents = world.cultivation.events.filter(event => event.discipleId === beneficiary
            && (event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.died'));
          const firstUnavailableEvent = Math.min(...lifeEvents.map(event => Number(event.eventId.slice(6))));
          const currentAlive = world.cultivation.disciples.some(member => member.discipleId === beneficiary && member.lifeState === 'alive');
          eligible = !!profile && (currentAlive || (lifeEvents.length > 0 && firstUnavailableEvent >= beforeEvent));
        }
        const expectedOwner = eligible ? { kind: 'disciple', discipleId: beneficiary } : { kind: 'sect-estate' };
        if (!same(estate.settledOwner, expectedOwner)) throw new Error('Estate recipient differs from committed eligible heir');
      }
    }
    if (world.cultivation.deaths.some(death => !estateDeaths.has(death.deathId))) throw new Error('Finalized death lacks estate responsibility');
}
