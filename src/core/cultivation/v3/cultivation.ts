import { availableResource, commitReservation, normalizeResourceLines, releaseReservation, reserveResources } from '../../economy/inventory';
import { allocateId } from '../../kernel/ids';
import { checkedAdd } from '../../kernel/numeric';
import { drawInteger } from '../../kernel/random';
import { canonicalStringify, cloneJson, compareStable, stableHash } from '../../kernel/serialization';
import { CULTIVATION_RULES as RULES, MAX_MONTHS_PER_STEP, PERMANENT_TALENT_RULES, REALM_RULES } from '../rules';
import { REALMS, type BreakthroughAttempt, type BreakthroughPreparation, type BreakthroughPreview, type CultivationCommand,
  type CultivationCommandResult, type CultivationError, type CultivationEvent, type CultivationFrame, type CultivationState,
  type CultivationTransition, type CultivationAgeSyncResult, type Cultivator, type DeathCause, type DeathRecord, type MonthStepResult, type Realm } from './types';
import { validIdentity, isCultivationCommand } from '../validation';
import { validateCultivationFrameV3 } from './validation';

class CultivationFault extends Error { constructor(readonly code: CultivationError) { super(code); } }
const fail = (code: CultivationError): never => { throw new CultivationFault(code); };
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
function id(frame: CultivationFrame, kind: 'instance' | 'event' | 'action'): string {
  const allocated = allocateId(frame.sequences, kind); frame.sequences = allocated.sequences; return allocated.id;
}
function disciple(frame: CultivationFrame, discipleId: string): Cultivator {
  return frame.cultivation.disciples.find((d) => d.discipleId === discipleId) ?? fail('UNKNOWN_DISCIPLE');
}
function attempt(frame: CultivationFrame, attemptId: string): BreakthroughAttempt {
  return frame.cultivation.attempts.find((a) => a.attemptId === attemptId) ?? fail('UNKNOWN_ATTEMPT');
}
function event(frame: CultivationFrame, kind: CultivationEvent['kind'], rootActionId: string, discipleId: string, relatedId: string | null): void {
  frame.cultivation.events.push({ eventId: id(frame, 'event'), kind, month: frame.cultivation.calendarMonth, rootActionId, discipleId, relatedId });
}
function available(d: Cultivator): void { if (d.activityOwner) fail('ACTIVITY_LOCKED'); if (d.lifeState !== 'alive' || d.activeAttemptId || d.teaching) fail('DISCIPLE_UNAVAILABLE'); }

export function createCultivatorV3(discipleId: string, options: {
  ageMonths?: number; realm?: Realm; aptitude?: number; cultivation?: number; understanding?: number; foundation?: number;
  mindset?: number; injury?: number; relicIds?: string[]; knowledgeIds?: string[];
} = {}): Cultivator {
  const realm = options.realm ?? 'mortal';
  if (!validIdentity(discipleId) || !REALMS.includes(realm)) throw new TypeError('Invalid cultivator identity/realm');
  const candidate: Cultivator = {
    discipleId, ageMonths: options.ageMonths ?? 18 * 12, realm, lifespanMonths: REALM_RULES[realm].lifespanMonths,
    cultivation: options.cultivation ?? 0, understanding: options.understanding ?? 25, foundation: options.foundation ?? 25,
    mindset: options.mindset ?? 50, injury: options.injury ?? 0, aptitude: options.aptitude ?? 50,
    lifeState: 'alive', trainingMode: 'duty', activeAttemptId: null, pendingDeathId: null, deathId: null, heirId: null,
    relicIds: [...(options.relicIds ?? [])], knowledge: (options.knowledgeIds ?? []).map((knowledgeId) => ({ knowledgeId, teacherId: null, teachingId: null })),
    teaching: null, talents: [], activityOwner: null,
  };
  const integers = [candidate.ageMonths, candidate.cultivation, candidate.aptitude, candidate.understanding, candidate.foundation, candidate.mindset, candidate.injury];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0) || candidate.ageMonths >= candidate.lifespanMonths
    || candidate.cultivation > REALM_RULES[realm].cultivationRequired || integers.slice(2).some((value) => value > 100)
    || candidate.relicIds.some((value) => !validIdentity(value)) || new Set(candidate.relicIds).size !== candidate.relicIds.length
    || candidate.knowledge.some((value) => !validIdentity(value.knowledgeId)) || new Set(candidate.knowledge.map((entry) => entry.knowledgeId)).size !== candidate.knowledge.length) throw new TypeError('Invalid cultivator progression');
  return candidate;
}
export function createCultivationStateV3(disciples: readonly Cultivator[], calendarMonth = 0): CultivationState {
  return { schemaVersion: 3, revision: 0, calendarMonth, disciples: cloneJson([...disciples]), attempts: [], pendingDeaths: [], deaths: [], sectRelicIds: [], receipts: [], events: [],
    legacyIdentities: disciples.map(d => ({ discipleId: d.discipleId, knowledge: cloneJson(d.knowledge) })), legacyStateExtras: {}, archivedDisciples: [], authorityReceipts: [] };
}

