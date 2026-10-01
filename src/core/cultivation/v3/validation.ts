import { validId as validExpeditionIdentity } from '../../expeditions/shared';
import { RESOURCE_IDS } from '../../economy/types';
import { normalizeResourceLines } from '../../economy/inventory';
import { drawInteger, RANDOM_ALGORITHM, RANDOM_STREAM_NAMES } from '../../kernel/random';
import { canonicalStringify } from '../../kernel/serialization';
import { CULTIVATION_RULES, MAX_CULTIVATION_HISTORY, MAX_CULTIVATORS, PERMANENT_TALENT_RULES, REALM_RULES } from '../rules';
import { CULTIVATION_EVENT_KINDS, REALMS, type CultivationFrame } from './types';
import { expandDeceasedCultivator, validateCultivationAuthorityFacts } from './provenance';

export const validIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const unique = (values: unknown[]): boolean => new Set(values).size === values.length;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalId = (value: unknown) => value === null || validIdentity(value);
/** Slash IDs are reserved for trusted adapters; the kernel player grammar excludes them. */
const validCommandIdentity = (value: unknown) => validIdentity(value) || validExpeditionIdentity(value);

/** Defensive import boundary: malformed input reports diagnostics, never partly settles costs/events. */
export function validateCultivationFrameV3(value: unknown): string[] {
  const version = 3;
  const errors: string[] = [];
  const check = (condition: unknown, message: string) => { if (!condition) errors.push(message); };
  try {
    if (!object(value) || !object(value.cultivation) || !object(value.inventory) || !object(value.randomStreams) || !object(value.sequences)) return ['Invalid cultivation frame'];
    const state = value.cultivation;
    for (const name of ['disciples', 'attempts', 'pendingDeaths', 'deaths', 'sectRelicIds', 'receipts', 'events', 'legacyIdentities', 'archivedDisciples', 'authorityReceipts']) {
      if (!Array.isArray(state[name]) || state[name].length > MAX_CULTIVATION_HISTORY) return [`Invalid collection: ${name}`];
    }
    canonicalStringify(value);
    const frame = value as unknown as CultivationFrame;
    const s = frame.cultivation;
    const allDisciples = [...s.disciples, ...s.archivedDisciples.map(expandDeceasedCultivator)];
    check(state.schemaVersion === version && integer(s.revision) && integer(s.calendarMonth), 'Invalid cultivation schema/revision/month');
    check(s.disciples.length <= MAX_CULTIVATORS && unique(allDisciples.map((d) => d.discipleId)), 'Invalid disciple identities/count');
    for (const key of ['nextEntity', 'nextEvent', 'nextAction', 'nextInstance'] as const) check(integer(frame.sequences[key]) && frame.sequences[key] > 0, 'Invalid sequence');
    for (const name of RANDOM_STREAM_NAMES) {
      const stream = frame.randomStreams[name];
      check(stream && stream.algorithm === RANDOM_ALGORITHM && integer(stream.state, 0xffffffff) && stream.state > 0 && integer(stream.draws), 'Invalid random stream');
    }
    for (const id of RESOURCE_IDS) {
      const entry = frame.inventory[id];
      check(entry && entry.resourceId === id && integer(entry.owned) && integer(entry.reserved) && integer(entry.capacity)
        && entry.reserved <= entry.owned && entry.owned <= entry.capacity, 'Invalid shared resource ledger');
    }
    const instanceIds: string[] = [];
    const allRelics = [...s.sectRelicIds];
    check(s.sectRelicIds.every(validIdentity), 'Invalid sect relic');
    for (const d of allDisciples) {
      check(validIdentity(d.discipleId) && REALMS.includes(d.realm), 'Invalid disciple identity/realm');
      if (version === 3) {
        check(d.activityOwner === null || (object(d.activityOwner) && d.activityOwner.kind === 'expedition'
          && validExpeditionIdentity(d.activityOwner.runId) && validExpeditionIdentity(d.activityOwner.lockId)), 'Invalid activity ownership');
        if (d.activityOwner !== null) check(d.activeAttemptId === null && d.teaching === null
          && !allDisciples.some((teacher) => teacher.teaching?.studentId === d.discipleId), 'Away disciple retains a local cultivation commitment');
      } else check(!Object.hasOwn(d, 'activityOwner'), 'Legacy cultivation has an unsupported activity owner');
      check(integer(d.ageMonths) && integer(d.lifespanMonths) && d.lifespanMonths === REALM_RULES[d.realm].lifespanMonths
        && integer(d.cultivation, REALM_RULES[d.realm].cultivationRequired), 'Invalid age/lifespan/cultivation');
      for (const stat of [d.understanding, d.foundation, d.mindset, d.injury, d.aptitude]) check(integer(stat, 100), 'Invalid cultivation stat');
      check(['alive', 'pendingDeath', 'dead'].includes(d.lifeState) && ['duty', 'training', 'rest'].includes(d.trainingMode), 'Invalid disciple lifecycle/mode');
      check(optionalId(d.activeAttemptId) && optionalId(d.pendingDeathId) && optionalId(d.deathId) && optionalId(d.heirId), 'Invalid disciple references');
      check(d.lifeState === 'alive' ? d.ageMonths < d.lifespanMonths && d.pendingDeathId === null && d.deathId === null
        : d.lifeState === 'pendingDeath' ? d.pendingDeathId !== null && d.deathId === null : d.deathId !== null && d.pendingDeathId === null, 'Invalid death boundary');
      if (d.heirId !== null) check(d.heirId !== d.discipleId && allDisciples.some((heir) => heir.discipleId === d.heirId && heir.lifeState === 'alive'), 'Invalid heir');
      check(Array.isArray(d.relicIds) && d.relicIds.every(validIdentity), 'Invalid character relics');
      allRelics.push(...d.relicIds);
      check(Array.isArray(d.knowledge) && unique(d.knowledge.map((entry) => entry.knowledgeId)), 'Duplicate knowledge');
      for (const knowledge of d.knowledge) {
        check(validIdentity(knowledge.knowledgeId) && optionalId(knowledge.teacherId) && optionalId(knowledge.teachingId), 'Invalid knowledge provenance');
        check((knowledge.teacherId === null) === (knowledge.teachingId === null), 'Incomplete knowledge provenance');
        if (knowledge.teacherId !== null) {
          check(allDisciples.some((teacher) => teacher.discipleId === knowledge.teacherId), 'Unknown teacher archive');
          instanceIds.push(knowledge.teachingId!);
        }
      }
      check(Array.isArray(d.talents) && d.talents.length <= Object.keys(PERMANENT_TALENT_RULES).length
        && unique(d.talents.map((entry) => entry.sourceDefinitionId)), 'Invalid permanent talent collection');
      for (const talent of d.talents) {
        check(Object.hasOwn(PERMANENT_TALENT_RULES, talent.sourceDefinitionId) && talent.sourceEntityId === d.discipleId && validIdentity(talent.sourceInstanceId)
          && talent.lifecycleScope === 'character' && talent.duration.kind === 'infinite' && integer(talent.createdSequence)
          && typeof talent.active === 'boolean' && (d.lifeState !== 'dead' || !talent.active), 'Invalid talent source ownership');
        instanceIds.push(talent.sourceInstanceId);
      }
      if (d.teaching !== null) {
        const plan = d.teaching;
        check(d.lifeState === 'alive' && d.activeAttemptId === null && validIdentity(plan.teachingId) && validIdentity(plan.knowledgeId)
          && plan.requiredMonths === CULTIVATION_RULES.teachingMonths && integer(plan.completedMonths) && plan.completedMonths < plan.requiredMonths
          && d.knowledge.some((entry) => entry.knowledgeId === plan.knowledgeId)
          && allDisciples.some((student) => student.discipleId === plan.studentId && student.discipleId !== d.discipleId && student.lifeState === 'alive'), 'Invalid teaching plan');
        instanceIds.push(plan.teachingId);
      }
    }
    check(unique(allRelics), 'Relic ownership is duplicated');
    check(unique(allDisciples.filter((d) => d.teaching).map((d) => d.teaching!.studentId)), 'Multiple teaching plans target one student');
    check(unique(s.attempts.map((a) => a.attemptId)), 'Duplicate breakthrough attempt');
    const requiredReserved = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<(typeof RESOURCE_IDS)[number], number>;
    for (const a of s.attempts) {
      const d = allDisciples.find((disciple) => disciple.discipleId === a.discipleId);
      check(d && validIdentity(a.attemptId) && validIdentity(a.rootActionId) && ['Reserved', 'InSeclusion', 'DecisionReady', 'Resolved', 'Cancelled'].includes(a.phase), 'Invalid attempt identity/phase');
      const p = a.preview;
      check(p.phase === 'Prepared' && p.rulesVersion === 1 && p.discipleId === a.discipleId && integer(p.stateRevision) && typeof p.basisHash === 'string'
        && p.targetRealm !== null && REALMS.includes(p.targetRealm) && integer(p.seclusionMonths) && p.seclusionMonths > 0 && p.seclusionMonths <= 12
        && p.monthlyMealCost === CULTIVATION_RULES.monthlyMealCost && integer(p.remainingLifespanMonths)
        && ['standard', 'forced'].includes(p.preparation.method) && [0, 1, 2].includes(p.preparation.arraySupport)
        && integer(p.successBps, 9500) && p.successBps >= 500 && integer(p.failureDeathBps, 9500)
        && p.overallDeathBps === Math.floor((10000 - p.successBps) * p.failureDeathBps / 10000) && p.blockers.length === 0, 'Invalid frozen breakthrough preview');
      const sourceRealm = REALMS[REALMS.indexOf(p.targetRealm!) - 1];
      if (!sourceRealm) throw new Error('Invalid target realm');
      const sourceRule = REALM_RULES[sourceRealm];
      const expectedCosts = sourceRule.costs.map((line) => ({ ...line }));
      if (p.preparation.arraySupport > 0) {
        const stone = expectedCosts.find((line) => line.resourceId === 'stone');
        if (stone) stone.quantity += p.preparation.arraySupport * 2;
        else expectedCosts.push({ resourceId: 'stone', quantity: p.preparation.arraySupport * 2 });
      }
      check(canonicalStringify(p.costs) === canonicalStringify(normalizeResourceLines(expectedCosts)) && p.seclusionMonths === sourceRule.seclusionMonths, 'Preview cost/duration differs from registered rules');
      const coefficients = CULTIVATION_RULES.success;
      const expectedFactorKeys = ['base', 'understanding', 'foundation', 'mindset', 'array', 'injury', 'tribulation', 'forced'];
      check(p.factors.length === expectedFactorKeys.length && p.factors.every((factor, index) => factor.key === expectedFactorKeys[index] && Number.isSafeInteger(factor.contributionBps)), 'Invalid risk factor breakdown');
      const factors = Object.fromEntries(p.factors.map((factor) => [factor.key, factor.contributionBps]));
      for (const [key, coefficient] of [['understanding', coefficients.understandingCoefficient], ['foundation', coefficients.foundationCoefficient], ['mindset', coefficients.mindsetCoefficient], ['injury', coefficients.injuryCoefficient]] as const) {
        check(integer((factors[key] ?? NaN) / coefficient, 100), 'Invalid frozen preparation factor');
      }
      check(factors.base === coefficients.baseBps && factors.array === p.preparation.arraySupport * coefficients.arrayLevelBps
        && factors.tribulation === sourceRule.tribulation * coefficients.tribulationCoefficient
        && factors.forced === (p.preparation.method === 'forced' ? coefficients.forcedBonusBps : 0), 'Risk factors differ from registered rules');
      const factorTotal = p.factors.reduce((sum, factor) => sum + factor.contributionBps, 0);
      check(p.successBps === Math.max(coefficients.minimumBps, Math.min(coefficients.maximumBps, factorTotal)), 'Success risk differs from its breakdown');
      const sourceInjury = (factors.injury ?? NaN) / coefficients.injuryCoefficient;
      const conditionalDeath = sourceRule.baseFailureDeathBps + (p.preparation.method === 'forced' ? CULTIVATION_RULES.failure.forcedDeathBps : 0)
        + Math.max(0, sourceInjury - CULTIVATION_RULES.failure.severeInjuryThreshold) * CULTIVATION_RULES.failure.injuryDeathCoefficient;
      check(p.failureDeathBps === Math.min(CULTIVATION_RULES.failure.maximumDeathBps, conditionalDeath), 'Conditional death risk differs from registered rules');
      check(integer(a.completedMonths, p.seclusionMonths) && integer(a.blockedMonths) && (a.blockedReason === null || a.blockedReason === 'SUPPLY_SHORTAGE'), 'Invalid seclusion progress');
      const reservation = a.reservation;
      check(validIdentity(reservation.reservationId) && reservation.ownerTransactionId === a.attemptId && ['reserved', 'released', 'committed'].includes(reservation.state)
        && canonicalStringify(reservation.lines) === canonicalStringify(p.costs) && unique(reservation.lines.map((line) => line.resourceId)), 'Invalid breakthrough escrow');
      for (const line of reservation.lines) {
        check(RESOURCE_IDS.includes(line.resourceId) && integer(line.quantity) && line.quantity > 0, 'Invalid escrow quantity');
        if (reservation.state === 'reserved') requiredReserved[line.resourceId] += line.quantity;
      }
      const active = ['Reserved', 'InSeclusion', 'DecisionReady'].includes(a.phase);
      if (active) check(d?.realm === sourceRealm && d.cultivation >= sourceRule.cultivationRequired
        && d.understanding * coefficients.understandingCoefficient === factors.understanding
        && d.foundation * coefficients.foundationCoefficient === factors.foundation
        && d.mindset * coefficients.mindsetCoefficient === factors.mindset
        && d.injury * coefficients.injuryCoefficient === factors.injury, 'Active attempt differs from frozen preparation');
      check(active ? d?.activeAttemptId === a.attemptId && d.lifeState === 'alive' && reservation.state === 'reserved' && a.sample === null && a.outcome === null
        : a.phase === 'Cancelled' ? reservation.state === 'released' && a.sample === null && a.outcome === 'cancelled'
          : reservation.state === 'committed' && a.sample !== null && ['success', 'injury', 'death'].includes(a.outcome ?? ''), 'Inconsistent attempt settlement');
      if (a.phase === 'DecisionReady' || a.phase === 'Resolved') check(a.completedMonths === p.seclusionMonths, 'Unfinished decision');
      if (a.sample !== null) {
        check(validIdentity(a.sample.sampleId) && integer(a.sample.successRoll, 10000) && a.sample.successRoll >= 1
          && (a.sample.deathRoll === null || (integer(a.sample.deathRoll, 10000) && a.sample.deathRoll >= 1)), 'Invalid saved breakthrough draw');
        for (const stream of [a.sample.randomBefore, a.sample.randomAfter]) check(stream.algorithm === RANDOM_ALGORITHM && integer(stream.state, 0xffffffff) && stream.state > 0 && integer(stream.draws), 'Invalid sample stream');
        check(a.sample.randomAfter.draws > a.sample.randomBefore.draws, 'Draw history did not advance');
        const succeeded = a.sample.successRoll <= p.successBps;
        check(succeeded ? a.outcome === 'success' && a.sample.deathRoll === null
          : a.sample.deathRoll !== null ? p.failureDeathBps > 0 && a.outcome === (a.sample.deathRoll <= p.failureDeathBps ? 'death' : 'injury')
            : p.failureDeathBps === 0 && a.outcome === 'injury', 'Outcome differs from saved sample');
        const successDraw = drawInteger({ ...frame.randomStreams, events: a.sample.randomBefore }, 'events', 1, 10000);
        const lastDraw = a.sample.deathRoll === null ? successDraw : drawInteger(successDraw.streams, 'events', 1, 10000);
        check(successDraw.value === a.sample.successRoll && (a.sample.deathRoll === null || lastDraw.value === a.sample.deathRoll)
          && canonicalStringify(lastDraw.streams.events) === canonicalStringify(a.sample.randomAfter), 'Stored sample does not match its RNG trace');
        instanceIds.push(a.sample.sampleId);
      }
      instanceIds.push(a.attemptId, reservation.reservationId);
    }
    for (const id of RESOURCE_IDS) check(integer(requiredReserved[id]) && requiredReserved[id] <= frame.inventory[id].reserved, 'Escrow exceeds shared reservation ledger');
    for (const d of allDisciples) {
      if (d.activeAttemptId !== null) check(s.attempts.some((a) => a.attemptId === d.activeAttemptId && a.discipleId === d.discipleId && ['Reserved', 'InSeclusion', 'DecisionReady'].includes(a.phase)), 'Dangling active attempt');
      if (d.pendingDeathId !== null) check(s.pendingDeaths.some((death) => death.deathId === d.pendingDeathId && death.discipleId === d.discipleId), 'Dangling pending death');
      if (d.deathId !== null) check(s.deaths.some((death) => death.deathId === d.deathId && death.discipleId === d.discipleId), 'Dangling death archive');
    }
    check(unique([...s.pendingDeaths, ...s.deaths].map((death) => death.deathId)) && unique(s.deaths.map((death) => death.discipleId)), 'Death must settle once');
    for (const death of [...s.pendingDeaths, ...s.deaths]) {
      check(validIdentity(death.deathId) && ['lifespan', 'breakthrough', 'combat', 'legacy-unknown'].includes(death.cause) && integer(death.month) && death.month <= s.calendarMonth
        && allDisciples.some((d) => d.discipleId === death.discipleId), 'Invalid death record');
      instanceIds.push(death.deathId);
    }
    for (const pending of s.pendingDeaths) check(allDisciples.some((d) => d.discipleId === pending.discipleId && d.lifeState === 'pendingDeath' && d.pendingDeathId === pending.deathId), 'Pending death has no matching disciple');
    for (const death of s.deaths) {
      check(allDisciples.some((d) => d.discipleId === death.discipleId && d.lifeState === 'dead' && d.deathId === death.deathId)
        && death.cleanupDiscipleId === death.discipleId && optionalId(death.beneficiaryId)
        && (death.beneficiaryId === null || allDisciples.some((d) => d.discipleId === death.beneficiaryId && d.discipleId !== death.discipleId))
        && Array.isArray(death.transferredRelicIds) && death.transferredRelicIds.every(validIdentity) && unique(death.transferredRelicIds)
        && Array.isArray(death.revokedSourceInstanceIds) && death.revokedSourceInstanceIds.every(validIdentity) && unique(death.revokedSourceInstanceIds)
        && optionalId(death.cancelledAttemptId), 'Invalid legacy settlement archive');
    }
    check(unique(instanceIds), 'Source/transaction/death identity collision');
    check(unique(s.events.map((event) => event.eventId)) && unique(s.receipts.map((receipt) => receipt.commandId)), 'Duplicate event/command receipt');
    for (const event of s.events) check(CULTIVATION_EVENT_KINDS.includes(event.kind) && /^event:[1-9]\d*$/.test(event.eventId) && Number(event.eventId.slice(6)) < frame.sequences.nextEvent
      && integer(event.month) && event.month <= s.calendarMonth && validIdentity(event.rootActionId) && validIdentity(event.discipleId), 'Invalid cultivation event');
    for (const id of instanceIds) if (id.startsWith('instance:')) check(Number(id.slice(9)) < frame.sequences.nextInstance, 'Instance sequence reuse');
    for (const receipt of s.receipts) check(validCommandIdentity(receipt.commandId) && receipt.result.commandId === receipt.commandId && typeof receipt.fingerprint === 'string', 'Invalid cultivation receipt');
  } catch { errors.push('Malformed cultivation state'); }
  if (!errors.length) errors.push(...validateCultivationAuthorityFacts(value as CultivationFrame));
  return errors;
}
