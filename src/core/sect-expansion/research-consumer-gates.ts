import { getSectBuildingDefinition, getSectRecipeDefinition, getSectResearchDefinition } from '../../content/sect-v9/catalog';
import type { SectBuildingId, SectRecipeId, SectResearchEffect } from '../../content/sect-v9/types';
import type { ConstructionBlueprint, ConstructionValidationIssue } from './construction-types';
import { ownSectFields } from './layout';
import type { SectProductionJob } from './production-types';
import type { SectResearchGateRef } from './research-gate-types';
import type { SectResearchFrame } from './research-types';

export function isSectResearchGateRef(value: unknown): value is SectResearchGateRef {
  return ownSectFields(value, ['researchId', 'completionJobId']) && typeof value.researchId === 'string'
    && getSectResearchDefinition(value.researchId) !== undefined && typeof value.completionJobId === 'string'
    && /^sect-research:[1-9][0-9]*$/.test(value.completionJobId) && value.completionJobId.length <= 128;
}
const sameRef = (a: SectResearchGateRef | undefined, b: SectResearchGateRef | null): boolean => !!a && !!b
  && a.researchId === b.researchId && a.completionJobId === b.completionJobId;
/** Leaf lookup only. Caller must first validate local records and all research work/payment/DAG.
 * No full validator/completion query is called here, and expiry never revokes earned research. */
function resolve(frame: Pick<SectResearchFrame, 'construction' | 'research'>, required: readonly string[], effect: SectResearchEffect,
  tick: number, calendarTick: number): SectResearchGateRef | null {
  if (required.length !== 1 || required[0] !== 'basic-medicine.v9') return null;
  const definition = getSectResearchDefinition(required[0]);
  if (!definition?.effects.some(value => value.kind === effect.kind && (value.kind === 'unlock-recipe'
    ? effect.kind === 'unlock-recipe' && value.recipeId === effect.recipeId
    : effect.kind === 'unlock-building-level' && value.definitionId === effect.definitionId && value.level === effect.level))) return null;
  const job = frame.research.jobs.find(value => value.researchId === definition.id && value.terminal?.kind === 'completed');
  return job?.terminal && job.terminal.tick <= tick && job.terminal.calendarTick <= calendarTick
    ? { researchId: definition.id, completionJobId: job.jobId } : null;
}
export function constructionResearchGate(frame: Pick<SectResearchFrame, 'construction' | 'research'>, definitionId: SectBuildingId, tick: number, calendarTick: number): SectResearchGateRef | null {
  if (definitionId !== 'alchemy.v9') return null; // L2 has no authenticated upgrade executor yet.
  const level = getSectBuildingDefinition(definitionId)?.levels[0];
  return level?.level === 1 ? resolve(frame, level.requiredResearch, { kind: 'unlock-building-level', definitionId, level: 1 }, tick, calendarTick) : null;
}
export function productionResearchGate(frame: SectResearchFrame, recipeId: SectRecipeId, tick: number, calendarTick: number): SectResearchGateRef | null {
  if (recipeId !== 'craft.wound-powder.v9') return null; // Alternative stays closed until genuine L2 upgrade authority.
  const recipe = getSectRecipeDefinition(recipeId);
  return recipe ? resolve(frame, recipe.requiredResearch, { kind: 'unlock-recipe', recipeId }, tick, calendarTick) : null;
}
export function constructionResearchGateMatches(frame: Pick<SectResearchFrame, 'construction' | 'research'>, bp: ConstructionBlueprint, tick: number, calendarTick: number): boolean {
  return sameRef(bp.researchGate, constructionResearchGate(frame, bp.definitionId, bp.placedTick, bp.placedCalendarTick))
    && sameRef(bp.researchGate, constructionResearchGate(frame, bp.definitionId, tick, calendarTick));
}
export function productionResearchGateMatches(frame: SectResearchFrame, job: SectProductionJob): boolean {
  if (!sameRef(job.researchGate, productionResearchGate(frame, job.recipeId, job.startedTick, job.startedCalendarTick))) return false;
  const building = frame.construction.buildings.find(value => value.buildingId === job.productiveSite.siteId);
  const source = frame.construction.jobs.find(value => value.jobId === building?.sourceJobId);
  const bp = frame.construction.blueprints.find(value => value.blueprintId === source?.blueprintId);
  return !!building && building.definitionId === 'alchemy.v9' && building.level === 1
    && source?.terminal?.kind === 'completed' && source.resultBuildingId === building.buildingId
    && source.jobId === job.productiveSite.sourceJobId && source.terminal.tick <= job.startedTick
    && source.terminal.calendarTick <= job.startedCalendarTick && !!bp && bp.jobId === source.jobId
    && constructionResearchGateMatches(frame, bp, source.startedTick, source.startedCalendarTick)
    && sameRef(bp.researchGate, job.researchGate ?? null);
}
/** Runs strictly AFTER research evidence and BEFORE exact owner closure/claims/headroom. */
export function validateSectResearchConsumerGates(frame: SectResearchFrame): readonly ConstructionValidationIssue[] {
  for (const bp of frame.construction.blueprints) {
    if (!getSectBuildingDefinition(bp.definitionId)!.levels[0]!.requiredResearch.length) continue;
    const job = frame.construction.jobs.find(value => value.blueprintId === bp.blueprintId);
    if (!constructionResearchGateMatches(frame, bp, job?.startedTick ?? bp.placedTick, job?.startedCalendarTick ?? bp.placedCalendarTick))
      return [{ code: 'INVALID_RESEARCH_GATE', path: bp.blueprintId }];
  }
  for (const job of frame.production.jobs) {
    if (getSectRecipeDefinition(job.recipeId)!.requiredResearch.length && !productionResearchGateMatches(frame, job))
      return [{ code: 'INVALID_RESEARCH_GATE', path: job.transactionId }];
  }
  return [];
}