/** Prepared is a serializable pure proposal. Confirm recomputes it, so forged/stale risk numbers cannot debit resources. */
export function previewBreakthroughV3(frame: CultivationFrame, discipleId: string, preparation: BreakthroughPreparation = { method: 'standard', arraySupport: 0 }): BreakthroughPreview {
  if (validateCultivationFrameV3(frame).length || !preparation || !['standard', 'forced'].includes(preparation.method) || ![0, 1, 2].includes(preparation.arraySupport)) throw new TypeError('Invalid breakthrough preview input');
  const d = disciple(frame, discipleId);
  const rule = REALM_RULES[d.realm];
  const targetRealm = REALMS[REALMS.indexOf(d.realm) + 1] ?? null;
  const coefficients = RULES.success;
  const factors: BreakthroughPreview['factors'] = [
    { key: 'base', contributionBps: coefficients.baseBps },
    { key: 'understanding', contributionBps: d.understanding * coefficients.understandingCoefficient },
    { key: 'foundation', contributionBps: d.foundation * coefficients.foundationCoefficient },
    { key: 'mindset', contributionBps: d.mindset * coefficients.mindsetCoefficient },
    { key: 'array', contributionBps: preparation.arraySupport * coefficients.arrayLevelBps },
    { key: 'injury', contributionBps: d.injury * coefficients.injuryCoefficient },
    { key: 'tribulation', contributionBps: rule.tribulation * coefficients.tribulationCoefficient },
    { key: 'forced', contributionBps: preparation.method === 'forced' ? coefficients.forcedBonusBps : 0 },
  ];
  const successBps = clamp(factors.reduce((sum, factor) => sum + factor.contributionBps, 0), coefficients.minimumBps, coefficients.maximumBps);
  const failureDeathBps = clamp(rule.baseFailureDeathBps + (preparation.method === 'forced' ? RULES.failure.forcedDeathBps : 0)
    + Math.max(0, d.injury - RULES.failure.severeInjuryThreshold) * RULES.failure.injuryDeathCoefficient, 0, RULES.failure.maximumDeathBps);
  const costs = rule.costs.map((line) => ({ ...line }));
  if (preparation.arraySupport > 0) {
    const stone = costs.find((line) => line.resourceId === 'stone');
    if (stone) stone.quantity += preparation.arraySupport * 2;
    else costs.push({ resourceId: 'stone', quantity: preparation.arraySupport * 2 });
  }
  const normalizedCosts = normalizeResourceLines(costs);
  if (!normalizedCosts) throw new TypeError('Invalid registered breakthrough costs');
  const blockers: BreakthroughPreview['blockers'] = [];
  if (d.lifeState !== 'alive') blockers.push('NOT_ALIVE');
  if (d.activeAttemptId || d.teaching || d.activityOwner) blockers.push('BUSY');
  if (!targetRealm) blockers.push('FINAL_REALM');
  if (d.cultivation < rule.cultivationRequired) blockers.push('CULTIVATION_REQUIRED');
  if (preparation.method === 'standard' && d.injury > RULES.standardMaximumInjury) blockers.push('INJURY_TOO_HIGH');
  if (costs.some((line) => availableResource(frame.inventory[line.resourceId]) < line.quantity)) blockers.push('MATERIALS_REQUIRED');
  const remainingLifespanMonths = Math.max(0, d.lifespanMonths - d.ageMonths);
  const warnings: BreakthroughPreview['warnings'] = ['MONTHLY_SUPPLY_REQUIRED'];
  if (remainingLifespanMonths <= rule.seclusionMonths) warnings.push('LIFESPAN_BEFORE_COMPLETION');
  if (availableResource(frame.inventory.meal) < rule.seclusionMonths * RULES.monthlyMealCost) warnings.push('AVAILABLE_MEALS_BELOW_PLAN');
  if (failureDeathBps > 0) warnings.push('FAILURE_CAN_KILL');
  if (preparation.method === 'forced') warnings.push('FORCED_ATTEMPT');
  return { phase: 'Prepared', rulesVersion: 1, stateRevision: frame.cultivation.revision,
    basisHash: stableHash({ disciple: d, inventory: frame.inventory, month: frame.cultivation.calendarMonth, revision: frame.cultivation.revision }),
    discipleId, targetRealm, preparation: { ...preparation }, costs: normalizedCosts, seclusionMonths: rule.seclusionMonths,
    monthlyMealCost: RULES.monthlyMealCost, remainingLifespanMonths, successBps, failureDeathBps,
    overallDeathBps: Math.floor((10000 - successBps) * failureDeathBps / 10000), factors, blockers, warnings };
}
function cancel(frame: CultivationFrame, a: BreakthroughAttempt): void {
  if (a.phase === 'Cancelled' || a.phase === 'Resolved') fail('ATTEMPT_FINISHED');
  const released = releaseReservation(frame.inventory, a.reservation);
  if (!released.ok) return fail('INSUFFICIENT_RESOURCES');
  frame.inventory = released.inventory; a.reservation = released.reservation;
  a.phase = 'Cancelled'; a.outcome = 'cancelled'; a.blockedReason = null;
  disciple(frame, a.discipleId).activeAttemptId = null;
  event(frame, 'cultivation.cancelled', a.rootActionId, a.discipleId, a.attemptId);
}
function clearUnavailableReferences(frame: CultivationFrame, discipleId: string): void {
  for (const d of frame.cultivation.disciples) {
    if (d.heirId === discipleId) d.heirId = null;
    if (d.teaching?.studentId === discipleId) d.teaching = null;
  }
}
function settleDeath(frame: CultivationFrame, d: Cultivator, deathId: string, cause: DeathCause, rootActionId: string): DeathRecord {
  if (d.lifeState === 'dead' || frame.cultivation.deaths.some((death) => death.deathId === deathId)) fail('DEATH_CONFLICT');
  const cancelledAttemptId = d.activeAttemptId;
  if (d.activeAttemptId) cancel(frame, attempt(frame, d.activeAttemptId));
  const heir = d.heirId === null ? undefined : frame.cultivation.disciples.find((candidate) => candidate.discipleId === d.heirId && candidate.lifeState === 'alive');
  const relics = [...d.relicIds];
  if (heir) heir.relicIds.push(...relics); else frame.cultivation.sectRelicIds.push(...relics);
  d.relicIds = []; d.lifeState = 'dead'; d.deathId = deathId; d.pendingDeathId = null; d.teaching = null;
  const revoked = d.talents.filter((talent) => talent.active).map((talent) => talent.sourceInstanceId);
  for (const talent of d.talents) talent.active = false;
  clearUnavailableReferences(frame, d.discipleId);
  frame.cultivation.pendingDeaths = frame.cultivation.pendingDeaths.filter((death) => death.deathId !== deathId);
  const death: DeathRecord = { deathId, discipleId: d.discipleId, cause, month: frame.cultivation.calendarMonth,
    beneficiaryId: heir?.discipleId ?? null, transferredRelicIds: relics, revokedSourceInstanceIds: revoked, cancelledAttemptId, cleanupDiscipleId: d.discipleId };
  frame.cultivation.deaths.push(death);
  event(frame, 'cultivation.died', rootActionId, d.discipleId, deathId);
  return death;
}
function resolve(frame: CultivationFrame, a: BreakthroughAttempt): CultivationCommandResult['outcome'] {
  if (a.phase !== 'DecisionReady') fail(a.phase === 'Resolved' || a.phase === 'Cancelled' ? 'ATTEMPT_FINISHED' : 'INVALID_PHASE');
  const d = disciple(frame, a.discipleId);
  const committed = commitReservation(frame.inventory, a.reservation, []);
  if (!committed.ok) return fail('INSUFFICIENT_RESOURCES');
  frame.inventory = committed.inventory; a.reservation = committed.reservation;
  const before = cloneJson(frame.randomStreams.events);
  const success = drawInteger(frame.randomStreams, 'events', 1, 10000); frame.randomStreams = success.streams;
  let deathRoll: number | null = null;
  if (success.value > a.preview.successBps && a.preview.failureDeathBps > 0) {
    const fatal = drawInteger(frame.randomStreams, 'events', 1, 10000); frame.randomStreams = fatal.streams; deathRoll = fatal.value;
  }
  a.sample = { sampleId: id(frame, 'instance'), successRoll: success.value, deathRoll, randomBefore: before, randomAfter: cloneJson(frame.randomStreams.events) };
  a.phase = 'Resolved'; a.blockedReason = null; d.activeAttemptId = null;
  if (success.value <= a.preview.successBps) {
    d.realm = a.preview.targetRealm!; d.lifespanMonths = REALM_RULES[d.realm].lifespanMonths; d.cultivation = 0;
    a.outcome = 'success';
  } else if (deathRoll !== null && deathRoll <= a.preview.failureDeathBps) {
    a.outcome = 'death'; settleDeath(frame, d, id(frame, 'instance'), 'breakthrough', a.rootActionId);
  } else {
    a.outcome = 'injury';
    d.injury = clamp(d.injury + (a.preview.preparation.method === 'forced' ? RULES.failure.forcedInjury : RULES.failure.normalInjury), 0, 100);
    d.cultivation -= Math.floor(d.cultivation * RULES.failure.cultivationLossBps / 10000);
  }
  event(frame, 'cultivation.resolved', a.rootActionId, d.discipleId, a.attemptId);
  return a.outcome;
}

