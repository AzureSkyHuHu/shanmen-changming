import { stableHash } from '../../core/kernel/serialization';
import { validateSectCatalog } from './validation';
import { SECT_CATALOG_ID, SECT_LIMITS, type SectBuildingDefinition, type SectCatalog, type SectCatalogIdentity, type SectRecipeDefinition, type SectResearchDefinition } from './types';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Candidate data only: no World/save registration, executor, transaction or default switch. */
export const SECT_V9_CANDIDATE: SectCatalog = freeze({
  schemaVersion: 1, id: SECT_CATALOG_ID, status: 'candidate', protocol: 'sect-expansion-candidate.1',
  resources: [
    { resourceId: 'spirit-stone', nameKey: 'sectV9.resource.spiritStone', initialOwned: 0, capacity: 99 },
    { resourceId: 'basic-insight', nameKey: 'sectV9.resource.basicInsight', initialOwned: 0, capacity: 99 },
    { resourceId: 'wound-powder', nameKey: 'sectV9.resource.woundPowder', initialOwned: 0, capacity: 99 },
  ],
  limits: SECT_LIMITS,
  buildings: [
    {
      id: 'library.v9', nameKey: 'sectV9.building.library', footprint: { width: 2, height: 2, entrance: { x: 0, y: 2 } },
      workstation: { seats: 1, activities: ['production', 'research'] },
      levels: [{ level: 1, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 8 }, { ledger: 'base', resourceId: 'stone', quantity: 4 }, { ledger: 'base', resourceId: 'plank', quantity: 4 }], workTicks: 320, requiredResearch: [], maintenance: { intervalTicks: 1200, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] } }],
      relocation: { costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], workTicks: 200 },
    },
    {
      id: 'alchemy.v9', nameKey: 'sectV9.building.alchemy', footprint: { width: 2, height: 2, entrance: { x: 0, y: 2 } },
      workstation: { seats: 1, activities: ['production'] },
      levels: [
        { level: 1, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 8 }, { ledger: 'base', resourceId: 'stone', quantity: 4 }, { ledger: 'base', resourceId: 'plank', quantity: 4 }], workTicks: 320, requiredResearch: ['basic-medicine.v9'], maintenance: { intervalTicks: 1200, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] } },
        { level: 2, costs: [{ ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }], workTicks: 400, requiredResearch: ['herbal-compatibility.v9'], maintenance: { intervalTicks: 1200, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }] } },
      ],
      relocation: { costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], workTicks: 200 },
    },
  ],
  research: [
    {
      id: 'basic-medicine.v9', nameKey: 'sectV9.research.basicMedicine', prerequisites: [],
      costs: [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 2 }, { ledger: 'sect', resourceId: 'spirit-stone', quantity: 2 }], workTicks: 240,
      workstation: { kind: 'placed', definitionId: 'library.v9', minimumLevel: 1 },
      effects: [{ kind: 'unlock-building-level', definitionId: 'alchemy.v9', level: 1 }, { kind: 'unlock-recipe', recipeId: 'craft.wound-powder.v9' }],
    },
    {
      id: 'herbal-compatibility.v9', nameKey: 'sectV9.research.herbalCompatibility', prerequisites: ['basic-medicine.v9'],
      costs: [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 4 }, { ledger: 'sect', resourceId: 'spirit-stone', quantity: 4 }], workTicks: 400,
      workstation: { kind: 'placed', definitionId: 'library.v9', minimumLevel: 1 },
      effects: [{ kind: 'unlock-building-level', definitionId: 'alchemy.v9', level: 2 }, { kind: 'unlock-recipe', recipeId: 'craft.wound-powder-alt.v9' }],
    },
  ],
  recipes: [
    { recipeId: 'gather.stone.v9', nameKey: 'sectV9.recipe.gatherStone', inputs: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }], outputs: [{ ledger: 'base', resourceId: 'stone', quantity: 3 }], workTicks: 160, workstation: { kind: 'legacy-point', blueprintId: 'mine' }, requiredResearch: [], commitPolicy: 'on-completion' },
    { recipeId: 'extract.spirit-stone.v9', nameKey: 'sectV9.recipe.extractSpiritStone', inputs: [{ ledger: 'base', resourceId: 'stone', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }], outputs: [{ ledger: 'sect', resourceId: 'spirit-stone', quantity: 1 }], workTicks: 240, workstation: { kind: 'legacy-point', blueprintId: 'spirit-vein' }, requiredResearch: [], commitPolicy: 'on-completion' },
    { recipeId: 'study.basic-insight.v9', nameKey: 'sectV9.recipe.studyBasicInsight', inputs: [{ ledger: 'base', resourceId: 'plank', quantity: 1 }, { ledger: 'base', resourceId: 'herbs', quantity: 2 }], outputs: [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 1 }], workTicks: 240, workstation: { kind: 'placed', definitionId: 'library.v9', minimumLevel: 1 }, requiredResearch: [], commitPolicy: 'on-completion' },
    { recipeId: 'craft.wound-powder.v9', nameKey: 'sectV9.recipe.craftWoundPowder', inputs: [{ ledger: 'base', resourceId: 'herbs', quantity: 3 }, { ledger: 'base', resourceId: 'grain', quantity: 1 }], outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }], workTicks: 160, workstation: { kind: 'placed', definitionId: 'alchemy.v9', minimumLevel: 1 }, requiredResearch: ['basic-medicine.v9'], commitPolicy: 'on-completion' },
    { recipeId: 'craft.wound-powder-alt.v9', nameKey: 'sectV9.recipe.craftWoundPowderAlt', inputs: [{ ledger: 'base', resourceId: 'herbs', quantity: 5 }, { ledger: 'base', resourceId: 'wood', quantity: 2 }], outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }], workTicks: 200, workstation: { kind: 'placed', definitionId: 'alchemy.v9', minimumLevel: 2 }, requiredResearch: ['herbal-compatibility.v9'], commitPolicy: 'on-completion' },
  ],
} satisfies SectCatalog);

if (!validateSectCatalog(SECT_V9_CANDIDATE).valid) throw new Error('Invalid sect v9 candidate catalog');
export const SECT_V9_CANDIDATE_IDENTITY: SectCatalogIdentity = freeze({ catalogId: SECT_CATALOG_ID, schemaVersion: 1, fingerprint: stableHash(SECT_V9_CANDIDATE) });

/** Local identity only. It is deliberately not one of the registered v7/v8 World identities. */
export function resolveSectCatalogIdentity(input: unknown): SectCatalog | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
  const keys = ['catalogId', 'schemaVersion', 'fingerprint'] as const;
  if (Reflect.ownKeys(input).length !== keys.length) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== SECT_V9_CANDIDATE_IDENTITY[key]) return null;
  }
  return SECT_V9_CANDIDATE;
}
export function getSectBuildingDefinition(id: string): SectBuildingDefinition | undefined { return SECT_V9_CANDIDATE.buildings.find(entry => entry.id === id); }
export function getSectResearchDefinition(id: string): SectResearchDefinition | undefined { return SECT_V9_CANDIDATE.research.find(entry => entry.id === id); }
export function getSectRecipeDefinition(id: string): SectRecipeDefinition | undefined { return SECT_V9_CANDIDATE.recipes.find(entry => entry.recipeId === id); }
