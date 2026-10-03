import { disciplePresentation, type DisciplePresentationId } from '../application/character-presentation';
import type { ApplicationSession, DeepReadonly, SessionProjection } from '../application/session';

/** Renderer-only DTOs. They cannot be dispatched, persisted, or used as World authority. */
export type SectRendererSelection = { readonly kind: 'disciple' | 'building' | 'blueprint' | 'sect-building'; readonly id: string } | null;
export interface SectRenderCell { readonly x: number; readonly y: number }
export interface SectRenderTerrain {
  readonly seed: string; readonly navVersion: number; readonly width: number; readonly height: number;
  readonly tiles: readonly (SectRenderCell & { readonly terrain: 'grass' | 'path' | 'forest' | 'stone' | 'water'; readonly walkable: boolean })[];
}
export interface SectVisualWork {
  readonly kind: 'legacy-production' | 'construction' | 'sect-production' | 'research' | 'care' | 'upgrade';
  readonly ownerId: string; readonly activeTicks: number; readonly requiredTicks: number; readonly blocked: boolean;
}
export interface SectRenderDisciple {
  readonly id: string; readonly nameKey: string; readonly presentationId: DisciplePresentationId;
  readonly position: SectRenderCell; readonly lifeState: 'alive' | 'pendingDeath' | 'dead'; readonly traveling: boolean;
  readonly work: SectVisualWork | null;
}
export interface SectRenderLegacyBuilding {
  readonly id: string; readonly blueprintId: string; readonly nameKey: string;
  readonly x: number; readonly y: number; readonly operational: boolean;
}
interface SectExpansionGeometry {
  readonly id: string; readonly definitionId: 'library.v9' | 'alchemy.v9';
  readonly footprint: { readonly cells: readonly SectRenderCell[]; readonly entrance: SectRenderCell };
}
export type SectRenderExpansion = SectExpansionGeometry & (
  | { readonly kind: 'blueprint'; readonly status: 'planned' | 'started'; readonly work: SectVisualWork | null }
  | { readonly kind: 'sect-building'; readonly level: 1 | 2; readonly operational: boolean }
);
/** Advisory only. This cannot authorize placement or make cells impassable. */
export interface SectPlacementRenderPreview {
  readonly anchor: SectRenderCell;
  readonly footprint: { readonly cells: readonly SectRenderCell[]; readonly entrance: SectRenderCell } | null;
  readonly allowed: boolean;
}
export interface SectRendererSnapshot {
  readonly map: SectRenderTerrain; readonly disciples: readonly SectRenderDisciple[];
  /** Only the existing point-based stations use the eight legacy building textures. */
  readonly buildings: readonly SectRenderLegacyBuilding[];
  readonly expansion: readonly SectRenderExpansion[]; readonly selection: SectRendererSelection;
  readonly clock: { readonly simulationTick: number }; readonly paused: boolean;
  readonly placement: SectPlacementRenderPreview | null;
}
export interface SectRendererSource {
  readonly rendererContract: 'sect-renderer.1';
  subscribe(listener: () => void): () => void;
  getSnapshot(): SectRendererSnapshot;
  select(selection: SectRendererSelection): void;
  /** Click-to-edit coordinates only; callers must separately preview and confirm a command. */
  onPlacementCell?(cell: SectRenderCell): void;
}
export type LegacySectRendererSession = Pick<ApplicationSession, 'subscribe' | 'getSnapshot' | 'select'>;
type LegacyProjection = DeepReadonly<Pick<SessionProjection, 'map' | 'disciples' | 'buildings' | 'transactions' | 'selection' | 'clock' | 'paused'>>;

