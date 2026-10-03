import type { SectResearchDefinition } from '../../../content/sect-v9/types';
import { deriveSectFootprint } from '../../sect-expansion/layout';
import type { SectRelocationRecordFrame } from '../../sect-expansion/relocation-types';
import type { SectResearchSiteProof } from '../../sect-expansion/research-types';
import { relocationHistoryPhasePassed } from './history-order';
import type { RelocationOwnerBoundary } from './types';

/** Internal fixed geometry leaf ONLY. The owning unknown-input entry authenticates
 * the full source, payments and lifecycle joins. Never an admission/query token.
 * Construction origins remain unchanged; completed moves alone change placement. */
export function relocationResearchSitesFromRecordsAt(frame: SectRelocationRecordFrame,
  definition: SectResearchDefinition, boundary: RelocationOwnerBoundary): readonly SectResearchSiteProof[] {
  if (definition.workstation.definitionId !== 'library.v9' || definition.workstation.minimumLevel > 1) return [];
  return frame.construction.buildings.filter(building => building.definitionId === 'library.v9' && building.level === 1
    && relocationHistoryPhasePassed(building.completedTick, 'construction', boundary)
    && frame.construction.blueprints.some(bp => bp.jobId === building.sourceJobId && bp.definitionId === 'library.v9' && bp.researchGate === undefined)).map(building => {
    const moved = frame.relocation.jobs.filter(job => job.buildingId === building.buildingId && job.terminal?.kind === 'completed'
      && relocationHistoryPhasePassed(job.terminal.tick, 'relocation', boundary)).at(-1);
    const source = moved?.to ?? building;
    const geometry = deriveSectFootprint({ definitionId: source.definitionId, anchor: source.anchor, rotation: source.rotation });
    if (!geometry.ok) throw new Error('Authenticated research site geometry was lost');
    return { buildingId: building.buildingId, sourceJobId: building.sourceJobId, position: { ...geometry.footprint.entrance },
      level: 1 as const, firstMaintenanceCalendarTick: building.firstMaintenanceCalendarTick };
  });
}