/** Accepted command IDs are durable. Exact retries return the original receipt without cost, draw, or event. */
export function applyCultivationCommandV3(frame: CultivationFrame, command: CultivationCommand): CultivationTransition {
  if (validateCultivationFrameV3(frame).length) return { ok: false, frame, code: 'INVALID_STATE' };
  try {
    if (!isCultivationCommand(command)) fail('INVALID_COMMAND');
    const fingerprint = canonicalStringify(command);
    const prior = frame.cultivation.receipts.find((receipt) => receipt.commandId === command.commandId);
    if (frame.cultivation.authorityReceipts.some(receipt => receipt.command.commandId === command.commandId)) fail('COMMAND_CONFLICT');
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('COMMAND_CONFLICT');
      return { ok: true, frame, result: cloneJson(prior.result), replayed: true };
    }
    if (command.expectedRevision !== frame.cultivation.revision) fail('REVISION_CONFLICT');
    const next = cloneJson(frame);
    const rootActionId = id(next, 'action');
    const result: CultivationCommandResult = { commandId: command.commandId, kind: command.kind, relatedId: null, outcome: 'accepted' };
    switch (command.kind) {
      case 'breakthrough.confirm': {
        const actual = previewBreakthroughV3(frame, command.preview.discipleId, command.preview.preparation);
        if (canonicalStringify(actual) !== canonicalStringify(command.preview)) fail('PREVIEW_STALE');
        if (actual.blockers.length) fail('PREPARATION_BLOCKED');
        const d = disciple(next, actual.discipleId);
        const attemptId = id(next, 'instance');
        const reserved = reserveResources(next.inventory, actual.costs, id(next, 'instance'), attemptId);
        if (!reserved.ok) return fail('INSUFFICIENT_RESOURCES');
        next.inventory = reserved.inventory; d.activeAttemptId = attemptId;
        next.cultivation.attempts.push({ attemptId, discipleId: d.discipleId, rootActionId, phase: 'Reserved', preview: cloneJson(actual),
          reservation: reserved.reservation, completedMonths: 0, blockedMonths: 0, blockedReason: null, sample: null, outcome: null });
        result.relatedId = attemptId; event(next, 'cultivation.confirmed', rootActionId, d.discipleId, attemptId);
        break;
      }
      case 'breakthrough.begin': {
        const a = attempt(next, command.attemptId);
        if (a.phase !== 'Reserved') fail('INVALID_PHASE');
        a.phase = 'InSeclusion'; result.relatedId = a.attemptId;
        event(next, 'cultivation.started', a.rootActionId, a.discipleId, a.attemptId); break;
      }
      case 'breakthrough.cancel': {
        const a = attempt(next, command.attemptId); cancel(next, a); result.relatedId = a.attemptId; result.outcome = 'cancelled'; break;
      }
      case 'breakthrough.resolve': {
        if (command.acknowledgeRisk !== true) fail('ACKNOWLEDGEMENT_REQUIRED');
        const a = attempt(next, command.attemptId); result.relatedId = a.attemptId; result.outcome = resolve(next, a); break;
      }
      case 'death.finalize': {
        if (command.acknowledgeDeath !== true) fail('ACKNOWLEDGEMENT_REQUIRED');
        if (!validIdentity(command.deathId) || !['lifespan', 'combat', 'breakthrough'].includes(command.cause)) fail('INVALID_COMMAND');
        const d = disciple(next, command.discipleId);
        if (d.lifeState === 'dead') fail('DEATH_CONFLICT');
        if (d.pendingDeathId !== null && (d.pendingDeathId !== command.deathId
          || next.cultivation.pendingDeaths.find((death) => death.deathId === d.pendingDeathId)?.cause !== command.cause)) fail('DEATH_CONFLICT');
        if (command.cause !== 'combat' && !next.cultivation.pendingDeaths.some((death) => death.deathId === command.deathId && death.cause === command.cause && death.discipleId === d.discipleId)) fail('INVALID_PHASE');
        result.relatedId = settleDeath(next, d, command.deathId, command.cause, rootActionId).deathId; result.outcome = 'death'; break;
      }
      case 'training.set': {
        const d = disciple(next, command.discipleId); available(d);
        if (!['duty', 'training', 'rest'].includes(command.mode)) fail('INVALID_COMMAND');
        d.trainingMode = command.mode; break;
      }
      case 'legacy.setHeir': {
        const d = disciple(next, command.discipleId);
        if (d.activityOwner) fail('ACTIVITY_LOCKED');
        if (d.lifeState !== 'alive') fail('DISCIPLE_UNAVAILABLE');
        if (command.heirId !== null && (command.heirId === d.discipleId || disciple(next, command.heirId).lifeState !== 'alive')) fail('INVALID_INHERITANCE');
        d.heirId = command.heirId; break;
      }
      case 'talent.grant': {
        const d = disciple(next, command.discipleId);
        if (d.lifeState !== 'alive') fail('DISCIPLE_UNAVAILABLE');
        if (!Object.hasOwn(PERMANENT_TALENT_RULES, command.talentId)) fail('UNKNOWN_TALENT');
        const existing = d.talents.find((talent) => talent.sourceDefinitionId === command.talentId);
        if (existing) { result.relatedId = existing.sourceInstanceId; break; }
        const createdSequence = next.sequences.nextInstance;
        const sourceInstanceId = id(next, 'instance');
        d.talents.push({ sourceEntityId: d.discipleId, sourceDefinitionId: command.talentId, sourceInstanceId,
          lifecycleScope: 'character', duration: { kind: 'infinite' }, createdSequence, active: true });
        result.relatedId = sourceInstanceId; event(next, 'cultivation.talentGranted', rootActionId, d.discipleId, sourceInstanceId); break;
      }
      case 'teaching.begin': {
        const teacher = disciple(next, command.discipleId); const student = disciple(next, command.studentId);
        available(teacher); available(student);
        if (teacher.discipleId === student.discipleId || !validIdentity(command.knowledgeId) || !teacher.knowledge.some((entry) => entry.knowledgeId === command.knowledgeId)
          || student.knowledge.some((entry) => entry.knowledgeId === command.knowledgeId) || next.cultivation.disciples.some((d) => d.teaching?.studentId === student.discipleId)) fail('INVALID_TEACHING');
        const teachingId = id(next, 'instance');
        teacher.teaching = { teachingId, studentId: student.discipleId, knowledgeId: command.knowledgeId, completedMonths: 0, requiredMonths: RULES.teachingMonths };
        result.relatedId = teachingId; event(next, 'cultivation.teachingStarted', rootActionId, teacher.discipleId, teachingId); break;
      }
      default: fail('INVALID_COMMAND');
    }
    next.cultivation.revision = checkedAdd(next.cultivation.revision, 1);
    next.cultivation.receipts.push({ commandId: command.commandId, fingerprint, result: cloneJson(result) });
    if (validateCultivationFrameV3(next).length) fail('INVALID_STATE');
    return { ok: true, frame: next, result, replayed: false };
  } catch (error) { return { ok: false, frame, code: error instanceof CultivationFault ? error.code : error instanceof RangeError ? 'OVERFLOW' : 'INVALID_COMMAND' }; }
}

