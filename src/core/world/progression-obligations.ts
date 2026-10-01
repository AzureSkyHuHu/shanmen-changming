import { REALMS } from '../cultivation/types';
import { assessBuildHistoryObligations } from '../save-budget/build-obligations';
import type { BuildHistoryObligationFacts, BuildHistoryObligationAssessment } from '../save-budget/build-obligations';
import { getWorldContent } from './content-access';
import type { WorldStateV8 } from './v8-types';

/** Facts derived from a previously validated World boundary, never a saved budget.
 * A completed teaching still owns its grant reservation until the build effect is
 * present. Clearing the live teaching plan alone cannot release that commitment. */
export function worldBuildHistoryObligationFacts(world: WorldStateV8): BuildHistoryObligationFacts {
  const content = getWorldContent(world);
  const profiles = new Map(world.cultivation.disciples.map(profile => [profile.discipleId, profile]));
  const activeBuilds = new Set(world.builds.disciples.map(build => build.discipleId));
  const permanentKnowledge = (teacherId: string, knowledgeId: string): boolean => {
    const definition = content.campaign?.knowledge.find(entry => entry.id === knowledgeId);
    const teacher = [...world.builds.disciples, ...world.builds.retiredDisciples].find(entry => entry.discipleId === teacherId);
    return !!definition && !!teacher?.learnedSkills.some(skill => skill.skillId === definition.skillId
      && 'provenance' in skill && skill.provenance.knowledgeId === knowledgeId);
  };
  const teachingGrants = new Set(world.builds.history.flatMap(entry => entry.authority && entry.command.kind === 'skill.grantKnowledge'
    && entry.command.provenance.kind === 'teaching' ? [entry.command.provenance.teachingId] : []));
  const teachingIds = new Set<string>();
  for (const teacher of world.cultivation.disciples) if (teacher.teaching && permanentKnowledge(teacher.discipleId, teacher.teaching.knowledgeId) && !teachingGrants.has(teacher.teaching.teachingId)) teachingIds.add(teacher.teaching.teachingId);
  // The event and retained knowledge bridge the in-memory month -> build-grant
  // transition, including when several teachings finish in the same month.
  for (const event of world.cultivation.events) {
    if (event.kind !== 'cultivation.taught' || !event.relatedId || teachingGrants.has(event.relatedId)) continue;
    const student = profiles.get(event.discipleId);
    const knowledge = student?.knowledge.find(entry => entry.teachingId === event.relatedId);
    if (!knowledge?.teacherId || !permanentKnowledge(knowledge.teacherId, knowledge.knowledgeId)) continue;
    if (!activeBuilds.has(event.discipleId)) throw new TypeError('Uncommitted teaching has no active build recipient');
    teachingIds.add(event.relatedId);
  }
  const hasAward = (discipleId: string, ruleId: string): boolean => world.builds.awards.some(award => award.discipleId === discipleId && award.ruleId === ruleId);
  const realmMilestoneIds = new Set<string>();
  for (const build of world.builds.disciples) {
    const profile = profiles.get(build.discipleId);
    if (!profile) throw new TypeError('Build obligation has no cultivation identity');
    for (const realm of REALMS.slice(1, REALMS.indexOf(profile.realm) + 1)) if (!hasAward(profile.discipleId, `realm.${realm}`)) realmMilestoneIds.add(`realm/${profile.discipleId}/${realm}`);
  }
  for (const attempt of world.cultivation.attempts) if (['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)
    && attempt.preview.targetRealm && !hasAward(attempt.discipleId, `realm.${attempt.preview.targetRealm}`)) {
    realmMilestoneIds.add(`realm/${attempt.discipleId}/${attempt.preview.targetRealm}`);
  }
  const run = world.expedition.run;
  const activeRun = run && run.phase !== 'Ended' ? { runId: run.runId, firstVictoryDiscipleIds: run.members
    .filter(member => member.alive && profiles.get(member.discipleId)?.lifeState !== 'dead' && !hasAward(member.discipleId, 'expedition.first-victory'))
    .map(member => member.discipleId) } : null;
  return {
    historyCount: world.builds.history.length, maximumCommands: content.buildRules.maximumCommands,
    disciples: world.builds.disciples.map(build => {
      const profile = profiles.get(build.discipleId)!;
      return { discipleId: profile.discipleId, lifeState: profile.lifeState, heirId: profile.heirId };
    }),
    retiredDiscipleIds: world.builds.retiredDisciples.map(member => member.discipleId),
    equipment: world.builds.equipment.map(item => ({ itemInstanceId: item.instanceId, ownerDiscipleId: item.owner.kind === 'disciple' ? item.owner.discipleId : null })),
    pendingEstates: world.builds.disciples.flatMap(build => {
      const profile = profiles.get(build.discipleId)!; if (profile.lifeState !== 'dead') return [];
      const death = world.cultivation.deaths.find(entry => entry.discipleId === profile.discipleId && entry.deathId === profile.deathId);
      const estate = world.legacy.estates.find(entry => entry.discipleId === profile.discipleId && entry.deathId === profile.deathId);
      if (!death || (estate && (estate.settledMonth !== null || estate.beneficiaryId !== death.beneficiaryId))) throw new TypeError('Unretired death has no consistent estate responsibility');
      return [{ discipleId: profile.discipleId, beneficiaryId: death.beneficiaryId }];
    }),
    teachingIds: [...teachingIds].sort(), realmMilestoneIds: [...realmMilestoneIds].sort(), activeRun,
  };
}
/** Build rows only. Callers must separately prove bytes, World archive and every
 * other domain limit before admitting or publishing a complete transition. */
export function assessWorldBuildHistoryObligations(world: WorldStateV8): BuildHistoryObligationAssessment {
  return assessBuildHistoryObligations(worldBuildHistoryObligationFacts(world));
}
