import { getSectBuildingDefinition, getSectRecipeDefinition, getSectResearchDefinition, resolveSectCatalogIdentity } from '../../content/sect-v9/catalog';
import { SECT_RESOURCE_IDS, SECT_STOCK_CAPACITY, type SectCell, type SectResourceLine } from '../../content/sect-v9/types';
import { emptyNavigation, MOVEMENT_TICKS_PER_CELL, type JobNavigation } from '../agents/navigation';
import { PERMANENT_TALENT_RULES } from '../cultivation/rules';
import { WOUND_POWDER_EFFECT_V9 } from '../cultivation/care-effect-v9';
import type { LedgerClaim, LedgerLine } from '../economy/ledger-operations';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES, RESOURCE_IDS } from '../economy/types';
import { CONSTRUCTION_LIMITS, type ConstructionBlueprint, type ConstructionBuilding, type ConstructionJob, type ConstructionReceipt } from '../sect-expansion/construction-types';
import { SECT_CARE_LIMITS, WOUND_POWDER_COST_V9, type SectCareCancellation, type SectCareJob, type SectCareReceipt } from '../sect-expansion/care-types';
import type { SectLedgerReservation } from '../sect-expansion/ledger';
import type { SectProductionJob, SectProductionReceipt } from '../sect-expansion/production-types';
import { SECT_RESEARCH_LIMITS, type SectResearchJob, type SectResearchReceipt } from '../sect-expansion/research-types';
import type { WorldStateV9 } from '../world/v9-types';
import { navigationPathByteBudget, type SaveBudgetMap } from './bounds';
import { createCanonicalByteCounter, jsonStringByteLength } from './canonical-bytes';
import { measureProgressionRecord } from './progression-bounds';

const MAX = Number.MAX_SAFE_INTEGER;
const ENTITY = `entity:${MAX - 1}`;
// Local construction/production/research/care command validators permit 128 code
// units. Their cancellation IDs are not all restricted to ASCII. NUL is the
// maximum JSON-escaped width per permitted code unit, including lone surrogates.
const COMMAND = '\u0000'.repeat(128);
const longest = <T extends string>(values: readonly T[]): T => values.reduce((a, b) => jsonStringByteLength(a) >= jsonStringByteLength(b) ? a : b);
export interface SectRecordMeasureV9 { bytes: number; decodedCharacters: number; decodedNodes: number }
export interface SectRecordBoundV9 extends SectRecordMeasureV9 { label: string; placement: 'replacement' | 'array-insertion'; routeCells: number }
export interface SectBranchBoundV9 extends SectRecordMeasureV9 { kind: 'live-peak' | 'completion' | 'cancellation'; records: SectRecordBoundV9[] }
export interface SectReservationV9 extends SectRecordMeasureV9 {
  kind: 'planned-blueprint' | 'construction' | 'production' | 'research' | 'care'; id: string; workerId: string | null;
  /** Per metric maximum over whole branch costs, not completion plus cancellation. */
  branches: SectBranchBoundV9[];
  rows: { constructionJobs: number; constructionBuildings: number; constructionReceipts: number; productionReceipts: number; researchReceipts: number; careReceipts: number; pairedClaims: number };
  counters: { constructionRevision: number; productionRevision: number; researchRevision: number; careRevision: number; cultivationRevision: number; constructionNextId: number; navVersion: number };
}
export interface SectObligationAssessmentV9 {
  scope: 'sect-record-peaks-and-immediate-recovery'; supported: boolean; owners: SectReservationV9[];
  totals: SectRecordMeasureV9 & { rows: SectReservationV9['rows']; counters: SectReservationV9['counters'] };
  shared: SectRecordMeasureV9; unknowns: string[]; excluded: readonly string[];
}
// Every object placed in a branch has a concrete persisted domain type. The last
// member represents the worker's two real World fields, rather than a fictitious
// duplicate World record. These witnesses are sizing envelopes, not valid saves.
type Witness = ConstructionBlueprint | ConstructionBuilding | ConstructionJob | ConstructionReceipt
  | SectProductionJob | SectProductionReceipt | SectResearchJob | SectResearchReceipt | SectCareJob | SectCareReceipt
  | SectLedgerReservation | { position: SectCell; traveling: boolean };
