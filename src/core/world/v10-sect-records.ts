import { SECT_RESOURCE_IDS } from '../../content/sect-v9/types';
import { RESOURCE_IDS } from '../economy/types';
import { iterateArchivedProduction } from '../history';
import { closeWorldEconomyOwnerLinks, type WorldEconomyRecords } from '../kernel/world-economy-records';
import { jsonStringByteLength, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { validateCareOwnerClosureV10, validateCareRecordsV10 } from '../sect-expansion/care-validation-v10';
import { v10CarePatientEligible } from '../sect-expansion/care-runtime-v10';
import { ownSectFields } from '../sect-expansion/layout';
import { validateSectMaintenanceRecordsV10 } from '../sect-expansion/maintenance-v10';
import { validateSectProductionRecordsV10, validateSectProductionReceiptsV10 } from '../sect-expansion/production-runtime-v10';
import { validateSectResearchConsumerGatesV10 } from '../sect-expansion/research-consumer-gates-v10';
import { inspectWorldSectUpgradePrefixV10, sectUpgradeAllLocalClaimsV10, sectUpgradeClaimsConflictV10 } from '../sect-expansion/upgrade-validation';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { isCultivationWorkerAvailable } from './cultivation-bridge';
import { lookupCommandReceipt, lookupEvent } from './history-access';
import type { V10LifecycleRecordEvidence } from './v10-lifecycle-records';
import { v10SectContext, v10WorkOwners } from './v10-sect-frame';

/** Fixed descriptor capture for internal v10 RECORD inspection. The byte/node ceiling
 * bounds this traversal only; it is NOT an envelope measurement, future reserve or save
 * admission. Unlike old JSON capture, v10 rejects repeated object references as well as
 * cycles. Never inspect caller-thrown exceptions. Proxy reflection can execute caller
 * traps and is not an atomic snapshot or a promise to identify every hostile Proxy. */
export function captureV10RecordData(input: unknown): unknown {
  const seen = new WeakSet<object>(); let bytes = 0; let nodes = 0;
  function invalid(): never { throw new TypeError('Invalid bounded v10 record data'); }
  const add = (count: number): void => { bytes += count; if (bytes > SAVE_FILE_LIMIT_BYTES) invalid(); };
  const stringBytes = (value: string): number => {
    if (value.length > SAVE_FILE_LIMIT_BYTES) invalid(); return jsonStringByteLength(value);
  };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > SAVE_FILE_LIMIT_BYTES || depth > 128) invalid();
    if (value === null) { add(4); return null; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return value; }
    if (typeof value === 'string') { add(stringBytes(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (typeof value !== 'object' || value === null || seen.has(value)) invalid();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) invalid();
    seen.add(value); add(2);
    const keys = Reflect.ownKeys(value);
    const count = array ? Math.max(0, keys.length - 1) : keys.length;
    if (keys.length > SAVE_FILE_LIMIT_BYTES || count > SAVE_FILE_LIMIT_BYTES - nodes
      || bytes + count * (array ? 1 : 4) + Math.max(0, count - 1) > SAVE_FILE_LIMIT_BYTES) invalid();
    // Capture this node's complete descriptor values before descending into children.
    // Subsequent sibling traps cannot substitute a getter for an already captured value.
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0
        || keys.length !== length.value + 1) invalid();
      const children: unknown[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        children.push(descriptor.value);
      }
      add(Math.max(0, children.length - 1)); return children.map(child => copy(child, depth + 1));
    }
    const children: [string, unknown][] = [];
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      add(stringBytes(key) + 1); children.push([key, descriptor.value]);
    }
    add(Math.max(0, children.length - 1));
    const result: Record<string, unknown> = {};
    for (const [key, child] of children) result[key] = copy(child, depth + 1);
    return result;
  }
  return copy(input, 0);
}

/** Fixed whole-sect RECORD composition. The enclosing root passes the SAME restored
 * World object to lifecycle inspection and this closure: evidence is exact-source bound.
 * Original records/reservations remain visible to every leaf; no old-version disguise,
 * policy parameter, trusted caller callback or filtered reservation book is accepted. */
