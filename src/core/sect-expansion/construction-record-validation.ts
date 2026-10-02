import { isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from './history-identity';
import { getSectBuildingDefinition, resolveSectCatalogIdentity } from '../../content/sect-v9/catalog';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify } from '../kernel/serialization';
import { deriveSectFootprint, ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines, validateSectLedgerContext } from './ledger';
import { isSectResearchGateRef } from './research-consumer-gates';
import { LEGACY_SECT_STATION_IDS } from './types';
import { CONSTRUCTION_LIMITS, type ConstructionCommand, type ConstructionContext, type ConstructionFrame, type ConstructionValidationIssue } from './construction-types';

const integer = isNonNegativeInteger;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const nullableId = (value: unknown): boolean => value === null || id(value);
const fields = ownSectFields;
const equal = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const cell = (value: unknown): boolean => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y) && value.x <= 255 && value.y <= 255;
const array = (value: unknown, maximum: number): value is unknown[] => isLedgerDataArray(value) && (value as unknown[]).length <= maximum;

/** Descriptor nodes count each primitive/object/array once, excluding property names.
 * These bounds intentionally sum mutually exclusive record fields at their independent maxima.
 * A generic R-resource claim is ≤17+18R nodes (three line arrays, two checkpoints, settlement
 * outputs); a paired claim adds its object and three scalar identity/policy fields. A job's
 * ≤1079 non-route nodes include BOTH visits, all 320 spans, full navigation metadata AND the
 * largest terminal (two 9-line tagged arrays). Only the ≤36 active jobs may hold route cells.
 * This is a local structural bound, never the future whole-World 4 MiB/reader admission proof.
 */
const MAX_MAP_CELLS = 256 * 256;
const genericClaimNodes = (resources: number): number => 17 + 18 * resources;
const pairedClaimNodes = 4 + genericClaimNodes(6) + genericClaimNodes(3);
const terminalNodes = 1 + 3 + 3 + 1 + 2 * (1 + 9 * 4) + 1;
const jobNonRouteNodes = 1 + 13 + 3 + 2 * 5 + (1 + 320 * 3) + 8 + terminalNodes;
export const CONSTRUCTION_DESCRIPTOR_NODE_BOUND =
  10 // Frame object, five scalar fields and the catalog identity record.
  + (7 + MAX_MAP_CELLS * 5) // Map metadata, tiles array, maximum tile records.
  + (1 + 8 * 6) // Legacy station records.
  + (1 + 36 * 11) // Projected people, including each nested position.
  + (46 + CONSTRUCTION_LIMITS.records * 3 * pairedClaimNodes) // Both inventories and all paired claims.
  + (1 + CONSTRUCTION_LIMITS.records * 12) // Ungated public blueprint history.
  + (1 + CONSTRUCTION_LIMITS.records * jobNonRouteNodes)
  + CONSTRUCTION_LIMITS.activeJobs * MAX_MAP_CELLS * 3 // Live path cell records.
  + (1 + (CONSTRUCTION_LIMITS.buildings - 8) * 13) // Completed building evidence.
  + (1 + CONSTRUCTION_LIMITS.receipts * 13); // Largest full-body receipt (place).
