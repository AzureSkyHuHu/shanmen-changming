import { getSectBuildingDefinition, resolveSectCatalogIdentity } from '../../content/sect-v9/catalog';
import type { SectCell, SectResourceLine } from '../../content/sect-v9/types';
import { emptyNavigation, MOVEMENT_TICKS_PER_CELL, type JobNavigation } from '../agents/navigation';
import type { LedgerClaim, LedgerLine } from '../economy/ledger-operations';
import { cloneJson } from '../kernel/serialization';
import type { SectLedgerReservation } from '../sect-expansion/ledger';
import { SECT_UPGRADE_LIMITS_V10 as LIMITS, type SectUpgradeCheckpointV10, type SectUpgradeJobV10,
  type SectUpgradeMeasureV10, type SectUpgradeObligationV10, type SectUpgradeReceiptV10,
  type SectUpgradeStateV10, type SectUpgradeVisitV10, type SectUpgradeWorkSpanV10 } from '../sect-expansion/upgrade-types';
import { navigationPathByteBudget, type SaveBudgetMap } from './bounds';
import { measureProgressionRecord as measure } from './progression-bounds';

const MAX = Number.MAX_SAFE_INTEGER;
// Frozen contract section 3.2; shared paired-book limit is unchanged by v10.
const ID_CODE_UNITS = 128;
const PAIRED_CLAIM_LIMIT = 384;
const DEATH_COMMAND_PREFIX = 'system/v10/death/';
const METRICS = ['bytes', 'decodedCharacters', 'decodedNodes'] as const;
type MutableMeasure = { -readonly [K in keyof SectUpgradeMeasureV10]: SectUpgradeMeasureV10[K] };
type WorkerFields = { readonly position: SectCell; readonly traveling: boolean };

/** Accepts the actual World fields, not a duplicated persisted upgrade frame.
 * Full source validation/capture belongs to the fixed enclosing v10 root. */
export interface SectUpgradeRecordSourceV10 {
  readonly map: SaveBudgetMap;
  readonly disciples: readonly (WorkerFields & { readonly id: string })[];
  readonly sectExpansion: {
    readonly schemaVersion: 2;
    readonly upgrade: SectUpgradeStateV10;
    readonly reservations: readonly SectLedgerReservation[];
  };
}
type PersistedWitness = SectUpgradeJobV10 | SectLedgerReservation | SectUpgradeReceiptV10 | WorkerFields;
type RepeatedWitness = SectUpgradeVisitV10 | SectUpgradeWorkSpanV10 | SectUpgradeCheckpointV10 | SectCell;
export interface SectUpgradeRepeatedBoundV10 {
  readonly field: 'siteVisits' | 'workSpans' | 'checkpoints' | 'navigation.path';
  readonly count: number;
  readonly sample: RepeatedWitness;
}
export interface SectUpgradeRecordBoundV10 extends SectUpgradeMeasureV10 {
  readonly label: 'upgrade.job' | 'paired-ledger' | 'upgrade.cancel-receipt' | 'World.worker.position+traveling';
  readonly placement: 'replacement' | 'array-insertion';
  /** Typed sizing witnesses. Empty repeated arrays are expanded analytically.
   * Independent field maxima are NOT alleged reachable game records. */
  readonly witness: PersistedWitness;
  readonly repeated: readonly SectUpgradeRepeatedBoundV10[];
  readonly maximum: SectUpgradeMeasureV10;
  readonly current: SectUpgradeMeasureV10;
}
export interface SectUpgradeBranchBoundV10 extends SectUpgradeMeasureV10 {
  readonly kind: 'live-peak' | 'completion' | 'cancellation';
  readonly variant: 'live' | 'completed' | 'requested-before-half' | 'requested-after-half' | 'death-before-half' | 'death-after-half';
  readonly records: readonly SectUpgradeRecordBoundV10[];
}
export interface SectUpgradeOwnerBoundV10 extends SectUpgradeObligationV10 {
  readonly branches: readonly SectUpgradeBranchBoundV10[];
  readonly remaining: {
    readonly workTicks: number; readonly siteVisits: number; readonly workSpanSlots: number;
    readonly appendableWorkSpans: number; readonly checkpoints: number; readonly navigationCells: number;
  };
}
export interface SectUpgradeObligationAssessmentV10 {
  readonly scope: 'upgrade-only-record-peaks-and-immediate-termination';
  readonly admitted: false;
  readonly supported: boolean;
  readonly owners: readonly SectUpgradeOwnerBoundV10[];
  readonly totals: SectUpgradeMeasureV10 & {
    readonly rows: { readonly upgradeReceipts: number; readonly upgradeJobs: 0; readonly pairedClaims: 0; readonly buildings: 0 };
    readonly counters: { readonly upgradeRevisions: number; readonly upgradeNextId: 0; readonly navVersion: 0 };
  };
  /** Upgrade revision digit growth, charged ONCE outside every owner branch. */
  readonly shared: SectUpgradeMeasureV10;
  readonly headroom: { readonly fits: boolean; readonly diagnostics: readonly string[] };
  readonly unknowns: readonly string[];
  readonly excluded: readonly string[];
}

