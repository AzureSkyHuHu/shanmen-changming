import type { SectBuildingId, SectBuildingLevel, SectCell } from '../../content/sect-v9/types';
import type { Disciple, WorldBuilding, WorldMap, WorldTile } from '../world/types';

export const SECT_ROTATIONS = Object.freeze([0, 90, 180, 270] as const);
export type SectRotation = typeof SECT_ROTATIONS[number];
export const LEGACY_SECT_STATION_IDS = Object.freeze(['housing', 'forest', 'herb-garden', 'kitchen', 'workshop', 'mine', 'spirit-vein', 'storage'] as const);
export interface SectPlacementRequest {
  readonly definitionId: SectBuildingId;
  /** Top-left of the rotated bounding box, not an arbitrary pivot. */
  readonly anchor: SectCell;
  readonly rotation: SectRotation;
}
export interface LegacyPointSpace { readonly kind: 'legacy-point'; readonly buildingId: string }
export interface PlacedBuildingSpace extends SectPlacementRequest {
  readonly kind: 'placed';
  readonly buildingId: string;
  readonly level: SectBuildingLevel;
}
export type SectBuildingSpace = LegacyPointSpace | PlacedBuildingSpace;
/** Soft claims do not block walking. Their footprint and entrance remain exclusively reserved. */
export interface SectBlueprintSpace extends SectPlacementRequest { readonly blueprintId: string }
export interface SectSpatialContext {
  readonly map: Readonly<Pick<WorldMap, 'width' | 'height'>> & { readonly tiles: readonly Readonly<WorldTile>[] };
  /** Authoritative old World points, supplied unchanged by the future World adapter. */
  readonly legacyStations: readonly Readonly<Pick<WorldBuilding, 'id' | 'blueprintId' | 'x' | 'y'>>[];
  readonly people: readonly Readonly<Pick<Disciple, 'id' | 'position' | 'lifeState' | 'traveling'>>[];
  /** Every old station must have exactly one legacy-point record; only new entities may be placed. */
  readonly spaces: readonly SectBuildingSpace[];
  readonly blueprints: readonly SectBlueprintSpace[];
}
export interface SectFootprint {
  readonly cells: readonly SectCell[];
  readonly entrance: SectCell;
}
export type SectGeometryError = 'INVALID_REQUEST' | 'UNKNOWN_DEFINITION' | 'INVALID_ANCHOR' | 'INVALID_ROTATION';
export type SectGeometryResult = { readonly ok: true; readonly footprint: SectFootprint } | { readonly ok: false; readonly code: SectGeometryError };
export interface SectHomeAnchor { readonly kind: 'legacy-station' | 'placed-entrance' | 'home-person'; readonly id: string; readonly position: SectCell }
export interface SectSpatialIssue {
  readonly code: 'INVALID_MAP' | 'INVALID_PEOPLE' | 'INVALID_LEGACY_STATIONS' | 'INVALID_SPACES' | 'INVALID_BLUEPRINTS'
    | 'OUT_OF_BOUNDS' | 'TERRAIN_BLOCKED' | 'ROAD_OCCUPIED' | 'FOOTPRINT_OVERLAP' | 'ENTRANCE_OVERLAP'
    | 'LEGACY_STATION_OCCUPIED' | 'PERSON_OCCUPIED' | 'BLUEPRINT_OVERLAP' | 'CONNECTIVITY_BLOCKED';
  readonly subjectId: string;
  readonly position?: SectCell;
}
export interface SectLayoutView {
  readonly occupiedCells: readonly SectCell[];
  readonly entrances: readonly { readonly buildingId: string; readonly position: SectCell }[];
  readonly requiredHomeAnchors: readonly SectHomeAnchor[];
  /** Detached effective grid, with legacy points still walkable. Never mutates map.tiles. */
  readonly walkableCells: readonly SectCell[];
}
export type SectLayoutResult = { readonly ok: true; readonly layout: SectLayoutView } | { readonly ok: false; readonly issues: readonly SectSpatialIssue[] };
export type SectPlacementResult =
  | { readonly ok: true; readonly footprint: SectFootprint; readonly layout: SectLayoutView }
  | { readonly ok: false; readonly code: SectGeometryError }
  | { readonly ok: false; readonly issues: readonly SectSpatialIssue[] };
