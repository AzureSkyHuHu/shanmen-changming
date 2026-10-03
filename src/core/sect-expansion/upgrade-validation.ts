import { getSectBuildingDefinition, getSectResearchDefinition, SECT_V9_CANDIDATE_IDENTITY } from '../../content/sect-v9/catalog';
import type { SectCell, SectResourceLine } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, isWalkable, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionClaims, constructionEffectiveMap } from './construction-runtime';
import { validateConstructionContext, validateConstructionRecords, validateWorldConstructionRecords } from './construction-record-validation';
import type { ConstructionClaim, ConstructionContext, ConstructionPerson, ConstructionValidationIssue } from './construction-types';
import { SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10 } from './descriptor-bounds-v10';
export { SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10 } from './descriptor-bounds-v10';
import { historicalDeathsOfV10LifecycleEvidence, type V10HistoricalDeathFact, type V10LifecycleRecordEvidence } from '../world/v10-lifecycle-records';
import { projectV10SectFrame } from '../world/v10-sect-frame';
import { captureSectHistoricalIdentitiesV10, isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from './history-identity';
import { deriveSectFootprint, ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { sectBuildingL1PaidRangeV10, validateSectMaintenanceL1RecordsV10, validateSectUpgradeResearchPrerequisitesV10 } from './maintenance-v10';
export { sectBuildingL1PaidRangeV10 } from './maintenance-v10';
import { SECT_UPGRADE_LIMITS_V10, type SectUpgradeCommandV10, type SectUpgradeFrameV10, type SectUpgradeJobV10,
  type WorldStateV10, type SectUpgradeRejectionV10, type SectUpgradeResearchRefV10, type SectUpgradeSiteProofV10, type SectUpgradeStateV10 } from './upgrade-types';

const MAX = Number.MAX_SAFE_INTEGER;
const integer = isNonNegativeInteger;
const fields = ownSectFields;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const playerId = (value: unknown): value is string => id(value) && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const key = (position: SectCell): string => `${position.x},${position.y}`;
const live = (job: { readonly terminal: unknown }): boolean => job.terminal === null;

/** Descriptor-only capture gate. No getters run; aliases/cycles, symbols, exotic prototypes,
 * undefined and non-enumerable data reject. Proxy reflection itself is not sandboxed: a hostile
 * trap can execute before throwing; caught failures do not claim universal Proxy safety. */
export function isSectUpgradeDataTreeV10(value: unknown, maximum = SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10): boolean {
  const seen = new Set<object>(); let remaining = maximum;
  const visit = (node: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 28) return false;
    if (node === null || typeof node === 'boolean') return true;
    if (typeof node === 'number') return integer(node);
    if (typeof node === 'string') return node.length <= 256;
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
      if (Object.getPrototypeOf(node) !== Array.prototype) return false;
      const length = Object.getOwnPropertyDescriptor(node, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !integer(length.value) || length.value > 65536 || length.value > remaining) return false;
      const keys = Reflect.ownKeys(node);
      if (keys.length !== length.value + 1) return false;
      for (let i = 0; i < length.value; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(node, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(node) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(node);
    if (keys.length > 64 || keys.length > remaining) return false;
    for (const name of keys) {
      if (typeof name !== 'string' || name.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(name)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(node, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  };
  try { return visit(value, 0); } catch { return false; }
}
const array = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum;
export function isSectUpgradeCommandV10(value: unknown): value is SectUpgradeCommandV10 {
  if (!isSectUpgradeDataTreeV10(value, 16) || !fields(value, ['kind', 'commandId', 'expectedRevision'], false)
    || !playerId(value.commandId) || !integer(value.expectedRevision)) return false;
  return value.kind === 'upgrade.start'
    ? fields(value, ['kind', 'commandId', 'expectedRevision', 'buildingId', 'workerId']) && id(value.buildingId) && id(value.workerId)
    : value.kind === 'upgrade.cancel' && fields(value, ['kind', 'commandId', 'expectedRevision', 'jobId']) && id(value.jobId);
}
export function createSectUpgradeStateV10(): SectUpgradeStateV10 {
  return { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY), revision: 0, nextId: 1, jobs: [], receipts: [] };
}
export function sectUpgradeCostsV10(): SectResourceLine[] {
  return cloneJson(normalizeSectResourceLines(getSectBuildingDefinition('alchemy.v9')!.levels[1]!.costs)!);
}
/** Research records/DAG/payment must be authenticated by the preceding fixed record stage. */
export function sectUpgradeGateFromRecordsV10(frame: SectUpgradeFrameV10, tick: number): SectUpgradeResearchRefV10 | null {
  const definition = getSectResearchDefinition('herbal-compatibility.v9')!;
  if (!definition.effects.some(effect => effect.kind === 'unlock-building-level' && effect.definitionId === 'alchemy.v9' && effect.level === 2)) return null;
  const jobs = frame.research.jobs.filter(job => job.researchId === definition.id && job.terminal?.kind === 'completed');
  if (jobs.length !== 1) return null;
  const job = jobs[0]!;
  return job.terminal!.tick <= tick && job.terminal!.calendarTick <= tick
    ? { researchId: 'herbal-compatibility.v9', completionJobId: job.jobId } : null;
}
export function sectUpgradeSiteFromRecordsV10(frame: SectUpgradeFrameV10, buildingId: string): SectUpgradeSiteProofV10 | null {
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  if (!building || building.definitionId !== 'alchemy.v9' || building.level !== 1) return null;
  const source = frame.construction.jobs.find(value => value.jobId === building.sourceJobId);
  if (source?.terminal?.kind !== 'completed' || source.terminal.buildingId !== buildingId || source.resultBuildingId !== buildingId) return null;
  const shape = deriveSectFootprint({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
  return shape.ok ? { buildingId, definitionId: 'alchemy.v9', sourceJobId: building.sourceJobId, level: 1,
    position: { ...shape.footprint.entrance }, firstMaintenanceCalendarTick: building.firstMaintenanceCalendarTick } : null;
}
export function sectUpgradeClaimsV10(frame: SectUpgradeFrameV10): readonly ConstructionClaim[] {
  return frame.upgrade.jobs.filter(live).slice().sort((a, b) => compareStable(a.jobId, b.jobId)).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.buildingId, ownerId: job.jobId },
    { kind: 'entrance' as const, key: job.entranceToken, ownerId: job.jobId },
  ]);
}
/** Shared owner view over the six-domain projection. Every owner is still independently
 * authenticated by the fixed root; claims do not establish an owner's provenance. */
export function sectUpgradeAllLocalClaimsV10(frame: SectUpgradeFrameV10): readonly ConstructionClaim[] {
  const claims: ConstructionClaim[] = [...constructionClaims(frame.construction), ...sectUpgradeClaimsV10(frame)];
  const storage = frame.construction.legacyStations.find(value => value.blueprintId === 'storage');
  for (const job of frame.production.jobs.filter(live)) {
    claims.push({ kind: 'worker', key: job.workerId, ownerId: job.transactionId });
    if (job.seatSiteId !== null) claims.push({ kind: 'seat', key: job.seatSiteId, ownerId: job.transactionId },
      { kind: 'entrance', key: key(job.productiveSite.position), ownerId: job.transactionId });
    else if (job.storageId !== null && storage) claims.push({ kind: 'entrance', key: key(storage), ownerId: job.transactionId });
  }
  for (const job of frame.research.jobs.filter(live)) claims.push({ kind: 'worker', key: job.workerId, ownerId: job.jobId },
    { kind: 'seat', key: job.site.buildingId, ownerId: job.jobId }, { kind: 'entrance', key: key(job.site.position), ownerId: job.jobId });
  for (const job of frame.care.jobs.filter(live)) claims.push({ kind: 'worker', key: job.patientId, ownerId: job.jobId },
    { kind: 'entrance', key: key(job.storagePosition), ownerId: job.jobId });
  return claims;
}
export function sectUpgradeWorkerEligibleV10(person: ConstructionPerson): boolean {
  return person.lifeState === 'alive' && person.canWork && !person.away && person.productionTransactionId === null
    && person.cultivationOwnerId === null && person.otherOwnerId === null;
}
export function sectUpgradeClaimsConflictV10(claims: readonly ConstructionClaim[]): boolean {
  const tokens = new Set<string>();
  for (const claim of claims) { const token = `${claim.kind}:${claim.key}`; if (tokens.has(token)) return true; tokens.add(token); }
  return false;
}
export function inspectSectUpgradeStartV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  buildingId: string, workerId: string): SectUpgradeRejectionV10 | null {
  if (!validateConstructionContext(context) || context.simulationTick !== context.calendarTick) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick) return 'STALE_CLOCK';
  if (context.mode !== 'management' || context.paused || context.expeditionActive) return 'MANAGEMENT_REQUIRED';
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  if (!building) return 'UNKNOWN_BUILDING';
  const site = sectUpgradeSiteFromRecordsV10(frame, buildingId);
  if (!site) return 'UNSUPPORTED_UPGRADE';
  if (frame.upgrade.jobs.some(job => job.buildingId === buildingId && job.terminal?.kind === 'completed')) return 'ALREADY_UPGRADED';
  if (frame.upgrade.jobs.some(job => job.buildingId === buildingId && live(job))) return 'UPGRADE_ACTIVE';
  if (!sectUpgradeGateFromRecordsV10(frame, context.simulationTick)) return 'RESEARCH_AUTHORITY_REQUIRED';
  if (!sectBuildingL1PaidRangeV10(frame, buildingId, context.simulationTick, context.simulationTick, context.calendarTick, context.calendarTick)) return 'MAINTENANCE_UNPAID';
  if (frame.production.jobs.some(job => live(job) && job.productiveSite.siteId === buildingId)
    || frame.research.jobs.some(job => live(job) && job.site.buildingId === buildingId)) return 'BUILDING_BUSY';
  const claims = [...sectUpgradeAllLocalClaimsV10(frame), ...context.externalClaims];
  if (sectUpgradeClaimsConflictV10(claims)) return 'CLAIM_CONFLICT';
  const worker = frame.construction.people.find(value => value.id === workerId);
  if (!worker || !sectUpgradeWorkerEligibleV10(worker)) return 'WORKER_UNAVAILABLE';
  if (claims.some(claim => claim.kind === 'worker' && claim.key === workerId || claim.kind === 'seat' && claim.key === buildingId
    || claim.kind === 'entrance' && claim.key === key(site.position))) return 'CLAIM_CONFLICT';
  const storage = frame.construction.legacyStations.find(value => value.blueprintId === 'storage' && value.operational);
  if (!storage) return 'STORAGE_UNAVAILABLE';
  const map = constructionEffectiveMap(frame.construction);
  if (!isWalkable(map, worker.position)) return 'UNSAFE_POSITION';
  if (!isWalkable(map, site.position)) return 'SITE_UNAVAILABLE';
  if (!isWalkable(map, storage) || claims.some(claim => claim.kind === 'entrance' && claim.key === key(storage))) return 'STORAGE_UNAVAILABLE';
  if (frame.construction.people.some(person => person.id !== workerId && !person.away && person.lifeState !== 'dead'
    && same(person.position, site.position))) return 'CLAIM_CONFLICT';
  const active = frame.upgrade.jobs.filter(live).length;
  if (frame.upgrade.jobs.length >= 128 || frame.upgrade.receipts.length + active + 2 > 256 || frame.upgrade.nextId > MAX - 2
    || frame.upgrade.revision > MAX - active - 2 || sectUpgradeAllLocalClaimsV10(frame).filter(claim => claim.kind === 'worker').length + context.externalActiveJobs >= 36
    || frame.construction.ledger.reservations.length >= 384 || context.simulationTick > MAX - 20) return 'CAPACITY_EXCEEDED';
  if (sectUpgradeCostsV10().some(line => {
    const entry = line.ledger === 'base' ? frame.construction.ledger.inventory[line.resourceId] : frame.construction.ledger.stock[line.resourceId];
    return entry.owned - entry.reserved < line.quantity;
  })) return 'INSUFFICIENT_INVENTORY';
  return null;
}

/** Exact upgrade record stage. Construction, all L1 payment history and full research DAG/work
 * are checked through strict shared leaves, with the complete reservation book intact. This is
 * still NOT complete v10 admission: L2 maintenance, production/care provenance, lifecycle,
 * legacy balances, six-owner closure and whole-envelope future headroom belong to the root. */
export function validateSectUpgradeRecordsV10(frame: SectUpgradeFrameV10,
  identities?: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  return validateUpgradeRecords(frame, identities, []);
}

/** Fixed World-owned historical validation only. Proof binds this exact unchanged World;
 * frame must equal its genuine projection. Neither an identity-only source nor a caller
 * death list can authorize system receipts. This cannot execute pre-retirement cleanup. */
export function validateWorldSectUpgradeRecordsV10(world: WorldStateV10, frame: SectUpgradeFrameV10,
  evidence: V10LifecycleRecordEvidence): readonly ConstructionValidationIssue[] {
  try {
    const deaths = historicalDeathsOfV10LifecycleEvidence(evidence, world);
    if (!isSectUpgradeDataTreeV10(frame) || !same(frame, projectV10SectFrame(world))) return [{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }];
    const identities = captureSectHistoricalIdentitiesV10(evidence, world);
    return validateUpgradeRecords(frame, identities, deaths);
  } catch { return [{ code: 'UPGRADE_DEATH_AUTHORITY_REQUIRED', path: 'upgrade' }]; }
}

/** Fixed complete prefix for the captured World record root. Derive the actual
 * projection and identities here; no supplied frame, prerequisite result, death
 * list, callback or skip flag is accepted. This is not whole-World admission.
 * Later maintenance, production, consumers, care and owner closure still run.
 * Keep the standalone wrappers above and their distinct error order unchanged. */
export function inspectWorldSectUpgradePrefixV10(world: WorldStateV10, evidence: V10LifecycleRecordEvidence): {
  readonly frame: SectUpgradeFrameV10;
  readonly identities: SectHistoricalIdentitySource;
  readonly issues: readonly ConstructionValidationIssue[];
} {
  // These stages deliberately precede the upgrade wrapper's catch boundary,
  // exactly as they did in the enclosing World owner closure.
  const identities = captureSectHistoricalIdentitiesV10(evidence, world);
  const frame = projectV10SectFrame(world);
  const result = (issues: readonly ConstructionValidationIssue[]) => ({ frame, identities, issues });
  const construction = validateWorldConstructionRecords(frame.construction, identities);
  if (construction.length) return result(construction);
  const maintenance = validateSectMaintenanceL1RecordsV10(frame); if (maintenance.length) return result(maintenance);
  const research = validateSectUpgradeResearchPrerequisitesV10(frame, identities); if (research.length) return result(research);
  try {
    // Preserve both exact-source reauthentication points and the independent
    // six-domain descriptor/projection check. Only repeated checks over this
    // same synchronous frame are omitted, not either descriptor contract.
    const deaths = historicalDeathsOfV10LifecycleEvidence(evidence, world);
    if (!isSectUpgradeDataTreeV10(frame) || !same(frame, projectV10SectFrame(world)))
      return result([{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }]);
    const upgradeIdentities = captureSectHistoricalIdentitiesV10(evidence, world);
    return result(validateUpgradeAfterWorldPrefix(frame, upgradeIdentities, deaths));
  } catch { return result([{ code: 'UPGRADE_DEATH_AUTHORITY_REQUIRED', path: 'upgrade' }]); }
}

/** Private continuation of this module's fixed complete World prefix only. */
function validateUpgradeAfterWorldPrefix(frame: SectUpgradeFrameV10, identities: SectHistoricalIdentitySource,
  deaths: readonly V10HistoricalDeathFact[]): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path = 'upgrade'): readonly ConstructionValidationIssue[] => [{ code, path }];
  try {
    if (!fields(frame, ['schemaVersion', 'construction', 'production', 'research', 'maintenance', 'care', 'upgrade'])
      || frame.schemaVersion !== 2) return fail('INVALID_SHAPE', 'frame');
    const authority = frame.construction; const tick = authority.lastSimulationTick;
    if (authority.lastCalendarTick !== tick || authority.buildings.some(building => building.level !== 1)) return fail('INVALID_CLOCK_OR_ORIGIN');
    return validateUpgradeDomainRecords(frame, identities, deaths, authority, tick);
  } catch { return fail('INVALID_UPGRADE_RECORDS'); }
}