type Candidate = { value: Witness; route?: true };
type Entry = { label: string; candidates: Candidate[]; current?: Witness };
const zero = (): SectRecordMeasureV9 => ({ bytes: 0, decodedCharacters: 0, decodedNodes: 0 });
const rows = (): SectReservationV9['rows'] => ({ constructionJobs: 0, constructionBuildings: 0, constructionReceipts: 0, productionReceipts: 0, researchReceipts: 0, careReceipts: 0, pairedClaims: 0 });
const counters = (): SectReservationV9['counters'] => ({ constructionRevision: 0, productionRevision: 0, researchRevision: 0, careRevision: 0, cultivationRevision: 0, constructionNextId: 0, navVersion: 0 });
const METRICS = ['bytes', 'decodedCharacters', 'decodedNodes'] as const;
function add(target: SectRecordMeasureV9, source: SectRecordMeasureV9): void { for (const key of METRICS) target[key] += source[key]; }
function maximumCell(map: SaveBudgetMap): SectCell { navigationPathByteBudget(map); return { x: map.width - 1, y: map.height - 1 }; }
function navigation(map: SaveBudgetMap): JobNavigation {
  return { path: [], target: maximumCell(map), routeVersion: MAX, movementTicks: MOVEMENT_TICKS_PER_CELL - 1, retryAtTick: MAX };
}
function bound(map: SaveBudgetMap, entry: Entry): SectRecordBoundV9 {
  const current = entry.current === undefined ? zero() : measureProgressionRecord(entry.current);
  const maximum = zero(); let routeCells = 0;
  for (const candidate of entry.candidates) {
    const measured = measureProgressionRecord(candidate.value);
    if (candidate.route) {
      // Typed jobs carry an empty path here. Add its exact analytical N-cell
      // replacement envelope without allocating N identical witness objects.
      const pathDelta = Math.max(0, navigationPathByteBudget(map) - 2);
      measured.bytes += pathDelta; measured.decodedCharacters += pathDelta;
      measured.decodedNodes += map.width * map.height * 3;
      routeCells = map.width * map.height;
    }
    for (const key of METRICS) maximum[key] = Math.max(maximum[key], measured[key]);
  }
  const insertion = entry.current === undefined;
  return { label: entry.label, placement: insertion ? 'array-insertion' : 'replacement', routeCells,
    bytes: Math.max(0, maximum.bytes - current.bytes) + Number(insertion),
    decodedCharacters: Math.max(0, maximum.decodedCharacters - current.decodedCharacters) + Number(insertion),
    decodedNodes: Math.max(0, maximum.decodedNodes - current.decodedNodes) };
}
function branch(map: SaveBudgetMap, kind: SectBranchBoundV9['kind'], entries: Entry[]): SectBranchBoundV9 {
  const result: SectBranchBoundV9 = { ...zero(), kind, records: entries.map(entry => bound(map, entry)) };
  for (const record of result.records) add(result, record); return result;
}
function owner(kind: SectReservationV9['kind'], id: string, workerId: string | null, branches: SectBranchBoundV9[]): SectReservationV9 {
  const result: SectReservationV9 = { ...zero(), kind, id, workerId, branches, rows: rows(), counters: counters() };
  for (const key of METRICS) result[key] = Math.max(...branches.map(value => value[key])); return result;
}
function entry(label: string, value: Witness, current?: Witness, route = false): Entry {
  return { label, candidates: [{ value, ...(route ? { route: true as const } : {}) }], ...(current === undefined ? {} : { current }) };
}
function worker(world: WorldStateV9, workerId: string): Entry {
  const actor = world.disciples.find(actor => actor.id === workerId);
  // Planned starts may choose any genuine actor. The longest coordinate/boolean
  // representation is bounded without granting existence or worker eligibility.
  return entry('World.worker.position+traveling', { position: maximumCell(world.map), traveling: false },
    actor ? { position: actor.position, traveling: actor.traveling } : { position: { x: 0, y: 0 }, traveling: true });
}
function claimOf(world: WorldStateV9, reservationId: string): SectLedgerReservation {
  const found = world.sectExpansion.reservations.find(value => value.reservationId === reservationId);
  if (!found) throw new TypeError(`Missing paired reservation ${reservationId}`); return found;
}
function paired(identity: { reservationId: string; ownerTransactionId: string }, lines: readonly SectResourceLine[], policy: SectLedgerReservation['policy']): SectLedgerReservation {
  function side<R extends string>(ledger: 'base' | 'sect'): LedgerClaim<R> {
    const values = lines.filter(line => line.ledger === ledger).map(line => ({ resourceId: line.resourceId as R, quantity: line.quantity }));
    return { ...identity, lines: values, consumed: [], remainingReservation: values, checkpoints: [], settlement: null };
  }
  return { ...identity, policy, base: side('base'), sect: side('sect') };
}
function claimAt(claim: SectLedgerReservation, stage: 'live' | 'complete' | 'cancel', outputs: readonly SectResourceLine[]): SectLedgerReservation {
  function side<R extends string>(source: LedgerClaim<R>, ledger: 'base' | 'sect'): LedgerClaim<R> {
    const checkpoint = (name: 'half' | 'remainder') => ({ checkpointId: `construction.${name}`, lines: source.lines
      .map(line => ({ ...line, quantity: name === 'half' ? Math.ceil(line.quantity / 2) : Math.floor(line.quantity / 2) })).filter(line => line.quantity > 0) });
    // Full consumed and remaining arrays independently dominate every split.
    // They intentionally coexist only in this typed maximum witness.
    return { ...source, consumed: source.lines, remainingReservation: source.lines,
      checkpoints: claim.policy === 'construction-checkpoints' ? [checkpoint('half'), checkpoint('remainder')] : [],
      settlement: stage === 'live' ? null : stage === 'complete'
        ? { kind: 'committed', operationId: `complete:${claim.ownerTransactionId}`, outputs: outputs.filter(line => line.ledger === ledger).map(line => ({ resourceId: line.resourceId as R, quantity: line.quantity })) }
        : { kind: 'released', operationId: `cancel:${claim.ownerTransactionId}` } };
  }
  return { ...claim, base: side(claim.base, 'base'), sect: side(claim.sect, 'sect') };
}
function constructionOwner(world: WorldStateV9, bp: ConstructionBlueprint, existing?: ConstructionJob): SectReservationV9 {
  const definition = getSectBuildingDefinition(bp.definitionId)?.levels[0]; if (!definition) throw new TypeError('Unknown construction definition');
  const map = world.map; const cell = maximumCell(map); const planned = existing === undefined;
  const job: ConstructionJob = existing ?? { jobId: `sect-construction:${MAX - 3}`, blueprintId: bp.blueprintId,
    reservationId: `sect-reservation:${MAX - 2}`, resultBuildingId: `sect-building:${MAX - 1}`, workerId: ENTITY,
    storageId: ENTITY, seatToken: bp.blueprintId, entranceToken: `${cell.x},${cell.y}`, phase: 'to-storage', startedTick: MAX,
    startedCalendarTick: MAX, origin: cell, storageVisit: null, siteVisit: null, workSpans: [], activeTicks: 0, navigation: emptyNavigation(), blocked: null, terminal: null };
  const claim = existing ? claimOf(world, job.reservationId) : paired({ reservationId: job.reservationId, ownerTransactionId: job.jobId }, definition.costs, 'construction-checkpoints');
  const peak: ConstructionJob = { ...job, phase: 'to-storage', storageVisit: { tick: MAX, position: cell }, siteVisit: { tick: MAX, position: cell },
    workSpans: Array.from({ length: definition.workTicks }, () => ({ firstTick: MAX, lastTick: MAX })), activeTicks: definition.workTicks,
    navigation: navigation(map), blocked: 'STORAGE_UNAVAILABLE' };
  const terminal = (kind: 'completed' | 'cancelled'): ConstructionJob => ({ ...peak, phase: kind, navigation: emptyNavigation(), blocked: null,
    terminal: { kind, tick: MAX, calendarTick: MAX, position: cell, previousPhase: 'to-storage', consumed: definition.costs,
      released: kind === 'cancelled' ? definition.costs : [], buildingId: kind === 'completed' ? job.resultBuildingId : null } });
  const receipt: ConstructionReceipt = { command: { kind: 'construction.cancel', commandId: COMMAND, expectedRevision: MAX - 1, blueprintId: bp.blueprintId }, revision: MAX, relatedId: bp.blueprintId };
  const start: ConstructionReceipt = { command: { kind: 'construction.start', commandId: COMMAND, expectedRevision: MAX - 1, blueprintId: bp.blueprintId, workerId: job.workerId }, revision: MAX, relatedId: job.jobId };
  const building: ConstructionBuilding = { kind: 'placed', buildingId: job.resultBuildingId, definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation,
    level: 1, sourceJobId: job.jobId, completedTick: MAX, completedCalendarTick: MAX, firstMaintenanceCalendarTick: MAX };
  const common = [worker(world, job.workerId), ...(planned ? [entry('construction.start-receipt', start)] : [])];
  const branches = [
    branch(map, 'live-peak', [...common, entry('construction.blueprint', { ...bp, status: 'started', jobId: job.jobId }, bp),
      entry('construction.job', peak, existing, true), entry('paired-ledger', claimAt(claim, 'live', []), existing ? claim : undefined)]),
    branch(map, 'completion', [...common, entry('construction.blueprint', { ...bp, status: 'completed', jobId: job.jobId, endedTick: MAX }, bp),
      entry('construction.job', terminal('completed'), existing), entry('paired-ledger', claimAt(claim, 'complete', []), existing ? claim : undefined), entry('construction.building', building)]),
    branch(map, 'cancellation', [...common, entry('construction.blueprint', { ...bp, status: 'cancelled', jobId: job.jobId, endedTick: MAX }, bp),
      entry('construction.job', terminal('cancelled'), existing), entry('paired-ledger', claimAt(claim, 'cancel', []), existing ? claim : undefined), entry('construction.cancel-receipt', receipt)]),
  ];
  const result = owner(planned ? 'planned-blueprint' : 'construction', planned ? bp.blueprintId : job.jobId, existing?.workerId ?? null, branches);
  result.rows.constructionJobs = Number(planned); result.rows.pairedClaims = Number(planned); result.rows.constructionBuildings = 1;
  result.rows.constructionReceipts = planned ? 2 : 1; result.counters.constructionRevision = planned ? 2 : 1;
  result.counters.constructionNextId = planned ? 3 : 0; result.counters.navVersion = planned ? 2 : 1;
  return result;
}
function productionOwner(world: WorldStateV9, job: SectProductionJob): SectReservationV9 {
  const recipe = getSectRecipeDefinition(job.recipeId); if (!recipe) throw new TypeError('Unknown production recipe');
  const cell = maximumCell(world.map); const claim = claimOf(world, job.reservationId);
  const storageId = longest(world.buildings.filter(site => site.blueprintId === 'storage').map(site => site.id).concat(ENTITY));
  const peak: SectProductionJob = { ...job, state: 'Committed', phase: longest(PRODUCTION_PHASES), blockedReason: longest(PRODUCTION_BLOCKED_REASONS),
    activeTicks: recipe.workTicks, navigation: navigation(world.map), worksiteId: job.productiveSite.siteId, seatSiteId: job.productiveSite.siteId, storageId,
    workVisit: { tick: MAX, calendarTick: MAX, position: cell }, deliveryVisit: { tick: MAX, calendarTick: MAX, position: cell },
    workSpans: Array.from({ length: recipe.workTicks }, () => ({ firstTick: MAX, lastTick: MAX, firstCalendarTick: MAX, lastCalendarTick: MAX })) };
  const terminal = (kind: 'completed' | 'cancelled'): SectProductionJob => ({ ...peak, state: kind === 'completed' ? 'Committed' : 'Cancelled', phase: kind === 'completed' ? 'Done' : 'Cancelled', navigation: emptyNavigation(), blockedReason: null,
    terminal: { kind, tick: MAX, calendarTick: MAX, position: cell, previousPhase: 'TravellingToStorage', consumed: recipe.inputs,
      released: kind === 'cancelled' ? recipe.inputs : [], outputs: kind === 'completed' ? recipe.outputs : [] } });
  const receipt: SectProductionReceipt = { command: { kind: 'production.cancel', commandId: COMMAND, expectedRevision: MAX - 1, jobId: job.transactionId }, revision: MAX, jobId: job.transactionId };
  const common = [worker(world, job.workerId)];
  const result = owner('production', job.transactionId, job.workerId, [
    branch(world.map, 'live-peak', [...common, entry('production.job', peak, job, true), entry('paired-ledger', claimAt(claim, 'live', []), claim)]),
    branch(world.map, 'completion', [...common, entry('production.job', terminal('completed'), job), entry('paired-ledger', claimAt(claim, 'complete', recipe.outputs), claim)]),
    branch(world.map, 'cancellation', [...common, entry('production.job', terminal('cancelled'), job), entry('paired-ledger', claimAt(claim, 'cancel', []), claim), entry('production.cancel-receipt', receipt)]),
  ]);
  result.rows.productionReceipts = 1; result.counters.productionRevision = 1; return result;
}
function researchOwner(world: WorldStateV9, job: SectResearchJob): SectReservationV9 {
  const definition = getSectResearchDefinition(job.researchId); if (!definition) throw new TypeError('Unknown research definition');
  const map = world.map; const cell = maximumCell(map); const claim = claimOf(world, job.reservationId);
  const peak: SectResearchJob = { ...job, phase: 'to-site', activeTicks: definition.workTicks, blocked: 'WORKSTATION_UNAVAILABLE', navigation: navigation(map),
    visits: Array.from({ length: SECT_RESEARCH_LIMITS.visits }, () => ({ tick: MAX, calendarTick: MAX, position: cell })),
    workSpans: Array.from({ length: definition.workTicks }, () => ({ firstTick: MAX, lastTick: MAX, firstCalendarTick: MAX, lastCalendarTick: MAX, visitIndex: SECT_RESEARCH_LIMITS.visits - 1 })) };
  const terminal = (kind: 'completed' | 'cancelled'): SectResearchJob => ({ ...peak, phase: kind, blocked: null, navigation: emptyNavigation(),
    terminal: { kind, previousPhase: 'working', tick: MAX, calendarTick: MAX, position: cell, consumed: definition.costs, released: kind === 'cancelled' ? definition.costs : [] } });
  const receipt: SectResearchReceipt = { command: { kind: 'research.cancel', commandId: COMMAND, expectedRevision: MAX - 1, jobId: job.jobId }, revision: MAX, jobId: job.jobId };
  const common = [worker(world, job.workerId)]; const result = owner('research', job.jobId, job.workerId, [
    branch(map, 'live-peak', [...common, entry('research.job', peak, job, true), entry('paired-ledger', claimAt(claim, 'live', []), claim)]),
    branch(map, 'completion', [...common, entry('research.job', terminal('completed'), job), entry('paired-ledger', claimAt(claim, 'complete', []), claim)]),
    branch(map, 'cancellation', [...common, entry('research.job', terminal('cancelled'), job), entry('paired-ledger', claimAt(claim, 'cancel', []), claim), entry('research.cancel-receipt', receipt)]),
  ]); result.rows.researchReceipts = 1; result.counters.researchRevision = 1; return result;
}
function careOwner(world: WorldStateV9, job: SectCareJob): SectReservationV9 {
  const map = world.map; const cell = maximumCell(map); const claim = claimOf(world, job.reservationId);
  const peak: SectCareJob = { ...job, phase: 'to-storage', activeTicks: SECT_CARE_LIMITS.workTicks, navigation: navigation(map), blocked: 'STORAGE_UNAVAILABLE',
    visits: Array.from({ length: SECT_CARE_LIMITS.visits }, () => ({ tick: MAX, calendarTick: MAX, position: cell })),
    workSpans: Array.from({ length: SECT_CARE_LIMITS.workTicks }, () => ({ firstTick: MAX, lastTick: MAX, visitIndex: SECT_CARE_LIMITS.visits - 1 })) };
  const terminal = (cancellation: SectCareCancellation | null): SectCareJob => ({ ...peak, phase: cancellation ? 'cancelled' : 'completed', navigation: emptyNavigation(), blocked: null,
    terminal: { kind: cancellation ? 'cancelled' : 'completed', previousPhase: 'to-storage', tick: MAX, calendarTick: MAX, position: cell, careRevision: MAX,
      consumed: cancellation ? [] : WOUND_POWDER_COST_V9, released: cancellation ? WOUND_POWDER_COST_V9 : [], cancellation,
      effect: cancellation ? null : { effectId: WOUND_POWDER_EFFECT_V9.id, careJobId: job.jobId, patientId: job.patientId, tick: MAX,
        beforeInjury: 100, afterInjury: 100 - WOUND_POWDER_EFFECT_V9.amount, beforeRevision: MAX - 1, afterRevision: MAX } } });
  const cancellations: SectCareCancellation[] = [{ kind: 'requested' }, { kind: 'death', deathId: `instance:${MAX - 1}` },
    { kind: 'rest-healed', beforeInjury: 100, beforeRevision: MAX - 1, afterRevision: MAX, month: MAX,
      // The cultivation schema permits one source per registered talent. The care
      // leaf's <=3 list is no larger. Fund escaped maximum-width source identities
      // even though only the healing subset appears in genuine runtime receipts.
      healingSourceInstanceIds: Object.keys(PERMANENT_TALENT_RULES).map(() => COMMAND) }];
  const receipt: SectCareReceipt = { command: { kind: 'care.cancel', commandId: COMMAND, expectedRevision: MAX - 1, jobId: job.jobId }, revision: MAX, jobId: job.jobId };
  const common = [worker(world, job.patientId)]; const result = owner('care', job.jobId, job.patientId, [
    branch(map, 'live-peak', [...common, entry('care.job', peak, job, true), entry('paired-ledger', claimAt(claim, 'live', []), claim)]),
    branch(map, 'completion', [...common, entry('care.job', terminal(null), job), entry('paired-ledger', claimAt(claim, 'complete', []), claim)]),
    branch(map, 'cancellation', [...common, { label: 'care.job', current: job, candidates: cancellations.map(reason => ({ value: terminal(reason) })) },
      entry('paired-ledger', claimAt(claim, 'cancel', []), claim), entry('care.cancel-receipt', receipt)]),
  ]); result.rows.careReceipts = 1; result.counters.careRevision = 1; result.counters.cultivationRevision = 1; return result;
}
function sharedWidthGrowth(world: WorldStateV9): SectRecordMeasureV9 {
  const records = world.sectExpansion;
  const current = { inventory: world.inventory, stock: records.stock, mapNavVersion: world.map.navVersion,
    constructionRevision: records.construction.revision, constructionNextId: records.construction.nextId,
    productionRevision: records.production.revision, productionNextId: records.production.nextId,
    researchRevision: records.research.revision, researchNextId: records.research.nextId,
    careRevision: records.care.revision, careNextId: records.care.nextId, maintenanceNextId: records.maintenance.nextId,
    cultivationRevision: world.cultivation.revision, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick };
  const inventory = { ...world.inventory }; for (const id of RESOURCE_IDS) inventory[id] = { ...inventory[id], owned: MAX, reserved: MAX, capacity: MAX };
  const stock = { ...records.stock }; for (const id of SECT_RESOURCE_IDS) stock[id] = { ...stock[id], owned: SECT_STOCK_CAPACITY, reserved: SECT_STOCK_CAPACITY, capacity: SECT_STOCK_CAPACITY };
  const maximum = { ...current, inventory, stock, mapNavVersion: MAX, constructionRevision: MAX, constructionNextId: MAX, productionRevision: MAX,
    productionNextId: MAX, researchRevision: MAX, researchNextId: MAX, careRevision: MAX, careNextId: MAX, maintenanceNextId: MAX,
    cultivationRevision: MAX, simulationTick: MAX, calendarTick: MAX };
  const used = measureProgressionRecord(current); const measured = measureProgressionRecord(maximum);
  return { bytes: Math.max(0, measured.bytes - used.bytes), decodedCharacters: Math.max(0, measured.decodedCharacters - used.decodedCharacters), decodedNodes: 0 };
}
/** Pure data-only derivation. Full v9 source validation belongs to the enclosing
 * query. No witness establishes payment, provenance, eligibility or import rights.
 * At each boundary it funds immediate cancellation/lifecycle recovery and finite
 * representation peaks. It does not fund indefinitely many optional waiting ticks. */
