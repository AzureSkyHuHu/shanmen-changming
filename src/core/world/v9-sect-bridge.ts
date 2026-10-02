import { SECT_RESOURCE_IDS } from '../../content/sect-v9/types';
import { createWorkPathBudget, type WorkPathBudget } from '../agents/work-navigation';
import { liveProductionAt } from '../economy/automatic-production';
import { createLegacyProductionContext } from '../economy/production';
import { runProductionPhases } from '../economy/production-context';
import { RESOURCE_IDS } from '../economy/types';
import { isPaused } from '../kernel/clock';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import { closeWorldEconomyOwnerLinks, type WorldEconomyRecords } from '../kernel/world-economy-records';
import { applyValidatedConstructionCommand, constructionEffectiveMap, tickValidatedConstruction } from '../sect-expansion/construction-runtime';
import type { ConstructionClaim, ConstructionContext, ConstructionPerson } from '../sect-expansion/construction-types';
import { captureSectHistoricalIdentitiesV9 } from '../sect-expansion/history-identity';
import { ownSectFields } from '../sect-expansion/layout';
import { tickValidatedSectMaintenancePayment } from '../sect-expansion/maintenance';
import type { SectMaintenanceFrame } from '../sect-expansion/maintenance-types';
import { validateWorldSectMaintenanceRecords } from '../sect-expansion/maintenance-validation';
import { applyValidatedSectProductionCommand, sectProductionClaims, tickValidatedSectProduction } from '../sect-expansion/production-runtime';
import { applyValidatedSectResearchCommand, tickValidatedSectResearch } from '../sect-expansion/research-runtime';
import { sectAllLocalClaims, sectClaimsConflict, sectResearchClaims } from '../sect-expansion/research-validation';
import type { SectCareFrameV9, SectExpansionOwnedRecordsV9 } from '../sect-expansion/care-types';
import { applyValidatedCareCommandV9, sectCareClaims, tickValidatedCareV9, v9CarePatientEligible } from '../sect-expansion/care-runtime';
import { validateCareOwnerClosureV9, validateCareRecordsV9 } from '../sect-expansion/care-validation';
import { lookupEvent, lookupCommandReceipt } from './history-access';
import { isCultivationWorkerAvailable } from './cultivation-bridge';
import type { SectCommandV9 } from '../kernel/contracts-v9';
import type { V9LifecycleRecordEvidence } from './v9-lifecycle-records';
import type { WorldStateV9 } from './v9-types';

/** Single explicit v9 work-owner union, including non-worker patient care. */
export type V9WorkOwner = { kind: 'legacy-production' | 'construction' | 'sect-production' | 'research' | 'care'; id: string; workerId: string };
export function v9WorkOwners(world: WorldStateV9): V9WorkOwner[] {
  return [
    ...world.activeProductionTransactionIds.map(id => ({ kind: 'legacy-production' as const, id, workerId: liveProductionAt(world, id)!.transaction.workerId })),
    ...world.sectExpansion.construction.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'construction' as const, id: job.jobId, workerId: job.workerId })),
    ...world.sectExpansion.production.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'sect-production' as const, id: job.transactionId, workerId: job.workerId })),
    ...world.sectExpansion.research.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'research' as const, id: job.jobId, workerId: job.workerId })),
    ...world.sectExpansion.care.jobs.filter(job => job.terminal === null).map(job => ({ kind: 'care' as const, id: job.jobId, workerId: job.patientId })),
  ];
}
export function v9WorkerAvailable(world: WorldStateV9, workerId: string): boolean {
  const actor = world.disciples.find(actor => actor.id === workerId);
  return !!actor && actor.canWork && !actor.traveling && isCultivationWorkerAvailable(world, workerId)
    && !world.builds.disciples.find(member => member.discipleId === workerId)?.lock
    && !v9WorkOwners(world).some(owner => owner.workerId === workerId);
}
export function v9SectContext(world: WorldStateV9): ConstructionContext {
  const claims: ConstructionClaim[] = [];
  for (const id of world.activeProductionTransactionIds.slice().sort(compareStable)) {
    const job = liveProductionAt(world, id)!.transaction;
    claims.push({ kind: 'worker', key: job.workerId, ownerId: id });
    if (job.storageId !== null) {
      const storage = world.buildings.find(site => site.id === job.storageId)!;
      const key = `${storage.x},${storage.y}`;
      if (!claims.some(claim => claim.kind === 'entrance' && claim.key === key)) claims.push({ kind: 'entrance', key, ownerId: id });
    }
  }
  for (const site of world.buildings) if (site.stationTransactionId !== null) {
    claims.push({ kind: 'seat', key: site.id, ownerId: site.stationTransactionId });
    const key = `${site.x},${site.y}`;
    if (!claims.some(claim => claim.kind === 'entrance' && claim.key === key)) claims.push({ kind: 'entrance', key, ownerId: site.stationTransactionId });
  }
  return { simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick, mode: world.clock.mode,
    paused: isPaused(world.clock), expeditionActive: false, externalActiveJobs: world.activeProductionTransactionIds.length, externalClaims: claims };
}
/** Borrow real authority only for a synchronous internal stage. No second current map,
 * people, base ledger or clock is persisted. An active sect owner owns its own travel. */
