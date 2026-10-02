import { applyCultivationCommandV3 } from '../cultivation/v3';
import type { CultivationCommand, CultivationEvent, CultivationFrame, CultivationTransition } from '../cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason, tickClock } from '../kernel/clock';
import type { WorldClock } from '../kernel/clock';
import { checkedAdd } from '../kernel/numeric';
import { canonicalStringify } from '../kernel/serialization';
import { canonicalUtf8ByteLength } from '../save-budget';
import type { ConstructionContext } from '../sect-expansion/construction-types';
import type { SectUpgradeFrameV10, WorldStateV10 } from '../sect-expansion/upgrade-types';
import { cultivationFrameOf, prepareCultivationClockAdvance, prepareCultivationWorldEvents, projectCultivationDisciples } from './cultivation-preparation';
import { appendWorldEvents, worldEventCursor, worldEventsSince } from './history-access';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';
import { inspectV10LifecycleRecords } from './v10-lifecycle-records';
import { projectV10SectFrame, v10SectContext } from './v10-sect-frame';

const evidence: unique symbol = Symbol('actual v10 cultivation transition');
/** Transient, identity-bound proof of one actual reducer invocation. Not serializable,
 * source admission, a historical-death certificate, or authority to publish a World. */
export interface V10CultivationTransitionEvidence { readonly [evidence]: true }
export interface V10PreWorkDeath {
  readonly discipleId: string;
  readonly deathId: string;
  readonly cause: 'lifespan' | 'breakthrough';
  readonly unavailableEventId: string;
  readonly unavailableKind: 'cultivation.expiryPending' | 'cultivation.died';
  readonly unavailableTick: number;
  readonly unavailableCalendarTick: number;
}
export interface V10CultivationPreparation {
  readonly world: WorldStateV10;
  readonly frame: SectUpgradeFrameV10;
  readonly context: ConstructionContext;
  readonly evidence: V10CultivationTransitionEvidence;
}
export interface V10CultivationClockPreparation extends V10CultivationPreparation { readonly advanced: boolean }
export interface V10CultivationCommandPreparation extends V10CultivationPreparation { readonly transition: CultivationTransition }

type ActualReducer = { readonly kind: 'clock'; readonly clock: WorldClock; readonly frame: CultivationFrame | null }
  | { readonly kind: 'command'; readonly transition: CultivationTransition };
interface Binding {
  readonly source: WorldStateV10;
  readonly sourceSnapshot: string;
  readonly actual: ActualReducer;
  readonly actualSnapshot: string;
  readonly candidate: WorldStateV10;
  readonly candidateSnapshot: string;
  readonly frame: SectUpgradeFrameV10;
  readonly frameSnapshot: string;
  readonly context: ConstructionContext;
  readonly contextSnapshot: string;
  /** Full actual suffix retains eventId/rootActionId/month, never caller claims. */
  readonly emittedSnapshot: string;
  readonly eventCursor: number;
}
const bindings = new WeakMap<V10CultivationTransitionEvidence, Binding>();
const snapshot = (value: unknown): string => { canonicalUtf8ByteLength(value); return canonicalStringify(value); };
const pendingDecision = (world: WorldStateV10): boolean => world.cultivation.pendingDeaths.length > 0
  || world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady');

/** This fixed extra check authenticates only the source lifecycle records. Complete
 * source economy/owner/capacity admission remains the INTERNAL root caller's duty. */
