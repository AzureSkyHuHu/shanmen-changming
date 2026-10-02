import type { SectBuildingLevelEvidenceV10, SectUpgradeFrameV10 } from './upgrade-types';

/** Fixed historical lookup AFTER construction and upgrade record authentication. This leaf is
 * deliberately independent of all validators so maintenance can compose without a cycle.
 * It grants no authority, closes no owners and never rewrites the immutable construction L1. */
export function sectBuildingLevelAtFromUpgradeRecordsV10(frame: SectUpgradeFrameV10, buildingId: string,
  tick: number, phase: 'maintenance' | 'after-upgrade'): SectBuildingLevelEvidenceV10 | null {
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > frame.construction.lastSimulationTick
    || (phase !== 'maintenance' && phase !== 'after-upgrade')) return null;
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  if (!building || building.level !== 1 || building.completedTick > tick) return null;
  const completions = frame.upgrade.jobs.filter(job => job.buildingId === buildingId && job.terminal?.kind === 'completed');
  if (completions.length > 1) return null;
  const completion = completions[0];
  const effective = completion?.terminal && (phase === 'maintenance' ? completion.terminal.tick < tick : completion.terminal.tick <= tick);
  return effective ? { level: 2, constructionJobId: building.sourceJobId, upgradeJobId: completion!.jobId }
    : { level: 1, constructionJobId: building.sourceJobId, upgradeJobId: null };
}
