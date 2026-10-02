import { createWorkPathBudget, type WorkPathBudget } from '../agents/work-navigation';
import { createLegacyProductionContext } from '../economy/production';
import { runProductionPhases } from '../economy/production-context';
import { isPaused } from '../kernel/clock';
import type { SectCommandV10 } from '../kernel/contracts-v10';
import { inspectUnregisteredWorldV10Records } from '../kernel/validation';
import { applyValidatedCareCommandV10, tickValidatedCareV10 } from '../sect-expansion/care-runtime-v10';
import { applyValidatedConstructionCommand, constructionEffectiveMap, tickValidatedConstruction } from '../sect-expansion/construction-runtime';
import type { ConstructionContext, ConstructionFrame } from '../sect-expansion/construction-types';
import { tickValidatedSectMaintenancePaymentV10 } from '../sect-expansion/maintenance-runtime-v10';
import { applyValidatedSectProductionCommandV10, tickValidatedSectProductionV10 } from '../sect-expansion/production-runtime-v10';
import { applyValidatedSectResearchCommandV10, tickValidatedSectResearchV10 } from '../sect-expansion/research-runtime-v10';
import { applyValidatedSectUpgradeCommandV10, tickValidatedSectUpgradeV10 } from '../sect-expansion/upgrade-runtime';
import { sectUpgradeAllLocalClaimsV10 } from '../sect-expansion/upgrade-validation';
import type { ConstructionProjectionV10, SectUpgradeFrameV10, WorldStateV10 } from '../sect-expansion/upgrade-types';
import { restoreWorldHistory } from './history-access';
import { composeV10SectFrame, projectV10SectFrame, v10SectContext } from './v10-sect-frame';
import { captureV10RecordData } from './v10-sect-records';

/** INTERNAL source capture, not external/runtime/save admission. Descriptor capture occurs
 * before any read; only this owned snapshot is executed. The inspector's own copy is not
 * mistaken for authentication of a subsequently mutable caller object. No capacity proof. */
export function captureValidatedV10PreparationSource(input: unknown): WorldStateV10 {
  const source = captureV10RecordData(input);
  const errors = inspectUnregisteredWorldV10Records(source);
  if (errors.length) throw new TypeError(errors[0]);
  return restoreWorldHistory(source as WorldStateV10);
}
/** Existing construction remains an L1-only reducer. Check its actual output instead
 * of casting a mutable numeric level or disguising the complete v10 frame as v9. */
function constructionOrigin(frame: ConstructionFrame): ConstructionProjectionV10 {
  return { ...frame, buildings: frame.buildings.map(building => {
    if (building.level !== 1) throw new TypeError('Construction changed immutable v10 L1 origin');
    return { ...building, level: 1 as const };
  }) };
}
function constructionContext(frame: SectUpgradeFrameV10, base: ConstructionContext): ConstructionContext {
  const own = new Set(frame.construction.jobs.filter(job => job.terminal === null).map(job => job.jobId));
  const other = sectUpgradeAllLocalClaimsV10(frame).filter(claim => !own.has(claim.ownerId));
  return { ...base, externalActiveJobs: base.externalActiveJobs + other.filter(claim => claim.kind === 'worker').length,
    externalClaims: [...base.externalClaims, ...other] };
}

/** Internal domain candidate dispatch. All v10-aware domains take a legacy-only
 * context and count their local care/upgrade/research/production owners once. */
export function applyV10SectStage(world: WorldStateV10, command: SectCommandV10): { world: WorldStateV10; relatedId: string | null; repeated: boolean } | { code: string } {
  const frame = projectV10SectFrame(world); const context = v10SectContext(world);
  if (command.domain === 'care') return applyValidatedCareCommandV10(world, frame, context, command.command);
  if (command.domain === 'construction') {
    const result = applyValidatedConstructionCommand(frame.construction, constructionContext(frame, context), command.command, frame);
    return result.ok ? { world: result.repeated ? world : composeV10SectFrame(world, { ...frame, construction: constructionOrigin(result.frame) }),
      relatedId: result.relatedId, repeated: result.repeated } : { code: result.code };
  }
  const result = command.domain === 'production' ? applyValidatedSectProductionCommandV10(frame, context, command.command)
    : command.domain === 'research' ? applyValidatedSectResearchCommandV10(frame, context, command.command)
      : applyValidatedSectUpgradeCommandV10(frame, context, command.command);
  return result.ok ? { world: result.repeated ? world : composeV10SectFrame(world, result.frame), relatedId: result.jobId, repeated: result.repeated } : { code: result.code };
}
function prepareSectStages(world: WorldStateV10, budget: WorkPathBudget, growth: 'normal' | 'no-optional-growth'): WorldStateV10 {
  if (isPaused(world.clock)) return world;
  const frame = projectV10SectFrame(world); const context = v10SectContext(world);
  const construction = tickValidatedConstruction(frame.construction, constructionContext(frame, context), budget, frame);
  if (!construction.ok) throw new RangeError(construction.code);
  const constructed: SectUpgradeFrameV10 = { ...frame, construction: constructionOrigin(construction.frame) };
  const maintained = growth === 'normal' ? tickValidatedSectMaintenancePaymentV10(constructed, context) : constructed;
  const upgraded = tickValidatedSectUpgradeV10(maintained, context, budget);
  if (!upgraded.ok) {
    if (upgraded.code === 'CAPACITY_EXCEEDED') throw new RangeError(upgraded.code);
    throw new TypeError(upgraded.code);
  }
  const produced = tickValidatedSectProductionV10(upgraded.frame, context, budget);
  const researched = tickValidatedSectResearchV10(produced, context, budget);
  const composed = composeV10SectFrame(world, researched);
  return tickValidatedCareV10(composed, projectV10SectFrame(composed), v10SectContext(composed), budget);
}
/** Exact funded order: construction → maintenance → upgrade → production → research → care. */
export function tickV10SectStages(world: WorldStateV10, budget: WorkPathBudget): WorldStateV10 {
  return prepareSectStages(world, budget, 'normal');
}
/** Root retries from the unchanged source; only renewal is omitted in this stage.
 * Existing paid work continues, and no saved permission or setting is disabled. */
export function prepareV10SectStagesWithoutOptionalGrowth(world: WorldStateV10, budget: WorkPathBudget): WorldStateV10 {
  return prepareSectStages(world, budget, 'no-optional-growth');
}
/** Unchanged six-resource algorithm, bound to the authoritative footprint/claim union.
 * The enclosing root supplies the same navigation budget used by every sect stage. */
export function tickV10LegacyProduction(world: WorldStateV10, budget = createWorkPathBudget(world.clock.simulationTick)): WorldStateV10 {
  const stages = createLegacyProductionContext<WorldStateV10>();
  const free = (candidate: WorldStateV10, id: string, position: { x: number; y: number }): boolean =>
    !sectUpgradeAllLocalClaimsV10(projectV10SectFrame(candidate)).some(claim => claim.kind === 'seat' && claim.key === id
      || claim.kind === 'entrance' && claim.key === `${position.x},${position.y}`);
  return runProductionPhases(world, { ...stages,
    view: candidate => ({ ...stages.view(candidate), map: constructionEffectiveMap(projectV10SectFrame(candidate).construction) }),
    workSites: (candidate, recipe) => stages.workSites(candidate, recipe).filter(site => free(candidate, site.id, site.position)),
    storageSites: candidate => stages.storageSites(candidate).filter(site => free(candidate, site.id, site.position)),
  }, budget);
}