function inspectSource(source: WorldStateV10): string {
  const before = snapshot(source);
  inspectV10LifecycleRecords(source);
  if (source.clock.pauseReasons.includes('cultivation') !== pendingDecision(source)) throw new TypeError('V10 cultivation pause differs from source lifecycle');
  if (snapshot(source) !== before) throw new TypeError('Changed v10 cultivation preparation source');
  return before;
}
function withPause(world: WorldStateV10): WorldStateV10 {
  const pending = pendingDecision(world);
  return world.clock.pauseReasons.includes('cultivation') === pending ? world
    : { ...world, clock: setPauseReason(world.clock, 'cultivation', pending) };
}
function compose(source: WorldStateV10, actual: CultivationFrame): WorldStateV10 {
  const mirrored = appendWorldEvents({ ...source, ...actual }, prepareCultivationWorldEvents(source, actual));
  // Set the decision pause BEFORE projecting the pre-work context. No work, estate,
  // archive, automatic start, award or cancellation reducer runs in this stage.
  return withPause({ ...mirrored, disciples: projectCultivationDisciples(source.disciples, actual.cultivation) });
}
function actualFrame(actual: ActualReducer): CultivationFrame | null {
  return actual.kind === 'clock' ? actual.frame : actual.transition.ok && !actual.transition.replayed ? actual.transition.frame : null;
}
function prepare(source: WorldStateV10, sourceSnapshot: string, candidate: WorldStateV10, actual: ActualReducer): V10CultivationPreparation {
  if (snapshot(source) !== sourceSnapshot) throw new TypeError('Changed v10 cultivation preparation source');
  const frame = projectV10SectFrame(candidate); const context = v10SectContext(candidate);
  const resultFrame = actualFrame(actual);
  const token = Object.freeze({ [evidence]: true as const });
  bindings.set(token, { source, sourceSnapshot, actual, actualSnapshot: snapshot(actual), candidate, candidateSnapshot: snapshot(candidate),
    frame, frameSnapshot: snapshot(frame), context, contextSnapshot: snapshot(context), eventCursor: worldEventCursor(source),
    emittedSnapshot: snapshot(resultFrame?.cultivation.events.slice(source.cultivation.events.length) ?? []) });
  // Inspect only the actual transition binding here. The completed-record lifecycle
  // inspector intentionally rejects a new unarchived dead actor, and is not called.
  readV10PreWorkDeaths(token, frame, context);
  return Object.freeze({ world: candidate, frame, context, evidence: token });
}

/** INTERNAL root-prevalidated candidate stage, NOT full v10 source/candidate admission.
 * Calls the real management tick and schema-3 month/birthday reducer itself. */