const zero = (): MutableMeasure => ({ bytes: 0, decodedCharacters: 0, decodedNodes: 0 });
function sum(values: readonly SectUpgradeMeasureV10[]): MutableMeasure {
  const result = zero();
  for (const value of values) for (const key of METRICS) {
    result[key] += value[key];
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new RangeError('Upgrade sizing exceeds finite safe range');
  }
  return result;
}
function delta(maximum: SectUpgradeMeasureV10, current: SectUpgradeMeasureV10): MutableMeasure {
  return { bytes: Math.max(0, maximum.bytes - current.bytes),
    decodedCharacters: Math.max(0, maximum.decodedCharacters - current.decodedCharacters),
    decodedNodes: Math.max(0, maximum.decodedNodes - current.decodedNodes) };
}
function safeInteger(value: number, maximum = MAX): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function cell(map: SaveBudgetMap): SectCell {
  navigationPathByteBudget(map); // Fixed navigation dimension guard: 1..256 each.
  return { x: map.width - 1, y: map.height - 1 };
}
function maxNavigation(map: SaveBudgetMap): JobNavigation {
  return { path: [], target: cell(map), routeVersion: MAX, movementTicks: MOVEMENT_TICKS_PER_CELL - 1, retryAtTick: MAX };
}
/** Replace an EMPTY array already counted in the skeleton. The array node and
 * brackets stay present; only member nodes, bytes and separators are added. */
function repeatedDelta(repeated: SectUpgradeRepeatedBoundV10): SectUpgradeMeasureV10 {
  const sample = measure(repeated.sample); const separators = Math.max(0, repeated.count - 1);
  return { bytes: repeated.count * sample.bytes + separators,
    decodedCharacters: repeated.count * sample.decodedCharacters + separators,
    decodedNodes: repeated.count * sample.decodedNodes };
}
function record(label: SectUpgradeRecordBoundV10['label'], witness: PersistedWitness,
  current?: PersistedWitness, repeated: readonly SectUpgradeRepeatedBoundV10[] = []): SectUpgradeRecordBoundV10 {
  const maximum = sum([measure(witness), ...repeated.map(repeatedDelta)]);
  const used = current === undefined ? zero() : measure(current);
  const growth = delta(maximum, used);
  // One possible outer array comma is the only insertion surcharge; receipt
  // object nodes already occur in the typed witness. Replacements add no comma.
  if (current === undefined) { growth.bytes++; growth.decodedCharacters++; }
  return { ...growth, label, placement: current === undefined ? 'array-insertion' : 'replacement',
    witness: cloneJson(witness), repeated: cloneJson(repeated), maximum, current: used };
}
function branch(kind: SectUpgradeBranchBoundV10['kind'], variant: SectUpgradeBranchBoundV10['variant'],
  records: readonly SectUpgradeRecordBoundV10[]): SectUpgradeBranchBoundV10 {
  return { ...sum(records), kind, variant, records };
}
function costs(): readonly SectResourceLine[] {
  const level = getSectBuildingDefinition('alchemy.v9')?.levels.find(value => value.level === 2);
  if (!level || level.workTicks !== LIMITS.workTicks || level.costs.some(value => value.ledger !== 'base')) {
    throw new TypeError('Unsupported frozen upgrade price');
  }
  return level.costs;
}
const halfCosts = (lines: readonly SectResourceLine[]): readonly SectResourceLine[] => lines.map(line => ({ ...line, quantity: Math.ceil(line.quantity / 2) }));

