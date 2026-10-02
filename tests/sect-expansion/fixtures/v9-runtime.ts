import type { SectRecipeId } from '../../../src/content/sect-v9/types';
import { dispatchUnregisteredCommandV9 } from '../../../src/core/kernel/commands-v9';
import type { CommandV9, SectCommandV9 } from '../../../src/core/kernel/contracts-v9';
import { prepareNormalTickCandidateV9 } from '../../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records } from '../../../src/core/kernel/validation';
import { createUnregisteredWorldV9 } from '../../../src/core/world/create-world-v9';
import type { WorldStateV9 } from '../../../src/core/world/v9-types';

export function recordChecked(world: WorldStateV9): WorldStateV9 {
  const issues = inspectUnregisteredWorldV9Records(world); if (issues.length) throw new Error(issues.join('; ')); return world;
}
export function fixtureCommand(world: WorldStateV9, body: Omit<CommandV9, 'commandId' | 'issuedTick' | 'sequence'>, commandId: string): CommandV9 {
  return { ...body, commandId, issuedTick: world.clock.simulationTick, sequence: 0 } as CommandV9;
}
export function fixtureSectCommand(world: WorldStateV9, payload: SectCommandV9): CommandV9 {
  return fixtureCommand(world, { kind: 'sect.command', payload }, payload.command.commandId);
}
export function fixtureApply(world: WorldStateV9, input: CommandV9): WorldStateV9 {
  const result = dispatchUnregisteredCommandV9(world, input);
  if (result.result.status !== 'accepted') throw new Error(JSON.stringify(result.result)); return result.world;
}
/** Setup is excluded from benchmark measurements. These actual tick preparations
 * run every calendar and work tick, and strict complete-record validation checks
 * each returned fixture. The extra base stock is explicitly a capacity fixture;
 * all new sect stock, buildings, research and medicine are genuinely paid work. */
export function fixtureUntil(world: WorldStateV9, done: (value: WorldStateV9) => boolean, limit = 1600): WorldStateV9 {
  let next = world;
  for (let index = 0; index < limit && !done(next); index++) next = prepareNormalTickCandidateV9(next);
  if (!done(next)) throw new Error('Fixture work did not finish'); return recordChecked(next);
}
export function fundedRuntimeFixture(): WorldStateV9 {
  const world = createUnregisteredWorldV9('runtime-capacity-real-fixture');
  for (const entry of Object.values(world.inventory)) entry.owned = Math.min(80, entry.capacity);
  return recordChecked(world);
}
export function fixturePlace(world: WorldStateV9, definitionId: 'library.v9' | 'alchemy.v9', x: number): WorldStateV9 {
  return fixtureApply(world, fixtureSectCommand(world, { domain: 'construction', command: { kind: 'blueprint.place',
    commandId: `fixture.place.${x}`, expectedRevision: world.sectExpansion.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } } }));
}
export function fixtureStartConstruction(world: WorldStateV9): WorldStateV9 {
  return fixtureApply(world, fixtureSectCommand(world, { domain: 'construction', command: { kind: 'construction.start',
    commandId: `fixture.construct.${world.sectExpansion.construction.nextId}`, expectedRevision: world.sectExpansion.construction.revision,
    blueprintId: world.sectExpansion.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' } }));
}
export function fixtureProduce(world: WorldStateV9, recipeId: SectRecipeId): WorldStateV9 {
  const started = fixtureApply(world, fixtureSectCommand(world, { domain: 'production', command: { kind: 'production.start',
    commandId: `fixture.production.${world.sectExpansion.production.nextId}`, expectedRevision: world.sectExpansion.production.revision,
    recipeId, workerId: 'entity:2' } }));
  return fixtureUntil(started, value => !!value.sectExpansion.production.jobs.at(-1)!.terminal);
}
export function fixtureResearchStart(world: WorldStateV9): WorldStateV9 {
  return fixtureApply(world, fixtureSectCommand(world, { domain: 'research', command: { kind: 'research.start', commandId: 'fixture.research',
    expectedRevision: world.sectExpansion.research.revision, researchId: 'basic-medicine.v9', workerId: 'entity:2' } }));
}
export function fixtureCareStart(world: WorldStateV9, id = 'fixture.care'): WorldStateV9 {
  return fixtureApply(world, fixtureSectCommand(world, { domain: 'care', command: { kind: 'care.start', commandId: id,
    expectedRevision: world.sectExpansion.care.revision, patientId: 'entity:4' } }));
}
export function medicineRuntimeFixture(): WorldStateV9 {
  let world = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
  world = fixtureUntil(world, value => !!value.sectExpansion.construction.jobs.at(-1)!.terminal);
  for (const recipe of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'] as const) world = fixtureProduce(world, recipe);
  world = fixtureResearchStart(world); world = fixtureUntil(world, value => !!value.sectExpansion.research.jobs.at(-1)!.terminal);
  world = fixtureStartConstruction(fixturePlace(world, 'alchemy.v9', 10));
  world = fixtureUntil(world, value => !!value.sectExpansion.construction.jobs.at(-1)!.terminal);
  return fixtureProduce(world, 'craft.wound-powder.v9');
}