export function deriveSectReservationsV9(world: WorldStateV9): SectObligationAssessmentV9 {
  const result: SectObligationAssessmentV9 = { scope: 'sect-record-peaks-and-immediate-recovery', supported: false, owners: [],
    totals: { ...zero(), rows: rows(), counters: counters() }, shared: zero(), unknowns: [], excluded: [
      'Elapsed ticks and construction/production/research revisions while indefinitely blocked or waiting',
      'Optional new production/research/care starts and maintenance renewals require remeasurement and future runtime admission',
      'Whole-save import, provenance, cancellation-release admission and guaranteed eventual completion are not certified',
      'Historical care beforeRevision/month-tick provenance is not independently authenticated by sizing',
    ] };
  try {
    createCanonicalByteCounter().measure(world); // Accessors/cycles/sparse arrays fail before property reads; no mutable cache.
    if (world.simulationVersion !== '0.9.0' || world.runtimeProtocol !== 'fresh-management-v9-unregistered.2'
      || !resolveSectCatalogIdentity(world.sectExpansion.construction.catalogIdentity)) throw new TypeError('Unsupported internal v9 record identity');
    navigationPathByteBudget(world.map);
    const records = world.sectExpansion;
    for (const bp of records.construction.blueprints) {
      if (bp.status === 'planned') result.owners.push(constructionOwner(world, bp));
      else if (bp.status === 'started') {
        const job = records.construction.jobs.find(job => job.jobId === bp.jobId && job.terminal === null);
        if (!job) throw new TypeError('Started blueprint lacks live construction owner'); result.owners.push(constructionOwner(world, bp, job));
      }
    }
    for (const job of records.production.jobs) if (!job.terminal) result.owners.push(productionOwner(world, job));
    for (const job of records.research.jobs) if (!job.terminal) result.owners.push(researchOwner(world, job));
    for (const job of records.care.jobs) if (!job.terminal) result.owners.push(careOwner(world, job));
    result.shared = sharedWidthGrowth(world); add(result.totals, result.shared);
    for (const value of result.owners) {
      add(result.totals, value);
      for (const key of Object.keys(value.rows) as (keyof SectReservationV9['rows'])[]) result.totals.rows[key] += value.rows[key];
      for (const key of Object.keys(value.counters) as (keyof SectReservationV9['counters'])[]) result.totals.counters[key] += value.counters[key];
    }
    for (const value of [...METRICS.map(key => result.totals[key]), ...Object.values(result.totals.rows), ...Object.values(result.totals.counters)]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Sect reservation exceeds safe finite range');
    }
    result.supported = true;
  } catch (error) {
    result.owners = []; result.totals = { ...zero(), rows: rows(), counters: counters() }; result.shared = zero();
    result.unknowns.push(error instanceof Error ? error.message : 'Unsupported sect obligation');
  }
  return result;
}