/** Internal facts can only originate at the fixed source-bound wrapper above. */
function validateUpgradeRecords(frame: SectUpgradeFrameV10, identities: SectHistoricalIdentitySource | undefined,
  deaths: readonly V10HistoricalDeathFact[]): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path = 'upgrade'): readonly ConstructionValidationIssue[] => [{ code, path }];
  try {
    if (!isSectUpgradeDataTreeV10(frame) || !fields(frame, ['schemaVersion', 'construction', 'production', 'research', 'maintenance', 'care', 'upgrade'])
      || frame.schemaVersion !== 2) return fail('INVALID_SHAPE', 'frame');
    const construction = identities ? validateWorldConstructionRecords(frame.construction, identities) : validateConstructionRecords(frame.construction);
    if (construction.length) return construction.map(issue => ({ ...issue, path: `construction.${issue.path}` }));
    const authority = frame.construction; const tick = authority.lastSimulationTick;
    if (authority.lastCalendarTick !== tick || authority.buildings.some(building => building.level !== 1)) return fail('INVALID_CLOCK_OR_ORIGIN');
    const maintenance = validateSectMaintenanceL1RecordsV10(frame); if (maintenance.length) return maintenance;
    const research = validateSectUpgradeResearchPrerequisitesV10(frame, identities); if (research.length) return research;
    return validateUpgradeDomainRecords(frame, identities, deaths, authority, tick);
  } catch { return fail('INVALID_UPGRADE_RECORDS'); }
}