function advanceAges(frame: CultivationFrame, ordered: Cultivator[], rootActionId: string, ages?: Readonly<Record<string, number>>): void {
  for (const d of ordered) {
    if (d.lifeState !== 'alive') continue;
    const age = ages === undefined ? checkedAdd(d.ageMonths, 1) : ages[d.discipleId];
    if (age === undefined || !Number.isSafeInteger(age) || age < d.ageMonths || age > d.ageMonths + 1) return fail('INVALID_STATE');
    d.ageMonths = age;
    if (d.ageMonths >= d.lifespanMonths) {
      const deathId = id(frame, 'instance');
      if (d.activeAttemptId) cancel(frame, attempt(frame, d.activeAttemptId));
      d.lifeState = 'pendingDeath'; d.pendingDeathId = deathId; d.teaching = null;
      clearUnavailableReferences(frame, d.discipleId);
      frame.cultivation.pendingDeaths.push({ deathId, discipleId: d.discipleId, cause: 'lifespan', month: frame.cultivation.calendarMonth });
      event(frame, 'cultivation.expiryPending', rootActionId, d.discipleId, deathId);
    }
  }
}

/** World integration supplies exact birth-clock ages. This path never trains or advances a calendar month. */
export function synchronizeCultivationAgesV3(frame: CultivationFrame, ages: Readonly<Record<string, number>>): CultivationAgeSyncResult {
  if (validateCultivationFrameV3(frame).length) return { ok: false, frame, code: 'INVALID_STATE' };
  try {
    const living = frame.cultivation.disciples.filter((d) => d.lifeState === 'alive');
    if (living.some((d) => !Number.isSafeInteger(ages[d.discipleId]) || ages[d.discipleId]! < d.ageMonths || ages[d.discipleId]! > d.ageMonths + 1)) fail('INVALID_STATE');
    if (living.every((d) => ages[d.discipleId] === d.ageMonths)) return { ok: true, frame };
    const next = cloneJson(frame);
    const rootActionId = id(next, 'action');
    advanceAges(next, [...next.cultivation.disciples].sort((a, b) => compareStable(a.discipleId, b.discipleId)), rootActionId, ages);
    next.cultivation.revision = checkedAdd(next.cultivation.revision, 1);
    if (validateCultivationFrameV3(next).length) fail('INVALID_STATE');
    return { ok: true, frame: next };
  } catch (error) { return { ok: false, frame, code: error instanceof CultivationFault ? error.code : 'OVERFLOW' }; }
}

