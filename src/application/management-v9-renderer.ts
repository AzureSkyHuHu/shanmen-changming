import { disciplePresentation } from './character-presentation';
import type { RuntimeExpansionJobV9, RuntimeExpansionViewV9, RuntimeFrameViewV9, RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import {
  copySectRenderLegacyBuildings, copySectRenderTerrain, freezeSectRendererSnapshot,
  type SectPlacementRenderPreview, type SectRenderCell, type SectRenderExpansion, type SectRendererSelection, type SectRendererSnapshot, type SectRendererSource, type SectVisualWork,
} from '../phaser/sect-renderer-contract';

/** Fixed, synchronous Session glue. Both views must belong to one published boundary.
 * The Session retains selection and effective pause/stop state; no World/export API is accepted. */
export interface ManagementV9RendererInput {
  readonly frame: RuntimeReadonlyV9<RuntimeFrameViewV9>;
  readonly expansion: RuntimeReadonlyV9<RuntimeExpansionViewV9>;
  readonly selection: SectRendererSelection;
  readonly paused: boolean;
}
export interface ManagementV9RendererPort {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ManagementV9RendererInput;
  select(selection: SectRendererSelection): void;
}
type ExpansionJob = RuntimeReadonlyV9<RuntimeExpansionJobV9>;
const actorOf = (job: ExpansionJob): string => job.domain === 'care' ? job.patientId : job.workerId;
const kindOf = (job: ExpansionJob): SectVisualWork['kind'] => job.domain === 'production' ? 'sect-production' : job.domain;
const isActive = (job: ExpansionJob): boolean => job.phase !== 'completed' && job.phase !== 'cancelled' && job.phase !== 'Done' && job.phase !== 'Cancelled';
function visualWork(job: ExpansionJob): SectVisualWork {
  return { kind: kindOf(job), ownerId: job.jobId, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.blocked !== null };
}
function ownedWork(input: ManagementV9RendererInput, discipleId: string): SectVisualWork | null {
  const owners = input.expansion.workOwners.filter(owner => owner.workerId === discipleId);
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  if (owner.kind === 'legacy-production') {
    const transaction = input.frame.transactions.find(job => job.transactionId === owner.id && job.workerId === discipleId
      && job.state !== 'Committed' && job.state !== 'Cancelled');
    return transaction ? { kind: 'legacy-production', ownerId: transaction.transactionId, activeTicks: transaction.activeTicks,
      requiredTicks: transaction.requiredTicks, blocked: transaction.state === 'Blocked' } : null;
  }
  const job = input.expansion.jobs.find(job => job.jobId === owner.id && actorOf(job) === discipleId && kindOf(job) === owner.kind && isActive(job));
  return job ? visualWork(job) : null;
}
export function projectManagementV9Renderer(input: ManagementV9RendererInput): SectRendererSnapshot {
  const { frame, expansion } = input;
  const work = new Map(frame.disciples.map(disciple => [disciple.id, ownedWork(input, disciple.id)]));
  const geometry = (row: RuntimeReadonlyV9<RuntimeExpansionViewV9['blueprints'][number] | RuntimeExpansionViewV9['buildings'][number]>) => ({
    definitionId: row.definitionId,
    footprint: { cells: row.footprint.cells.map(cell => ({ x: cell.x, y: cell.y })),
      entrance: { x: row.footprint.entrance.x, y: row.footprint.entrance.y } },
  });
  const overlays: SectRenderExpansion[] = expansion.blueprints.map(blueprint => {
    const job = blueprint.status === 'started' ? expansion.jobs.find(job => job.domain === 'construction'
      && job.blueprintId === blueprint.blueprintId && job.jobId === blueprint.jobId && isActive(job)) : undefined;
    const owner = job && job.domain === 'construction' ? work.get(job.workerId) : null;
    return { ...geometry(blueprint), kind: 'blueprint', id: blueprint.blueprintId, status: blueprint.status,
      work: owner?.kind === 'construction' && owner.ownerId === blueprint.jobId ? owner : null };
  });
  for (const building of expansion.buildings) overlays.push({ ...geometry(building), kind: 'sect-building', id: building.buildingId,
    level: building.level, operational: building.maintenance.operational });
  return freezeSectRendererSnapshot({
    map: copySectRenderTerrain(frame.map), buildings: copySectRenderLegacyBuildings(frame.buildings), expansion: overlays, placement: null,
    disciples: frame.disciples.map((disciple, index) => ({ id: disciple.id, nameKey: disciple.nameKey,
      presentationId: disciplePresentation(disciple, index).id, position: { x: disciple.position.x, y: disciple.position.y },
      lifeState: disciple.lifeState, traveling: disciple.traveling, work: work.get(disciple.id) ?? null })),
    selection: input.selection ? { kind: input.selection.kind, id: input.selection.id } : null,
    clock: { simulationTick: frame.clock.simulationTick }, paused: input.paused || frame.clock.pauseReasons.length > 0,
  });
}
export interface ManagementV9RendererSource extends SectRendererSource {
  /** A local overlay only. Passing null returns Canvas clicks to normal entity selection. */
  setPlacementPreview(preview: SectPlacementRenderPreview | null): void;
}
export interface ManagementV9RendererOptions { readonly onPlacementCell?: (cell: SectRenderCell) => void }
function copyPlacementPreview(preview: SectPlacementRenderPreview | null): SectPlacementRenderPreview | null {
  if (!preview) return null;
  if (preview.footprint && preview.footprint.cells.length > 4) throw new RangeError('Placement preview exceeds its fixed footprint');
  const cell = (point: SectRenderCell): SectRenderCell => {
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) throw new TypeError('Invalid placement preview cell');
    return Object.freeze({ x: point.x, y: point.y });
  };
  return Object.freeze({ anchor: cell(preview.anchor), allowed: preview.allowed && preview.footprint !== null,
    footprint: preview.footprint ? Object.freeze({ cells: Object.freeze(preview.footprint.cells.map(cell)), entrance: cell(preview.footprint.entrance) }) : null });
}
export function createManagementV9RendererSource(port: ManagementV9RendererPort, options: ManagementV9RendererOptions = {}): ManagementV9RendererSource {
  let previous: ManagementV9RendererInput | undefined;
  let snapshot: SectRendererSnapshot | undefined;
  let placement: SectPlacementRenderPreview | null = null;
  let previousPlacement: SectPlacementRenderPreview | null = null;
  const placementListeners = new Set<() => void>();
  return {
    rendererContract: 'sect-renderer.1', subscribe: listener => {
      let active = true;
      const notify = () => { if (active) listener(); };
      placementListeners.add(notify);
      const stop = port.subscribe(notify);
      return () => { if (active) { active = false; placementListeners.delete(notify); stop(); } };
    },
    getSnapshot: () => {
      const next = port.getSnapshot();
      // Session publications are immutable. Wrapper allocation does not invalidate an unchanged bounded view.
      if (!snapshot || !previous || placement !== previousPlacement || next.frame !== previous.frame || next.expansion !== previous.expansion || next.paused !== previous.paused
        || next.selection?.kind !== previous.selection?.kind || next.selection?.id !== previous.selection?.id) {
        snapshot = freezeSectRendererSnapshot({ ...projectManagementV9Renderer(next), placement }); previous = next; previousPlacement = placement;
      }
      return snapshot;
    },
    select: selection => port.select(selection ? { kind: selection.kind, id: selection.id } : null),
    onPlacementCell: cell => { if (placement) options.onPlacementCell?.({ x: cell.x, y: cell.y }); },
    setPlacementPreview: preview => {
      const next = copyPlacementPreview(preview);
      if (JSON.stringify(next) === JSON.stringify(placement)) return;
      placement = next;
      for (const listener of [...placementListeners]) listener();
    },
  };
}