export function projectV9SectFrame(world: WorldStateV9): SectCareFrameV9 {
  const records = world.sectExpansion;
  const owners = v9WorkOwners(world);
  const people = world.disciples.map((actor): ConstructionPerson => {
    const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    const build = world.builds.disciples.find(member => member.discipleId === actor.id)!;
    const student = world.cultivation.disciples.find(member => member.teaching?.studentId === actor.id);
    return { id: actor.id, position: actor.position, lifeState: profile.lifeState,
      canWork: actor.canWork && profile.trainingMode === 'duty' && (!actor.traveling || owners.some(owner => owner.workerId === actor.id && owner.kind !== 'legacy-production')),
      away: profile.activityOwner !== null, productionTransactionId: actor.assignmentTransactionId,
      cultivationOwnerId: profile.activeAttemptId ?? profile.teaching?.teachingId ?? student?.teaching?.teachingId ?? profile.activityOwner?.lockId ?? null,
      otherOwnerId: build.lock?.lockId ?? null };
  });
  return { schemaVersion: 1, construction: { ...records.construction, map: world.map, people,
    lastSimulationTick: world.clock.simulationTick, lastCalendarTick: world.clock.calendarTick,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    ledger: { inventory: world.inventory, stock: records.stock, reservations: records.reservations } },
    production: records.production, research: records.research, maintenance: records.maintenance, care: records.care };
}
export function ownedV9SectRecords(frame: SectCareFrameV9): SectExpansionOwnedRecordsV9 {
  const { schemaVersion, catalogIdentity, revision, nextId, blueprints, jobs, buildings, receipts } = frame.construction;
  return { schemaVersion: 1, construction: { schemaVersion, catalogIdentity, revision, nextId, blueprints, jobs, buildings, receipts },
    stock: frame.construction.ledger.stock, reservations: frame.construction.ledger.reservations,
    production: frame.production, research: frame.research, maintenance: frame.maintenance, care: frame.care };
}
export function composeV9SectFrame(world: WorldStateV9, frame: SectCareFrameV9): WorldStateV9 {
  const records = ownedV9SectRecords(frame);
  return { ...world, map: frame.construction.map, inventory: frame.construction.ledger.inventory, sectExpansion: records,
    disciples: world.disciples.map(actor => {
      const person = frame.construction.people.find(person => person.id === actor.id)!;
      if (actor.assignmentTransactionId !== null || records.care.jobs.some(job => job.patientId === actor.id && !job.terminal)) return actor;
      const jobs = [...records.construction.jobs, ...records.production.jobs, ...records.research.jobs];
      const job = jobs.find(job => job.workerId === actor.id && job.terminal === null);
      return { ...actor, position: { ...person.position }, traveling: !!job && job.navigation.path.length > 0 && (('state' in job ? job.blockedReason === null : job.blocked === null)) };
    }) };
}
export function inspectV9SectOwnerClosure(world: WorldStateV9, economy: WorldEconomyRecords, lifecycle: V9LifecycleRecordEvidence): string[] {
  const records = world.sectExpansion;
  if (!ownSectFields(records, ['schemaVersion', 'construction', 'stock', 'reservations', 'production', 'research', 'maintenance', 'care']) || records.schemaVersion !== 1
    || !ownSectFields(records.construction, ['schemaVersion', 'catalogIdentity', 'revision', 'nextId', 'blueprints', 'jobs', 'buildings', 'receipts'])) return ['Invalid v9 owned records'];
  const frame = projectV9SectFrame(world);
  const identities = captureSectHistoricalIdentitiesV9(lifecycle);
  // Keep the original record-only view and ALL shared reservations. The old exact
  // four-owner root remains strict; only this version authenticates the fifth owner.
  const maintenanceView: SectMaintenanceFrame = { schemaVersion: 1, construction: frame.construction, production: frame.production, research: frame.research, maintenance: frame.maintenance };
  const issues = validateWorldSectMaintenanceRecords(maintenanceView, identities);
  if (issues.length) return issues.map(issue => `${issue.code}:${issue.path}`);
  const careIssues = validateCareRecordsV9(world, maintenanceView, identities);
  if (careIssues.length) return careIssues.map(issue => `${issue.code}:${issue.path}`);
  // This protocol has never run combat: every persisted paired clock is on the
  // same genesis timeline, including records with no completed-building anchor yet.
  const paired: readonly (readonly [number, number])[] = [
    ...records.construction.blueprints.map(bp => [bp.placedTick, bp.placedCalendarTick] as const),
    ...records.construction.jobs.flatMap(job => [[job.startedTick, job.startedCalendarTick] as const,
      ...(job.terminal ? [[job.terminal.tick, job.terminal.calendarTick] as const] : [])]),
    ...records.construction.buildings.map(building => [building.completedTick, building.completedCalendarTick] as const),
    ...records.production.jobs.flatMap(job => [[job.startedTick, job.startedCalendarTick] as const,
      ...[job.workVisit, job.deliveryVisit, job.terminal].filter(value => value !== null).map(value => [value.tick, value.calendarTick] as const),
      ...job.workSpans.flatMap(span => [[span.firstTick, span.firstCalendarTick] as const, [span.lastTick, span.lastCalendarTick] as const])]),
    ...records.research.jobs.flatMap(job => [[job.startedTick, job.startedCalendarTick] as const,
      ...job.visits.map(visit => [visit.tick, visit.calendarTick] as const),
      ...(job.terminal ? [[job.terminal.tick, job.terminal.calendarTick] as const] : []),
      ...job.workSpans.flatMap(span => [[span.firstTick, span.firstCalendarTick] as const, [span.lastTick, span.lastCalendarTick] as const])]),
    ...records.maintenance.payments.map(payment => [payment.paidTick, payment.paidCalendarTick] as const),
  ];
  if (paired.some(([tick, calendar]) => tick !== calendar)) return ['V9 management historical clocks differ'];
  const local = validateCareOwnerClosureV9(world, maintenanceView); if (local.length) return local.map(issue => `${issue.code}:${issue.path}`);
  const old = closeWorldEconomyOwnerLinks(economy); if (!old.ok) return old.errors;
  for (const id of RESOURCE_IDS) {
    const sect = records.reservations.reduce((sum, claim) => sum + (claim.base.remainingReservation.find(line => line.resourceId === id)?.quantity ?? 0), 0);
    const total = old.claims.reservedTotals[id] + sect;
    if (!Number.isSafeInteger(total) || world.inventory[id].reserved !== total) return ['V9 shared reservation total differs'];
  }
  for (const id of SECT_RESOURCE_IDS) {
    const owned = records.reservations.reduce((sum, claim) => sum - (claim.sect.consumed.find(line => line.resourceId === id)?.quantity ?? 0)
      + (claim.sect.settlement?.kind === 'committed' ? claim.sect.settlement.outputs.find(line => line.resourceId === id)?.quantity ?? 0 : 0), 0);
    if (!Number.isSafeInteger(owned) || records.stock[id].owned !== owned) return ['V9 zero-genesis stock provenance differs'];
  }
  const owners = v9WorkOwners(world); const localClaims = [...sectAllLocalClaims(frame), ...sectCareClaims(world)];
  if (owners.length > 36 || new Set(owners.map(owner => owner.workerId)).size !== owners.length
    || sectClaimsConflict([...v9SectContext(world).externalClaims, ...localClaims])) return ['V9 work claims conflict'];
  for (const owner of owners) {
    if (owner.kind === 'care') { if (!v9CarePatientEligible(world, owner.workerId, owner.id)) return ['V9 live patient unavailable']; continue; }
    const actor = world.disciples.find(actor => actor.id === owner.workerId);
    if (!actor || !actor.canWork || !isCultivationWorkerAvailable(world, owner.workerId)
      || world.builds.disciples.find(member => member.discipleId === owner.workerId)?.lock) return ['V9 live worker unavailable'];
  }
  const commandIds = new Set<string>();
  const domainReceipts = [...records.construction.receipts, ...records.production.receipts, ...records.research.receipts, ...records.care.receipts];
  for (const receipt of domainReceipts) {
    if (commandIds.has(receipt.command.commandId) || lookupCommandReceipt(world, receipt.command.commandId)) return ['V9 command identity has multiple owners'];
    commandIds.add(receipt.command.commandId);
    if (receipt.command.kind.startsWith('care.')) continue; // Its exact system cancellation source is authenticated by the care leaf.
    if (receipt.command.commandId.startsWith('system/v9/')) {
      const command = receipt.command;
      const job = command.kind === 'construction.cancel' ? records.construction.jobs.find(job => job.blueprintId === command.blueprintId)
        : command.kind === 'production.cancel' ? records.production.jobs.find(job => job.transactionId === command.jobId)
        : command.kind === 'research.cancel' ? records.research.jobs.find(job => job.jobId === command.jobId) : undefined;
      if (!job || job.terminal?.kind !== 'cancelled') return ['Invalid lifecycle cancellation'];
      const death = [...world.cultivation.pendingDeaths, ...world.cultivation.deaths].find(death => death.discipleId === job.workerId);
      const event = world.cultivation.events.find(event => event.discipleId === job.workerId && event.relatedId === death?.deathId
        && (event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.died'));
      const mirror = event && lookupEvent(world, event.eventId);
      // The complete event may be archived; resolve through the normal history reader below.
      const jobId = 'transactionId' in job ? job.transactionId : job.jobId;
      if (!death || command.commandId !== `system/v9/death/${death.deathId}/${jobId}` || !event
        || !mirror || mirror.tick !== job.terminal.tick) return ['Lifecycle cancellation source differs'];
    }
  }
  return [];
}

/** Internal stages return candidates only. The version root authenticates source and result. */
export function applyV9SectStage(world: WorldStateV9, command: SectCommandV9): { world: WorldStateV9; relatedId: string | null; repeated: boolean } | { code: string } {
  const frame = projectV9SectFrame(world); const baseContext = v9SectContext(world);
  if (command.domain === 'care') return applyValidatedCareCommandV9(world, frame, baseContext, command.command);
  const context = { ...baseContext, externalActiveJobs: baseContext.externalActiveJobs + world.sectExpansion.care.jobs.filter(job => !job.terminal).length,
    externalClaims: [...baseContext.externalClaims, ...sectCareClaims(world)] };
  if (command.domain === 'construction') {
    const result = applyValidatedConstructionCommand(frame.construction, { ...context,
      externalActiveJobs: context.externalActiveJobs + frame.production.jobs.filter(job => !job.terminal).length + frame.research.jobs.filter(job => !job.terminal).length,
      externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, command.command, frame);
    return result.ok ? { world: result.repeated ? world : composeV9SectFrame(world, { ...frame, construction: result.frame }), relatedId: result.relatedId, repeated: result.repeated } : { code: result.code };
  }
  if (command.domain === 'production') {
    const result = applyValidatedSectProductionCommand(frame, { ...context, externalActiveJobs: context.externalActiveJobs + frame.research.jobs.filter(job => !job.terminal).length,
      externalClaims: [...context.externalClaims, ...sectResearchClaims(frame)] }, command.command, frame, frame);
    return result.ok ? { world: result.repeated ? world : composeV9SectFrame(world, { ...frame, construction: result.frame.construction, production: result.frame.production }), relatedId: result.jobId, repeated: result.repeated } : { code: result.code };
  }
  const result = applyValidatedSectResearchCommand(frame, context, command.command, frame);
  return result.ok ? { world: result.repeated ? world : composeV9SectFrame(world, { ...frame, construction: result.frame.construction, research: result.frame.research }), relatedId: result.jobId, repeated: result.repeated } : { code: result.code };
}
function prepareSectStages(world: WorldStateV9, budget: WorkPathBudget, growth: 'normal' | 'no-optional-growth'): WorldStateV9 {
  if (isPaused(world.clock)) return world;
  const frame = projectV9SectFrame(world); const baseContext = v9SectContext(world);
  const context = { ...baseContext, externalActiveJobs: baseContext.externalActiveJobs + world.sectExpansion.care.jobs.filter(job => !job.terminal).length,
    externalClaims: [...baseContext.externalClaims, ...sectCareClaims(world)] };
  const researchActive = frame.research.jobs.filter(job => !job.terminal).length;
  const construction = tickValidatedConstruction(frame.construction, { ...context,
    externalActiveJobs: context.externalActiveJobs + researchActive + frame.production.jobs.filter(job => !job.terminal).length,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, budget, frame);
  if (!construction.ok) throw new RangeError(construction.code);
  const constructed = { ...frame, construction: construction.frame };
  const maintained = growth === 'normal' ? tickValidatedSectMaintenancePayment(constructed, context) : constructed;
  const production = tickValidatedSectProduction(maintained, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive,
    externalClaims: [...context.externalClaims, ...sectResearchClaims(maintained)] }, budget, maintained, maintained);
  const afterProduction = { ...maintained, construction: production.construction, production: production.production };
  const research = tickValidatedSectResearch(afterProduction, context, budget, afterProduction);
  const composed = composeV9SectFrame(world, { ...afterProduction, construction: research.construction, research: research.research, care: frame.care });
  return tickValidatedCareV9(composed, projectV9SectFrame(composed), v9SectContext(composed), budget);
}
/** Normal funded order is unchanged: construction, maintenance, production, research, care. */
export function tickV9SectStages(world: WorldStateV9, budget: WorkPathBudget): WorldStateV9 {
  return prepareSectStages(world, budget, 'normal');
}
/** Internal recovery preparation. It never changes maintenance permissions or saves
 * a disabled setting; the owning gate retries this path from the unchanged boundary. */
export function prepareV9SectStagesWithoutOptionalGrowth(world: WorldStateV9, budget: WorkPathBudget): WorldStateV9 {
  return prepareSectStages(world, budget, 'no-optional-growth');
}
/** Old recipe/state machines remain unchanged; only their actual movement/site view is bound
 * to v9's authoritative footprint and exclusive expansion claims. One budget is shared. */
export function tickV9LegacyProduction(world: WorldStateV9, budget = createWorkPathBudget(world.clock.simulationTick)): WorldStateV9 {
  const stages = createLegacyProductionContext<WorldStateV9>();
  const free = (candidate: WorldStateV9, id: string, position: { x: number; y: number }): boolean =>
    ![...sectAllLocalClaims(projectV9SectFrame(candidate)), ...sectCareClaims(candidate)].some(claim => claim.kind === 'seat' && claim.key === id || claim.kind === 'entrance' && claim.key === `${position.x},${position.y}`);
  return runProductionPhases(world, { ...stages,
    view: candidate => ({ ...stages.view(candidate), map: constructionEffectiveMap(projectV9SectFrame(candidate).construction) }),
    workSites: (candidate, recipe) => stages.workSites(candidate, recipe).filter(site => free(candidate, site.id, site.position)),
    storageSites: candidate => stages.storageSites(candidate).filter(site => free(candidate, site.id, site.position)),
  }, budget);
}
export const sameV9SectCommand = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