function advanceMonth(frame: CultivationFrame, ages?: Readonly<Record<string, number>>): void {
  frame.cultivation.calendarMonth = checkedAdd(frame.cultivation.calendarMonth, 1);
  const rootActionId = id(frame, 'action');
  const ordered = [...frame.cultivation.disciples].sort((a, b) => compareStable(a.discipleId, b.discipleId));
  // Fixed priority: age every living disciple, mark expiry, then surviving seclusion/teaching/training.
  advanceAges(frame, ordered, rootActionId, ages);
  const students = new Set(ordered.flatMap((d) => d.teaching ? [d.teaching.studentId] : []));
  for (const d of ordered) {
    if (d.lifeState !== 'alive' || d.activityOwner !== null) continue;
    if (d.activeAttemptId) {
      const a = attempt(frame, d.activeAttemptId);
      if (a.phase !== 'InSeclusion') continue;
      if (availableResource(frame.inventory.meal) < a.preview.monthlyMealCost) {
        a.blockedReason = 'SUPPLY_SHORTAGE'; a.blockedMonths = checkedAdd(a.blockedMonths, 1); continue;
      }
      frame.inventory.meal.owned -= a.preview.monthlyMealCost;
      a.blockedReason = null; a.completedMonths = checkedAdd(a.completedMonths, 1);
      if (a.completedMonths === a.preview.seclusionMonths) { a.phase = 'DecisionReady'; event(frame, 'cultivation.ready', a.rootActionId, d.discipleId, a.attemptId); }
      continue;
    }
    if (d.teaching) {
      const plan = d.teaching; const student = disciple(frame, plan.studentId);
      if (student.activeAttemptId || student.teaching) continue;
      plan.completedMonths += 1;
      if (plan.completedMonths === plan.requiredMonths) {
        student.knowledge.push({ knowledgeId: plan.knowledgeId, teacherId: d.discipleId, teachingId: plan.teachingId });
        event(frame, 'cultivation.taught', rootActionId, student.discipleId, plan.teachingId); d.teaching = null;
      }
      continue;
    }
    if (students.has(d.discipleId)) continue;
    const bonuses = d.talents.filter((talent) => talent.active).map((talent) => PERMANENT_TALENT_RULES[talent.sourceDefinitionId]);
    if (d.trainingMode === 'training' && d.injury <= RULES.training.maximumTrainableInjury) {
      d.cultivation = Math.min(REALM_RULES[d.realm].cultivationRequired, d.cultivation + RULES.training.baseUnits + Math.floor(d.aptitude / RULES.training.aptitudeDivisor) + bonuses.reduce((sum, talent) => sum + talent.trainingUnits, 0));
      d.understanding = Math.min(100, d.understanding + RULES.training.understandingPerMonth + bonuses.reduce((sum, talent) => sum + talent.understanding, 0));
      d.foundation = Math.min(100, d.foundation + RULES.training.foundationPerMonth);
    } else if (d.trainingMode === 'rest') {
      d.injury = Math.max(0, d.injury - RULES.rest.healingPerMonth - bonuses.reduce((sum, talent) => sum + talent.healing, 0));
      d.mindset = Math.min(100, d.mindset + RULES.rest.mindsetPerMonth);
    }
  }
  frame.cultivation.revision = checkedAdd(frame.cultivation.revision, 1);
}

