import { isWoundPowderEffectReceiptV9 } from '../cultivation/care-effect-v9';
import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { isCultivationCommand } from '../cultivation/validation';
import type { CultivationCommand, CultivationEvent } from '../cultivation/types';
import { isLedgerDataArray } from '../economy/ledger-operations';
import { iterateArchivedEvents } from '../history';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import { canonicalUtf8ByteLength } from '../save-budget';
import { SECT_CARE_LIMITS } from '../sect-expansion/care-types';
import { ownSectFields } from '../sect-expansion/layout';
import { lookupCommandReceipt, lookupEvent } from './history-access';
import { V9_CULTIVATION_CLOCK_LIMIT, type V9CultivationClockTransition } from './v9-cultivation-clock-types';
import type { WorldStateV9 } from './v9-types';

const integer = isNonNegativeInteger;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const fail = (message: string): never => { throw new TypeError(`Invalid v9 cultivation clock: ${message}`); };
interface RevisionOwner {
  before: number; kind: 'command' | 'archive' | 'care' | 'month' | 'age-sync';
  tick: number | null; rank: number; events: CultivationEvent[]; key: string; allocatedAction?: number;
}
/** Read only after lifecycle inspection. Redundant month/afterRevision values are derived. */
export function v9CultivationMonthTransition(world: WorldStateV9, month: number): V9CultivationClockTransition | undefined {
  return world.cultivationClock.transitions.find(record => record.kind === 'month' && record.tick === month * CALENDAR_TICKS_PER_MONTH);
}
/** Every fresh accepted schema-3 command increments, even an accepted no-op talent
 * grant or same-mode training.set. Exact retries retain the original single receipt. */
export function v9CanonicalCultivationCommands(world: WorldStateV9): CultivationCommand[] {
  return world.cultivation.receipts.map(receipt => {
    let parsed: unknown; try { parsed = JSON.parse(receipt.fingerprint); } catch { return fail('malformed command fingerprint'); }
    if (!isCultivationCommand(parsed) || canonicalStringify(parsed) !== receipt.fingerprint
      || parsed.commandId !== receipt.commandId || receipt.result.commandId !== parsed.commandId
      || receipt.result.kind !== parsed.kind) return fail('noncanonical command owner');
    return parsed;
  });
}

/** Structural chronology and source consistency only. This does not replay the World,
 * authenticate edits cryptographically, or reconstruct every historical injury.
 * All loops are over bounded retained rows/identities, never an alleged revision/tick. */