/** Keep every immutable identity verbatim, including any permitted JSON escapes.
 * No subtraction assumes that an ID has an ASCII width or may later be shortened. */
function claimWitness(claim: SectLedgerReservation, paid: 'none' | 'half' | 'full', terminal: 'live' | 'complete' | 'cancel'): SectLedgerReservation {
  function side<R extends string>(source: LedgerClaim<R>): LedgerClaim<R> {
    const half: LedgerLine<R>[] = source.lines.map(line => ({ ...line, quantity: Math.ceil(line.quantity / 2) }));
    const rest: LedgerLine<R>[] = source.lines.map(line => ({ ...line, quantity: Math.floor(line.quantity / 2) }));
    const checkpoints = paid === 'none' ? [] : [{ checkpointId: 'construction.half', lines: half },
      ...(paid === 'full' ? [{ checkpointId: 'construction.remainder', lines: rest }] : [])];
    return { ...source, consumed: paid === 'none' ? [] : paid === 'half' ? half : source.lines,
      remainingReservation: terminal !== 'live' || paid === 'full' ? [] : paid === 'half' ? rest : source.lines,
      checkpoints, settlement: terminal === 'live' ? null : terminal === 'complete'
        ? { kind: 'committed', operationId: `complete:${claim.ownerTransactionId}`, outputs: [] }
        : { kind: 'released', operationId: `cancel:${claim.ownerTransactionId}` } };
  }
  return { ...claim, base: side(claim.base), sect: side(claim.sect) };
}
function visitsAndSpans(map: SaveBudgetMap, checkpointCount: number): SectUpgradeRepeatedBoundV10[] {
  const visit: SectUpgradeVisitV10 = { tick: MAX, calendarTick: MAX, position: cell(map) };
  const span: SectUpgradeWorkSpanV10 = { firstTick: MAX, lastTick: MAX, firstCalendarTick: MAX, lastCalendarTick: MAX, visitIndex: LIMITS.siteVisits - 1 };
  // Remainder is the longer spelling; activeTicks 200 and 400 have equal widths.
  const checkpoint: SectUpgradeCheckpointV10 = { ...visit, checkpointId: 'construction.remainder', activeTicks: LIMITS.workTicks };
  return [{ field: 'siteVisits', count: LIMITS.siteVisits, sample: visit },
    { field: 'workSpans', count: LIMITS.workSpans, sample: span },
    { field: 'checkpoints', count: checkpointCount, sample: checkpoint }];
}
function owner(source: SectUpgradeRecordSourceV10, job: SectUpgradeJobV10, claim: SectLedgerReservation): SectUpgradeOwnerBoundV10 {
  const map = source.map; const maximumCell = cell(map); const price = costs(); const half = halfCosts(price);
  const actor = source.disciples.find(value => value.id === job.workerId);
  if (!actor) throw new TypeError('Live upgrade lacks actual World worker fields');
  const worker = record('World.worker.position+traveling', { position: maximumCell, traveling: false },
    { position: actor.position, traveling: actor.traveling });
  const peak: SectUpgradeJobV10 = { ...job, phase: 'to-storage', storageVisit: { tick: MAX, calendarTick: MAX, position: maximumCell },
    siteVisits: [], workSpans: [], checkpoints: [], activeTicks: LIMITS.workTicks,
    navigation: maxNavigation(map), blocked: 'STORAGE_UNAVAILABLE', terminal: null };
  const repeated = visitsAndSpans(map, LIMITS.checkpoints);
  const liveJob = record('upgrade.job', peak, job, [...repeated,
    { field: 'navigation.path', count: map.width * map.height, sample: maximumCell }]);
  // Full and half payment have different consumed/remaining sizes. Take maxima
  // across whole live branches instead of summing their mutually exclusive claims.
  const branches: SectUpgradeBranchBoundV10[] = (['none', 'half', 'full'] as const).map(paid =>
    branch('live-peak', 'live', [liveJob, record('paired-ledger', claimWitness(claim, paid, 'live'), claim), worker]));
  const completion: SectUpgradeJobV10 = { ...peak, phase: 'completed', navigation: emptyNavigation(), blocked: null,
    terminal: { kind: 'completed', previousPhase: 'working', resultLevel: 2, cancellation: null,
      tick: MAX, calendarTick: MAX, position: maximumCell, consumed: price, released: [], upgradeRevision: MAX } };
  branches.push(branch('completion', 'completed', [record('upgrade.job', completion, job, repeated),
    record('paired-ledger', claimWitness(claim, 'full', 'complete'), claim), worker]));
  // The WHOLE system command is limited to 128 code units. Maximise the unknown
  // death reference within that budget; NUL uses the longest JSON escape per unit.
  // This deliberately covers future authenticated death cancellation although the
  // current standalone runtime refuses to execute that lifecycle path.
  const deathUnits = ID_CODE_UNITS - DEATH_COMMAND_PREFIX.length - '/'.length - job.jobId.length;
  if (deathUnits < 1) throw new TypeError('Upgrade job ID leaves no bounded system death command');
  const deathId = '\u0000'.repeat(deathUnits);
  for (const paid of ['none', 'half'] as const) {
    if (paid === 'none' && job.activeTicks >= LIMITS.halfWorkTicks) continue;
    for (const kind of ['requested', 'death'] as const) {
      const cancellation = kind === 'requested' ? { kind } : { kind, deathId };
      const cancelled: SectUpgradeJobV10 = { ...peak, phase: 'cancelled', activeTicks: LIMITS.workTicks - 1,
        navigation: emptyNavigation(), blocked: null,
        terminal: { kind: 'cancelled', previousPhase: 'to-storage', resultLevel: 1, cancellation,
          tick: MAX, calendarTick: MAX, position: maximumCell, consumed: paid === 'none' ? [] : half,
          released: paid === 'none' ? price : half, upgradeRevision: MAX } };
      const receipt: SectUpgradeReceiptV10 = { command: { kind: 'upgrade.cancel',
        commandId: kind === 'requested' ? 'c'.repeat(ID_CODE_UNITS) : `${DEATH_COMMAND_PREFIX}${deathId}/${job.jobId}`,
        expectedRevision: MAX - 1, jobId: job.jobId }, revision: MAX, jobId: job.jobId };
      const variant = `${kind}-${paid === 'none' ? 'before' : 'after'}-half` as SectUpgradeBranchBoundV10['variant'];
      branches.push(branch('cancellation', variant, [record('upgrade.job', cancelled, job, visitsAndSpans(map, Number(paid === 'half'))),
        record('paired-ledger', claimWitness(claim, paid, 'cancel'), claim), worker, record('upgrade.cancel-receipt', receipt)]));
    }
  }
  const maximum = zero();
  for (const key of METRICS) maximum[key] = Math.max(...branches.map(value => value[key]));
  const remainingWork = LIMITS.workTicks - job.activeTicks;
  return { ...maximum, jobId: job.jobId, branches,
    rows: { upgradeReceipts: 1, upgradeJobs: 0, pairedClaims: 0, buildings: 0 },
    counters: { upgradeRevisions: 1, upgradeNextId: 0, navVersion: 0 },
    remaining: { workTicks: remainingWork, siteVisits: LIMITS.siteVisits - job.siteVisits.length,
      workSpanSlots: LIMITS.workSpans - job.workSpans.length,
      appendableWorkSpans: Math.min(remainingWork, LIMITS.workSpans - job.workSpans.length),
      checkpoints: LIMITS.checkpoints - job.checkpoints.length, navigationCells: map.width * map.height } };
}