export function inspectV10SectOwnerClosure(world: WorldStateV10, economy: WorldEconomyRecords, lifecycle: V10LifecycleRecordEvidence): string[] {
  const records = world.sectExpansion;
  if (!ownSectFields(records, ['schemaVersion', 'construction', 'stock', 'reservations', 'production', 'research', 'maintenance', 'care', 'upgrade']) || records.schemaVersion !== 2
    || !ownSectFields(records.construction, ['schemaVersion', 'catalogIdentity', 'revision', 'nextId', 'blueprints', 'jobs', 'buildings', 'receipts'])) return ['Invalid v10 owned records'];
  const issueStrings = (issues: readonly { code: string; path: string }[]): string[] => issues.map(issue => `${issue.code}:${issue.path}`);
  const prefix = inspectWorldSectUpgradePrefixV10(world, lifecycle);
  if (prefix.issues.length) return issueStrings(prefix.issues);
  const { identities, frame } = prefix;
  const maintenance = validateSectMaintenanceRecordsV10(frame); if (maintenance.length) return issueStrings(maintenance);
  const production = validateSectProductionRecordsV10(frame, identities); if (production.length) return issueStrings(production);
  const receipts = validateSectProductionReceiptsV10(frame); if (receipts.length) return issueStrings(receipts);
  const gates = validateSectResearchConsumerGatesV10(frame); if (gates.length) return issueStrings(gates);
  const care = validateCareRecordsV10(world, frame, identities); if (care.length) return issueStrings(care);
  // Every persisted paired historical clock belongs to the same management genesis.
  // Old construction visits/spans and care spans have only a simulation tick; do not
  // fabricate a second timestamp or alter their historical shapes.
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
    ...records.upgrade.jobs.flatMap(job => [[job.startedTick, job.startedCalendarTick] as const,
      ...[job.storageVisit, ...job.siteVisits, ...job.checkpoints, job.terminal].filter(value => value !== null).map(value => [value.tick, value.calendarTick] as const),
      ...job.workSpans.flatMap(span => [[span.firstTick, span.firstCalendarTick] as const, [span.lastTick, span.lastCalendarTick] as const])]),
    ...records.care.jobs.flatMap(job => [[job.startedTick, job.startedCalendarTick] as const,
      ...job.visits.map(visit => [visit.tick, visit.calendarTick] as const),
      ...(job.terminal ? [[job.terminal.tick, job.terminal.calendarTick] as const] : [])]),
  ];
  if (paired.some(([tick, calendar]) => tick !== calendar)) return ['V10 management historical clocks differ'];
  // Lifecycle opens these decisions before every work stage. Resolving the decision
  // later at the same boundary does not retroactively fund work on that tick.
  const pauseTicks = [...new Set(world.cultivation.events
    .filter(event => event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.ready')
    .map(event => lookupEvent(world, event.eventId)!.tick))].sort((a, b) => a - b);
  const pauseSet = new Set(pauseTicks);
  const crossesPause = (span: { firstTick: number; lastTick: number }): boolean => {
    let lo = 0; let hi = pauseTicks.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (pauseTicks[mid]! < span.firstTick) lo = mid + 1; else hi = mid; }
    return lo < pauseTicks.length && pauseTicks[lo]! <= span.lastTick;
  };
  const work = [...records.construction.jobs, ...records.production.jobs, ...records.research.jobs, ...records.care.jobs, ...records.upgrade.jobs];
  const workTicks = [
    ...records.construction.jobs.flatMap(job => [job.storageVisit, job.siteVisit].filter(value => value !== null).map(value => value.tick)),
    ...records.production.jobs.flatMap(job => [job.workVisit, job.deliveryVisit].filter(value => value !== null).map(value => value.tick)),
    ...records.research.jobs.flatMap(job => job.visits.map(visit => visit.tick)),
    ...records.care.jobs.flatMap(job => job.visits.map(visit => visit.tick)),
    ...records.upgrade.jobs.flatMap(job => [job.storageVisit, ...job.siteVisits, ...job.checkpoints].filter(value => value !== null).map(value => value.tick)),
    ...records.maintenance.payments.map(payment => payment.paidTick),
  ];
  if (workTicks.some(tick => pauseSet.has(tick)) || work.some(job => job.workSpans.some(crossesPause)
    || job.terminal?.kind === 'completed' && pauseSet.has(job.terminal.tick))) return ['V10 work occurs on a pre-work decision-pause tick'];
  // These are authenticated settlement/source records, not the time a cancellation
  // receipt was acknowledged or retried. Manual starts and either kind of cancellation
  // remain possible at a decision boundary; a committed output cannot occur there.
  const committedOnPause = (transaction: { state: string; completedTick: number | null }): boolean =>
    transaction.state === 'Committed' && transaction.completedTick !== null && pauseSet.has(transaction.completedTick);
  if (Object.values(world.transactions).some(committedOnPause)
    || Object.values(world.automaticProduction.pins).some(committedOnPause)
    // Automatic starts and blocked notices are emitted only by post-lifecycle tick
    // work phases. Cancellation notices may instead come from an immediate command.
    || world.automaticProduction.journal.some(notice => notice.kind !== 'cancelled' && pauseSet.has(notice.tick))
    || Object.values(world.automaticProduction.live).some(pair => pauseSet.has(pair.transaction.startedTick)))
    return ['V10 legacy production occurs on a pre-work decision-pause tick'];
  if (pauseSet.size > 0) for (const { transaction } of iterateArchivedProduction(world.history)) if (committedOnPause(transaction))
    return ['V10 legacy production occurs on a pre-work decision-pause tick'];
  const local = validateCareOwnerClosureV10(world, frame); if (local.length) return issueStrings(local);
  const old = closeWorldEconomyOwnerLinks(economy); if (!old.ok) return old.errors;
  for (const id of RESOURCE_IDS) {
    const sect = records.reservations.reduce((sum, claim) => sum + (claim.base.remainingReservation.find(line => line.resourceId === id)?.quantity ?? 0), 0);
    const total = old.claims.reservedTotals[id] + sect;
    if (!Number.isSafeInteger(total) || world.inventory[id].reserved !== total) return ['V10 shared reservation total differs'];
  }
  for (const id of SECT_RESOURCE_IDS) {
    const owned = records.reservations.reduce((sum, claim) => sum - (claim.sect.consumed.find(line => line.resourceId === id)?.quantity ?? 0)
      + (claim.sect.settlement?.kind === 'committed' ? claim.sect.settlement.outputs.find(line => line.resourceId === id)?.quantity ?? 0 : 0), 0);
    if (!Number.isSafeInteger(owned) || records.stock[id].owned !== owned) return ['V10 zero-genesis stock provenance differs'];
  }
  // Construction allocates its future building ID exactly once, even before completion.
  // Completed building/source fields are references, not a second allocation.
  const allocated = [
    ...records.construction.blueprints.map(bp => bp.blueprintId),
    ...records.construction.jobs.flatMap(job => [job.jobId, job.reservationId, job.resultBuildingId]),
    ...records.production.jobs.flatMap(job => [job.transactionId, job.reservationId]),
    ...records.research.jobs.flatMap(job => [job.jobId, job.reservationId]),
    ...records.maintenance.payments.flatMap(payment => [payment.paymentId, payment.reservationId]),
    ...records.care.jobs.flatMap(job => [job.jobId, job.reservationId]),
    ...records.upgrade.jobs.flatMap(job => [job.jobId, job.reservationId]),
  ];
  const entityIds = new Set([...world.disciples.map(actor => actor.id), ...world.buildings.map(site => site.id),
    ...world.legacy.archivedIdentities.map(identity => identity.discipleId)]);
  if (new Set(allocated).size !== allocated.length || allocated.some(id => entityIds.has(id) || economy.transactionIds.has(id))) return ['V10 record identity has multiple owners'];
  const owners = v10WorkOwners(world);
  // This six-domain helper already includes care; appending it again is a false conflict.
  if (owners.length > 36 || new Set(owners.map(owner => owner.workerId)).size !== owners.length
    || sectUpgradeClaimsConflictV10([...v10SectContext(world).externalClaims, ...sectUpgradeAllLocalClaimsV10(frame)])) return ['V10 work claims conflict'];
  for (const owner of owners) {
    if (owner.kind === 'care') { if (!v10CarePatientEligible(world, owner.workerId, owner.id)) return ['V10 live patient unavailable']; continue; }
    const actor = world.disciples.find(actor => actor.id === owner.workerId);
    if (!actor || !actor.canWork || !isCultivationWorkerAvailable(world, owner.workerId)
      || world.builds.disciples.find(member => member.discipleId === owner.workerId)?.lock) return ['V10 live worker unavailable'];
  }
  const commandIds = new Set<string>();
  const domainReceipts = [...records.construction.receipts, ...records.production.receipts, ...records.research.receipts, ...records.care.receipts, ...records.upgrade.receipts];
  for (const receipt of domainReceipts) {
    if (commandIds.has(receipt.command.commandId) || lookupCommandReceipt(world, receipt.command.commandId)) return ['V10 command identity has multiple owners'];
    commandIds.add(receipt.command.commandId);
    // These fixed leaves own their exact cancellation protocols. Old care remains system/v9.
    if (receipt.command.kind.startsWith('care.') || receipt.command.kind.startsWith('upgrade.')) continue;
    if (receipt.command.commandId.startsWith('system/') && !receipt.command.commandId.startsWith('system/v9/'))
      return ['Unsupported v10 legacy-domain system namespace'];
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
      const jobId = 'transactionId' in job ? job.transactionId : job.jobId;
      if (!death || command.commandId !== `system/v9/death/${death.deathId}/${jobId}` || !event
        || !mirror || mirror.tick !== job.terminal.tick) return ['Lifecycle cancellation source differs'];
    }
  }
  return [];
}