export function prepareValidatedV10CultivationClock(source: WorldStateV10): V10CultivationClockPreparation {
  const before = inspectSource(source);
  const clock = tickClock(source.clock);
  if (clock === source.clock) return Object.freeze({ ...prepare(source, before, source, { kind: 'clock', clock, frame: null }), advanced: false });
  const clocked = { ...source, clock };
  const monthChanged = Math.floor(clock.calendarTick / CALENDAR_TICKS_PER_MONTH) !== source.cultivation.calendarMonth;
  const birthday = source.disciples.some(actor => {
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    return profile.lifeState === 'alive'
      && Math.floor(checkedAdd(clock.calendarTick, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH) !== profile.ageMonths;
  });
  // Reserve the finite row BEFORE schema-3 can allocate IDs, change resources or draw.
  if ((monthChanged || birthday) && source.cultivationClock.transitions.length >= V9_CULTIVATION_CLOCK_LIMIT) throw new RangeError('Cultivation clock record capacity exhausted');
  const reduced = prepareCultivationClockAdvance(clocked);
  if ((reduced !== null) !== (monthChanged || birthday)) throw new TypeError('Unexpected v10 cultivation clock transition');
  let candidate: WorldStateV10 = clocked;
  if (reduced) {
    if (reduced.cultivation.revision !== checkedAdd(source.cultivation.revision, 1)
      || reduced.sequences.nextAction !== checkedAdd(source.sequences.nextAction, 1)) throw new TypeError('Unexpected v10 cultivation clock allocation');
    candidate = compose({ ...clocked, cultivationClock: { transitions: [...source.cultivationClock.transitions,
      { kind: monthChanged ? 'month' : 'age-sync', tick: clock.simulationTick,
        beforeRevision: source.cultivation.revision, rootActionId: `action:${source.sequences.nextAction}` }] } }, reduced);
  }
  return Object.freeze({ ...prepare(source, before, candidate, { kind: 'clock', clock, frame: reduced }), advanced: true });
}

/** INTERNAL root-prevalidated source/command stage. The root still owns command
 * admission, cross-domain IDs/work claims, reconciliation and final publication.
 * Failed reducers and exact retries preserve the exact source World and mint no facts. */
export function prepareValidatedV10CultivationCommand(source: WorldStateV10, command: CultivationCommand): V10CultivationCommandPreparation {
  const before = inspectSource(source);
  snapshot(command); // Reject accessors before the domain reducer reads the command.
  const transition = applyCultivationCommandV3(cultivationFrameOf(source), command);
  const candidate = transition.ok && !transition.replayed ? compose(source, transition.frame) : source;
  return Object.freeze({ ...prepare(source, before, candidate, { kind: 'command', transition }), transition });
}

/** Exact pre-work-stage facts are derived from the actual newly emitted suffix. An old
 * expiry finalized now is NOT a new unavailable boundary and cannot release delayed
 * work. Exact identity and canonical snapshots prevent rebinding to another stage. */
export function readV10PreWorkDeaths(token: V10CultivationTransitionEvidence, frame: SectUpgradeFrameV10,
  context: ConstructionContext): readonly V10PreWorkDeath[] {
  const binding = bindings.get(token);
  if (!binding || binding.frame !== frame || binding.context !== context) throw new TypeError('Unauthenticated v10 cultivation transition evidence');
  if (snapshot(binding.source) !== binding.sourceSnapshot || snapshot(binding.actual) !== binding.actualSnapshot
    || snapshot(binding.candidate) !== binding.candidateSnapshot || snapshot(frame) !== binding.frameSnapshot
    || snapshot(context) !== binding.contextSnapshot) throw new TypeError('Changed v10 cultivation transition binding');
  const { source, candidate, actual } = binding; const reduced = actualFrame(actual);
  const emitted: CultivationEvent[] = reduced?.cultivation.events.slice(source.cultivation.events.length) ?? [];
  if (snapshot(emitted) !== binding.emittedSnapshot
    || reduced && snapshot(reduced.cultivation.events.slice(0, source.cultivation.events.length)) !== snapshot(source.cultivation.events)) throw new TypeError('V10 cultivation event prefix differs');
  const expectedMirrors = reduced ? prepareCultivationWorldEvents({ cultivation: source.cultivation, clock: candidate.clock }, reduced) : [];
  if (worldEventCursor(candidate) !== checkedAdd(binding.eventCursor, expectedMirrors.length)
    || snapshot(worldEventsSince(candidate, binding.eventCursor)) !== snapshot(expectedMirrors)) throw new TypeError('V10 cultivation World mirror suffix differs');
  const facts: V10PreWorkDeath[] = [];
  for (const event of emitted) {
    if (event.kind !== 'cultivation.expiryPending' && event.kind !== 'cultivation.died') continue;
    const records = (event.kind === 'cultivation.expiryPending' ? candidate.cultivation.pendingDeaths : candidate.cultivation.deaths)
      .filter(death => death.deathId === event.relatedId && death.discipleId === event.discipleId && death.month === event.month);
    if (records.length !== 1 || event.relatedId === null) throw new TypeError('V10 emitted death lacks its actual record');
    const death = records[0]!;
    if (death.cause !== 'lifespan' && death.cause !== 'breakthrough'
      || event.kind === 'cultivation.expiryPending' && death.cause !== 'lifespan') throw new TypeError('Unsupported v10 pre-work death source');
    if (event.kind === 'cultivation.died' && source.cultivation.pendingDeaths.some(pending => pending.deathId === death.deathId
      && pending.discipleId === death.discipleId)) continue;
    const previous = source.cultivation.disciples.find(member => member.discipleId === death.discipleId);
    const profile = candidate.cultivation.disciples.find(member => member.discipleId === death.discipleId);
    const person = frame.construction.people.find(member => member.id === death.discipleId);
    if (previous?.lifeState !== 'alive' || source.cultivation.deaths.some(old => old.deathId === death.deathId || old.discipleId === death.discipleId)
      || source.cultivation.pendingDeaths.some(old => old.deathId === death.deathId || old.discipleId === death.discipleId)
      || profile?.lifeState !== (event.kind === 'cultivation.expiryPending' ? 'pendingDeath' : 'dead')
      || (event.kind === 'cultivation.expiryPending' ? profile.pendingDeathId : profile.deathId) !== death.deathId
      || !person || person.lifeState !== profile.lifeState || person.canWork
      || facts.some(fact => fact.deathId === death.deathId || fact.discipleId === death.discipleId)) throw new TypeError('V10 death is not a new unavailable boundary');
    facts.push(Object.freeze({ discipleId: death.discipleId, deathId: death.deathId, cause: death.cause,
      unavailableEventId: event.eventId, unavailableKind: event.kind,
      unavailableTick: candidate.clock.simulationTick, unavailableCalendarTick: candidate.clock.calendarTick }));
  }
  return Object.freeze(facts);
}
