import { getWorldContent } from './content-access';
import type { WorldStateV8 } from './v8-types';
/** A later purchase cannot retroactively turn old legacy teaching into a promised
 * permanent skill. The teacher's real acquisition must precede teaching.start. */
export function permanentTeachingLesson(world: WorldStateV8, teachingId: string) {
  const started = world.cultivation.events.find(event => event.kind === 'cultivation.teachingStarted' && event.relatedId === teachingId);
  const receipt = world.cultivation.receipts.find(entry => entry.result.kind === 'teaching.begin' && entry.result.relatedId === teachingId);
  if (!started || !receipt) return null;
  const command: { kind: string; discipleId: string; studentId: string; knowledgeId: string } = JSON.parse(receipt.fingerprint);
  if (command.kind !== 'teaching.begin' || command.discipleId !== started.discipleId) return null;
  const definition = getWorldContent(world).campaign?.knowledge.find(lesson => lesson.id === command.knowledgeId);
  if (!definition) return null;
  const acquired = world.builds.history.some(entry => entry.authority && entry.command.kind === 'skill.grantKnowledge'
    && entry.command.discipleId === command.discipleId && entry.command.skillId === definition.skillId
    && entry.command.provenance.knowledgeId === definition.id && entry.sequencesBefore.nextEvent <= Number(started.eventId.slice(6)));
  return acquired ? { definition, teacherId: command.discipleId, studentId: command.studentId } : null;
}
