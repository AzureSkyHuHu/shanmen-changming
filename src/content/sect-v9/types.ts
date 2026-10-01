import type { ResourceId } from '../../core/economy/types';

export const SECT_CATALOG_ID = 'content.sect-v9.candidate-1' as const;
export const SECT_RESOURCE_IDS = Object.freeze(['spirit-stone', 'basic-insight', 'wound-powder'] as const);
export const SECT_BUILDING_IDS = Object.freeze(['library.v9', 'alchemy.v9'] as const);
export const SECT_RESEARCH_IDS = Object.freeze(['basic-medicine.v9', 'herbal-compatibility.v9'] as const);
export const SECT_RECIPE_IDS = Object.freeze(['gather.stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'craft.wound-powder.v9', 'craft.wound-powder-alt.v9'] as const);
export const SECT_STOCK_CAPACITY = 99;
export const SECT_LIMITS = Object.freeze({ activeJobs: 36, blueprints: 16, buildings: 200, activeResearch: 1 });
export type SectResourceId = typeof SECT_RESOURCE_IDS[number];
export type SectBuildingId = typeof SECT_BUILDING_IDS[number];
export type SectResearchId = typeof SECT_RESEARCH_IDS[number];
export type SectRecipeId = typeof SECT_RECIPE_IDS[number];
export type SectBuildingLevel = 1 | 2;

/** The discriminant forbids both cross-ledger resource aliases and a second base balance. */
export type SectResourceLine =
  | { readonly ledger: 'base'; readonly resourceId: ResourceId; readonly quantity: number }
  | { readonly ledger: 'sect'; readonly resourceId: SectResourceId; readonly quantity: number };
export interface SectStockEntry { readonly owned: number; readonly reserved: number; readonly capacity: typeof SECT_STOCK_CAPACITY }
export type SectStock = Readonly<Record<SectResourceId, SectStockEntry>>;
export interface SectCell { readonly x: number; readonly y: number }
export interface SectFootprintDefinition {
  readonly width: 2;
  readonly height: 2;
  /** Unrotated, edge-adjacent cell outside the occupied rectangle; also the queue point. */
  readonly entrance: SectCell;
}
export interface SectBuildingLevelDefinition {
  readonly level: SectBuildingLevel;
  readonly costs: readonly SectResourceLine[];
  readonly workTicks: number;
  readonly requiredResearch: readonly SectResearchId[];
  readonly maintenance: { readonly intervalTicks: 1200; readonly costs: readonly SectResourceLine[] };
}
export interface SectBuildingDefinition {
  readonly id: SectBuildingId;
  readonly nameKey: string;
  readonly footprint: SectFootprintDefinition;
  /** Production/research compete for this one seat. An entrance token is not this seat. */
  readonly workstation: { readonly seats: 1; readonly activities: readonly ('production' | 'research')[] };
  readonly levels: readonly SectBuildingLevelDefinition[];
  readonly relocation: { readonly costs: readonly SectResourceLine[]; readonly workTicks: 200 };
}
export type SectWorkstationRequirement =
  | { readonly kind: 'legacy-point'; readonly blueprintId: 'mine' | 'spirit-vein' }
  | { readonly kind: 'placed'; readonly definitionId: SectBuildingId; readonly minimumLevel: SectBuildingLevel };
export type SectResearchEffect =
  | { readonly kind: 'unlock-building-level'; readonly definitionId: SectBuildingId; readonly level: SectBuildingLevel }
  | { readonly kind: 'unlock-recipe'; readonly recipeId: SectRecipeId };
export interface SectResearchDefinition {
  readonly id: SectResearchId;
  readonly nameKey: string;
  readonly prerequisites: readonly SectResearchId[];
  readonly costs: readonly SectResourceLine[];
  readonly workTicks: number;
  readonly workstation: Extract<SectWorkstationRequirement, { kind: 'placed' }>;
  readonly effects: readonly SectResearchEffect[];
}
export interface SectRecipeDefinition {
  readonly recipeId: SectRecipeId;
  readonly nameKey: string;
  readonly inputs: readonly SectResourceLine[];
  readonly outputs: readonly SectResourceLine[];
  readonly workTicks: number;
  readonly workstation: SectWorkstationRequirement;
  readonly requiredResearch: readonly SectResearchId[];
  readonly commitPolicy: 'on-completion';
}
export interface SectCatalog {
  readonly schemaVersion: 1;
  readonly id: typeof SECT_CATALOG_ID;
  readonly status: 'candidate';
  readonly protocol: 'sect-expansion-candidate.1';
  readonly resources: readonly { readonly resourceId: SectResourceId; readonly nameKey: string; readonly initialOwned: 0; readonly capacity: 99 }[];
  readonly limits: typeof SECT_LIMITS;
  readonly buildings: readonly SectBuildingDefinition[];
  readonly research: readonly SectResearchDefinition[];
  /** Only five additive recipes. Existing six-resource recipes keep their original authority. */
  readonly recipes: readonly SectRecipeDefinition[];
}
export interface SectCatalogIdentity { readonly catalogId: typeof SECT_CATALOG_ID; readonly schemaVersion: 1; readonly fingerprint: string }
export interface SectValidationIssue { readonly code: string; readonly path: string }
export type SectCatalogValidation =
  | { readonly valid: true; readonly value: SectCatalog; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly SectValidationIssue[] };
