import type { SectResearchId } from '../../../src/content/sect-v9/types';
import { createWorkPathBudget } from '../../../src/core/agents/work-navigation';
import { cloneJson } from '../../../src/core/kernel/serialization';
import type { ConstructionCommand, ConstructionContext } from '../../../src/core/sect-expansion/construction-types';
import type { SectMaintenanceFrame } from '../../../src/core/sect-expansion/maintenance-types';
import type { SectRelocationCommand } from '../../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState } from '../../../src/core/sect-expansion/relocation-validation';
import type { SectResearchCommand } from '../../../src/core/sect-expansion/research-types';
import { prepareConstructionRelocationResearchCommandCandidate, prepareConstructionRelocationResearchTickCandidate,
  type ConstructionRelocationResearchDomainCandidate, type ConstructionRelocationResearchDomainFrame } from '../../../src/core/world/relocation-owner/research-domain-composition';
import { projectV9SectFrame } from '../../../src/core/world/v9-sect-bridge';
import type { WorldStateV9 } from '../../../src/core/world/v9-types';
import { fixturePlace, fixtureProduce, fixtureResearchStart, fixtureStartConstruction, fixtureUntil,
  fundedRuntimeFixture } from '../../sect-expansion/fixtures/v9-runtime';

export type Frame = ConstructionRelocationResearchDomainFrame;
export function context(frame: Frame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  return { simulationTick: frame.records.construction.lastSimulationTick, calendarTick: frame.records.construction.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch };
}
export function nextContext(frame: Frame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  return context(frame, { simulationTick: frame.records.construction.lastSimulationTick + 1,
    calendarTick: frame.records.construction.lastCalendarTick + (patch.mode === 'combat' || patch.paused || patch.expeditionActive ? 0 : 1), ...patch });
}
export function unwrap(result: ConstructionRelocationResearchDomainCandidate): Frame {
  if (!result.ok) throw new Error(`${result.code}: ${result.issues.join(';')}`);
  if (result.scope !== 'construction-relocation-research-domain-candidate') throw new Error('Unexpected executable scope'); return result.frame;
}
export function apply(frame: Frame, command: ConstructionCommand | SectRelocationCommand | SectResearchCommand): Frame {
  return unwrap(prepareConstructionRelocationResearchCommandCandidate(frame, context(frame), command));
}
export function step(frame: Frame, patch: Partial<ConstructionContext> = {}): Frame {
  const ctx = nextContext(frame, patch); return unwrap(prepareConstructionRelocationResearchTickCandidate(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
export function until(frame: Frame, done: (value: Frame) => boolean, limit = 2000): Frame {
  for (let i = 0; i < limit && !done(frame); i++) frame = step(frame);
  if (!done(frame)) throw new Error('Real research domain fixture did not reach its boundary'); return frame;
}
export function researchCommand(frame: Frame, workerId = 'entity:2', researchId: SectResearchId = 'herbal-compatibility.v9'): SectResearchCommand {
  return { kind: 'research.start', commandId: `research-domain.start.${frame.records.research.nextId}`, expectedRevision: frame.records.research.revision, researchId, workerId };
}
export function start(frame: Frame, workerId = 'entity:2', researchId: SectResearchId = 'herbal-compatibility.v9'): Frame {
  return apply(frame, researchCommand(frame, workerId, researchId));
}
export function cancelResearch(frame: Frame): Frame {
  return apply(frame, { kind: 'research.cancel', commandId: `research-domain.cancel.${frame.records.research.nextId}`,
    expectedRevision: frame.records.research.revision, jobId: frame.records.research.jobs.at(-1)!.jobId });
}
export function moveCommand(frame: Frame, workerId = 'entity:2', x = 4): SectRelocationCommand {
  return { kind: 'relocation.start', commandId: `research-domain.move.${frame.records.relocation.nextId}`, expectedRevision: frame.records.relocation.revision,
    buildingId: frame.records.construction.buildings[0]!.buildingId, workerId, target: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } };
}
export function move(frame: Frame, workerId = 'entity:2', x = 4): Frame { return apply(frame, moveCommand(frame, workerId, x)); }
export function build(frame: Frame, workerId = 'entity:3', x = 10): Frame {
  frame = apply(frame, { kind: 'blueprint.place', commandId: `research-domain.place.${frame.records.construction.nextId}`,
    expectedRevision: frame.records.construction.revision, placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } });
  return apply(frame, { kind: 'construction.start', commandId: `research-domain.build.${frame.records.construction.nextId}`,
    expectedRevision: frame.records.construction.revision, blueprintId: frame.records.construction.blueprints.at(-1)!.blueprintId, workerId });
}
export function fromMaintained(old: SectMaintenanceFrame): Frame {
  return cloneJson({ records: { construction: old.construction, relocation: createSectRelocationState(), research: old.research, maintenance: old.maintenance }, live: [] });
}
export function maintained(world: WorldStateV9): SectMaintenanceFrame {
  const f = projectV9SectFrame(world); return cloneJson({ schemaVersion: 1, construction: f.construction, production: f.production, research: f.research, maintenance: f.maintenance });
}
export function actualOldResearchFixture(): { world: WorldStateV9; beforeBasic: SectMaintenanceFrame; old: SectMaintenanceFrame } {
  // Only base inventory uses the explicitly labelled funded capacity seed. Every
  // sect resource is produced by real v9 production, with its full paired ledger.
  let world = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
  world = fixtureUntil(world, w => !!w.sectExpansion.construction.jobs[0]!.terminal);
  for (let i = 0; i < 6; i++) world = fixtureProduce(world, 'extract.spirit-stone.v9');
  for (let i = 0; i < 6; i++) world = fixtureProduce(world, 'study.basic-insight.v9');
  const beforeBasic = maintained(world);
  if (beforeBasic.construction.ledger.stock['spirit-stone'].owned !== 6 || beforeBasic.construction.ledger.stock['basic-insight'].owned !== 6)
    throw new Error('Six real units of each sect resource were not produced');
  world = fixtureResearchStart(world); world = fixtureUntil(world, w => !!w.sectExpansion.research.jobs[0]!.terminal);
  const old = maintained(world);
  if (!old.maintenance.payments.length || old.research.jobs[0]!.terminal?.kind !== 'completed') throw new Error('Missing genuine old work/payment history');
  return { world, beforeBasic, old };
}
