import { RESOURCE_IDS } from '../../core/economy/types';
import { STARTER_RECIPES } from '../../core/economy/recipes';
import { stableHash } from '../../core/kernel/serialization';
import { SECT_BUILDING_IDS, SECT_CATALOG_ID, SECT_LIMITS, SECT_RECIPE_IDS, SECT_RESEARCH_IDS, SECT_RESOURCE_IDS, SECT_STOCK_CAPACITY,
  type SectCatalog, type SectCatalogValidation, type SectResearchEffect, type SectStock, type SectValidationIssue, type SectWorkstationRequirement } from './types';

type DataObject = Record<string, unknown>;
const object = (value: unknown): value is DataObject => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: readonly string[]): value is DataObject => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const member = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value);
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
const list = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const nameKey = (value: unknown) => typeof value === 'string' && /^sectV9\.[A-Za-z][A-Za-z0-9.]*$/.test(value);

/** Reject accessors, exotic prototypes, holes, cycles and oversized authoring input before reading fields. */
function plainData(input: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): boolean {
    if (++nodes > 4000 || depth > 16) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 256;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object' || ancestors.has(value)) return false;
    const array = Array.isArray(value);
    if (!array && !object(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (array ? value.length > 64 || keys.length !== value.length + 1 : keys.length > 32) return false;
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(value);
    return true;
  }
  return visit(input, 0);
}

export function createEmptySectStock(): SectStock {
  return {
    'spirit-stone': { owned: 0, reserved: 0, capacity: SECT_STOCK_CAPACITY },
    'basic-insight': { owned: 0, reserved: 0, capacity: SECT_STOCK_CAPACITY },
    'wound-powder': { owned: 0, reserved: 0, capacity: SECT_STOCK_CAPACITY },
  };
}
export function validateSectStock(input: unknown): readonly SectValidationIssue[] {
  if (!plainData(input) || !exact(input, SECT_RESOURCE_IDS)) return [{ code: 'stock-shape', path: 'stock' }];
  const issues: SectValidationIssue[] = [];
  for (const id of SECT_RESOURCE_IDS) {
    const entry = input[id];
    if (!exact(entry, ['owned', 'reserved', 'capacity']) || entry.capacity !== SECT_STOCK_CAPACITY
      || typeof entry.owned !== 'number' || !Number.isSafeInteger(entry.owned) || entry.owned < 0 || entry.owned > SECT_STOCK_CAPACITY
      || typeof entry.reserved !== 'number' || !Number.isSafeInteger(entry.reserved) || entry.reserved < 0 || entry.reserved > entry.owned) {
      issues.push({ code: 'stock-bound', path: `stock.${id}` });
    }
  }
  return issues;
}

/** Structural and dependency validation for candidate authoring; valid data is not executable authority. */
export function validateSectCatalog(input: unknown): SectCatalogValidation {
  const issues: SectValidationIssue[] = [];
  const add = (code: string, path: string) => { issues.push({ code, path }); };
  if (!plainData(input) || !exact(input, ['schemaVersion', 'id', 'status', 'protocol', 'resources', 'limits', 'buildings', 'research', 'recipes'])) {
    return { valid: false, issues: [{ code: 'catalog-shape', path: 'catalog' }] };
  }
  if (input.schemaVersion !== 1 || input.id !== SECT_CATALOG_ID || input.status !== 'candidate' || input.protocol !== 'sect-expansion-candidate.1') add('catalog-version', 'catalog');
  if (!exact(input.limits, Object.keys(SECT_LIMITS)) || Object.entries(SECT_LIMITS).some(([key, value]) => (input.limits as DataObject)[key] !== value)) add('catalog-limits', 'limits');
  const unique = (ids: readonly unknown[], path: string) => { if (new Set(ids).size !== ids.length) add('duplicate-id', path); };
  function references(value: unknown, path: string): void {
    if (!list(value, SECT_RESEARCH_IDS.length) || !value.every(id => member(id, SECT_RESEARCH_IDS))) add('research-reference', path);
    else unique(value, path);
  }
  function lines(value: unknown, path: string): void {
    if (!list(value, RESOURCE_IDS.length + SECT_RESOURCE_IDS.length) || value.length === 0) { add('price-shape', path); return; }
    const ids: string[] = [];
    value.forEach((line, index) => {
      const current = `${path}[${index}]`;
      if (!exact(line, ['ledger', 'resourceId', 'quantity'])) { add('price-shape', current); return; }
      const idsForLedger = line.ledger === 'base' ? RESOURCE_IDS : line.ledger === 'sect' ? SECT_RESOURCE_IDS : [];
      if (!member(line.resourceId, idsForLedger)) add('ledger-resource', current);
      if (!positive(line.quantity, line.ledger === 'sect' ? SECT_STOCK_CAPACITY : 999)) add('price-bound', current);
      ids.push(`${String(line.ledger)}:${String(line.resourceId)}`);
    });
    unique(ids, path);
  }
  function station(value: unknown, path: string, research = false): void {
    if (exact(value, ['kind', 'blueprintId']) && value.kind === 'legacy-point' && !research && member(value.blueprintId, ['mine', 'spirit-vein'])) return;
    if (exact(value, ['kind', 'definitionId', 'minimumLevel']) && value.kind === 'placed' && member(value.definitionId, SECT_BUILDING_IDS) && [1, 2].includes(value.minimumLevel as number)) return;
    add('workstation-shape', path);
  }
  if (!list(input.resources, 3) || input.resources.length !== 3) add('resource-set', 'resources');
  else {
    const ids: unknown[] = [];
    input.resources.forEach((resource, index) => {
      if (!exact(resource, ['resourceId', 'nameKey', 'initialOwned', 'capacity']) || !member(resource.resourceId, SECT_RESOURCE_IDS) || !nameKey(resource.nameKey) || resource.initialOwned !== 0 || resource.capacity !== SECT_STOCK_CAPACITY) add('resource-set', `resources[${index}]`);
      else ids.push(resource.resourceId);
    });
    unique(ids, 'resources');
  }
  if (!list(input.buildings, 2) || input.buildings.length !== 2) add('building-set', 'buildings');
  else {
    const ids: unknown[] = [];
    input.buildings.forEach((building, index) => {
      const path = `buildings[${index}]`;
      if (!exact(building, ['id', 'nameKey', 'footprint', 'workstation', 'levels', 'relocation']) || !member(building.id, SECT_BUILDING_IDS) || !nameKey(building.nameKey)) { add('building-shape', path); return; }
      ids.push(building.id);
      const footprint = building.footprint;
      if (!exact(footprint, ['width', 'height', 'entrance']) || footprint.width !== 2 || footprint.height !== 2 || !exact(footprint.entrance, ['x', 'y'])) add('footprint-shape', `${path}.footprint`);
      else {
        const { x, y } = footprint.entrance;
        if (!Number.isInteger(x) || !Number.isInteger(y) || !(((x === -1 || x === 2) && (y === 0 || y === 1)) || ((y === -1 || y === 2) && (x === 0 || x === 1)))) add('outside-entrance', `${path}.footprint.entrance`);
      }
      if (!exact(building.workstation, ['seats', 'activities']) || building.workstation.seats !== 1 || !list(building.workstation.activities, 2)
        || !building.workstation.activities.includes('production') || building.workstation.activities.some(activity => !member(activity, ['production', 'research']))) add('workstation-shape', `${path}.workstation`);
      else unique(building.workstation.activities, `${path}.workstation.activities`);
      if (!list(building.levels, 2) || building.levels.length !== (building.id === 'library.v9' ? 1 : 2)) add('building-levels', `${path}.levels`);
      else building.levels.forEach((level, levelIndex) => {
        const current = `${path}.levels[${levelIndex}]`;
        if (!exact(level, ['level', 'costs', 'workTicks', 'requiredResearch', 'maintenance']) || level.level !== levelIndex + 1 || !positive(level.workTicks)) { add('building-levels', current); return; }
        lines(level.costs, `${current}.costs`); references(level.requiredResearch, `${current}.requiredResearch`);
        if (!exact(level.maintenance, ['intervalTicks', 'costs']) || level.maintenance.intervalTicks !== 1200) add('maintenance-shape', `${current}.maintenance`);
        else lines(level.maintenance.costs, `${current}.maintenance.costs`);
      });
      if (!exact(building.relocation, ['costs', 'workTicks']) || building.relocation.workTicks !== 200) add('relocation-shape', `${path}.relocation`);
      else lines(building.relocation.costs, `${path}.relocation.costs`);
    });
    unique(ids, 'buildings');
  }
  if (!list(input.research, 2) || input.research.length !== 2) add('research-set', 'research');
  else {
    const ids: unknown[] = [];
    input.research.forEach((research, index) => {
      const path = `research[${index}]`;
      if (!exact(research, ['id', 'nameKey', 'prerequisites', 'costs', 'workTicks', 'workstation', 'effects']) || !member(research.id, SECT_RESEARCH_IDS) || !nameKey(research.nameKey) || !positive(research.workTicks)) { add('research-shape', path); return; }
      ids.push(research.id); references(research.prerequisites, `${path}.prerequisites`); lines(research.costs, `${path}.costs`); station(research.workstation, `${path}.workstation`, true);
      if (!list(research.effects, 7) || research.effects.length === 0) add('research-effects', `${path}.effects`);
      else research.effects.forEach((effect, effectIndex) => {
        if (exact(effect, ['kind', 'definitionId', 'level']) && effect.kind === 'unlock-building-level' && member(effect.definitionId, SECT_BUILDING_IDS) && [1, 2].includes(effect.level as number)) return;
        if (exact(effect, ['kind', 'recipeId']) && effect.kind === 'unlock-recipe' && member(effect.recipeId, SECT_RECIPE_IDS)) return;
        add('research-effects', `${path}.effects[${effectIndex}]`);
      });
    });
    unique(ids, 'research');
  }
  if (!list(input.recipes, 5) || input.recipes.length !== 5) add('recipe-set', 'recipes');
  else {
    const ids: unknown[] = [];
    input.recipes.forEach((recipe, index) => {
      const path = `recipes[${index}]`;
      if (!exact(recipe, ['recipeId', 'nameKey', 'inputs', 'outputs', 'workTicks', 'workstation', 'requiredResearch', 'commitPolicy']) || !member(recipe.recipeId, SECT_RECIPE_IDS) || !nameKey(recipe.nameKey) || !positive(recipe.workTicks) || recipe.commitPolicy !== 'on-completion') { add('recipe-shape', path); return; }
      ids.push(recipe.recipeId); lines(recipe.inputs, `${path}.inputs`); lines(recipe.outputs, `${path}.outputs`);
      references(recipe.requiredResearch, `${path}.requiredResearch`); station(recipe.workstation, `${path}.workstation`);
    });
    unique(ids, 'recipes');
  }
  if (issues.length) return { valid: false, issues };
  // All fields and references are now structurally bounded, plain data of the declared union.
  const catalog = input as unknown as SectCatalog;
  const buildings = new Map(catalog.buildings.map(entry => [entry.id, entry]));
  const research = new Map(catalog.research.map(entry => [entry.id, entry]));
  const recipes = new Map(catalog.recipes.map(entry => [entry.recipeId, entry]));
  const ancestors = (ids: readonly string[]): Set<string> => {
    const found = new Set<string>();
    const walk = (id: string, stack: Set<string>) => {
      if (stack.has(id)) { add('prerequisite-cycle', id); return; }
      if (found.has(id)) return;
      found.add(id);
      const node = catalog.research.find(entry => entry.id === id);
      if (node) for (const parent of node.prerequisites) walk(parent, new Set([...stack, id]));
    };
    for (const id of ids) walk(id, new Set());
    return found;
  };
  for (const node of catalog.research) ancestors([node.id]);
  const effectKey = (effect: SectResearchEffect) => effect.kind === 'unlock-recipe' ? `recipe:${effect.recipeId}` : `building:${effect.definitionId}:${effect.level}`;
  const effects = new Map<string, string>();
  for (const node of catalog.research) {
    for (const effect of node.effects) {
      const key = effectKey(effect);
      if (effects.has(key)) add('duplicate-unlock', node.id);
      effects.set(key, node.id);
      const target = effect.kind === 'unlock-recipe' ? recipes.get(effect.recipeId) : buildings.get(effect.definitionId)?.levels.find(level => level.level === effect.level);
      if (!target || !target.requiredResearch.includes(node.id)) add('unlock-gate-mismatch', key);
    }
  }
  function checkStation(requirement: SectWorkstationRequirement, required: readonly string[], path: string, activity: 'production' | 'research') {
    if (requirement.kind === 'legacy-point') return;
    const building = buildings.get(requirement.definitionId);
    const level = building?.levels.find(entry => entry.level === requirement.minimumLevel);
    if (!building || !level || !building.workstation.activities.includes(activity)) { add('workstation-reference', path); return; }
    const available = ancestors(required);
    for (const previous of building.levels.filter(entry => entry.level <= requirement.minimumLevel)) {
      if (previous.requiredResearch.some(id => !available.has(id))) add('workstation-gate', path);
    }
  }
  for (const building of catalog.buildings) for (const level of building.levels) {
    for (const id of level.requiredResearch) if (!research.get(id)?.effects.some(effect => effectKey(effect) === `building:${building.id}:${level.level}`)) add('missing-unlock', `${building.id}:${level.level}`);
  }
  for (const recipe of catalog.recipes) {
    checkStation(recipe.workstation, recipe.requiredResearch, recipe.recipeId, 'production');
    for (const id of recipe.requiredResearch) if (!research.get(id)?.effects.some(effect => effectKey(effect) === `recipe:${recipe.recipeId}`)) add('missing-unlock', recipe.recipeId);
  }
  for (const node of catalog.research) checkStation(node.workstation, node.prerequisites, node.id, 'research');
  // Conservative renewable-source reachability, not a quantitative solvency/balance proof.
  // Discover roots from the unchanged legacy recipes, starting with zero resources. In particular,
  // the finite initial stone stock is NOT a renewable root; gather.stone.v9 must supply it.
  // As elsewhere in this authoring check, legacy stations and eligible labor are assumed available.
  const availableResources = new Set<string>();
  for (let pass = 0; pass < RESOURCE_IDS.length; pass += 1) {
    for (const recipe of Object.values(STARTER_RECIPES)) {
      if (recipe.inputs.every(line => availableResources.has(`base:${line.resourceId}`))) {
        for (const output of recipe.outputs) availableResources.add(`base:${output.resourceId}`);
      }
    }
  }
  const availableLevels = new Set<string>(); const completed = new Set<string>(); const producible = new Set<string>();
  const priceAvailable = (lines: SectCatalog['recipes'][number]['inputs']) => lines.every(line => availableResources.has(`${line.ledger}:${line.resourceId}`));
  const stationAvailable = (requirement: SectWorkstationRequirement) => requirement.kind === 'legacy-point' || availableLevels.has(`${requirement.definitionId}:${requirement.minimumLevel}`);
  for (let pass = 0; pass < 11; pass += 1) {
    for (const building of catalog.buildings) for (const level of building.levels) {
      if (level.requiredResearch.every(id => completed.has(id)) && priceAvailable(level.costs) && (level.level === 1 || availableLevels.has(`${building.id}:${level.level - 1}`))) availableLevels.add(`${building.id}:${level.level}`);
    }
    for (const recipe of catalog.recipes) {
      if (recipe.requiredResearch.every(id => completed.has(id)) && stationAvailable(recipe.workstation) && priceAvailable(recipe.inputs)) {
        producible.add(recipe.recipeId); for (const output of recipe.outputs) availableResources.add(`${output.ledger}:${output.resourceId}`);
      }
    }
    for (const node of catalog.research) if (node.prerequisites.every(id => completed.has(id)) && stationAvailable(node.workstation) && priceAvailable(node.costs)) completed.add(node.id);
  }
  if (producible.size !== catalog.recipes.length || completed.size !== catalog.research.length || availableLevels.size !== catalog.buildings.reduce((sum, building) => sum + building.levels.length, 0)) add('bootstrap-deadlock', 'catalog');
  return issues.length ? { valid: false, issues } : { valid: true, value: catalog, issues: [] };
}

/** Includes every candidate field; corruption/version identity, never a security signature. */
export function sectCatalogFingerprint(input: unknown): string | null {
  const report = validateSectCatalog(input);
  return report.valid ? stableHash(report.value) : null;
}
