import type { MigrationIssueV10 } from '../sect-expansion/upgrade-types';
import { admitSaveWorldV9 } from './save-admission-v9';
import type { SaveFailureV9 } from './save-admission-v9';
import type { WorldStateV9 } from './v9-types';

function sourceIssue(failure: SaveFailureV9): MigrationIssueV10 {
  switch (failure.error.code) {
    case 'UNSUPPORTED_SIMULATION_VERSION': return { code: 'UNSUPPORTED_SOURCE', path: 'simulationVersion' };
    case 'UNSUPPORTED_CONTENT_VERSION': return { code: 'UNSUPPORTED_SOURCE', path: 'contentIdentity' };
    case 'UNSUPPORTED_SCOPE': return { code: 'UNSUPPORTED_SOURCE', path: '$' };
    case 'TOO_LARGE': return { code: 'CAPACITY_EXCEEDED', path: '$' };
    default: return { code: 'INVALID_SOURCE', path: '$' };
  }
}

/** Source diagnostics only: [] is not v10 admission, migration preparation or
 * permission to write a save. The unchanged fully funded v9 admission captures
 * bounded data descriptors BEFORE any source-property reads. Inspect only its
 * detached, completely authenticated snapshot, never the caller's object again.
 *
 * Existing v9 rejection takes precedence over quiet-boundary diagnostics. In
 * particular persisted queues, expeditions, activity/build locks, unarchived dead
 * identities, unsettled estates and dangling claims already fail v9 admission.
 * They are still spelled out below as boundary requirements, not exemptions.
 * Proxy reflection retains the original capture's documented limitations.
 *
 * No clock advance, cancellation, payment, reward, history rewrite or source
 * freezing occurs. Controller-owned read-only status and target-v10 headroom
 * belong to later gates and cannot be inferred from a World.
 */
export function inspectQuietV9ToV10Boundary(source: WorldStateV9): readonly MigrationIssueV10[] {
  const admitted = admitSaveWorldV9(source);
  if (!admitted.ok) return [sourceIssue(admitted)];
  const world = admitted.world;
  const issues: MigrationIssueV10[] = [];
  const add = (code: MigrationIssueV10['code'], path: string): void => { issues.push({ code, path }); };

  // The fixed .3 admission already authenticates the exact empty campaign and
  // expedition authorities. No v8/experimental management identity is adapted.
  if (world.clock.mode !== 'management') add('UNSUPPORTED_SOURCE', 'clock.mode');
  for (const field of ['run', 'travel', 'battle'] as const) {
    if (world.expedition[field] !== null) add('ACTIVE_WORK', `expedition.${field}`);
  }
  world.pendingCommands.forEach((_command, index) => add('PENDING_COMMANDS', `pendingCommands[${index}]`));
  world.activeProductionTransactionIds.forEach((_id, index) => add('ACTIVE_WORK', `activeProductionTransactionIds[${index}]`));
  for (const id of Object.keys(world.automaticProduction.live).sort()) {
    add('ACTIVE_WORK', `automaticProduction.live[${JSON.stringify(id)}]`);
  }
  for (const domain of ['construction', 'production', 'research', 'care'] as const) {
    world.sectExpansion[domain].jobs.forEach((job, index) => {
      if (job.terminal === null) add('ACTIVE_WORK', `sectExpansion.${domain}.jobs[${index}]`);
    });
  }
  world.sectExpansion.construction.blueprints.forEach((blueprint, index) => {
    if (blueprint.status === 'planned') add('PLANNED_BLUEPRINT', `sectExpansion.construction.blueprints[${index}]`);
  });
  // Individual stored plans may remain enabled while the global scheduler is
  // disabled. Do not reset plans, decision counters or activation review state.
  if (world.sectEconomy.enabled) add('AUTOMATIC_WORK_ENABLED', 'sectEconomy.enabled');

  world.cultivation.attempts.forEach((attempt, index) => {
    if (attempt.phase === 'Reserved' || attempt.phase === 'InSeclusion' || attempt.phase === 'DecisionReady') {
      add('ACTIVE_PROGRESSION', `cultivation.attempts[${index}]`);
    }
  });
  world.cultivation.disciples.forEach((profile, index) => {
    const path = `cultivation.disciples[${index}]`;
    if (profile.activeAttemptId !== null) add('ACTIVE_PROGRESSION', `${path}.activeAttemptId`);
    if (profile.teaching !== null) add('ACTIVE_PROGRESSION', `${path}.teaching`);
    if (profile.activityOwner !== null) add('ACTIVE_PROGRESSION', `${path}.activityOwner`);
    if (profile.lifeState !== 'alive') add('PENDING_LIFECYCLE', `${path}.lifeState`);
    if (profile.pendingDeathId !== null) add('PENDING_LIFECYCLE', `${path}.pendingDeathId`);
    if (profile.deathId !== null) add('PENDING_LIFECYCLE', `${path}.deathId`);
  });
  world.builds.disciples.forEach((build, index) => {
    if (build.lock !== null) add('ACTIVE_PROGRESSION', `builds.disciples[${index}].lock`);
  });
  world.cultivation.pendingDeaths.forEach((_death, index) => add('PENDING_LIFECYCLE', `cultivation.pendingDeaths[${index}]`));
  world.legacy.estates.forEach((estate, index) => {
    if (estate.settledMonth === null || estate.settledOwner === null || estate.pendingRunId !== null) {
      add('UNSETTLED_ESTATE', `legacy.estates[${index}]`);
    }
  });
  world.disciples.forEach((actor, index) => {
    if (actor.lifeState !== 'alive') add('PENDING_LIFECYCLE', `disciples[${index}].lifeState`);
    if (actor.assignmentTransactionId !== null) add('ACTIVE_WORK', `disciples[${index}].assignmentTransactionId`);
    if (actor.traveling) add('ACTIVE_WORK', `disciples[${index}].traveling`);
  });
  world.buildings.forEach((building, index) => {
    if (building.stationTransactionId !== null) add('ACTIVE_WORK', `buildings[${index}].stationTransactionId`);
  });
  // Terminal histories, training/rest settings, expired maintenance, legal pause
  // reasons and speed are intentionally not blockers and remain untouched.
  return issues;
}