const EXCLUDED = Object.freeze([
  'Whole-v10 identity/provenance/owner closure, envelope, archive, reader and 4 MiB admission remain the enclosing root responsibility',
  'Existing five owners, progression, teaching, lifecycle records, ledger-balance/clock widths and other domains are not charged here',
  'Death witness size does not authorize death cancellation, historical identity, safe worker release or lifecycle continuation',
  'One revision per active owner funds immediate cancellation; unbounded retries/waiting and eventual completion are not promised',
  'Optional starts require fresh complete admission; every actual tick/command must recheck all owners and remaining terminal headroom',
]);

/** Fresh local derivation only. Nothing accepts this result back as a certificate.
 * Current completed/cancelled jobs and their claims/receipts remain in the complete
 * source measurement; they are never subtracted as reclaimable owner space. */
export function deriveSectUpgradeObligationsV10(source: SectUpgradeRecordSourceV10): SectUpgradeObligationAssessmentV10 {
  const emptyTotals = () => ({ ...zero(), rows: { upgradeReceipts: 0, upgradeJobs: 0 as const, pairedClaims: 0 as const, buildings: 0 as const },
    counters: { upgradeRevisions: 0, upgradeNextId: 0 as const, navVersion: 0 as const } });
  try {
    // Reject ordinary accessors/cycles/non-JSON before subsequent typed reads.
    // This is NOT hostile-Proxy capture or the complete root's bounded reader.
    measure(source);
    const state = source.sectExpansion.upgrade;
    if (source.sectExpansion.schemaVersion !== 2 || state.schemaVersion !== 1 || state.protocol !== 'alchemy-l1-l2.1'
      || !resolveSectCatalogIdentity(state.catalogIdentity) || !safeInteger(state.revision)
      || !safeInteger(state.nextId) || state.nextId !== state.jobs.length * 2 + 1) throw new TypeError('Unsupported upgrade sizing identity/counters');
    cell(source.map);
    const live = state.jobs.filter(job => job.terminal === null);
    const owners: SectUpgradeOwnerBoundV10[] = [];
    const workers = new Set<string>();
    for (const job of live) {
      const index = state.jobs.indexOf(job);
      if (job.jobId !== `sect-upgrade:${index * 2 + 1}` || job.reservationId !== `sect-upgrade-reservation:${index * 2 + 2}`
        || !safeInteger(job.activeTicks, LIMITS.workTicks - 1) || job.siteVisits.length > LIMITS.siteVisits
        || job.workSpans.length > LIMITS.workSpans || job.checkpoints.length > LIMITS.checkpoints
        || !['to-storage', 'to-site', 'working'].includes(job.phase) || workers.has(job.workerId)) throw new TypeError('Unsupported active upgrade sizing surface');
      workers.add(job.workerId);
      const claims = source.sectExpansion.reservations.filter(claim => claim.reservationId === job.reservationId || claim.ownerTransactionId === job.jobId);
      const claim = claims[0];
      if (claims.length !== 1 || !claim || claim.reservationId !== job.reservationId || claim.ownerTransactionId !== job.jobId
        || claim.policy !== 'construction-checkpoints' || claim.base.settlement !== null || claim.sect.settlement !== null) throw new TypeError('Missing unique live upgrade paired claim');
      owners.push(owner(source, job, claim));
    }
    const shared = owners.length ? delta(measure(MAX), measure(state.revision)) : zero();
    const totals = { ...emptyTotals(), ...sum([...owners, shared]),
      rows: { upgradeReceipts: owners.length, upgradeJobs: 0 as const, pairedClaims: 0 as const, buildings: 0 as const },
      counters: { upgradeRevisions: owners.length, upgradeNextId: 0 as const, navVersion: 0 as const } };
    const diagnostics: string[] = [];
    if (state.jobs.length > LIMITS.records) diagnostics.push('Upgrade job limit exceeded');
    if (owners.length > LIMITS.activeJobs) diagnostics.push('Upgrade active-owner limit exceeded');
    if (state.receipts.length > LIMITS.receipts - owners.length) diagnostics.push('Insufficient upgrade cancel receipt headroom');
    if (state.revision > MAX - owners.length) diagnostics.push('Insufficient upgrade cancel revision headroom');
    if (source.sectExpansion.reservations.length > PAIRED_CLAIM_LIMIT) diagnostics.push('Shared paired reservation limit exceeded');
    return { scope: 'upgrade-only-record-peaks-and-immediate-termination', admitted: false, supported: true,
      owners, totals, shared, headroom: { fits: diagnostics.length === 0, diagnostics }, unknowns: [], excluded: EXCLUDED };
  } catch {
    // Do not inspect a possibly hostile thrown object/message.
    return { scope: 'upgrade-only-record-peaks-and-immediate-termination', admitted: false, supported: false,
      owners: [], totals: emptyTotals(), shared: zero(), headroom: { fits: false, diagnostics: ['Upgrade sizing unavailable'] },
      unknowns: ['Unsupported upgrade sizing source; complete v10 validation is required'], excluded: EXCLUDED };
  }
}
