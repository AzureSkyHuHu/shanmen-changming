import type { BuildErrorV2 } from '../builds/v2-types';
import { applyBuildCommandV2 } from '../builds/v2';
import type { BuildCommand } from '../builds/types';
import { copy } from '../expeditions/shared';
import { getWorldBuildContentContext } from './content-access';
import { permanentTeachingLesson } from './teaching-provenance';
import type { WorldStateV8 } from './v8-types';
import type { WorldBuildResult } from './build-bridge';
export function dispatchWorldBuildV8(world: WorldStateV8, command: BuildCommand):
  { ok: true; world: WorldStateV8; result: WorldBuildResult; eventIds: string[] } | { ok: false; code: BuildErrorV2 } {
  const profile = world.cultivation.disciples.find(entry => entry.discipleId === command.discipleId);
  if (!profile) return { ok: false, code: 'UNKNOWN_DISCIPLE' };
  if (profile.activityOwner) return { ok: false, code: 'EXPEDITION_LOCKED' };
  if (profile.lifeState !== 'alive' || world.clock.mode !== 'management') return { ok: false, code: 'INVALID_STATE' };
  const context = getWorldBuildContentContext(world); if (!context) return { ok: false, code: 'INVALID_STATE' };
  const applied = applyBuildCommandV2({ builds: world.builds, sequences: world.sequences }, command, context);
  if (!applied.ok) return { ok: false, code: applied.code };
  // An accepted permanent lesson owns its prerequisites until the atomic grant.
  // Learning that same skill or removing a required skill cannot invalidate it.
  for (const teacher of world.cultivation.disciples) {
    if (!teacher.teaching || teacher.teaching.studentId !== command.discipleId) continue;
    const lesson = permanentTeachingLesson(world, teacher.teaching.teachingId); if (!lesson) continue;
    const student = applied.frame.builds.disciples.find(entry => entry.discipleId === command.discipleId)!;
    if (student.learnedSkills.some(skill => skill.skillId === lesson.definition.skillId)
      || lesson.definition.requiredSkillIds.some(id => !student.learnedSkills.some(skill => skill.skillId === id))) return { ok: false, code: 'INVALID_STATE' };
  }
  return { ok: true, world: { ...world, builds: copy(applied.frame.builds), sequences: copy(applied.frame.sequences) }, eventIds: [],
    result: { commandId: command.commandId, kind: command.kind, revision: applied.receipt.revision, resultId: applied.receipt.resultId } };
}
