import { applyCultivationCommandV3, previewBreakthroughV3, stepCultivationMonthsV3, synchronizeCultivationAgesV3 } from '../cultivation/v3';
import type { BreakthroughPreparation, CultivationCommand, CultivationCommandResult, CultivationError, CultivationFrame } from '../cultivation/v3';
import { REALMS } from '../cultivation/types';
import { applyBuildAuthorityCommandV2 } from '../builds/v2';
import type { MilestoneRuleId } from '../builds/types';
import { liveProductionAt } from '../economy/automatic-production';
import type { ProductionReceiptContext } from '../economy/automatic-types';
import { cancelProduction } from '../economy/production';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../kernel/clock';
import { checkedAdd } from '../kernel/numeric';
import { copy } from '../expeditions/shared';
import { appendWorldEvents, worldEventCursor, worldEventsSince } from './history-access';
import { isCultivationWorkerAvailable } from './cultivation-bridge';
import { getWorldBuildContentContext, getWorldContent } from './content-access';
import { permanentTeachingLesson } from './teaching-provenance';
import type { WorldStateV8 } from './v8-types';

export const cultivationFrameV8 = (world: WorldStateV8): CultivationFrame => ({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences });
export const hasCultivationDecisionV8 = (world: WorldStateV8): boolean => world.cultivation.pendingDeaths.length > 0 || world.cultivation.attempts.some(attempt => attempt.phase === 'DecisionReady');
export function withCultivationPauseV8(world: WorldStateV8): WorldStateV8 {
  return { ...world, clock: setPauseReason(world.clock, 'cultivation', hasCultivationDecisionV8(world)) };
}
export function previewWorldBreakthroughV8(world: WorldStateV8, discipleId: string, preparation?: BreakthroughPreparation) {
  return previewBreakthroughV3(cultivationFrameV8(world), discipleId, preparation);
}
export function reconcileWorldProgressionV8(world: WorldStateV8): WorldStateV8 {
  let next = world; const context = getWorldBuildContentContext(next); if (!context) throw new TypeError('Missing v8 build context');
  for (const profile of next.cultivation.disciples) for (const realm of REALMS.slice(1, REALMS.indexOf(profile.realm) + 1)) {
    const ruleId = `realm.${realm}` as MilestoneRuleId;
    if (next.builds.awards.some(award => award.discipleId === profile.discipleId && award.ruleId === ruleId)) continue;
    const granted = applyBuildAuthorityCommandV2({ builds: next.builds, sequences: next.sequences }, { kind: 'milestone.award',
      commandId: `system/realm/${profile.discipleId}/${realm}`, expectedRevision: next.builds.revision, milestoneId: `realm/${profile.discipleId}/${realm}`, discipleId: profile.discipleId, ruleId }, context);
    if (!granted.ok) throw new TypeError(`Realm award failed: ${granted.code}`);
    next = { ...next, builds: copy(granted.frame.builds), sequences: copy(granted.frame.sequences) };
  }
  for (const event of next.cultivation.events) {
    if (event.kind !== 'cultivation.taught' || !event.relatedId) continue;
    const acquisitionId = `teaching/${event.relatedId}/${event.discipleId}`;
    if (next.builds.history.some(entry => entry.authority && entry.command.kind === 'skill.grantKnowledge' && entry.command.acquisitionId === acquisitionId)) continue;
    const lesson = permanentTeachingLesson(next, event.relatedId); if (!lesson) continue;
    if (lesson.studentId !== event.discipleId) throw new TypeError('Teaching completion recipient differs');
    const granted = applyBuildAuthorityCommandV2({ builds: next.builds, sequences: next.sequences }, { kind: 'skill.grantKnowledge', commandId: acquisitionId,
      expectedRevision: next.builds.revision, acquisitionId, discipleId: event.discipleId, skillId: lesson.definition.skillId,
      provenance: { kind: 'teaching', knowledgeId: lesson.definition.id, teacherId: lesson.teacherId, teachingId: event.relatedId } }, context);
    if (!granted.ok) throw new TypeError(`Teaching permanent grant failed: ${granted.code}`);
    next = { ...next, builds: copy(granted.frame.builds), sequences: copy(granted.frame.sequences) };
  }
  return next;
}
function publish(world: WorldStateV8, frame: CultivationFrame, receiptContext?: ProductionReceiptContext): WorldStateV8 {
  let next = appendWorldEvents({ ...world, ...frame }, frame.cultivation.events.slice(world.cultivation.events.length).map(event => ({
    eventId: event.eventId, kind: event.kind, tick: world.clock.simulationTick, rootActionId: event.rootActionId, parentEventId: null,
    payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month } } )));
  next = { ...next, disciples: next.disciples.map(actor => {
    const profile = next.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    return { ...actor, lifeState: profile.lifeState, ageMonths: profile.ageMonths,
      canWork: profile.lifeState !== 'alive' ? false : profile.ageMonths !== actor.ageMonths ? profile.ageMonths >= 16 * 12 : actor.canWork };
  }) };
  for (const id of [...next.activeProductionTransactionIds]) {
    const job = liveProductionAt(next, id)?.transaction; if (!job) throw new TypeError('Missing production obligation');
    if (!isCultivationWorkerAvailable(next, job.workerId)) {
      const cancelled = cancelProduction(next, id, receiptContext); if (!cancelled.ok) throw new TypeError('Cannot release unavailable production'); next = cancelled.world;
    }
  }
  return withCultivationPauseV8(reconcileWorldProgressionV8(next));
}
export function dispatchWorldCultivationV8(world: WorldStateV8, command: CultivationCommand, receiptContext?: ProductionReceiptContext):
  { ok: true; world: WorldStateV8; result: CultivationCommandResult; eventIds: string[] } | { ok: false; code: CultivationError } {
  if (world.clock.mode !== 'management' && !(command.kind === 'death.finalize' && command.cause === 'combat')) return { ok: false, code: 'DISCIPLE_UNAVAILABLE' };
  if (command.kind === 'teaching.begin') {
    const definition = getWorldContent(world).campaign?.knowledge.find(lesson => lesson.id === command.knowledgeId);
    const teacher = world.builds.disciples.find(member => member.discipleId === command.discipleId);
    const permanent = definition && teacher?.learnedSkills.some(skill => skill.skillId === definition.skillId && 'provenance' in skill && skill.provenance.knowledgeId === definition.id);
    if (permanent) {
      const student = world.builds.disciples.find(member => member.discipleId === command.studentId);
      if (!student || student.school !== definition.school || student.learnedSkills.some(skill => skill.skillId === definition.skillId)
        || definition.requiredSkillIds.some(id => !student.learnedSkills.some(skill => skill.skillId === id))) return { ok: false, code: 'INVALID_TEACHING' };
    }
  }
  const transition = applyCultivationCommandV3(cultivationFrameV8(world), command); if (!transition.ok) return { ok: false, code: transition.code };
  const next = publish(world, transition.frame, receiptContext);
  return { ok: true, world: next, result: transition.result, eventIds: worldEventsSince(next, worldEventCursor(world)).map(event => event.eventId) };
}
export function advanceWorldCultivationV8(world: WorldStateV8): WorldStateV8 {
  if (world.clock.mode !== 'management') return world;
  const ages: Record<string, number> = {}; let changed = false;
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id); if (!profile) throw new TypeError('Missing cultivation identity');
    if (profile.lifeState !== 'alive') continue;
    ages[actor.id] = Math.floor(checkedAdd(world.clock.calendarTick, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
    if (ages[actor.id] !== profile.ageMonths) changed = true;
  }
  const month = Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
  if (month !== world.cultivation.calendarMonth) {
    if (month !== world.cultivation.calendarMonth + 1) throw new TypeError('Cultivation calendar skipped a month');
    const step = stepCultivationMonthsV3(cultivationFrameV8(world), 1, { ages });
    if (step.processedMonths !== 1) throw new TypeError(`Cultivation month failed: ${step.stopped}`); return publish(world, step.frame);
  }
  if (!changed) return world;
  const synced = synchronizeCultivationAgesV3(cultivationFrameV8(world), ages);
  if (!synced.ok) throw new TypeError(`Cultivation birthday failed: ${synced.code}`); return publish(world, synced.frame);
}
