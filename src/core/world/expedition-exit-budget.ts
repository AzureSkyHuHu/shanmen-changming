import { contentIdentity, RELEASE_V8_CANDIDATE } from '../../content/registry';
import { CAMPAIGN_ROUTE_IDS } from '../campaign/types';
import type { CampaignClear } from '../campaign/types';
import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import type { AbandonedCheckpoint, EncounterMemberResult, EndRunSettlement, ExpeditionCommand, ExpeditionReceipt, TimeCheckpoint,
  TravelLedgerEntry, ValidatedEncounterOutcome } from '../expeditions/types';
import type { EncounterDeathMapping, WorldExpeditionEffectReceipt } from '../expeditions/world-types';
import type { CommandReceipt } from '../kernel/contracts';
import type { RegisteredExpedition } from '../expeditions/versioned';
import { retainedRecordBytes } from '../save-budget/bounds';
import { CALENDAR_TICKS_PER_MONTH, PAUSE_REASONS } from '../kernel/clock';
import { canonicalStringify, cloneJson } from '../kernel/serialization';
import { validateWorldStateV8 } from '../kernel/validation';
import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { measureProgressionRecord } from '../save-budget/progression-bounds';
import { assessCoveredBoundaryCapacityV8 } from './runtime-capacity-v8';
import { worldBuildHistoryObligationFacts } from './progression-obligations';
import { permanentTeachingLesson } from './teaching-provenance';
import { assessRunReturnInventory } from './expedition-return-capacity';
import type { WorldStateV8, WorldRunHistoryV8 } from './v8-types';

/** Product-enforced quotas, not empirical or natural upper bounds. Hooks must
 * enforce these same values on every published boundary before activation. */
export const REGISTERED_EXPEDITION_EXIT_QUOTAS = Object.freeze({
  protocol: 'registered-exit-quota-1', registryId: 'content.release-v8.candidate-2',
  runBytes: 192 * 1024, worldEncounterBytes: 256 * 1024, squad: 6,
  encounters: 3, travelMonthsPerNode: 1, returnMonths: 1, forcedCalendarMonths: 2,
  runCommands: 512, effectReceipts: 2048, expeditionArrayLength: 8192,
});
const MAX = Number.MAX_SAFE_INTEGER;
const MAX_RESOURCE = 1_000_000_000; // Registered expedition resourceLines validator.
const INSTANCE = `instance:${MAX - 1}`;
const ENTITY = `entity:${MAX - 1}`;
const EVENT = `event:${MAX - 1}`;
const ID = 'i'.repeat(120); // Domain validId grammar; not a player-generated outcome.
const HASH = 'f'.repeat(8);
const emptySize = canonicalUtf8ByteLength(null);
const resources: ResourceLine[] = RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: MAX_RESOURCE }));
const add = (...values: number[]) => values.reduce((total, value) => total > MAX - value ? MAX + 1 : total + value, 0);
function allocatedIdentity(value: string, prefix: 'run' | 'instance'): boolean {
  const ordinal = Number(value.slice(prefix.length + 1));
  return Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal < MAX && value === `${prefix}:${ordinal}`;
}
/** Outer kernel grammar plus the complete derived domain effect ID. This helper
 * never clips, hashes, rewrites or allocates an identity. */