export function inspectV9CultivationClockRecords(world: WorldStateV9): void {
  canonicalUtf8ByteLength(world);
  const state = world.cultivation; const rows = world.cultivationClock?.transitions; const now = world.clock.simulationTick;
  if (!ownSectFields(world.cultivationClock, ['transitions']) || !Array.isArray(rows) || !isLedgerDataArray(rows)
    || rows.length > V9_CULTIVATION_CLOCK_LIMIT || !integer(now) || !integer(state.revision)
    || state.receipts.length > MAX_CULTIVATION_HISTORY || state.authorityReceipts.length > MAX_CULTIVATION_HISTORY
    || state.events.length > MAX_CULTIVATION_HISTORY || world.sectExpansion.care.jobs.length > SECT_CARE_LIMITS.records) fail('record bounds');
  const owners: RevisionOwner[] = [];
  const eventOwners = new Map<string, RevisionOwner>(); const commands = v9CanonicalCultivationCommands(world);
  const eventKey = (kind: string, discipleId: string, relatedId: string | null): string => JSON.stringify([kind, discipleId, relatedId]);
  const eventSources = new Map<string, CultivationEvent[]>();
  for (const event of state.events) {
    const key = eventKey(event.kind, event.discipleId, event.relatedId);
    const matches = eventSources.get(key) ?? []; matches.push(event); eventSources.set(key, matches);
  }
  const profiles = new Map([...state.disciples, ...state.archivedDisciples].map(profile => [profile.discipleId, profile]));
  const mirrors = new Map(state.events.map(event => {
    const mirror = lookupEvent(world, event.eventId);
    if (!mirror || mirror.kind !== event.kind || mirror.rootActionId !== event.rootActionId || mirror.parentEventId !== null
      || !integer(mirror.tick) || mirror.tick > now || Math.floor(mirror.tick / CALENDAR_TICKS_PER_MONTH) !== event.month
      || !same(mirror.payload, { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month })) fail('event mirror differs');
    return [event.eventId, mirror!] as const;
  }));
  const ownEvent = (owner: RevisionOwner, event: CultivationEvent): void => {
    if (eventOwners.has(event.eventId)) fail('event has multiple sources');
    const tick = mirrors.get(event.eventId)!.tick;
    if (owner.tick !== null && owner.tick !== tick) fail('source and event ticks differ');
    owner.tick = tick; owner.events.push(event); eventOwners.set(event.eventId, owner);
  };
  const oneEvent = (kind: CultivationEvent['kind'], discipleId: string, relatedId: string | null): CultivationEvent => {
    const matches = eventSources.get(eventKey(kind, discipleId, relatedId)) ?? [];
    if (matches.length !== 1) return fail('missing or duplicate command event'); return matches[0]!;
  };
  let previousCommand = -1;
  const grantedSources = new Set<string>();
  for (const [i, command] of commands.entries()) {
    const receipt = state.receipts[i]!; const result = receipt.result;
    if (!ownSectFields(receipt, ['commandId', 'fingerprint', 'result'])
      || !ownSectFields(result, ['commandId', 'kind', 'relatedId', 'outcome'])
      || command.expectedRevision <= previousCommand || command.expectedRevision >= state.revision) fail('command revision order');
    previousCommand = command.expectedRevision;
    const owner: RevisionOwner = { before: command.expectedRevision, kind: 'command', tick: null, rank: 2, events: [], key: command.commandId };
    owners.push(owner);
    let related: string | null = null; let outcome: typeof result.outcome = 'accepted';
    if (command.kind === 'training.set' || command.kind === 'legacy.setHeir') {
      if (!profiles.has(command.discipleId)) fail('unknown command identity');
    } else if (command.kind === 'talent.grant') {
      const source = profiles.get(command.discipleId)?.talents.find(talent => talent.sourceDefinitionId === command.talentId);
      if (!source) fail('talent command source missing'); related = source!.sourceInstanceId;
      if (!grantedSources.has(related)) ownEvent(owner, oneEvent('cultivation.talentGranted', command.discipleId, related));
      grantedSources.add(related);
    } else if (command.kind === 'teaching.begin') {
      related = result.relatedId;
      if (typeof related !== 'string') fail('missing teaching identity');
      ownEvent(owner, oneEvent('cultivation.teachingStarted', command.discipleId, related));
    } else if (command.kind === 'death.finalize') {
      related = command.deathId; outcome = 'death';
      const death = state.deaths.find(death => death.deathId === command.deathId && death.discipleId === command.discipleId && death.cause === command.cause);
      if (!death) fail('death command source missing');
      ownEvent(owner, oneEvent('cultivation.died', command.discipleId, related));
    } else {
      const attemptId = command.kind === 'breakthrough.confirm' ? result.relatedId : command.attemptId;
      const attempt = state.attempts.find(attempt => attempt.attemptId === attemptId);
      if (!attempt || command.kind === 'breakthrough.confirm' && !same(command.preview, attempt.preview)) fail('attempt command source missing');
      related = attempt!.attemptId;
      const kind = command.kind === 'breakthrough.confirm' ? 'cultivation.confirmed'
        : command.kind === 'breakthrough.begin' ? 'cultivation.started'
          : command.kind === 'breakthrough.cancel' ? 'cultivation.cancelled' : 'cultivation.resolved';
      ownEvent(owner, oneEvent(kind, attempt!.discipleId, related));
      if (command.kind === 'breakthrough.cancel') outcome = 'cancelled';
      if (command.kind === 'breakthrough.resolve') {
        if (!attempt!.outcome || attempt!.outcome === 'cancelled') fail('unresolved command'); outcome = attempt!.outcome!;
        if (outcome === 'death') {
          const death = state.deaths.find(death => death.discipleId === attempt!.discipleId && death.cause === 'breakthrough');
          if (!death) fail('missing breakthrough death'); ownEvent(owner, oneEvent('cultivation.died', attempt!.discipleId, death!.deathId));
        }
      }
    }
    if (result.relatedId !== related || result.outcome !== outcome) fail('command result differs');
    if (['talent.grant', 'teaching.begin', 'breakthrough.confirm', 'death.finalize'].includes(command.kind) && owner.events.length) {
      const root = owner.events[0]!.rootActionId;
      const action = /^action:[1-9]\d*$/.test(root) ? Number(root.slice(7)) : NaN;
      if (!Number.isSafeInteger(action) || action >= world.sequences.nextAction) fail('invalid command action');
      owner.allocatedAction = action;
    }
    const worldReceipt = lookupCommandReceipt(world, command.commandId);
    if (worldReceipt && (worldReceipt.result.status !== 'accepted' || worldReceipt.fingerprint !== canonicalStringify({ kind: 'cultivation.command', payload: { command } })
      || !same(worldReceipt.result.cultivationResult, result)
      || !same([...worldReceipt.result.eventIds].sort(), owner.events.map(event => event.eventId).sort()))) fail('World command source differs');
  }
  for (const receipt of state.authorityReceipts) {
    const command = receipt.command;
    if (command.kind !== 'disciple.archive' || receipt.revision !== command.expectedRevision + 1
      || receipt.fingerprint !== canonicalStringify(command)) fail('unsupported authority owner');
    const deathEvent = oneEvent('cultivation.died', command.discipleId, command.kind === 'disciple.archive' ? command.deathId : null);
    const deathOwner = eventOwners.get(deathEvent.eventId);
    if (!deathOwner || command.expectedRevision !== deathOwner.before + 1) fail('archive is not the immediate death-command successor');
    owners.push({ before: command.expectedRevision, kind: 'archive', tick: mirrors.get(deathEvent.eventId)!.tick, rank: 2, events: [], key: command.discipleId });
  }
  // Decision pauses freeze global time until a same-boundary command settles
  // them. Checking just the opening tick would permit a forged extra paused tick.
  // Existing exact mirrors suffice; there is no World replay or new pause ledger.
  for (const event of state.events) {
    const openedAt = mirrors.get(event.eventId)!.tick;
    if (event.kind === 'cultivation.expiryPending') {
      const death = state.deaths.find(death => death.deathId === event.relatedId && death.discipleId === event.discipleId);
      if (death) {
        const closed = oneEvent('cultivation.died', event.discipleId, death.deathId);
        if (mirrors.get(closed.eventId)!.tick !== openedAt) fail('death decision closed after its paused boundary');
      } else if (now !== openedAt) fail('unresolved death decision advanced the clock');
    } else if (event.kind === 'cultivation.ready') {
      const attempt = state.attempts.find(attempt => attempt.attemptId === event.relatedId && attempt.discipleId === event.discipleId);
      if (!attempt) fail('ready decision lacks its attempt');
      if (attempt!.phase === 'DecisionReady') {
        if (now !== openedAt) fail('unresolved breakthrough decision advanced the clock');
      } else {
        if (attempt!.phase !== 'Resolved' && attempt!.phase !== 'Cancelled') fail('ready decision has an impossible phase');
        const closed = oneEvent(attempt!.phase === 'Resolved' ? 'cultivation.resolved' : 'cultivation.cancelled', event.discipleId, event.relatedId);
        if (mirrors.get(closed.eventId)!.tick !== openedAt) fail('breakthrough decision closed after its paused boundary');
      }
    }
  }
  // Lifecycle decisions pause the entire World before any work on that already-
  // advanced tick. The patient need not be the actor whose decision caused it.
  const preWorkPauseTicks = new Set(state.events.filter(event => event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.ready')
    .map(event => mirrors.get(event.eventId)!.tick));
  for (const job of world.sectExpansion.care.jobs) if (job.terminal?.kind === 'completed') {
    const effect = job.terminal.effect;
    if (!isWoundPowderEffectReceiptV9(effect) || effect.careJobId !== job.jobId || effect.patientId !== job.patientId
      || effect.tick !== job.terminal.tick || effect.tick <= job.startedTick || effect.tick > now) fail('invalid care revision owner');
    if (preWorkPauseTicks.has(effect!.tick)) fail('care effect occurs on a pre-work decision-pause tick');
    const expiry = state.events.find(event => event.kind === 'cultivation.expiryPending' && event.discipleId === job.patientId);
    const died = state.events.find(event => event.kind === 'cultivation.died' && event.discipleId === job.patientId);
    if (expiry && effect!.tick >= mirrors.get(expiry.eventId)!.tick || died && effect!.tick > mirrors.get(died.eventId)!.tick) fail('care effect is outside the living work interval');
    owners.push({ before: effect!.beforeRevision, kind: 'care', tick: effect!.tick, rank: 1, events: [], key: job.jobId });
  }
  const byTick = new Map<number, RevisionOwner>(); const rootIds = new Set<string>();
  let previousTick = 0; let previousClockRevision = -1; let previousAction = 0; let monthCount = 0;
  for (const row of rows!) {
    const action = typeof row.rootActionId === 'string' && /^action:[1-9]\d*$/.test(row.rootActionId) ? Number(row.rootActionId.slice(7)) : NaN;
    if (!ownSectFields(row, ['kind', 'tick', 'beforeRevision', 'rootActionId']) || !['month', 'age-sync'].includes(row.kind)
      || !integer(row.tick) || row.tick <= previousTick || row.tick > now || !integer(row.beforeRevision) || row.beforeRevision <= previousClockRevision
      || !Number.isSafeInteger(action) || action <= previousAction || action >= world.sequences.nextAction || rootIds.has(row.rootActionId)
      || (row.kind === 'month') !== (row.tick % CALENDAR_TICKS_PER_MONTH === 0)) fail('clock row shape/order');
    previousTick = row.tick; previousClockRevision = row.beforeRevision; previousAction = action; rootIds.add(row.rootActionId);
    if (row.kind === 'month') monthCount += 1;
    const owner: RevisionOwner = { before: row.beforeRevision, kind: row.kind, tick: row.tick, rank: 0, events: [], key: row.rootActionId, allocatedAction: action };
    byTick.set(row.tick, owner); owners.push(owner);
  }
  if (monthCount !== Math.floor(now / CALENDAR_TICKS_PER_MONTH) || state.calendarMonth !== monthCount) fail('missing month transition');
  // All fresh identities exist at tick zero. Group equal birthday residues; their
  // union is a contiguous arithmetic progression ending at the latest living span.
  const birthdayEnds = new Map<number, number>();
  const identities = [...world.disciples.map(actor => ({ discipleId: actor.id, birthCalendarTick: actor.birthCalendarTick })), ...world.legacy.archivedIdentities];
  if (identities.length !== profiles.size || identities.length > 36 || new Set(identities.map(identity => identity.discipleId)).size !== identities.length) fail('fresh identity coverage');
  for (const identity of identities) {
    const profile = profiles.get(identity.discipleId); if (!profile || !Number.isSafeInteger(identity.birthCalendarTick) || identity.birthCalendarTick > 0) fail('identity lifetime');
    const expiry = state.events.find(event => event.kind === 'cultivation.expiryPending' && event.discipleId === identity.discipleId);
    const died = state.events.find(event => event.kind === 'cultivation.died' && event.discipleId === identity.discipleId);
    const end = expiry ? mirrors.get(expiry.eventId)!.tick : died ? mirrors.get(died.eventId)!.tick : now;
    const duration = end - identity.birthCalendarTick;
    if (!Number.isSafeInteger(duration) || profile!.ageMonths !== Math.floor(duration / CALENDAR_TICKS_PER_MONTH)) fail('age and lifetime differ');
    if (expiry && (end !== identity.birthCalendarTick + profile!.lifespanMonths * CALENDAR_TICKS_PER_MONTH
      || died && mirrors.get(died.eventId)!.tick < end)) fail('expiry differs from actual birthday');
    const residue = ((identity.birthCalendarTick % CALENDAR_TICKS_PER_MONTH) + CALENDAR_TICKS_PER_MONTH) % CALENDAR_TICKS_PER_MONTH;
    if (residue > 0 && end >= residue) birthdayEnds.set(residue, Math.max(birthdayEnds.get(residue) ?? 0, end));
  }
  let expectedBirthdays = 0;
  for (const [residue, end] of birthdayEnds) expectedBirthdays += Math.floor((end - residue) / CALENDAR_TICKS_PER_MONTH) + 1;
  if (rows!.length - monthCount !== expectedBirthdays) fail('missing birthday transition');
  for (const row of rows!) if (row.kind === 'age-sync' && row.tick > (birthdayEnds.get(row.tick % CALENDAR_TICKS_PER_MONTH) ?? -1)) fail('fake birthday transition');
  // The command receipts own their exact emitted event sets. Remaining events can
  // only be emitted by the actual clock path at its exact World tick.
  for (const event of state.events) if (!eventOwners.has(event.eventId)) {
    const tick = mirrors.get(event.eventId)!.tick; const owner = byTick.get(tick);
    if (!owner) fail('event lacks clock source');
    if (event.kind === 'cultivation.expiryPending' || event.kind === 'cultivation.taught') {
      if (event.rootActionId !== owner!.key || event.kind === 'cultivation.taught' && owner!.kind !== 'month') fail('clock root differs');
    } else if (event.kind === 'cultivation.ready') {
      if (owner!.kind !== 'month' || !state.attempts.some(attempt => attempt.attemptId === event.relatedId && attempt.rootActionId === event.rootActionId && attempt.discipleId === event.discipleId)) fail('ready source differs');
    } else if (event.kind === 'cultivation.cancelled') {
      const expiry = state.events.find(other => other.kind === 'cultivation.expiryPending' && other.discipleId === event.discipleId && mirrors.get(other.eventId)!.tick === tick);
      if (!expiry || Number(event.eventId.slice(6)) >= Number(expiry.eventId.slice(6))
        || !state.attempts.some(attempt => attempt.attemptId === event.relatedId && attempt.rootActionId === event.rootActionId && attempt.discipleId === event.discipleId && attempt.phase === 'Cancelled')) fail('clock cancellation source differs');
    } else fail('event lacks command source');
    ownEvent(owner!, event);
  }
  // Fresh successful receipts cannot manufacture accepted no-ops after a real
  // pending/final death. This is a narrow lifecycle-source bound, not command or
  // whole-World replay; genuinely living no-op commands still own one revision.
  const expiryRevisions = new Map<string, number>(); const deathRevisions = new Map<string, number>();
  for (const event of state.events) {
    if (event.kind === 'cultivation.expiryPending') expiryRevisions.set(event.discipleId, eventOwners.get(event.eventId)!.before);
    if (event.kind === 'cultivation.died') deathRevisions.set(event.discipleId, eventOwners.get(event.eventId)!.before);
  }
  const attempts = new Map(state.attempts.map(attempt => [attempt.attemptId, attempt]));
  for (const command of commands) {
    const targets = command.kind === 'death.finalize' ? []
      : command.kind === 'teaching.begin' ? [command.discipleId, command.studentId]
        : command.kind === 'legacy.setHeir' ? [command.discipleId, ...(command.heirId === null ? [] : [command.heirId])]
          : command.kind === 'breakthrough.confirm' ? [command.preview.discipleId]
            : 'attemptId' in command ? [attempts.get(command.attemptId)!.discipleId] : [command.discipleId];
    for (const target of targets) {
      const expiry = expiryRevisions.get(target); const death = deathRevisions.get(target);
      if (expiry !== undefined && command.expectedRevision >= expiry
        || death !== undefined && (command.expectedRevision > death || command.expectedRevision === death && command.kind !== 'breakthrough.resolve')) {
        fail('command source requires a living disciple');
      }
    }
  }
  // A clock root is freshly allocated; it cannot borrow a command/attempt root.
  if (owners.some(owner => owner.kind === 'command' && owner.events.some(event => rootIds.has(event.rootActionId)))) fail('clock root is command-owned');
  for (const event of [...iterateArchivedEvents(world.history), ...world.events]) {
    if (rootIds.has(event.rootActionId) && !eventOwners.has(event.eventId)) fail('clock root is owned outside cultivation');
  }
  owners.sort((a, b) => a.before - b.before);
  if (owners.length !== state.revision || owners.some((owner, index) => owner.before !== index)) fail('revision gap or duplicate owner');
  let earliestTick = 0; let earliestRank = 2; let previousCare: RevisionOwner | undefined; let lastAllocatedAction = 0;
  for (const owner of owners) {
    if (owner.allocatedAction !== undefined) {
      if (owner.allocatedAction <= lastAllocatedAction) fail('action allocation chronology differs');
      lastAllocatedAction = owner.allocatedAction;
    }
    // Boundary commands execute after that tick's work. If they have no event,
    // choose their earliest possible boundary; the next exact owner must fit it.
    if (owner.tick === null) {
      if (owner.rank < earliestRank) earliestTick += 1;
      earliestRank = owner.rank;
    } else {
      if (owner.tick < earliestTick || owner.tick === earliestTick && owner.rank < earliestRank) fail('revision/tick order differs');
      earliestTick = owner.tick; earliestRank = owner.rank;
      if (owner.kind === 'care') {
        if (previousCare?.tick === owner.tick && compareStable(previousCare.key, owner.key) >= 0) fail('same-tick care order differs');
        previousCare = owner;
      }
    }
  }
  if (earliestTick > now) fail('command is beyond current boundary');
  // Command-emitted events are ordered by their reducer owner, even when a shared
  // attempt root is reused later. Array reordering cannot change this chronology.
  let lastEventNumber = 0; let lastEventOwner = -1;
  for (const event of state.events) {
    const number = Number(event.eventId.slice(6)); const owner = eventOwners.get(event.eventId)!;
    if (number <= lastEventNumber || owner.before < lastEventOwner) fail('event source chronology differs');
    lastEventNumber = number; lastEventOwner = owner.before;
  }
}