/** No offline elapsed-time input. Stop at DecisionReady/expiry and let the foreground UI acknowledge. */
export function stepCultivationMonthsV3(frame: CultivationFrame, months: number, options: { ages?: Readonly<Record<string, number>> } = {}): MonthStepResult {
  if (!Number.isSafeInteger(months) || months < 0 || months > MAX_MONTHS_PER_STEP || (options.ages !== undefined && months !== 1)) return { frame, processedMonths: 0, stopped: 'invalid-month-count' };
  if (validateCultivationFrameV3(frame).length) return { frame, processedMonths: 0, stopped: 'invalid-state' };
  let current = frame;
  for (let processed = 0; processed < months; processed++) {
    if (current.cultivation.pendingDeaths.length || current.cultivation.attempts.some((a) => a.phase === 'DecisionReady')) return { frame: current, processedMonths: processed, stopped: 'decision-required' };
    try {
      const next = cloneJson(current); advanceMonth(next, options.ages);
      if (validateCultivationFrameV3(next).length) return { frame: current, processedMonths: processed, stopped: 'invalid-state' };
      current = next;
    } catch { return { frame: current, processedMonths: processed, stopped: 'overflow' }; }
  }
  return { frame: current, processedMonths: months, stopped: current.cultivation.pendingDeaths.length || current.cultivation.attempts.some((a) => a.phase === 'DecisionReady') ? 'decision-required' : 'complete' };
}