export function isRegisteredExitCommandId(runId: string, commandId: string): boolean {
  return allocatedIdentity(runId, 'run')
    && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(commandId)
    && !['constructor', 'prototype', '__proto__'].includes(commandId)
    && `${runId}/command/${commandId}`.length <= 120;
}
export type ExitEntry = 'emergency-retreat' | 'safe-retreat' | 'finish-checkpoint-then-retreat' | 'finish-return' | 'already-ended';
export interface RegisteredExitPlan {
  runId: string; entry: ExitEntry; calendarTicks: number; monthBoundaries: number; birthdayActions: number;
  requiredRunCommands: number; possibleMemberDeaths: number; cancelProductionIds: string[];
  cancelAttemptIds: string[]; maximumDiscardOperations: number; requiredUnpaidMeal: number;
  /** Outer recovery IDs must also fit the derived run effectId (max 120). */
  commandIdMaximumLength: number;
  requirements: readonly string[];
}
export interface ExitRecordBound {
  label: string; placement: 'run' | 'world'; count: number; bytes: number; characters: number; nodes: number;
}
export interface RegisteredExpeditionExitBudget {
  supported: boolean; fits: boolean; actualFits: boolean; unknowns: string[]; violations: string[];
  quota: typeof REGISTERED_EXPEDITION_EXIT_QUOTAS; plan: RegisteredExitPlan | null;
  costs: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  peak: { encodedWorldBytes: number; fixedWorldBytes: number; twoRunCopiesBytes: number; worldEncounterBytes: number;
    registeredProofWrapperBytes: number; progressionBytes: number; productionBytes: number; clearanceBytes: number; additionalWorldBytes: number; retainedGeneralHeadroomBytes: number; totalBytes: number };
  run: { currentBytes: number; finishDeltaBytes: number; maximumFinishedBytes: number; records: readonly ExitRecordBound[] };
  /** Composition evidence. These amounts are already included, never add again. */
  coverage: readonly string[];
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function failResult(reason: string): RegisteredExpeditionExitBudget {
  return freeze({ supported: false, fits: false, actualFits: false, unknowns: [reason], violations: [], quota: REGISTERED_EXPEDITION_EXIT_QUOTAS,
    plan: null, costs: {}, limits: {}, peak: { encodedWorldBytes: 0, fixedWorldBytes: 0, twoRunCopiesBytes: 0, worldEncounterBytes: 0,
      registeredProofWrapperBytes: 0, progressionBytes: 0, productionBytes: 0, clearanceBytes: 0, additionalWorldBytes: 0, retainedGeneralHeadroomBytes: 0, totalBytes: 0 },
    run: { currentBytes: 0, finishDeltaBytes: 0, maximumFinishedBytes: 0, records: [] }, coverage: [] });
}
/** A reader-valid imported no-op can occupy a later adapter ID. Expected
 * revisions make a prior row incompatible with a future first application even
 * if its kind happens to match. Never delete/rename the old receipt to recover. */
function occupiedExitAuthorityId(world: WorldStateV8, runCommands: number, legs: number, futureInstances: number): string | null {
  const run = world.expedition.run!; if (run.phase === 'Ended') return null;
  const nextResultId = `${run.runId}/result/${run.nodeIndex + 1}`;
  if (run.phase === 'InEncounter' && run.encounterResults.some(result => result.resultId === nextResultId)) return `run-result:${nextResultId}`;
  const domainIds = new Set([`${run.runId}/settle`]);
  for (let index = 1; index <= legs; index++) domainIds.add(`${run.runId}/month/${run.travelLedger.length + index}`);
  for (let offset = 0; offset < runCommands; offset++) domainIds.add(`${run.runId}/world-deaths/${run.revision + offset}`);
  const domainConflict = run.receipts.find(receipt => domainIds.has(receipt.commandId));
  if (domainConflict) return `run:${domainConflict.commandId}`;

  const buildIds = new Set([`${run.runId}/build-unlock`]);
  const milestoneIds = new Set<string>();
  const facts = worldBuildHistoryObligationFacts(world);
  for (const milestoneId of facts.realmMilestoneIds) { buildIds.add(`system/${milestoneId}`); milestoneIds.add(milestoneId); }
  for (const teachingId of facts.teachingIds) {
    const lesson = permanentTeachingLesson(world, teachingId);
    if (lesson) buildIds.add(`teaching/${teachingId}/${lesson.studentId}`);
  }
  if (run.settlement?.reason === 'victory') for (const member of run.members) if (member.alive
    && !world.builds.awards.some(award => award.discipleId === member.discipleId && award.ruleId === 'expedition.first-victory'))
    { buildIds.add(`${run.runId}/award/${member.discipleId}`); milestoneIds.add(`milestone.first-expedition.${member.discipleId.replace(':', '-')}`); }
  const milestoneConflict = world.builds.awards.find(award => milestoneIds.has(award.milestoneId));
  if (milestoneConflict) return `build-milestone:${milestoneConflict.milestoneId}`;
  const deathIds = new Set(world.cultivation.disciples.flatMap(profile => (profile.deathId ?? profile.pendingDeathId) ? [profile.deathId ?? profile.pendingDeathId!] : []));
  // This bounded count is derived by the existing typed progression owner, never
  // supplied by a save. It includes possible new combat/lifespan death allocations.
  for (let offset = 0; offset < futureInstances; offset++) {
    const ordinal = add(world.sequences.nextInstance, offset); if (ordinal < MAX) deathIds.add(`instance:${ordinal}`);
  }
  const deathPrefixes = [...deathIds].map(id => `death/${id}/`);
  const buildConflict = world.builds.receipts.find(receipt => buildIds.has(receipt.commandId)
    || deathPrefixes.some(prefix => receipt.commandId.startsWith(prefix)));
  if (buildConflict) return `build:${buildConflict.commandId}`;
  for (const entry of world.builds.history) if (entry.command.kind === 'equipment.transfer'
    && deathPrefixes.some(prefix => entry.command.kind === 'equipment.transfer' && entry.command.transferId.startsWith(`${prefix}item/`)))
    return `build-transfer:${entry.command.transferId}`;
  const cultivationIds = new Set([...deathIds].map(id => `death/${id}/archive`));
  if (run.phase === 'InEncounter') for (const id of deathIds) cultivationIds.add(`${run.runId}/death/${id}`);
  const cultivationConflict = world.cultivation.receipts.find(receipt => cultivationIds.has(receipt.commandId))?.commandId
    ?? world.cultivation.authorityReceipts.find(receipt => cultivationIds.has(receipt.command.commandId))?.command.commandId;
  return cultivationConflict ? `cultivation:${cultivationConflict}` : null;
}
/** Full data-only query. No plan, death, result, RNG, resource or World field is
 * executed or written. Typed envelopes below are size witnesses, not game facts.
 * The caller must still execute and validate the real recovery transitions. */
export function assessRegisteredExpeditionExitBudget(world: WorldStateV8): RegisteredExpeditionExitBudget {
  try {
    canonicalUtf8ByteLength(world);
    const errors = validateWorldStateV8(world); if (errors.length) return failResult(`Invalid source World: ${errors[0]}`);
    const run = world.expedition.run; if (!run) return failResult('No admitted run; assess the detached departure candidate');
    const quota = REGISTERED_EXPEDITION_EXIT_QUOTAS;
    if (!allocatedIdentity(run.runId, 'run') || Number(run.runId.slice(4)) >= world.sequences.nextAction)
      return failResult('Unproved run allocation namespace; preserve the original source');
    for (const member of run.members) if (member.alive) {
      const pending = world.cultivation.pendingDeaths.find(death => death.discipleId === member.discipleId);
      if (pending && (!allocatedIdentity(pending.deathId, 'instance') || Number(pending.deathId.slice(9)) >= world.sequences.nextInstance))
        return failResult('Unproved pending away-death allocation namespace; preserve the original source');
    }
    if (world.expedition.protocol !== 'release-v3' || run.schemaVersion !== 3
      || run.identity.registryId !== quota.registryId
      || world.expedition.contentIdentity?.registryId !== quota.registryId
      || canonicalStringify(world.expedition.contentIdentity) !== canonicalStringify(contentIdentity(RELEASE_V8_CANDIDATE))) return failResult('Unsupported saved run identity/protocol; preserve the legacy source');
    if (!CAMPAIGN_ROUTE_IDS.includes(world.expedition.routeId!) || run.origin.route.encounterCount !== quota.encounters
      || run.origin.route.minimumTravelMonths !== 1 || run.origin.route.maximumTravelMonths !== 1 || run.origin.route.returnMonths !== quota.returnMonths
      || (run.origin.monthlyMealPerMember ?? 1) !== 1 || run.members.length < 1 || run.members.length > quota.squad) return failResult('Unproved route, party or provision rules');
    if (world.clock.pauseReasons.includes('error')) return failResult('An invariant-error pause has no certified command recovery');
    if (world.pendingCommands.length) return failResult('Queued optional effects must be settled before certifying a fixed exit path');
    if (run.phase === 'Preparing') return failResult('Departure has not atomically admitted its supplies and locks');
    if (run.phase !== 'Ended' && (world.expedition.history.some(history => history.runId === run.runId)
      || world.campaign.settledRunEvidence.some(proof => proof.run.runId === run.runId))) return failResult('Active run already has a terminal history/proof');
    const returnInventory = assessRunReturnInventory(world);
    if (!returnInventory.fits) return failResult('Incoming cargo itself exceeds storage capacity; discard is not a recovery proof');
    if (returnInventory.creditCeilings.some(line => line.quantity > MAX_RESOURCE)) return failResult('Return credit exceeds the registered resource-line arithmetic bound');
    // These imported/partial boundaries need a separate real transition proof. A
    // pending away death in RewardPending regenerates its offer and consumes RNG.
    if (run.phase === 'RewardPending' && world.cultivation.pendingDeaths.some(death => run.members.some(member => member.discipleId === death.discipleId && member.alive)))
      return failResult('Pending away death would regenerate an offer; its RNG/offer recovery is not certified');
    if (run.phase === 'InEncounter' && (world.expedition.battle?.controller.outcome.status !== 'running'
      || world.cultivation.pendingDeaths.length || world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady')))
      return failResult('Emergency retreat requires a running controller without a blocking cultivation decision');
    if (run.phase === 'InEncounter' && !world.expedition.battle!.participants.some(participant =>
      world.expedition.battle!.controller.battle.entities[participant.battleEntityId]!.life !== 'Dead'))
      return failResult('Running controller has no non-permanently-dead participant for a real emergency retreat');
    const covered = assessCoveredBoundaryCapacityV8(world);
    if (!covered.supported) return failResult('Underlying progression/production record or numeric obligations are unproved');
    const active = run.phase !== 'Ended';
    const commandIdMaximumLength = Math.min(128, 120 - `${run.runId}/command/`.length);
    if (commandIdMaximumLength < 1) return failResult('Run effect namespace leaves no legal player recovery command ID');
    const entry: ExitEntry = run.phase === 'InEncounter' ? 'emergency-retreat' : run.phase === 'Travelling' ? 'finish-checkpoint-then-retreat'
      : run.phase === 'Ending' ? 'finish-return' : run.phase === 'Ended' ? 'already-ended' : 'safe-retreat';
    const living = run.members.filter(member => member.alive).length;
    const returnMonths = active && living ? (run.settlement ? Math.max(0, run.settlement.returnMonths - run.settlement.returnProgress) : quota.returnMonths) : 0;
    const remainingTravel = run.phase === 'Travelling' ? world.expedition.travel
      ? world.expedition.travel.targetCalendarTick - world.clock.calendarTick : CALENDAR_TICKS_PER_MONTH : 0;
    const returnTicks = run.phase === 'Ending' && world.expedition.travel
      ? world.expedition.travel.targetCalendarTick - world.clock.calendarTick : returnMonths * CALENDAR_TICKS_PER_MONTH;
    const calendarTicks = add(remainingTravel, returnTicks);
    if (calendarTicks > quota.forcedCalendarMonths * CALENDAR_TICKS_PER_MONTH) return failResult('Exit requires more than the proved two-month calendar window');
    const endTick = add(world.clock.calendarTick, calendarTicks);
    const monthBoundaries = endTick > MAX ? quota.forcedCalendarMonths : Math.floor(endTick / CALENDAR_TICKS_PER_MONTH) - world.cultivation.calendarMonth;
    const birthdays = new Set<number>();
    if (endTick <= MAX) for (const actor of world.disciples) if (actor.lifeState === 'alive') {
      // There are at most two birthdays per actor in this bounded interval. Only
      // non-global-month birthdays allocate a separate synchronization action.
      const first = add(world.clock.calendarTick, CALENDAR_TICKS_PER_MONTH - ((world.clock.calendarTick - actor.birthCalendarTick) % CALENDAR_TICKS_PER_MONTH));
      for (let tick = first; tick <= endTick && tick <= MAX; tick += CALENDAR_TICKS_PER_MONTH) if (tick % CALENDAR_TICKS_PER_MONTH !== 0) birthdays.add(tick);
    }
    const birthdayActions = birthdays.size;
    const forcedActions = add(monthBoundaries, birthdayActions);
    // A prepaid cursor AT its target still owns an uncommitted ledger row.
    const legs = active ? (run.phase === 'Travelling' ? 1 : 0) + returnMonths : 0;
    if (active && legs > 0 && !world.expedition.travel && run.calendarMonth !== world.cultivation.calendarMonth)
      return failResult('Unaligned run/World month before mandatory checkpoint admission');
    const prepaid = world.expedition.travel ? 1 : 0;
    const timeCommands = Math.max(0, 2 * legs - prepaid);
    const entryCommands = active && run.phase !== 'Ending' ? 1 : 0;
    const requiredRunCommands = active ? timeCommands + entryCommands + living + 1 : 0;
    const conflict = occupiedExitAuthorityId(world, requiredRunCommands, legs, covered.progression.progression.totals.sequenceReserve.nextInstance);
    if (conflict) return failResult(`Mandatory adapter identity already occupied: ${conflict}`);
    const requiredUnpaidMeal = Math.max(0, legs - prepaid) * living;
    if ((run.supplies.find(line => line.resourceId === 'meal')?.quantity ?? 0) < requiredUnpaidMeal)
      return failResult('Existing carried meals cannot pay the mandatory unadmitted exit checkpoints');
    const plan: RegisteredExitPlan = { runId: run.runId, entry, calendarTicks, monthBoundaries, birthdayActions, requiredRunCommands,
      possibleMemberDeaths: active ? living : 0, cancelProductionIds: active ? [...world.activeProductionTransactionIds] : [], commandIdMaximumLength,
      cancelAttemptIds: active ? world.cultivation.attempts.filter(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)).map(attempt => attempt.attemptId) : [],
      maximumDiscardOperations: covered.clearance.maximumDiscardOperations, requiredUnpaidMeal,
      requirements: ['Use the real controller outcome for emergency retreat; never synthesize victory',
        'Cancel every existing production job before the bounded recovery clock advances; its existing reservation pays cancellation',
        'Admit no new optional production, enrollment, lesson, build or expedition choice during recovery unless the complete exit certificate is recomputed',
        'Respect real pending deaths; confirm them through existing commands and cancel every unsampled active attempt before advancing the recovery clock',
        'Finish any prepaid travel checkpoint through ordinary ticks, then use the legal retreat; never refund or jump its calendar',
        'Enforce product run/WorldEncounter quotas and every reader/row/counter dimension on each published complete boundary'] };

    const records: ExitRecordBound[] = [];
    let extraArchiveReceiptRows = 0; let extraArchiveCharacters = 0; let extraArchiveNodes = 0;
    const record = (label: string, placement: 'run' | 'world', value: unknown, count = 1, current?: unknown): void => {
      if (!count) return;
      const maximum = measureProgressionRecord(value); const used = current === undefined ? { bytes: 0, decodedCharacters: 0, decodedNodes: 0 } : measureProgressionRecord(current);
      const delimiter = current === undefined ? 1 : 0;
      records.push({ label, placement, count, bytes: Math.max(0, maximum.bytes - used.bytes) * count + delimiter * count,
        characters: Math.max(0, maximum.decodedCharacters - used.decodedCharacters) * count + delimiter * count,
        nodes: Math.max(0, maximum.decodedNodes - used.decodedNodes) * count });
    };
    const memberResults: EncounterMemberResult[] = run.members.map(member => ({ discipleId: member.discipleId, alive: false, permanentDeathId: INSTANCE,
      health: member.loadout.stats.maxHealth, spirit: member.loadout.maximumSpirit, injury: 100, durability: 100 }));
    const outcome: ValidatedEncounterOutcome = { encounterId: run.currentEncounter?.encounterId ?? ID, resultId: ID,
      validation: { kind: 'validatedCombatOutcome', battleId: ID, battleSnapshotHash: HASH }, outcome: 'emergencyRetreat', retreatConfirmed: true,
      members: memberResults, consumedSupplies: [], securedLoot: [], unsecuredLoot: [], unlockIds: [] };
    const checkpoint: TimeCheckpoint = { checkpointId: ID, timeSettlementId: ID, runId: run.runId, kind: 'return', nodeVisitId: ID,
      monthOrdinal: 1, expectedCalendarMonth: MAX - 1, resultingCalendarMonth: MAX, absentDiscipleIds: run.members.map(member => member.discipleId),
      supplyCost: [{ resourceId: 'meal', quantity: run.members.length }] };
    const end: EndRunSettlement = { settlementId: `${run.runId}/settlement`, reason: 'emergencyRetreat', createdMonth: MAX,
      returnMonths: 1, retainedUnsecuredBps: 10000, loot: resources, lostLoot: resources, unusedSupplies: resources,
      unlockIds: [...run.unlockIds], returnProgress: 1, committed: false, commitId: ID };
    const commandId = 'c'.repeat(commandIdMaximumLength);
    const bodies: ExpeditionCommand[] = [
      { kind: 'encounter.resolve', commandId, expectedRevision: MAX - 1, result: outcome },
      { kind: 'members.died', commandId, expectedRevision: MAX - 1, discipleIds: run.members.map(member => member.discipleId), deathRecordIds: run.members.map(() => INSTANCE) },
      { kind: 'time.admit', commandId, expectedRevision: MAX - 1, checkpointId: ID, expectedCalendarMonth: MAX - 1 },
      { kind: 'time.commit', commandId, expectedRevision: MAX - 1, checkpointId: ID, expectedCalendarMonth: MAX - 1, resultingCalendarMonth: MAX },
      { kind: 'run.end', commandId, expectedRevision: MAX - 1, reason: 'safeRetreat' },
      { kind: 'run.settle', commandId, expectedRevision: MAX - 1, settlementId: ID },
    ];
    const maximumCommand = bodies.reduce((left, right) => canonicalUtf8ByteLength(left) >= canonicalUtf8ByteLength(right) ? left : right);
    const receipt: ExpeditionReceipt = { commandId, commandHash: HASH, kind: 'encounter.resolve', revision: MAX, effectIds: [ID], resultId: ID };
    if (active) {
      record('mandatory domain commands (largest typed exit command per row)', 'run', maximumCommand, requiredRunCommands);
      record('mandatory domain receipts', 'run', receipt, requiredRunCommands);
      if (run.phase === 'InEncounter') record('actual emergency outcome retained alongside its command', 'run', outcome);
      record('terminal settlement including all possible cargo and loss lines', 'run', end, 1, run.settlement ?? undefined);
      record('one admitted checkpoint before append', 'run', checkpoint, legs ? 1 : 0, run.admittedCheckpoint ?? undefined);
      const ledger: TravelLedgerEntry = { ...checkpoint, committedBy: ID }; record('completed prepaid and return ledger rows', 'run', ledger, legs);
      const abandoned: AbandonedCheckpoint = { checkpoint, reason: 'allMembersDead', abandonedAtCalendarMonth: MAX };
      record('possible all-dead prepaid checkpoint abandonment', 'run', abandoned, legs ? 1 : 0);
      for (const [index, member] of run.members.entries()) record(`member terminal widths:${member.discipleId}`, 'run', { ...cloneJson(member), ...memberResults[index]! }, 1, member);
      for (const offer of run.offers) if (offer.resolution === 'pending') record(`offer forfeiture:${offer.offerId}`, 'run',
        { ...cloneJson(offer), resolution: 'forfeited', commitId: `${run.runId}/settlement/forfeit/${offer.offerId}` }, 1, offer);
      record('run scalar widths', 'run', { revision: MAX, calendarMonth: MAX, locked: false, phase: 'RewardPending', forfeited: MAX }, 1,
        { revision: run.revision, calendarMonth: run.calendarMonth, locked: run.locked, phase: run.phase, forfeited: run.rewardCounters.forfeited });
      const effect: WorldExpeditionEffectReceipt = { effectId: ID, runId: run.runId, kind: 'encounterResult', simulationTick: MAX };
      record('applied effect acknowledgements', 'world', effect, requiredRunCommands);
      if (run.phase === 'InEncounter') {
        // The generic continuation reserve is deliberately supplemented by the
        // complete fatal-outcome event-list receipt; do not rely on accidental
        // spare bytes in another command's longer fingerprint.
        const fatalReceipt: CommandReceipt = { commandId,
          fingerprint: canonicalStringify({ kind: 'expedition.command', payload: { command: { commandId, kind: 'expedition.emergency-retreat', expectedBasisStamp: HASH, acknowledgeLoss: true } } }),
          result: { commandId, status: 'accepted', transactionId: null, eventIds: run.members.map(() => EVENT), rejection: null,
            expeditionResult: { kind: 'expedition.emergency-retreat', runId: run.runId, phase: 'Ending', relatedId: ID } } };
        const decoded = measureProgressionRecord(fatalReceipt);
        records.push({ label: 'supplemental fatal emergency World receipt (overlaps generic continuation reserve)', placement: 'world', count: 1,
          bytes: retainedRecordBytes(fatalReceipt, commandId, [fatalReceipt.fingerprint]), characters: decoded.decodedCharacters, nodes: decoded.decodedNodes + 32 });
        extraArchiveReceiptRows = 1; extraArchiveCharacters = decoded.decodedCharacters; extraArchiveNodes = decoded.decodedNodes + 32;
      }
      const mapping: EncounterDeathMapping = { encounterId: ID, battleEntityId: ENTITY, battleDeathId: INSTANCE, discipleId: ENTITY, worldDeathId: INSTANCE };
      record('new actual combat-to-World death mappings', 'world', mapping, run.phase === 'InEncounter' ? living : 0);
      const history: WorldRunHistoryV8 = { runId: run.runId, settlementId: `${run.runId}/settlement`, reason: 'emergencyRetreat', result: 'withdrawn',
        routeId: world.expedition.routeId!, contentIdentity: cloneJson(world.expedition.contentIdentity!), protocol: 'release-v3',
        forcedWithdrawal: false, endedCalendarTick: MAX, loot: resources, returnedSupplies: resources, lostLoot: resources,
        survivingDiscipleIds: run.members.map(member => member.discipleId), deadDiscipleIds: run.members.map(member => member.discipleId),
        deathMappings: [...cloneJson(world.expedition.deathMappings), ...Array.from({ length: living }, () => mapping)] };
      record('one terminal history summary with all future mappings', 'world', history);
      const clear: CampaignClear = { revision: MAX, routeId: world.expedition.routeId!, runId: run.runId, settlementId: `${run.runId}/settlement`, endedMonth: MAX, evidenceHash: HASH };
      record('possible already-won first-clear record', 'world', clear);
      record('first-clear reference to the one shared run proof', 'world', { routeId: world.expedition.routeId!, runId: run.runId });
      record('campaign revision width', 'world', MAX, 1, world.campaign.progress.revision);
      record('settled unlock insertions (no new reward is assumed)', 'world', [...run.unlockIds]);
      record('recovery pause fields', 'world', [...PAUSE_REASONS], 1, world.clock.pauseReasons);
      record('management clock mode width after combat', 'world', 'management', 1, world.clock.mode);
      record('temporary travel cursor', 'world', { checkpointId: ID, startCalendarTick: MAX - CALENDAR_TICKS_PER_MONTH, targetCalendarTick: MAX }, legs ? 1 : 0, world.expedition.travel ?? undefined);
      record('return blocker and withdrawal widths', 'world', { blockedReason: 'INVENTORY_FULL', forcedWithdrawal: false }, 1,
        { blockedReason: world.expedition.blockedReason, forcedWithdrawal: world.expedition.forcedWithdrawal });
      const inventory = cloneJson(world.inventory);
      for (const resourceId of RESOURCE_IDS) inventory[resourceId] = { ...inventory[resourceId], owned: inventory[resourceId].capacity, reserved: inventory[resourceId].capacity };
      record('return inventory digit growth (actual capacities and preserved extensions)', 'world', inventory, 1, world.inventory);
    }
    const runDelta = records.filter(record => record.placement === 'run').reduce((sum, record) => add(sum, record.bytes), 0);
    const worldDelta = records.filter(record => record.placement === 'world').reduce((sum, record) => add(sum, record.bytes), 0);
    const encoded = measureWorldSaveBytes(world, { saveVersion: 8 }); // Existing helper uses worst legal escaped metadata.
    const runBytes = canonicalUtf8ByteLength(run); const encounterBytes = canonicalUtf8ByteLength(world.expedition.battle);
    const fixed = encoded - runBytes - encounterBytes;
    const proofShell: Omit<Extract<RegisteredExpedition, { protocol: 'release-v3' }>, 'run'> & { run: null } = { schemaVersion: 1,
      identity: world.expedition.contentIdentity!, routeId: world.expedition.routeId!, protocol: 'release-v3', run: null };
    const proofWrapper = canonicalUtf8ByteLength(proofShell) - emptySize + 1; // New array entry separator.
    const existing = covered.progression.base;
    // Preserve the old named margin until review proves its complete replacement.
    // Compose known production costs explicitly; never subtract an opaque total.
    const production = add(existing.journalReserveBytes, existing.liveObligationBytes, existing.manualObligationBytes, existing.pendingObligationBytes);
    const progression = covered.progression.progression.totals;
    const peak = { encodedWorldBytes: encoded, fixedWorldBytes: fixed, twoRunCopiesBytes: active ? 2 * quota.runBytes : runBytes,
      worldEncounterBytes: active ? quota.worldEncounterBytes : encounterBytes, registeredProofWrapperBytes: active ? proofWrapper : 0,
      progressionBytes: progression.bytes, productionBytes: production, clearanceBytes: covered.clearance.bytes,
      additionalWorldBytes: worldDelta, retainedGeneralHeadroomBytes: existing.generalHeadroomBytes, totalBytes: 0 };
    peak.totalBytes = add(peak.fixedWorldBytes, peak.twoRunCopiesBytes, peak.worldEncounterBytes, peak.registeredProofWrapperBytes,
      peak.progressionBytes, peak.productionBytes, peak.clearanceBytes, peak.additionalWorldBytes, peak.retainedGeneralHeadroomBytes);
    const costs = { ...covered.costs }; const limits = { ...covered.limits };
    costs.wireBytes = peak.totalBytes;
    costs.archiveReceiptRows = add(costs.archiveReceiptRows!, extraArchiveReceiptRows);
    costs.archiveCharacters = add(costs.archiveCharacters!, extraArchiveCharacters);
    costs.archiveNodes = add(costs.archiveNodes!, extraArchiveNodes);
    costs.runQuota = add(runBytes, runDelta); limits.runQuota = quota.runBytes;
    costs.worldEncounterQuota = encounterBytes; limits.worldEncounterQuota = quota.worldEncounterBytes;
    costs.runCommands = add(run.commandLog.length, requiredRunCommands); limits.runCommands = quota.runCommands;
    costs.runReceipts = add(run.receipts.length, requiredRunCommands); limits.runReceipts = quota.runCommands;
    costs.runRevision = add(run.revision, requiredRunCommands); limits.runRevision = MAX;
    costs.runCalendarMonth = add(run.calendarMonth, legs); limits.runCalendarMonth = MAX;
    costs.runRewardForfeitures = add(run.rewardCounters.forfeited, active && run.currentOfferId ? 1 : 0); limits.runRewardForfeitures = MAX;
    costs.effectReceipts = add(world.expedition.effectReceipts.length, requiredRunCommands); limits.effectReceipts = quota.effectReceipts;
    costs.expeditionHistory = add(world.expedition.history.length, active ? 1 : 0); limits.expeditionHistory = quota.expeditionArrayLength;
    costs.settledRunProofs = add(world.campaign.settledRunEvidence.length, active ? 1 : 0); limits.settledRunProofs = quota.expeditionArrayLength;
    costs.deathMappings = add(world.expedition.deathMappings.length, run.phase === 'InEncounter' ? living : 0); limits.deathMappings = quota.expeditionArrayLength;
    costs.runEncounterResults = add(run.encounterResults.length, run.phase === 'InEncounter' ? 1 : 0); limits.runEncounterResults = quota.encounters;
    costs.runTravelLedger = add(run.travelLedger.length, legs); limits.runTravelLedger = quota.expeditionArrayLength;
    costs.runAbandonedCheckpoints = add(run.abandonedCheckpoints.length, legs ? 1 : 0); limits.runAbandonedCheckpoints = quota.expeditionArrayLength;
    costs['sequence.nextAction'] = add(costs['sequence.nextAction']!, forcedActions);
    // Existing progression funds terminal deaths/attempts and their raw RNG needs.
    // Calendar/birthday actions and injury-only profile updates are additional.
    costs.cultivationRevision = add(costs.cultivationRevision!, forcedActions, run.phase === 'InEncounter' ? living : 0);
    costs.calendarMonth = add(costs.calendarMonth!, monthBoundaries);
    costs.calendarTick = add(costs.calendarTick!, calendarTicks);
    costs.simulationTick = add(costs.simulationTick!, calendarTicks);
    for (const actor of world.disciples) if (actor.lifeState === 'alive') { const key = `chronology.${actor.id}`; costs[key] = add(world.clock.calendarTick - actor.birthCalendarTick, calendarTicks); limits[key] = MAX; }
    for (const [key, extra] of Object.entries(progression.buildCollections)) {
      const current = key === 'learnedSkills' ? world.builds.disciples.reduce((sum, disciple) => sum + disciple.learnedSkills.length, 0) : world.builds[key as Exclude<keyof typeof progression.buildCollections, 'learnedSkills'>].length;
      costs[`build.${key}`] = add(current, extra); limits[`build.${key}`] = key === 'history' || key === 'receipts' ? 1024 : 16_384;
    }
    for (const [key, extra] of Object.entries(progression.legacyRows)) { costs[`legacy.${key}`] = add(world.legacy[key as keyof typeof progression.legacyRows].length, extra); limits[`legacy.${key}`] = MAX_CULTIVATION_HISTORY; }
    // No new campaign claim is part of retreat. A legitimate already-won Ending
    // may add one clear; include that domain reader increment explicitly.
    const campaignSize = measureProgressionRecord({ format: 'shanmen-campaign', version: 2, state: world.campaign.progress, checksum: HASH });
    const campaignGrowth = records.filter(record => record.label.includes('first-clear record') || record.label === 'campaign revision width');
    costs.campaignReaderNodes = add(campaignSize.decodedNodes, ...campaignGrowth.map(record => record.nodes)); limits.campaignReaderNodes = 200_000;
    costs.campaignReaderCharacters = add(campaignSize.decodedCharacters, ...campaignGrowth.map(record => record.characters)); limits.campaignReaderCharacters = 2_000_000;
    const possibleClear = active && run.settlement?.reason === 'victory' && !world.campaign.progress.clears.some(clear => clear.routeId === world.expedition.routeId) ? 1 : 0;
    costs.campaignClears = add(world.campaign.progress.clears.length, possibleClear); limits.campaignClears = CAMPAIGN_ROUTE_IDS.length;
    costs.campaignClearEvidence = add(world.campaign.clearEvidence.length, possibleClear); limits.campaignClearEvidence = CAMPAIGN_ROUTE_IDS.length;
    costs.campaignRevision = add(world.campaign.progress.revision, possibleClear); limits.campaignRevision = MAX;
    costs.cultivationSectRelics = add(world.cultivation.sectRelicIds.length, ...world.cultivation.disciples.map(profile => profile.relicIds.length)); limits.cultivationSectRelics = MAX_CULTIVATION_HISTORY;
    const runHeader = canonicalUtf8ByteLength({ format: 'shanmen-expedition', version: 3, state: null, checksum: HASH }) - emptySize;
    costs.runReaderCharacters = quota.runBytes + runHeader; limits.runReaderCharacters = 4_000_000;
    const battleHeader = canonicalUtf8ByteLength({ snapshotVersion: 2, simulationVersion: 'combat-runtime-2', checksum: HASH, state: null }) - emptySize;
    const controllerHeader = canonicalUtf8ByteLength({ version: 2, checksum: HASH, state: null }) - emptySize;
    costs.battleReaderCharacters = quota.worldEncounterBytes + battleHeader; limits.battleReaderCharacters = 8_000_000;
    costs.controllerReaderCharacters = 2 * (quota.worldEncounterBytes + battleHeader) + controllerHeader + 2; limits.controllerReaderCharacters = 16_000_000;
    const violations = Object.keys(costs).filter(key => !Number.isSafeInteger(costs[key]) || costs[key]! < 0
      || !Number.isSafeInteger(limits[key]) || costs[key]! > limits[key]!);
    return freeze({ supported: true, fits: covered.progression.numeric.fits && violations.length === 0, actualFits: encoded <= SAVE_FILE_LIMIT_BYTES,
      unknowns: [], violations, quota, plan, costs, limits, peak,
      run: { currentBytes: runBytes, finishDeltaBytes: runDelta, maximumFinishedBytes: add(runBytes, runDelta), records },
      coverage: ['worst legal envelope metadata and two serialized run copies', 'product-enforced run and WorldEncounter quotas; not natural maxima',
        'typed mandatory exit commands, receipts, outcomes, checkpoint/settlement/forfeiture/member growth', 'World effects, history, mappings, clear/reference and reader bounds',
        'existing production cancellation and at most six complete clearance operations via the existing budget',
        'existing progression build/cultivation/archive/death/estate record vector without adding build rows twice',
        'bounded actual month and off-boundary-birthday actions, IDs, revisions and calendar arithmetic',
        'no future combat victory promise; unrecognized contents, queues and old protocols fail closed'] });
  } catch (error) { return failResult(error instanceof Error ? error.message : 'Unknown exit-budget derivation failure'); }
}