/** Local research schema adds precisely the optional reference object and its two scalars. */
export const CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_DESCRIPTOR_NODE_BOUND + CONSTRUCTION_LIMITS.records * 3;
/** Bounded descriptor-only walk before any nested reads or canonical serialization. */
function plainTree(value: unknown, depth = 0, budget = { left: CONSTRUCTION_DESCRIPTOR_NODE_BOUND }): boolean {
  if (--budget.left < 0 || depth > 16) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => plainTree(child, depth + 1, budget));
  if (!isLedgerDataRecord(value)) return false;
  return Object.values(value as Record<string, unknown>).every(child => plainTree(child, depth + 1, budget));
}
export function isConstructionCommand(value: unknown): value is ConstructionCommand {
  if (!plainTree(value) || !fields(value, ['commandId', 'expectedRevision', 'kind'], false) || !id(value.commandId) || !integer(value.expectedRevision)) return false;
  if (value.kind === 'blueprint.place') return fields(value, ['commandId', 'expectedRevision', 'kind', 'placement']) && deriveSectFootprint(value.placement).ok;
  if (value.kind === 'construction.start') return fields(value, ['commandId', 'expectedRevision', 'kind', 'blueprintId', 'workerId']) && id(value.blueprintId) && id(value.workerId);
  return value.kind === 'construction.cancel' && fields(value, ['commandId', 'expectedRevision', 'kind', 'blueprintId']) && id(value.blueprintId);
}
export function validateConstructionContext(value: unknown): value is ConstructionContext {
  if (!plainTree(value) || !fields(value, ['simulationTick', 'calendarTick', 'mode', 'paused', 'expeditionActive', 'externalActiveJobs', 'externalClaims'])
    || !integer(value.simulationTick) || !integer(value.calendarTick) || !['management', 'combat'].includes(value.mode as string)
    || typeof value.paused !== 'boolean' || typeof value.expeditionActive !== 'boolean' || !integer(value.externalActiveJobs)
    || value.externalActiveJobs > CONSTRUCTION_LIMITS.activeJobs || !array(value.externalClaims, CONSTRUCTION_LIMITS.externalClaims)) return false;
  const claims = new Set<string>();
  return value.externalClaims.every(claim => {
    if (!fields(claim, ['kind', 'key', 'ownerId']) || !['worker', 'seat', 'entrance'].includes(claim.kind as string) || !id(claim.key) || !id(claim.ownerId)) return false;
    const key = `${claim.kind}:${claim.key}`;
    if (claims.has(key)) return false;
    claims.add(key); return true;
  });
}

/** Local structural/accounting record checks in their established first-issue order.
 * Local consumer references are shape only, never proof of completed research. */
export function validateConstructionRecords(input: unknown): readonly ConstructionValidationIssue[] {
  return validateRecords(input, 'research-consumer-records');
}
/** Named strict entry point preserves the public ungated schema and first-issue ordering. */
export function validateUngatedConstructionRecords(input: unknown): readonly ConstructionValidationIssue[] {
  return validateRecords(input, 'ungated');
}
/** Internal World-composition leaf. Its source was authenticated by the selected World version;
 * only a terminal record may refer to an archived identity. Public roots never call this path. */