/** Freeze only freshly allocated presentation data, never the source Session/runtime DTO. */
export function freezeSectRendererSnapshot(snapshot: SectRendererSnapshot): SectRendererSnapshot {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}
export function copySectRenderTerrain(map: SectRenderTerrain): SectRenderTerrain {
  return { seed: map.seed, navVersion: map.navVersion, width: map.width, height: map.height,
    tiles: map.tiles.map(tile => ({ x: tile.x, y: tile.y, terrain: tile.terrain, walkable: tile.walkable })) };
}
export function copySectRenderLegacyBuildings(buildings: readonly SectRenderLegacyBuilding[]): readonly SectRenderLegacyBuilding[] {
  return buildings.map(building => ({ id: building.id, blueprintId: building.blueprintId, nameKey: building.nameKey,
    x: building.x, y: building.y, operational: building.operational }));
}
export function projectLegacySectRenderer(projection: LegacyProjection): SectRendererSnapshot {
  return freezeSectRendererSnapshot({
    map: copySectRenderTerrain(projection.map), buildings: copySectRenderLegacyBuildings(projection.buildings), expansion: [], placement: null,
    disciples: projection.disciples.map((disciple, index) => {
      // Legacy rendering intentionally retains the original assignment lookup semantics.
      const transaction = projection.transactions.find(entry => entry.transactionId === disciple.assignmentTransactionId);
      return { id: disciple.id, nameKey: disciple.nameKey, presentationId: disciplePresentation(disciple, index).id,
        position: { x: disciple.position.x, y: disciple.position.y }, lifeState: disciple.lifeState, traveling: disciple.traveling,
        work: transaction ? { kind: 'legacy-production', ownerId: transaction.transactionId, activeTicks: transaction.activeTicks,
          requiredTicks: transaction.requiredTicks, blocked: transaction.state === 'Blocked' } : null };
    }),
    selection: projection.selection ? { kind: projection.selection.kind, id: projection.selection.id } : null,
    clock: { simulationTick: projection.clock.simulationTick }, paused: projection.paused,
  });
}
export function createLegacySectRendererSource(session: LegacySectRendererSession): SectRendererSource {
  let previous: ReturnType<LegacySectRendererSession['getSnapshot']> | undefined;
  let snapshot: SectRendererSnapshot | undefined;
  return {
    rendererContract: 'sect-renderer.1',
    subscribe: listener => session.subscribe(listener),
    getSnapshot: () => {
      const next = session.getSnapshot();
      if (!snapshot || next !== previous) { snapshot = projectLegacySectRenderer(next); previous = next; }
      return snapshot;
    },
    select: selection => {
      // New expansion entities have their own kinds; never pass them to a legacy Session.
      if (selection === null) session.select(null);
      else if (selection.kind === 'disciple' || selection.kind === 'building') session.select({ kind: selection.kind, id: selection.id });
    },
  };
}
export function asSectRendererSource(source: SectRendererSource | LegacySectRendererSession): SectRendererSource {
  return 'rendererContract' in source ? source : createLegacySectRendererSource(source);
}
/** A late notification after teardown cannot touch destroyed Phaser objects. */
export function subscribeSectRenderer(source: SectRendererSource, update: () => void): () => void {
  let active = true;
  const stop = source.subscribe(() => { if (active) update(); });
  return () => { if (active) { active = false; stop(); } };
}
/** Stable, domain-qualified keys prevent an overlay from aliasing a legacy sprite. */
export function sectRenderEntityKey(selection: NonNullable<SectRendererSelection>): string {
  return `${selection.kind}:${selection.id}`;
}
export function sectVisualWorkProgress(work: SectVisualWork | null): number | null {
  if (!work || !Number.isFinite(work.activeTicks) || !Number.isFinite(work.requiredTicks) || work.requiredTicks <= 0) return null;
  return Math.max(0, Math.min(1, work.activeTicks / work.requiredTicks));
}

/** Convert camera-world coordinates to one bounded map cell without dispatch or prediction. */
export function sectPlacementCellAt(snapshot: SectRendererSnapshot, worldX: number, worldY: number,
  origin: SectRenderCell, tileSize: number): SectRenderCell | null {
  if (!snapshot.placement || !Number.isFinite(worldX) || !Number.isFinite(worldY) || tileSize <= 0) return null;
  const x = Math.floor((worldX - origin.x) / tileSize), y = Math.floor((worldY - origin.y) / tileSize);
  return x >= 0 && y >= 0 && x < snapshot.map.width && y < snapshot.map.height ? { x, y } : null;
}
