import { SECT_RESOURCE_IDS } from '../../content/sect-v9/types';
import { liveProductionAt } from '../economy/automatic-production';
import { isPaused } from '../kernel/clock';
import { compareStable } from '../kernel/serialization';
import { captureSectHistoricalIdentitiesV8, type SectHistoricalIdentitySource } from '../sect-expansion/history-identity';
import type { ConstructionClaim, ConstructionContext, ConstructionPerson, ConstructionStation, ConstructionValidationIssue } from '../sect-expansion/construction-types';
import { ownSectFields } from '../sect-expansion/layout';
import type { SectMaintenanceFrame } from '../sect-expansion/maintenance-types';
import { validateSectMaintenanceOwnerClosure, validateWorldSectMaintenanceRecords } from '../sect-expansion/maintenance-validation';
import { sectAllLocalClaims, sectClaimsConflict } from '../sect-expansion/research-validation';
import type { SectExpansionOwnedRecords } from '../sect-expansion/world-records-types';
import type { InventoryLedger } from '../economy/types';
import type { WorldClock } from '../kernel/clock';
import type { WorldMap } from './types';
import type { WorldStateV8 } from './v8-types';

/** Read-only source-version port for the next World integration. This is NOT a World v9,
 * migration, constructor, execution gateway, capacity certificate or codec registration. */
export interface WorldSectAuthorityProjectionV8 {
  readonly sourceVersion: 8;
  readonly map: WorldMap;
  readonly clock: WorldClock;
  readonly inventory: InventoryLedger;
  readonly people: readonly ConstructionPerson[];
  readonly legacyStations: readonly ConstructionStation[];
  readonly context: ConstructionContext;
  readonly historicalIdentities: SectHistoricalIdentitySource;
}
export function projectWorldSectAuthoritiesV8(world: WorldStateV8): WorldSectAuthorityProjectionV8 {
  // The factory authenticates the complete real v8 World, including retirement sources.
  const historicalIdentities = captureSectHistoricalIdentitiesV8(world);
  const people = world.disciples.map((actor): ConstructionPerson => {
    const profile = world.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    const build = world.builds.disciples.find(value => value.discipleId === actor.id)!;
    const student = world.cultivation.disciples.find(value => value.teaching?.studentId === actor.id);
    return { id: actor.id, position: actor.position, lifeState: profile.lifeState,
      // This source version cannot authorize expansion work while its actual actor is moving.
      canWork: actor.canWork && profile.trainingMode === 'duty' && !actor.traveling,
      away: profile.activityOwner !== null, productionTransactionId: actor.assignmentTransactionId,
      cultivationOwnerId: profile.activeAttemptId ?? profile.teaching?.teachingId ?? student?.teaching?.teachingId ?? profile.activityOwner?.lockId ?? null,
      otherOwnerId: build.lock?.lockId ?? null };
  });
  const claims: ConstructionClaim[] = [];
  for (const id of [...world.activeProductionTransactionIds].sort(compareStable)) {
    const pair = liveProductionAt(world, id)!;
    claims.push({ kind: 'worker', key: pair.transaction.workerId, ownerId: id });
    // Old storage has no exclusive reservation; several legacy deliveries may share it.
    // Represent its occupied entrance once, deterministically, while retaining every worker.
    if (pair.transaction.storageId !== null) {
      const storage = world.buildings.find(site => site.id === pair.transaction.storageId)!;
      const key = `${storage.x},${storage.y}`;
      if (!claims.some(claim => claim.kind === 'entrance' && claim.key === key)) claims.push({ kind: 'entrance', key, ownerId: id });
    }
  }
  for (const site of world.buildings) if (site.stationTransactionId !== null) {
    claims.push({ kind: 'seat', key: site.id, ownerId: site.stationTransactionId },
      { kind: 'entrance', key: `${site.x},${site.y}`, ownerId: site.stationTransactionId });
  }
  return { sourceVersion: 8, map: world.map, clock: world.clock, inventory: world.inventory, people,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    historicalIdentities, context: { simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
      mode: world.clock.mode, paused: isPaused(world.clock), expeditionActive: world.expedition.run !== null && world.expedition.run.phase !== 'Ended',
      externalActiveJobs: world.activeProductionTransactionIds.length, externalClaims: claims } };
}
export type WorldSectRecordsProjectionResult =
  | { readonly ok: true; readonly frame: SectMaintenanceFrame; readonly authority: WorldSectAuthorityProjectionV8 }
  | { readonly ok: false; readonly issues: readonly ConstructionValidationIssue[] };