export function validateWorldConstructionRecords(input: unknown, identities: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  return validateRecords(input, 'research-consumer-records', identities);
}
function validateRecords(input: unknown, scope: 'ungated' | 'research-consumer-records', identities?: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  if (!plainTree(input, 0, { left: scope === 'ungated' ? CONSTRUCTION_DESCRIPTOR_NODE_BOUND : CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND }) || !fields(input, ['schemaVersion', 'catalogIdentity', 'revision', 'nextId', 'lastSimulationTick', 'lastCalendarTick', 'map', 'legacyStations', 'people', 'ledger', 'blueprints', 'jobs', 'buildings', 'receipts'])) return fail('INVALID_SHAPE', 'frame');
  const frame = input as unknown as ConstructionFrame;
  if (frame.schemaVersion !== 1 || !resolveSectCatalogIdentity(frame.catalogIdentity) || !integer(frame.revision) || !integer(frame.nextId) || frame.nextId < 1
    || !integer(frame.lastSimulationTick) || !integer(frame.lastCalendarTick)) return fail('INVALID_IDENTITY', 'frame');
  const map = frame.map;
  if (!fields(map, ['width', 'height', 'seed', 'generationVersion', 'navVersion', 'tiles']) || !integer(map.width) || map.width < 1 || map.width > 256
    || !integer(map.height) || map.height < 1 || map.height > 256 || typeof map.seed !== 'string' || map.seed.length < 1 || map.seed.length > 256
    || map.generationVersion !== 1 || !integer(map.navVersion) || !array(map.tiles, 65536) || map.tiles.length !== map.width * map.height) return fail('INVALID_MAP', 'map');
  const inMap = (p: { readonly x: number; readonly y: number }): boolean => integer(p.x) && integer(p.y) && p.x < map.width && p.y < map.height;
  const tiles = new Set<string>();
  for (const tile of map.tiles) {
    if (!fields(tile, ['x', 'y', 'terrain', 'walkable'])) return fail('INVALID_MAP', 'map.tiles');
    const key = `${tile.x},${tile.y}`;
    if (!inMap(tile) || !['grass', 'forest', 'stone', 'water', 'path'].includes(tile.terrain)
      || typeof tile.walkable !== 'boolean' || tiles.has(key)) return fail('INVALID_MAP', 'map.tiles');
    tiles.add(key);
  }
  if (!array(frame.legacyStations, 8) || frame.legacyStations.length !== 8 || !array(frame.people, 36)
    || !array(frame.blueprints, CONSTRUCTION_LIMITS.records) || !array(frame.jobs, CONSTRUCTION_LIMITS.records)
    || !array(frame.buildings, CONSTRUCTION_LIMITS.buildings - 8) || !array(frame.receipts, CONSTRUCTION_LIMITS.receipts)
    || !fields(frame.ledger, ['inventory', 'stock', 'reservations']) || !array(frame.ledger.reservations, CONSTRUCTION_LIMITS.records * 3)
    || !validateSectLedgerContext(frame.ledger)) return fail('INVALID_COLLECTION', 'frame');
  const externalIds = new Set<string>(); const kinds = new Set<string>();
  for (const station of frame.legacyStations) {
    if (!fields(station, ['id', 'blueprintId', 'x', 'y', 'operational']) || !id(station.id) || externalIds.has(station.id) || !inMap(station)
      || !LEGACY_SECT_STATION_IDS.some(kind => kind === station.blueprintId) || kinds.has(station.blueprintId) || typeof station.operational !== 'boolean') return fail('INVALID_STATION', 'legacyStations');
    externalIds.add(station.id); kinds.add(station.blueprintId);
  }
  for (const person of frame.people) {
    if (!fields(person, ['id', 'position', 'lifeState', 'canWork', 'away', 'productionTransactionId', 'cultivationOwnerId', 'otherOwnerId'])
      || !id(person.id) || externalIds.has(person.id) || !cell(person.position) || !inMap(person.position) || !['alive', 'pendingDeath', 'dead'].includes(person.lifeState)
      || typeof person.canWork !== 'boolean' || typeof person.away !== 'boolean' || !nullableId(person.productionTransactionId)
      || !nullableId(person.cultivationOwnerId) || !nullableId(person.otherOwnerId)) return fail('INVALID_PERSON', 'people');
    externalIds.add(person.id);
  }
  const allocated = new Set<number>();
  const allocation = (value: string, prefix: string): boolean => {
    if (!id(value) || !value.startsWith(`${prefix}:`) || externalIds.has(value)) return false;
    const suffix = value.slice(prefix.length + 1); const n = Number(suffix);
    if (!integer(n) || n < 1 || String(n) !== suffix || n >= frame.nextId || allocated.has(n)) return false;
    allocated.add(n); return true;
  };
  const blueprintIds = new Set<string>();
  const occupiedClaims = new Set(frame.legacyStations.map(station => `${station.x},${station.y}`));
  for (const bp of frame.blueprints) {
    if (!fields(bp, ['definitionId', 'anchor', 'rotation', 'blueprintId', 'placedTick', 'placedCalendarTick', 'status', 'jobId', 'endedTick',
      ...(scope === 'research-consumer-records' && bp?.definitionId === 'alchemy.v9' ? ['researchGate'] : [])])
      || !allocation(bp.blueprintId, 'sect-blueprint') || !deriveSectFootprint({ definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation }).ok
      || !integer(bp.placedTick) || bp.placedTick > frame.lastSimulationTick || !integer(bp.placedCalendarTick) || bp.placedCalendarTick > frame.lastCalendarTick
      || !['planned', 'started', 'completed', 'cancelled'].includes(bp.status) || !nullableId(bp.jobId)
      || !(bp.endedTick === null || integer(bp.endedTick) && bp.endedTick >= bp.placedTick && bp.endedTick <= frame.lastSimulationTick)
      || (getSectBuildingDefinition(bp.definitionId)!.levels[0]!.requiredResearch.length !== 0
        && (scope === 'ungated' || bp.definitionId !== 'alchemy.v9' || !isSectResearchGateRef(bp.researchGate)))) return fail('INVALID_BLUEPRINT', 'blueprints');
    if ((bp.status === 'planned' && (bp.jobId !== null || bp.endedTick !== null)) || (bp.status === 'started' && (bp.jobId === null || bp.endedTick !== null))
      || ((bp.status === 'completed' || bp.status === 'cancelled') && bp.endedTick === null) || (bp.status === 'completed' && bp.jobId === null)) return fail('INVALID_BLUEPRINT_STATE', bp.blueprintId);
    const geometry = deriveSectFootprint({ definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation });
    if (!geometry.ok || !geometry.footprint.cells.every(inMap) || !inMap(geometry.footprint.entrance)) return fail('INVALID_GEOMETRY', bp.blueprintId);
    if (bp.status !== 'cancelled') {
      for (const p of [...geometry.footprint.cells, geometry.footprint.entrance]) {
        const key = `${p.x},${p.y}`;
        if (occupiedClaims.has(key)) return fail('OVERLAPPING_CLAIMS', bp.blueprintId);
        occupiedClaims.add(key);
      }
    }
    blueprintIds.add(bp.blueprintId);
  }
  const cancellationObligations = frame.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length;
  if (frame.revision > Number.MAX_SAFE_INTEGER - cancellationObligations) return fail('REVISION_OBLIGATION', 'revision');
  if (frame.blueprints.filter(bp => bp.status === 'planned').length > CONSTRUCTION_LIMITS.blueprints) return fail('BLUEPRINT_LIMIT', 'blueprints');
  if (frame.jobs.some(job => !isLedgerDataRecord(job))) return fail('INVALID_JOB', 'jobs');
  const active = frame.jobs.filter(job => job.terminal === null);
  if (map.navVersion > Number.MAX_SAFE_INTEGER - active.length) return fail('NAVIGATION_OBLIGATION', 'map.navVersion');
  if (active.length > CONSTRUCTION_LIMITS.activeJobs || active.length + frame.buildings.length + 8 > CONSTRUCTION_LIMITS.buildings) return fail('JOB_LIMIT', 'jobs');
  const workers = new Set<string>(); const seats = new Set<string>(); const entrances = new Set<string>();
  for (const job of frame.jobs) {
    if (!fields(job, ['jobId', 'blueprintId', 'reservationId', 'resultBuildingId', 'workerId', 'storageId', 'seatToken', 'entranceToken', 'phase', 'startedTick', 'startedCalendarTick', 'origin', 'storageVisit', 'siteVisit', 'workSpans', 'activeTicks', 'navigation', 'blocked', 'terminal'])
      || !allocation(job.jobId, 'sect-construction') || !allocation(job.reservationId, 'sect-reservation') || !allocation(job.resultBuildingId, 'sect-building') || !blueprintIds.has(job.blueprintId)
      || !(frame.people.some(person => person.id === job.workerId) || isArchivedSectWorkerReference(identities, job.workerId, job.terminal)) || !frame.legacyStations.some(station => station.id === job.storageId && station.blueprintId === 'storage')
      || !integer(job.startedTick) || job.startedTick > frame.lastSimulationTick || !integer(job.startedCalendarTick) || job.startedCalendarTick > frame.lastCalendarTick
      || !cell(job.origin) || !inMap(job.origin) || !['to-storage', 'to-site', 'working', 'completed', 'cancelled'].includes(job.phase)
      || ![null, 'PATH_BLOCKED', 'PATH_BUDGET', 'WORKER_UNAVAILABLE', 'ENTRANCE_BUSY', 'STORAGE_UNAVAILABLE', 'PLACEMENT_CHANGED'].includes(job.blocked)
      || !integer(job.activeTicks) || !array(job.workSpans, 320)) return fail('INVALID_JOB', 'jobs');
    const bp = frame.blueprints.find(value => value.blueprintId === job.blueprintId)!;
    const definition = getSectBuildingDefinition(bp.definitionId)!.levels[0]!;
    const geometry = deriveSectFootprint({ definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation });
    if (!geometry.ok || bp.jobId !== job.jobId || job.startedTick < bp.placedTick || job.startedCalendarTick < bp.placedCalendarTick
      || job.seatToken !== bp.blueprintId || job.entranceToken !== `${geometry.footprint.entrance.x},${geometry.footprint.entrance.y}` || job.activeTicks > definition.workTicks) return fail('INVALID_JOB_SOURCE', job.jobId);
    const visit = (value: typeof job.storageVisit): boolean => value === null || fields(value, ['tick', 'position']) && integer(value.tick)
      && value.tick > job.startedTick && value.tick <= frame.lastSimulationTick && cell(value.position) && inMap(value.position);
    const storage = frame.legacyStations.find(station => station.id === job.storageId)!;
    if (!visit(job.storageVisit) || !visit(job.siteVisit) || (job.storageVisit && !equal(job.storageVisit.position, { x: storage.x, y: storage.y }))
      || (job.siteVisit && (!job.storageVisit || job.siteVisit.tick <= job.storageVisit.tick || !equal(job.siteVisit.position, geometry.footprint.entrance)))) return fail('INVALID_VISIT', job.jobId);
    // Necessary duration only, never alleged route reconstruction or World provenance. The shared
    // navigator spends four ticks per cell and even same-cell arrival consumes one phase boundary.
    const minimumStorageTicks = Math.max(1, cardinalDistance(job.origin, storage) * MOVEMENT_TICKS_PER_CELL);
    const minimumSiteTicks = Math.max(1, cardinalDistance(storage, geometry.footprint.entrance) * MOVEMENT_TICKS_PER_CELL);
    if ((job.storageVisit && job.storageVisit.tick - job.startedTick < minimumStorageTicks)
      || (job.siteVisit && job.storageVisit && job.siteVisit.tick - job.storageVisit.tick < minimumSiteTicks)) return fail('IMPOSSIBLE_TRAVEL_DURATION', job.jobId);
    let count = 0; let previous = job.siteVisit?.tick ?? job.startedTick;
    for (const span of job.workSpans) {
      if (!fields(span, ['firstTick', 'lastTick']) || !integer(span.firstTick) || !integer(span.lastTick) || span.firstTick <= previous
        || span.lastTick < span.firstTick || span.lastTick > frame.lastSimulationTick || (count > 0 && span.firstTick === previous + 1)) return fail('INVALID_WORK_EVIDENCE', job.jobId);
      count += span.lastTick - span.firstTick + 1; previous = span.lastTick;
    }
    if (count !== job.activeTicks || (count > 0 && !job.siteVisit)) return fail('INVALID_WORK_EVIDENCE', job.jobId);
    const claim = frame.ledger.reservations.find(value => value.reservationId === job.reservationId && value.ownerTransactionId === job.jobId);
    if (!claim || claim.policy !== 'construction-checkpoints' || !equal(sectReservationLines(claim, 'lines'), normalizeSectResourceLines(definition.costs))) return fail('INVALID_COST_SOURCE', job.jobId);
    const half = Math.ceil(definition.workTicks / 2);
    const expectedCheckpoints = job.phase === 'completed' ? 2 : job.activeTicks >= half ? 1 : 0;
    if (claim.base.checkpoints.length !== expectedCheckpoints) return fail('INVALID_CHECKPOINT_WORK', job.jobId);
    const nav = job.navigation;
    if (!fields(nav, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !array(nav.path, map.width * map.height)
      || nav.path.some(p => !cell(p) || !inMap(p)) || !(nav.target === null || cell(nav.target) && inMap(nav.target))
      || !(nav.routeVersion === null || integer(nav.routeVersion) && nav.routeVersion <= map.navVersion)
      || !integer(nav.movementTicks) || nav.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(nav.retryAtTick)
      || nav.path.some((p, index) => index > 0 && cardinalDistance(p, nav.path[index - 1]!) !== 1)) return fail('INVALID_NAVIGATION', job.jobId);
    if (job.terminal === null) {
      if (bp.status !== 'started' || !['to-storage', 'to-site', 'working'].includes(job.phase) || claim.base.settlement !== null
        || workers.has(job.workerId) || seats.has(job.seatToken) || entrances.has(job.entranceToken)
        || (job.phase === 'to-storage' && (job.storageVisit !== null || job.siteVisit !== null || count !== 0))
        || (job.phase === 'to-site' && (!job.storageVisit || job.siteVisit !== null || count !== 0))
        || (job.phase === 'working' && !job.siteVisit)) return fail('INVALID_ACTIVE_OWNERSHIP', job.jobId);
      workers.add(job.workerId); seats.add(job.seatToken); entrances.add(job.entranceToken);
    } else {
      const terminal = job.terminal;
      if (!fields(terminal, ['kind', 'tick', 'calendarTick', 'position', 'previousPhase', 'consumed', 'released', 'buildingId'])
        || !['completed', 'cancelled'].includes(terminal.kind) || job.phase !== terminal.kind || bp.status !== terminal.kind || bp.endedTick !== terminal.tick
        || !integer(terminal.tick) || terminal.tick < job.startedTick || terminal.tick < previous || terminal.tick > frame.lastSimulationTick
        || !integer(terminal.calendarTick) || terminal.calendarTick < job.startedCalendarTick || terminal.calendarTick > frame.lastCalendarTick
        || !cell(terminal.position) || !inMap(terminal.position) || !['to-storage', 'to-site', 'working'].includes(terminal.previousPhase)
        || !equal(terminal.consumed, sectReservationLines(claim, 'consumed')) || !array(terminal.released, 9) || !nullableId(terminal.buildingId)
        || nav.path.length !== 0 || nav.target !== null || nav.routeVersion !== null || nav.movementTicks !== 0 || nav.retryAtTick !== 0 || job.blocked !== null) return fail('INVALID_TERMINAL', job.jobId);
      if (terminal.kind === 'completed') {
        if (terminal.previousPhase !== 'working' || job.activeTicks !== definition.workTicks || !job.siteVisit || !equal(terminal.position, geometry.footprint.entrance)
          || terminal.released.length !== 0 || terminal.buildingId !== job.resultBuildingId || claim.base.settlement?.kind !== 'committed'
          || claim.base.settlement.operationId !== `complete:${job.jobId}`) return fail('INVALID_COMPLETION', job.jobId);
      } else {
        const unpaid = sectReservationLines(claim, 'lines').map(line => ({ ...line, quantity: line.quantity - (terminal.consumed.find(paid => paid.ledger === line.ledger && paid.resourceId === line.resourceId)?.quantity ?? 0) })).filter(line => line.quantity > 0);
        if (terminal.buildingId !== null || claim.base.settlement?.kind !== 'released' || claim.base.settlement.operationId !== `cancel:${job.jobId}`
          || !equal(unpaid, terminal.released) || (terminal.previousPhase === 'to-storage' && (job.storageVisit || job.siteVisit || count))
          || (terminal.previousPhase === 'to-site' && (!job.storageVisit || job.siteVisit || count)) || (terminal.previousPhase === 'working' && !job.siteVisit)) return fail('INVALID_CANCELLATION', job.jobId);
      }
    }
    // Both travel and productive work happen only on management/calendar ticks. Encounter or
    // paused simulation gaps never count toward these necessary, separately evidenced minima.
    const minimumCalendarElapsed = job.activeTicks + (job.storageVisit ? minimumStorageTicks : 0) + (job.siteVisit ? minimumSiteTicks : 0);
    const observedCalendar = job.terminal === null ? frame.lastCalendarTick : job.terminal.calendarTick;
    if (observedCalendar - job.startedCalendarTick < minimumCalendarElapsed) return fail('IMPOSSIBLE_CALENDAR_DURATION', job.jobId);
  }
  for (const bp of frame.blueprints) {
    if (bp.jobId === null) continue;
    const owned = frame.jobs.find(job => job.jobId === bp.jobId);
    if (!owned || owned.blueprintId !== bp.blueprintId || (owned.terminal === null ? bp.status !== 'started' : bp.status !== owned.terminal.kind || bp.endedTick !== owned.terminal.tick)) return fail('ORPHAN_BLUEPRINT', bp.blueprintId);
  }
  // Namespace ownership is bidirectional: an arithmetic-valid orphan claim cannot strand funds.
  for (const claim of frame.ledger.reservations) {
    if (!claim.reservationId.startsWith('sect-reservation:') && !claim.ownerTransactionId.startsWith('sect-construction:')) continue;
    if (frame.jobs.filter(job => job.reservationId === claim.reservationId && job.jobId === claim.ownerTransactionId).length !== 1) return fail('ORPHAN_RESERVATION', claim.reservationId);
  }
  for (const building of frame.buildings) {
    if (!fields(building, ['kind', 'buildingId', 'definitionId', 'anchor', 'rotation', 'level', 'sourceJobId', 'completedTick', 'completedCalendarTick', 'firstMaintenanceCalendarTick'])
      || !id(building.buildingId) || building.kind !== 'placed' || building.level !== 1) return fail('INVALID_BUILDING', 'buildings');
    const job = frame.jobs.find(value => value.jobId === building.sourceJobId);
    const bp = frame.blueprints.find(value => value.jobId === building.sourceJobId);
    if (!job || !bp || job.terminal?.kind !== 'completed' || job.terminal.buildingId !== building.buildingId
      || building.completedTick !== job.terminal.tick || building.completedCalendarTick !== job.terminal.calendarTick
      || building.firstMaintenanceCalendarTick !== building.completedCalendarTick + 1200 || !integer(building.firstMaintenanceCalendarTick)
      || !equal({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation }, { definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation })) return fail('INVALID_BUILDING_SOURCE', building.buildingId);
  }
  if (frame.jobs.some(job => job.phase === 'completed' && frame.buildings.filter(b => b.sourceJobId === job.jobId).length !== 1)) return fail('MISSING_BUILDING', 'buildings');
  if (frame.receipts.length + frame.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length > CONSTRUCTION_LIMITS.receipts) return fail('TERMINAL_CAPACITY', 'receipts');
  const commandIds = new Set<string>(); const receiptRevisions = new Set<number>();
  for (const receipt of frame.receipts) {
    if (!fields(receipt, ['command', 'revision', 'relatedId']) || !isConstructionCommand(receipt.command) || commandIds.has(receipt.command.commandId)
      || !integer(receipt.revision) || receiptRevisions.has(receipt.revision) || receipt.revision > frame.revision || receipt.revision !== receipt.command.expectedRevision + 1 || !id(receipt.relatedId)) return fail('INVALID_RECEIPT', 'receipts');
    commandIds.add(receipt.command.commandId); receiptRevisions.add(receipt.revision);
    const command = receipt.command;
    const bp = frame.blueprints.find(value => value.blueprintId === (command.kind === 'blueprint.place' ? receipt.relatedId : command.blueprintId));
    if (!bp || (command.kind === 'blueprint.place' && !equal(command.placement, { definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation }))
      || (command.kind === 'construction.start' && (receipt.relatedId !== bp.jobId || !frame.jobs.some(job => job.jobId === bp.jobId && job.workerId === command.workerId)))
      || (command.kind === 'construction.cancel' && (receipt.relatedId !== bp.blueprintId || bp.status !== 'cancelled'))) return fail('INVALID_RECEIPT_SOURCE', 'receipts');
  }
  for (const bp of frame.blueprints) {
    if (frame.receipts.filter(r => r.command.kind === 'blueprint.place' && r.relatedId === bp.blueprintId).length !== 1
      || (bp.jobId !== null && frame.receipts.filter(r => r.command.kind === 'construction.start' && r.relatedId === bp.jobId).length !== 1)
      || (bp.status === 'cancelled' && frame.receipts.filter(r => r.command.kind === 'construction.cancel' && r.relatedId === bp.blueprintId).length !== 1)) return fail('MISSING_RECEIPT', bp.blueprintId);
  }
  return [];
}
