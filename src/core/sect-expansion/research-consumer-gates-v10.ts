import { getSectBuildingDefinition, getSectRecipeDefinition, getSectResearchDefinition } from '../../content/sect-v9/catalog';
import type { SectRecipeId, SectResearchEffect, SectResearchId } from '../../content/sect-v9/types';
import type { ConstructionBlueprint, ConstructionValidationIssue } from './construction-types';
import { deriveSectFootprint, ownSectFields } from './layout';
import { isSectResearchGateRef } from './research-consumer-gates';
import type { SectResearchGateRef } from './research-gate-types';
import { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';
import type { SectProductionJobV10, SectProductionSiteProofV10, SectUpgradeFrameV10 } from './upgrade-types';

const siteFields = ['kind', 'siteId', 'position', 'sourceJobId', 'level', 'firstMaintenanceCalendarTick'] as const;
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
// Boolean wrapper preserves the old-proof union: Record<string, unknown> narrowing must
// not erase its optional-never upgradeJobId branch in the TypeScript data guard.
const exactFields = (value: unknown, fields: readonly string[]): boolean => ownSectFields(value, fields);
const sameRef = (actual: unknown, expected: SectResearchGateRef | null): boolean => isSectResearchGateRef(actual)
  && expected !== null && actual.researchId === expected.researchId && actual.completionJobId === expected.completionJobId;
const sameCell = (actual: unknown, expected: { readonly x: number; readonly y: number }): boolean => ownSectFields(actual, ['x', 'y'])
  && actual.x === expected.x && actual.y === expected.y;

/** These are synchronized management clocks, not a caller-supplied historical authority. */
function clock(frame: SectUpgradeFrameV10, tick: number, calendarTick: number): boolean {
  return integer(tick) && integer(calendarTick) && tick === calendarTick
    && integer(frame.construction.lastSimulationTick) && integer(frame.construction.lastCalendarTick)
    && tick <= frame.construction.lastSimulationTick && calendarTick <= frame.construction.lastCalendarTick
    && frame.construction.lastSimulationTick === frame.construction.lastCalendarTick;
}
function before(frame: SectUpgradeFrameV10, sourceTick: number, sourceCalendar: number, tick: number, calendarTick: number): boolean {
  return clock(frame, sourceTick, sourceCalendar) && clock(frame, tick, calendarTick)
    && sourceTick <= tick && sourceCalendar <= calendarTick;
}
function effectMatches(actual: SectResearchEffect, expected: SectResearchEffect): boolean {
  return actual.kind === 'unlock-recipe' ? expected.kind === 'unlock-recipe' && actual.recipeId === expected.recipeId
    : expected.kind === 'unlock-building-level' && actual.definitionId === expected.definitionId && actual.level === expected.level;
}
/** Root authenticates research work, payment, prerequisites and receipts first. No completion
 * cache, output resemblance, caller callback or whole-v9 frame is an authority here. */
function resolve(frame: SectUpgradeFrameV10, required: readonly SectResearchId[], researchId: SectResearchId,
  effect: SectResearchEffect, tick: number, calendarTick: number): SectResearchGateRef | null {
  if (required.length !== 1 || required[0] !== researchId || !clock(frame, tick, calendarTick)) return null;
  const definition = getSectResearchDefinition(researchId);
  if (!definition?.effects.some(value => effectMatches(value, effect))) return null;
  const completions = frame.research.jobs.filter(job => job.researchId === researchId && job.terminal?.kind === 'completed');
  if (completions.length !== 1) return null;
  const completion = completions[0]!;
  const terminal = completion.terminal!;
  const ref = { researchId, completionJobId: completion.jobId };
  return isSectResearchGateRef(ref) && before(frame, terminal.tick, terminal.calendarTick, tick, calendarTick) ? ref : null;
}
function constructionGate(frame: SectUpgradeFrameV10, bp: ConstructionBlueprint, tick: number, calendarTick: number): SectResearchGateRef | null {
  if (bp.definitionId !== 'alchemy.v9') return null;
  const level = getSectBuildingDefinition('alchemy.v9')!.levels[0]!;
  return level.level === 1 ? resolve(frame, level.requiredResearch, 'basic-medicine.v9',
    { kind: 'unlock-building-level', definitionId: 'alchemy.v9', level: 1 }, tick, calendarTick) : null;
}
function constructionGateMatches(frame: SectUpgradeFrameV10, bp: ConstructionBlueprint, tick: number, calendarTick: number): boolean {
  return before(frame, bp.placedTick, bp.placedCalendarTick, tick, calendarTick)
    && sameRef(bp.researchGate, constructionGate(frame, bp, bp.placedTick, bp.placedCalendarTick))
    && sameRef(bp.researchGate, constructionGate(frame, bp, tick, calendarTick));
}

/** Fixed research-reference lookup only, AFTER full v10 source authentication. A non-null
 * result is not site eligibility, production admission, payment proof or an unlock flag. */
export function productionResearchGateV10(frame: SectUpgradeFrameV10, recipeId: SectRecipeId,
  tick: number, calendarTick: number): SectResearchGateRef | null {
  const researchId = recipeId === 'craft.wound-powder.v9' ? 'basic-medicine.v9'
    : recipeId === 'craft.wound-powder-alt.v9' ? 'herbal-compatibility.v9' : null;
  if (researchId === null) return null;
  const recipe = getSectRecipeDefinition(recipeId);
  return recipe ? resolve(frame, recipe.requiredResearch, researchId, { kind: 'unlock-recipe', recipeId }, tick, calendarTick) : null;
}

function placedOrigin(frame: SectUpgradeFrameV10, site: SectProductionSiteProofV10, tick: number, calendarTick: number) {
  if (site.kind !== 'placed' || !clock(frame, tick, calendarTick)) return null;
  const building = frame.construction.buildings.find(value => value.buildingId === site.siteId);
  const source = frame.construction.jobs.find(value => value.jobId === building?.sourceJobId);
  const bp = frame.construction.blueprints.find(value => value.blueprintId === source?.blueprintId);
  if (!building || building.level !== 1 || source?.terminal?.kind !== 'completed' || !bp
    || site.sourceJobId !== source.jobId || source.resultBuildingId !== building.buildingId
    || source.terminal.buildingId !== building.buildingId || bp.jobId !== source.jobId || bp.definitionId !== building.definitionId
    || building.completedTick !== source.terminal.tick || building.completedCalendarTick !== source.terminal.calendarTick
    || site.firstMaintenanceCalendarTick !== building.firstMaintenanceCalendarTick
    || !before(frame, source.terminal.tick, source.terminal.calendarTick, tick, calendarTick)) return null;
  const geometry = deriveSectFootprint({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
  return geometry.ok && sameCell(site.position, geometry.footprint.entrance) ? { building, source, bp } : null;
}

/** Exact powder consumer/source join AFTER construction, research, upgrade and maintenance
 * authenticity. The original L1 blueprint always keeps its independent basic-medicine gate.
 * Payment/work/delivery and the entire production→upgrade lifetime belong to the production
 * record stage, including jobs whose seat was released for TravellingToStorage/AwaitingDelivery. */
export function productionResearchGateMatchesV10(frame: SectUpgradeFrameV10, job: SectProductionJobV10): boolean {
  if (!sameRef(job.researchGate, productionResearchGateV10(frame, job.recipeId, job.startedTick, job.startedCalendarTick))) return false;
  const site = job.productiveSite;
  if (!exactFields(site, [...siteFields, ...(site.level === 2 ? ['upgradeJobId'] : [])])) return false;
  const origin = placedOrigin(frame, site, job.startedTick, job.startedCalendarTick);
  if (!origin || origin.building.definitionId !== 'alchemy.v9'
    || !constructionGateMatches(frame, origin.bp, origin.source.startedTick, origin.source.startedCalendarTick)) return false;
  const level = sectBuildingLevelAtFromUpgradeRecordsV10(frame, site.siteId, job.startedTick, 'after-upgrade');
  if (!level || level.constructionJobId !== site.sourceJobId || level.level !== site.level) return false;
  if (site.level === 1) return job.recipeId === 'craft.wound-powder.v9';
  if (site.level !== 2 || level.level !== 2 || site.upgradeJobId !== level.upgradeJobId) return false;
  const upgrade = frame.upgrade.jobs.find(value => value.jobId === site.upgradeJobId);
  return upgrade?.terminal?.kind === 'completed' && upgrade.terminal.resultLevel === 2
    && upgrade.buildingId === site.siteId && upgrade.site.buildingId === site.siteId && upgrade.site.sourceJobId === site.sourceJobId
    && before(frame, upgrade.terminal.tick, upgrade.terminal.calendarTick, job.startedTick, job.startedCalendarTick);
}

/** Preserve the three old ungated records exactly; no future recipe is admitted implicitly. */
function ungatedMatches(frame: SectUpgradeFrameV10, job: SectProductionJobV10): boolean {
  if (!['gather.stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9'].includes(job.recipeId)
    || Object.hasOwn(job, 'researchGate') || !clock(frame, job.startedTick, job.startedCalendarTick)
    || !exactFields(job.productiveSite, siteFields)) return false;
  const recipe = getSectRecipeDefinition(job.recipeId)!;
  if (recipe.requiredResearch.length !== 0) return false;
  const site = job.productiveSite;
  const requirement = recipe.workstation;
  if (requirement.kind === 'legacy-point') {
    const station = frame.construction.legacyStations.find(value => value.id === site.siteId && value.blueprintId === requirement.blueprintId);
    return !!station && site.kind === 'legacy-point' && site.level === 0 && site.sourceJobId === null
      && site.firstMaintenanceCalendarTick === null && sameCell(site.position, station);
  }
  const origin = placedOrigin(frame, site, job.startedTick, job.startedCalendarTick);
  return !!origin && origin.building.definitionId === 'library.v9' && requirement.definitionId === 'library.v9'
    && site.level === 1 && !Object.hasOwn(origin.bp, 'researchGate');
}

/** Version-owned record leaf only. Call AFTER descriptor, construction, production record/
 * receipt, research DAG/payment, upgrade and maintenance stages; BEFORE exact owner closure.
 * This does not authenticate a whole frame, filter reservations or confer runtime admission. */
export function validateSectResearchConsumerGatesV10(frame: SectUpgradeFrameV10): readonly ConstructionValidationIssue[] {
  for (const bp of frame.construction.blueprints) {
    const level = getSectBuildingDefinition(bp.definitionId)?.levels[0];
    if (!level || level.level !== 1) return [{ code: 'INVALID_RESEARCH_GATE', path: bp.blueprintId }];
    if (level.requiredResearch.length === 0) {
      if (Object.hasOwn(bp, 'researchGate')) return [{ code: 'INVALID_RESEARCH_GATE', path: bp.blueprintId }];
      continue;
    }
    const source = frame.construction.jobs.find(value => value.blueprintId === bp.blueprintId);
    if (!constructionGateMatches(frame, bp, source?.startedTick ?? bp.placedTick, source?.startedCalendarTick ?? bp.placedCalendarTick))
      return [{ code: 'INVALID_RESEARCH_GATE', path: bp.blueprintId }];
  }
  for (const job of frame.production.jobs) {
    const valid = job.recipeId === 'craft.wound-powder.v9' || job.recipeId === 'craft.wound-powder-alt.v9'
      ? productionResearchGateMatchesV10(frame, job) : ungatedMatches(frame, job);
    if (!valid) return [{ code: 'INVALID_RESEARCH_GATE', path: job.transactionId }];
  }
  return [];
}