/** Shared unchanged upgrade-specific checks, reachable only after one of this
 * module's fixed complete prerequisite compositions. Never export this body. */
function validateUpgradeDomainRecords(frame: SectUpgradeFrameV10, identities: SectHistoricalIdentitySource | undefined,
  deaths: readonly V10HistoricalDeathFact[], authority: SectUpgradeFrameV10['construction'], tick: number): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path = 'upgrade'): readonly ConstructionValidationIssue[] => [{ code, path }];
  try {
    // L1's gate is an immutable historical construction prerequisite, never inferred from
    // later herbal compatibility. Check it even before this frame has any upgrade jobs.
    const basicMedicine = frame.research.jobs.find(job => job.researchId === 'basic-medicine.v9' && job.terminal?.kind === 'completed');
    for (const blueprint of authority.blueprints) {
      if (blueprint.definitionId !== 'alchemy.v9') continue;
      const source = authority.jobs.find(job => job.jobId === blueprint.jobId);
      if (!basicMedicine?.terminal || !same(blueprint.researchGate, { researchId: 'basic-medicine.v9', completionJobId: basicMedicine.jobId })
        || basicMedicine.terminal.tick > blueprint.placedTick || basicMedicine.terminal.calendarTick > blueprint.placedCalendarTick
        || source && (basicMedicine.terminal.tick > source.startedTick || basicMedicine.terminal.calendarTick > source.startedCalendarTick))
        return fail('INVALID_UPGRADE_L1_RESEARCH_SOURCE', blueprint.blueprintId);
    }
    const domain = frame.upgrade;
    if (!fields(domain, ['schemaVersion', 'protocol', 'catalogIdentity', 'revision', 'nextId', 'jobs', 'receipts'])
      || domain.schemaVersion !== 1 || domain.protocol !== 'alchemy-l1-l2.1' || !same(domain.catalogIdentity, SECT_V9_CANDIDATE_IDENTITY)
      || !integer(domain.revision) || !integer(domain.nextId) || !array(domain.jobs, SECT_UPGRADE_LIMITS_V10.records)
      || !array(domain.receipts, SECT_UPGRADE_LIMITS_V10.receipts) || domain.nextId !== domain.jobs.length * 2 + 1) return fail('INVALID_UPGRADE_DOMAIN');
    // Validate common owner-claim surfaces without pretending this authenticates their histories.
    for (const state of [frame.production, frame.research, frame.care]) if (!fields(state, ['revision', 'nextId', 'jobs', 'receipts'])
      || !array(state.jobs, 128) || !array(state.receipts, 256)) return fail('INVALID_OWNER_SURFACE', 'frame');
    const cell = (value: unknown): value is SectCell => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y)
      && value.x < authority.map.width && value.y < authority.map.height;
    const active = domain.jobs.filter(live);
    if (domain.jobs.length === 0 && (domain.revision !== 0 || domain.receipts.length !== 0)
      || domain.jobs.length > 0 && domain.receipts[0]?.revision !== 1) return fail('INVALID_UPGRADE_INITIAL_REVISION');
    if (active.length > 36 || domain.revision > MAX - active.length || domain.receipts.length + active.length > 256) return fail('UPGRADE_TERMINAL_CAPACITY');
    const costs = sectUpgradeCostsV10(); const half = costs.map(line => ({ ...line, quantity: 3 }));
    const revisions: { revision: number; tick: number; kind: 'command' | 'completion' }[] = [];
    const commandIds = new Set<string>(); let lastReceiptRevision = 0;
    const deathFact = (job: SectUpgradeJobV10): V10HistoricalDeathFact | undefined => {
      const cancellation = job.terminal?.cancellation;
      return cancellation?.kind === 'death' ? deaths.find(death => death.deathId === cancellation.deathId && death.discipleId === job.workerId) : undefined;
    };
    const authenticatedSystemCancel = (command: SectUpgradeCommandV10, jobId: string): boolean => {
      if (!fields(command, ['kind', 'commandId', 'expectedRevision', 'jobId']) || command.kind !== 'upgrade.cancel'
        || !id(command.commandId) || !integer(command.expectedRevision) || command.jobId !== jobId) return false;
      const job = domain.jobs.find(value => value.jobId === jobId);
      const fact = job && deathFact(job);
      return !!fact && command.commandId === `system/v10/death/${fact.deathId}/${jobId}`;
    };
    for (const receipt of domain.receipts) {
      if (!fields(receipt, ['command', 'revision', 'jobId'])
        || !(isSectUpgradeCommandV10(receipt.command) || authenticatedSystemCancel(receipt.command, receipt.jobId))
        || !integer(receipt.revision) || receipt.command.expectedRevision === MAX || receipt.revision !== receipt.command.expectedRevision + 1
        || receipt.revision > domain.revision || receipt.revision <= lastReceiptRevision || commandIds.has(receipt.command.commandId) || !id(receipt.jobId)) return fail('INVALID_UPGRADE_RECEIPT');
      commandIds.add(receipt.command.commandId); lastReceiptRevision = receipt.revision;
      const job = domain.jobs.find(value => value.jobId === receipt.jobId); const command = receipt.command;
      if (!job || (command.kind === 'upgrade.start' ? command.buildingId !== job.buildingId || command.workerId !== job.workerId
        : command.jobId !== job.jobId || job.terminal?.kind !== 'cancelled' || job.terminal.upgradeRevision !== receipt.revision)) return fail('INVALID_UPGRADE_RECEIPT_SOURCE', receipt.jobId);
    }
    const otherCommandIds = [...authority.receipts, ...frame.production.receipts, ...frame.research.receipts, ...frame.care.receipts]
      .map(receipt => receipt.command.commandId);
    if (otherCommandIds.some(value => commandIds.has(value))) return fail('UPGRADE_COMMAND_COLLISION');
    const externalIds = new Set([...authority.people.map(value => value.id), ...authority.legacyStations.map(value => value.id),
      ...authority.buildings.map(value => value.buildingId), ...authority.blueprints.map(value => value.blueprintId), ...authority.jobs.map(value => value.jobId),
      ...frame.production.jobs.map(value => value.transactionId), ...frame.research.jobs.map(value => value.jobId),
      ...frame.care.jobs.map(value => value.jobId), ...frame.maintenance.payments.map(value => value.paymentId)]);
    let previousStartTick = 0; let previousStartRevision = 0;
    const history: SectUpgradeJobV10[] = [];
    for (const [index, job] of domain.jobs.entries()) {
      if (!fields(job, ['jobId', 'reservationId', 'workerId', 'buildingId', 'fromLevel', 'toLevel', 'requiredTicks', 'researchGate', 'site', 'storageId',
        'storagePosition', 'seatToken', 'entranceToken', 'startedTick', 'startedCalendarTick', 'origin', 'phase', 'storageVisit', 'siteVisits',
        'workSpans', 'checkpoints', 'activeTicks', 'navigation', 'blocked', 'terminal'])
        || job.jobId !== `sect-upgrade:${index * 2 + 1}` || job.reservationId !== `sect-upgrade-reservation:${index * 2 + 2}`
        || externalIds.has(job.jobId) || externalIds.has(job.reservationId) || !id(job.workerId) || !id(job.buildingId) || !id(job.storageId)
        || !id(job.seatToken) || !id(job.entranceToken) || job.fromLevel !== 1 || job.toLevel !== 2 || job.requiredTicks !== 400
        || !integer(job.startedTick) || job.startedTick > tick || job.startedCalendarTick !== job.startedTick || !cell(job.origin) || !cell(job.storagePosition)
        || !integer(job.activeTicks) || job.activeTicks > 400 || !['to-storage', 'to-site', 'working', 'completed', 'cancelled'].includes(job.phase)
        || ![null, 'PATH_BLOCKED', 'PATH_BUDGET', 'WORKER_UNAVAILABLE', 'ENTRANCE_BUSY', 'STORAGE_UNAVAILABLE', 'SITE_UNAVAILABLE', 'MAINTENANCE_UNPAID', 'VISIT_CAPACITY'].includes(job.blocked)
        || !array(job.siteVisits, 401) || !array(job.workSpans, 400) || !array(job.checkpoints, 2)) return fail('INVALID_UPGRADE_JOB');
      const starts = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'upgrade.start');
      const cancels = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'upgrade.cancel');
      if (starts.length !== 1 || cancels.length !== (job.terminal?.kind === 'cancelled' ? 1 : 0)
        || starts[0]!.revision <= previousStartRevision || job.startedTick < previousStartTick) return fail('INVALID_UPGRADE_COMMAND_CHRONOLOGY', job.jobId);
      const startRevision = starts[0]!.revision; previousStartRevision = startRevision; previousStartTick = job.startedTick;
      revisions.push({ revision: startRevision, tick: job.startedTick, kind: 'command' });
      const worker = authority.people.find(value => value.id === job.workerId);
      if (!worker && !isArchivedSectWorkerReference(identities, job.workerId, job.terminal)) return fail('INVALID_UPGRADE_WORKER_REFERENCE', job.jobId);
      // This worker's first unavailable boundary mandates the pre-work death batch.
      // A player reason/receipt cannot launder that same-tick cancellation; earlier
      // requested terminals and another worker's global pause remain legal.
      const unavailable = deaths.find(death => death.discipleId === job.workerId);
      if (unavailable && (job.terminal === null || job.startedTick >= unavailable.unavailableTick
        || job.storageVisit && job.storageVisit.tick >= unavailable.unavailableTick
        || job.siteVisits.some(visit => visit.tick >= unavailable.unavailableTick)
        || job.workSpans.some(span => span.lastTick >= unavailable.unavailableTick)
        || job.terminal.tick > unavailable.unavailableTick
        || job.terminal.tick === unavailable.unavailableTick
          && (job.terminal.kind !== 'cancelled' || job.terminal.cancellation?.kind !== 'death'))) return fail('INVALID_UPGRADE_LIFETIME', job.jobId);
      const site = sectUpgradeSiteFromRecordsV10(frame, job.buildingId);
      if (!site || !fields(job.site, ['buildingId', 'definitionId', 'sourceJobId', 'position', 'level', 'firstMaintenanceCalendarTick'])
        || !same(job.site, site) || job.seatToken !== job.buildingId || job.entranceToken !== key(site.position)) return fail('INVALID_UPGRADE_SITE_SOURCE', job.jobId);
      const building = authority.buildings.find(value => value.buildingId === job.buildingId)!;
      const source = authority.jobs.find(value => value.jobId === building.sourceJobId)!;
      const blueprint = authority.blueprints.find(value => value.blueprintId === source.blueprintId);
      const basic = frame.research.jobs.find(value => value.researchId === 'basic-medicine.v9' && value.terminal?.kind === 'completed');
      if (!blueprint || blueprint.definitionId !== 'alchemy.v9' || blueprint.jobId !== source.jobId || !basic?.terminal
        || !same(blueprint.researchGate, { researchId: 'basic-medicine.v9', completionJobId: basic.jobId })
        || basic.terminal.tick > blueprint.placedTick || basic.terminal.calendarTick > blueprint.placedCalendarTick
        || basic.terminal.tick > source.startedTick || basic.terminal.calendarTick > source.startedCalendarTick) return fail('INVALID_UPGRADE_L1_RESEARCH_SOURCE', job.jobId);
      if (source.terminal!.tick > job.startedTick || source.terminal!.calendarTick > job.startedCalendarTick
        || !sectBuildingL1PaidRangeV10(frame, job.buildingId, job.startedTick, job.startedTick, job.startedTick, job.startedTick)) return fail('INVALID_UPGRADE_PAID_START', job.jobId);
      const gate = sectUpgradeGateFromRecordsV10(frame, job.startedTick);
      if (!fields(job.researchGate, ['researchId', 'completionJobId']) || !same(job.researchGate, gate)) return fail('INVALID_UPGRADE_RESEARCH_GATE', job.jobId);
      const storage = authority.legacyStations.find(value => value.id === job.storageId && value.blueprintId === 'storage');
      if (!storage || !same(job.storagePosition, { x: storage.x, y: storage.y })) return fail('INVALID_UPGRADE_STORAGE', job.jobId);
      const predecessorOverlap = history.some(previous => (previous.buildingId === job.buildingId || previous.workerId === job.workerId)
        && (!previous.terminal || previous.terminal.tick > job.startedTick || previous.terminal.upgradeRevision >= startRevision));
      if (predecessorOverlap || history.some(previous => previous.buildingId === job.buildingId && previous.terminal?.kind === 'completed')) return fail('UPGRADE_OVERLAP', job.jobId);
      const endTick = job.terminal?.tick ?? MAX;
      const overlaps = (started: number, terminal: { readonly tick: number } | null): boolean =>
        (terminal === null || terminal.tick > job.startedTick) && (job.terminal === null || started < endTick);
      if (frame.production.jobs.some(other => other.productiveSite.siteId === job.buildingId && overlaps(other.startedTick, other.terminal))
        || frame.research.jobs.some(other => other.site.buildingId === job.buildingId && overlaps(other.startedTick, other.terminal))) return fail('UPGRADE_PRODUCTIVE_SITE_OVERLAP', job.jobId);
      if (authority.jobs.some(other => other.workerId === job.workerId && overlaps(other.startedTick, other.terminal))
        || frame.production.jobs.some(other => other.workerId === job.workerId && overlaps(other.startedTick, other.terminal))
        || frame.research.jobs.some(other => other.workerId === job.workerId && overlaps(other.startedTick, other.terminal))
        || frame.care.jobs.some(other => other.patientId === job.workerId && overlaps(other.startedTick, other.terminal))) return fail('UPGRADE_WORKER_HISTORY_OVERLAP', job.jobId);
      const visit = (value: unknown): value is { tick: number; calendarTick: number; position: SectCell } => fields(value, ['tick', 'calendarTick', 'position'])
        && integer(value.tick) && value.tick <= tick && value.calendarTick === value.tick && cell(value.position);
      if (job.storageVisit !== null && (!visit(job.storageVisit) || !same(job.storageVisit.position, job.storagePosition)
        || job.storageVisit.tick - job.startedTick < Math.max(1, cardinalDistance(job.origin, job.storagePosition) * MOVEMENT_TICKS_PER_CELL))) return fail('INVALID_UPGRADE_STORAGE_VISIT', job.jobId);
      let lastVisitTick = job.storageVisit?.tick ?? job.startedTick;
      for (const [visitIndex, value] of job.siteVisits.entries()) {
        if (!job.storageVisit || !visit(value) || !same(value.position, site.position) || value.tick <= lastVisitTick
          || visitIndex === 0 && value.tick - job.storageVisit.tick < Math.max(1, cardinalDistance(job.storagePosition, site.position) * MOVEMENT_TICKS_PER_CELL)) return fail('INVALID_UPGRADE_SITE_VISIT', job.jobId);
        lastVisitTick = value.tick;
      }
      let count = 0; let lastTick = job.startedTick; let lastVisitIndex = -1;
      const ordinal = new Map<number, number>();
      for (const span of job.workSpans) {
        if (!fields(span, ['firstTick', 'lastTick', 'firstCalendarTick', 'lastCalendarTick', 'visitIndex']) || !integer(span.firstTick) || !integer(span.lastTick)
          || span.firstCalendarTick !== span.firstTick || span.lastCalendarTick !== span.lastTick || span.firstTick <= lastTick || span.lastTick < span.firstTick
          || span.lastTick > tick || !integer(span.visitIndex) || span.visitIndex >= job.siteVisits.length || span.visitIndex < lastVisitIndex
          || span.firstTick <= job.siteVisits[span.visitIndex]!.tick || job.siteVisits[span.visitIndex + 1] && span.lastTick >= job.siteVisits[span.visitIndex + 1]!.tick
          || lastVisitIndex === span.visitIndex && span.firstTick - lastTick === 1
          || !sectBuildingL1PaidRangeV10(frame, job.buildingId, span.firstTick, span.lastTick, span.firstCalendarTick, span.lastCalendarTick)) return fail('INVALID_UPGRADE_WORK', job.jobId);
        const length = span.lastTick - span.firstTick + 1;
        if (length > 400 - count) return fail('INVALID_UPGRADE_WORK', job.jobId);
        for (const checkpoint of [200, 400]) if (count < checkpoint && count + length >= checkpoint) ordinal.set(checkpoint, span.firstTick + (checkpoint - count - 1));
        count += length; lastTick = span.lastTick; lastVisitIndex = span.visitIndex;
      }
      if (count !== job.activeTicks || job.phase === 'working' && !job.siteVisits.length) return fail('INVALID_UPGRADE_WORK', job.jobId);
      const checkpoints = count >= 400 ? 2 : count >= 200 ? 1 : 0;
      if (job.checkpoints.length !== checkpoints) return fail('INVALID_UPGRADE_CHECKPOINTS', job.jobId);
      for (const [n, checkpoint] of job.checkpoints.entries()) {
        const activeTicks = n === 0 ? 200 : 400;
        if (!fields(checkpoint, ['tick', 'calendarTick', 'position', 'checkpointId', 'activeTicks'])
          || checkpoint.activeTicks !== activeTicks || checkpoint.checkpointId !== (n === 0 ? 'construction.half' : 'construction.remainder')
          || checkpoint.tick !== ordinal.get(activeTicks) || checkpoint.calendarTick !== checkpoint.tick || !same(checkpoint.position, site.position)) return fail('INVALID_UPGRADE_CHECKPOINT_WORK', job.jobId);
      }
      const claims = authority.ledger.reservations.filter(claim => claim.ownerTransactionId === job.jobId || claim.reservationId === job.reservationId);
      const claim = claims[0];
      if (claims.length !== 1 || !claim || claim.ownerTransactionId !== job.jobId || claim.reservationId !== job.reservationId
        || claim.policy !== 'construction-checkpoints' || !same(sectReservationLines(claim, 'lines'), costs)
        || claim.base.checkpoints.length !== checkpoints || claim.sect.checkpoints.length !== checkpoints
        || !same(sectReservationLines(claim, 'consumed'), count >= 400 ? costs : count >= 200 ? half : [])) return fail('INVALID_UPGRADE_COST_SOURCE', job.jobId);
      const nav = job.navigation;
      const target = job.phase === 'to-storage' ? job.storagePosition : site.position;
      if (!fields(nav, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !array(nav.path, authority.map.width * authority.map.height)
        || nav.path.some(position => !cell(position)) || !(nav.target === null || cell(nav.target) && same(nav.target, target))
        || !(nav.routeVersion === null || integer(nav.routeVersion) && nav.routeVersion <= authority.map.navVersion)
        || !integer(nav.movementTicks) || nav.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(nav.retryAtTick)
        || nav.path.some((position, n) => n > 0 && cardinalDistance(position, nav.path[n - 1]!) !== 1)
        || nav.path.length && (nav.target === null || nav.routeVersion === null || !same(nav.path.at(-1), nav.target))
        || !nav.path.length && nav.movementTicks !== 0) return fail('INVALID_UPGRADE_NAVIGATION', job.jobId);
      if (job.terminal === null) {
        if (!worker || !['to-storage', 'to-site', 'working'].includes(job.phase) || count >= 400 || claim.base.settlement !== null || claim.sect.settlement !== null
          || !same(sectReservationLines(claim, 'remainingReservation'), count >= 200 ? half : costs)
          || job.phase === 'to-storage' && (job.storageVisit !== null || job.siteVisits.length || count)
          || job.phase !== 'to-storage' && job.storageVisit === null
          || job.phase === 'working' && !same(nav, emptyNavigation())
          || nav.path.length && nav.routeVersion === authority.map.navVersion && cardinalDistance(worker.position, nav.path[0]!) !== 1) return fail('INVALID_ACTIVE_UPGRADE', job.jobId);
      } else {
        const terminal = job.terminal;
        if (!fields(terminal, ['tick', 'calendarTick', 'position', 'consumed', 'released', 'upgradeRevision', 'kind', 'previousPhase', 'resultLevel', 'cancellation'])
          || !['completed', 'cancelled'].includes(terminal.kind) || job.phase !== terminal.kind || !integer(terminal.tick) || terminal.tick > tick
          || terminal.calendarTick !== terminal.tick || terminal.tick < Math.max(job.startedTick, lastVisitTick, lastTick) || !cell(terminal.position)
          || !integer(terminal.upgradeRevision) || terminal.upgradeRevision <= startRevision || terminal.upgradeRevision > domain.revision
          || !['to-storage', 'to-site', 'working'].includes(terminal.previousPhase)
          || terminal.previousPhase === 'to-storage' && (job.storageVisit !== null || count || job.siteVisits.length)
          || terminal.previousPhase !== 'to-storage' && !job.storageVisit || terminal.previousPhase === 'working' && !job.siteVisits.length
          || !same(terminal.consumed, sectReservationLines(claim, 'consumed')) || !array(terminal.released, 2)
          || !same(nav, emptyNavigation()) || job.blocked !== null || sectReservationLines(claim, 'remainingReservation').length) return fail('INVALID_UPGRADE_TERMINAL', job.jobId);
        if (terminal.kind === 'completed') {
          if (terminal.resultLevel !== 2 || terminal.previousPhase !== 'working' || terminal.cancellation !== null || count !== 400 || terminal.tick !== lastTick
            || !same(terminal.position, site.position) || terminal.released.length || !same(terminal.consumed, costs)
            || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
            || claim.base.settlement.operationId !== `complete:${job.jobId}` || claim.sect.settlement.operationId !== `complete:${job.jobId}`
            || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length) return fail('INVALID_UPGRADE_COMPLETION', job.jobId);
          revisions.push({ revision: terminal.upgradeRevision, tick: terminal.tick, kind: 'completion' });
        } else {
          if (terminal.cancellation?.kind === 'death') {
            const fact = deathFact(job);
            if (!fact || !fields(terminal.cancellation, ['kind', 'deathId'])
              || terminal.tick !== fact.unavailableTick || terminal.calendarTick !== fact.unavailableCalendarTick
              || cancels[0]!.command.commandId !== `system/v10/death/${fact.deathId}/${job.jobId}`
              || job.storageVisit && job.storageVisit.tick >= fact.unavailableTick
              || job.siteVisits.some(visit => visit.tick >= fact.unavailableTick)
              || job.workSpans.some(span => span.lastTick >= fact.unavailableTick)) return fail('UPGRADE_DEATH_AUTHORITY_REQUIRED', job.jobId);
          } else if (!fields(terminal.cancellation, ['kind']) || terminal.cancellation.kind !== 'requested'
            || !isSectUpgradeCommandV10(cancels[0]!.command)) return fail('INVALID_UPGRADE_CANCELLATION', job.jobId);
          if (terminal.resultLevel !== 1 || count >= 400 || !same(terminal.released, count >= 200 ? half : costs)
            || cancels[0]!.revision !== terminal.upgradeRevision || cancels[0]!.revision <= startRevision
            || claim.base.settlement?.kind !== 'released' || claim.sect.settlement?.kind !== 'released'
            || claim.base.settlement.operationId !== `cancel:${job.jobId}` || claim.sect.settlement.operationId !== `cancel:${job.jobId}`) return fail('INVALID_UPGRADE_CANCELLATION', job.jobId);
          revisions.push({ revision: terminal.upgradeRevision, tick: terminal.tick, kind: 'command' });
        }
      }
      history.push(job);
    }
    const anchors = revisions.slice().sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < anchors.length; i++) {
      const before = anchors[i - 1]!; const after = anchors[i]!;
      if (after.tick < before.tick || after.revision === before.revision && (after.tick !== before.tick || after.kind !== 'completion' || before.kind !== 'completion'))
        return fail('INVALID_UPGRADE_REVISION_CHRONOLOGY');
    }
    const claims = sectUpgradeAllLocalClaimsV10(frame);
    if (sectUpgradeClaimsConflictV10(claims)) return fail('UPGRADE_CLAIM_CONFLICT');
    if (claims.filter(claim => claim.kind === 'worker').length > 36) return fail('UPGRADE_ACTIVE_LIMIT');
    return [];
  } catch { return fail('INVALID_UPGRADE_RECORDS'); }
}