/** Compose expansion-owned records with actual World authorities for read/validation only.
 * No returned position, inventory or nav change is written back. Strict v8 reservation closure
 * remains intact, so this cannot execute a new expansion reservation inside an old World. */
export function projectWorldSectRecordsV8(world: WorldStateV8, input: unknown): WorldSectRecordsProjectionResult {
  const fail = (code: string, path: string): WorldSectRecordsProjectionResult => ({ ok: false, issues: [{ code, path }] });
  let authority: WorldSectAuthorityProjectionV8;
  try { authority = projectWorldSectAuthoritiesV8(world); } catch { return fail('INVALID_WORLD_AUTHORITY', 'world'); }
  if (!ownSectFields(input, ['schemaVersion', 'construction', 'stock', 'reservations', 'production', 'research', 'maintenance']) || input.schemaVersion !== 1
    || !ownSectFields(input.construction, ['schemaVersion', 'catalogIdentity', 'revision', 'nextId', 'blueprints', 'jobs', 'buildings', 'receipts']))
    return fail('INVALID_OWNED_RECORDS', 'sectExpansion');
  const records = input as unknown as SectExpansionOwnedRecords;
  const frame: SectMaintenanceFrame = { schemaVersion: 1, construction: { ...records.construction,
    lastSimulationTick: authority.clock.simulationTick, lastCalendarTick: authority.clock.calendarTick,
    map: authority.map, legacyStations: authority.legacyStations, people: authority.people,
    ledger: { inventory: authority.inventory, stock: records.stock, reservations: records.reservations } },
    production: records.production, research: records.research, maintenance: records.maintenance };
  const local = validateWorldSectMaintenanceRecords(frame, authority.historicalIdentities);
  if (local.length) return { ok: false, issues: local };
  const closure = validateSectMaintenanceOwnerClosure(frame);
  if (closure.length) return { ok: false, issues: closure };
  // A valid v8 World already explains EVERY base reservation using its old owners. It has no
  // expansion owner slot: accepting even a coincidentally equal new claim would double-spend.
  if (records.reservations.some(claim => claim.base.remainingReservation.length !== 0))
    return fail('SOURCE_VERSION_RESERVATION_BOUNDARY', 'reservations');
  // This contract starts sect-owned stock from zero. All outputs/consumption have already
  // been authenticated against registered jobs, prices, work, delivery and paired settlement.
  for (const id of SECT_RESOURCE_IDS) {
    let owned = 0;
    for (const claim of records.reservations) {
      owned -= claim.sect.consumed.find(line => line.resourceId === id)?.quantity ?? 0;
      if (claim.sect.settlement?.kind === 'committed') owned += claim.sect.settlement.outputs.find(line => line.resourceId === id)?.quantity ?? 0;
    }
    if (!Number.isSafeInteger(owned) || owned !== records.stock[id].owned) return fail('SECT_STOCK_PROVENANCE', `stock.${id}`);
  }
  const localClaims = sectAllLocalClaims(frame);
  if (sectClaimsConflict([...authority.context.externalClaims, ...localClaims])) return fail('CLAIM_CONFLICT', 'world');
  if (authority.context.externalActiveJobs + localClaims.filter(claim => claim.kind === 'worker').length > 36) return fail('JOB_LIMIT', 'world');
  for (const claim of localClaims) if (claim.kind === 'worker') {
    const person = authority.people.find(value => value.id === claim.key);
    if (!person || person.lifeState !== 'alive' || !person.canWork || person.away || person.productionTransactionId !== null
      || person.cultivationOwnerId !== null || person.otherOwnerId !== null) return fail('WORKER_UNAVAILABLE', claim.key);
  }
  return { ok: true, frame, authority };
}
