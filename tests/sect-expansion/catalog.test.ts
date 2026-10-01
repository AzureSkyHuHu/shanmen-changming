import { describe, expect, it } from 'vitest';
import { SECT_V9_CANDIDATE, SECT_V9_CANDIDATE_IDENTITY, getSectBuildingDefinition, getSectRecipeDefinition, getSectResearchDefinition, resolveSectCatalogIdentity } from '../../src/content/sect-v9/catalog';
import { SECT_LIMITS, SECT_RESOURCE_IDS, type SectCatalog } from '../../src/content/sect-v9/types';
import { createEmptySectStock, sectCatalogFingerprint, validateSectCatalog, validateSectStock } from '../../src/content/sect-v9/validation';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE, resolveContentIdentity } from '../../src/content/registry';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { STARTER_RECIPES, getRecipe } from '../../src/core/economy/recipes';
import { createWorld } from '../../src/core/world/create-world';
import { cloneJson } from '../../src/core/kernel/serialization';
import { en } from '../../src/content/locales/en';
import { zhCN } from '../../src/content/locales/zh-CN';
import { createTranslator, messageSpecifications, SAFE_TRANSLATION_MESSAGE, type LocaleDiagnostic, type TextKey } from '../../src/i18n';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = () => cloneJson(SECT_V9_CANDIDATE) as Mutable<SectCatalog>;
const codes = (input: unknown) => validateSectCatalog(input).issues.map(issue => issue.code);

describe('isolated sect v9 candidate authoring', () => {
  it('defines exactly the planned two buildings, two research nodes and five additive recipes', () => {
    expect(validateSectCatalog(SECT_V9_CANDIDATE)).toMatchObject({ valid: true, issues: [] });
    expect(SECT_V9_CANDIDATE.buildings).toHaveLength(2);
    expect(SECT_V9_CANDIDATE.research).toHaveLength(2);
    expect(SECT_V9_CANDIDATE.recipes).toHaveLength(5);
    expect(SECT_V9_CANDIDATE.resources.map(({ resourceId, initialOwned, capacity }) => ({ resourceId, initialOwned, capacity }))).toEqual(SECT_RESOURCE_IDS.map(resourceId => ({ resourceId, initialOwned: 0, capacity: 99 })));
    expect(SECT_V9_CANDIDATE.limits).toEqual({ activeJobs: 36, blueprints: 16, buildings: 200, activeResearch: 1 });
    expect(SECT_LIMITS).toBe(SECT_V9_CANDIDATE.limits);
    expect(Object.keys(STARTER_RECIPES)).toHaveLength(6);
    expect(RESOURCE_IDS).toEqual(['wood', 'stone', 'herbs', 'grain', 'meal', 'plank']);
    for (const recipe of SECT_V9_CANDIDATE.recipes) expect(getRecipe(recipe.recipeId)).toBeUndefined();
  });
  it('translates every candidate and resource name in both languages with per-key Chinese fallback', () => {
    const keys = [...SECT_V9_CANDIDATE.buildings, ...SECT_V9_CANDIDATE.research, ...SECT_V9_CANDIDATE.recipes, ...SECT_V9_CANDIDATE.resources].map(definition => definition.nameKey);
    expect(keys).toHaveLength(12); expect(new Set(keys).size).toBe(12);
    const diagnostics: LocaleDiagnostic[] = [];
    const translate = createTranslator({ onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    const fallback = createTranslator({ englishCatalog: {}, onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    for (const key of keys) {
      expect(Object.hasOwn(messageSpecifications, key)).toBe(true);
      expect(Object.hasOwn(zhCN, key)).toBe(true); expect(Object.hasOwn(en, key)).toBe(true);
      expect(translate('zh-CN', key)).toBe(zhCN[key as TextKey]);
      expect(translate('en', key)).toBe(en[key as keyof typeof en]);
      expect(translate('en', key)).not.toBe(SAFE_TRANSLATION_MESSAGE);
      expect(translate('zh-CN', key)).toMatch(/[\u3400-\u9fff]/);
      expect(fallback('en', key)).toBe(zhCN[key as TextKey]);
    }
    expect(diagnostics).toEqual([]);
  });
  it('locks the proposed prices, work times, shared seat, upgrade and maintenance differences', () => {
    const library = getSectBuildingDefinition('library.v9')!; const alchemy = getSectBuildingDefinition('alchemy.v9')!;
    const construction = [{ ledger: 'base', resourceId: 'wood', quantity: 8 }, { ledger: 'base', resourceId: 'stone', quantity: 4 }, { ledger: 'base', resourceId: 'plank', quantity: 4 }];
    expect(library.levels[0]).toMatchObject({ costs: construction, workTicks: 320, requiredResearch: [] });
    expect(alchemy.levels[0]).toMatchObject({ costs: construction, workTicks: 320, requiredResearch: ['basic-medicine.v9'] });
    expect(library.workstation).toEqual({ seats: 1, activities: ['production', 'research'] });
    expect(alchemy.workstation).toEqual({ seats: 1, activities: ['production'] });
    expect(alchemy.levels[1]).toEqual({ level: 2, costs: [{ ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }], workTicks: 400, requiredResearch: ['herbal-compatibility.v9'], maintenance: { intervalTicks: 1200, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }] } });
    for (const building of [library, alchemy]) {
      expect(building.relocation).toEqual({ costs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }], workTicks: 200 });
      expect(building.levels[0]!.maintenance).toEqual({ intervalTicks: 1200, costs: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] });
    }
    expect(getSectResearchDefinition('basic-medicine.v9')).toMatchObject({ prerequisites: [], costs: [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 2 }, { ledger: 'sect', resourceId: 'spirit-stone', quantity: 2 }], workTicks: 240 });
    expect(getSectResearchDefinition('herbal-compatibility.v9')).toMatchObject({ prerequisites: ['basic-medicine.v9'], costs: [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 4 }, { ledger: 'sect', resourceId: 'spirit-stone', quantity: 4 }], workTicks: 400 });
  });
  it('retains the exact five non-free conversion recipes and their independent research/level gates', () => {
    expect(SECT_V9_CANDIDATE.recipes.map(recipe => [recipe.recipeId, recipe.workTicks, recipe.inputs, recipe.outputs])).toEqual([
      ['gather.stone.v9', 160, [{ ledger: 'base', resourceId: 'wood', quantity: 1 }], [{ ledger: 'base', resourceId: 'stone', quantity: 3 }]],
      ['extract.spirit-stone.v9', 240, [{ ledger: 'base', resourceId: 'stone', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }], [{ ledger: 'sect', resourceId: 'spirit-stone', quantity: 1 }]],
      ['study.basic-insight.v9', 240, [{ ledger: 'base', resourceId: 'plank', quantity: 1 }, { ledger: 'base', resourceId: 'herbs', quantity: 2 }], [{ ledger: 'sect', resourceId: 'basic-insight', quantity: 1 }]],
      ['craft.wound-powder.v9', 160, [{ ledger: 'base', resourceId: 'herbs', quantity: 3 }, { ledger: 'base', resourceId: 'grain', quantity: 1 }], [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }]],
      ['craft.wound-powder-alt.v9', 200, [{ ledger: 'base', resourceId: 'herbs', quantity: 5 }, { ledger: 'base', resourceId: 'wood', quantity: 2 }], [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }]],
    ]);
    expect(getSectRecipeDefinition('study.basic-insight.v9')!.requiredResearch).toEqual([]);
    expect(getSectRecipeDefinition('craft.wound-powder.v9')).toMatchObject({ workstation: { minimumLevel: 1 }, requiredResearch: ['basic-medicine.v9'] });
    expect(getSectRecipeDefinition('craft.wound-powder-alt.v9')).toMatchObject({ workstation: { minimumLevel: 2 }, requiredResearch: ['herbal-compatibility.v9'] });
  });
  it.each([0, -1, 1.5, 1000, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid base price %s', quantity => {
    const value = copy(); value.buildings[0]!.levels[0]!.costs[0]!.quantity = quantity;
    expect(validateSectCatalog(value).valid).toBe(false);
  });
  it('rejects mismatched ledger resources, unknown fields, duplicates and unbounded sect prices', () => {
    const badLedger = copy(); Object.assign(badLedger.recipes[1]!.outputs[0]!, { ledger: 'base' });
    expect(codes(badLedger)).toContain('ledger-resource');
    const unknown = copy(); Object.assign(unknown.recipes[0]!.inputs[0]!, { resourceId: 'spirit-energy' });
    expect(codes(unknown)).toContain('ledger-resource');
    const oversized = copy(); oversized.research[0]!.costs[0]!.quantity = 100;
    expect(codes(oversized)).toContain('price-bound');
    const duplicate = copy(); duplicate.recipes[0]!.inputs.push(cloneJson(duplicate.recipes[0]!.inputs[0]!));
    expect(codes(duplicate)).toContain('duplicate-id');
    const extra = copy(); Object.assign(extra.buildings[0]!.footprint, { passable: true });
    expect(codes(extra)).toContain('footprint-shape');
    const zero = copy(); zero.recipes[0]!.inputs = [];
    expect(codes(zero)).toContain('price-shape');
  });
  it('rejects cycles, orphaned effects, removed gates and impossible station levels', () => {
    const cycle = copy(); cycle.research[0]!.prerequisites = ['herbal-compatibility.v9'];
    expect(codes(cycle)).toContain('prerequisite-cycle');
    const effects = copy(); effects.research[0]!.effects.pop();
    expect(codes(effects)).toContain('missing-unlock');
    const gate = copy(); gate.recipes[3]!.requiredResearch = [];
    expect(codes(gate)).toContain('unlock-gate-mismatch');
    expect(codes(gate)).toContain('workstation-gate');
    const station = copy(); station.recipes[2]!.workstation = { kind: 'placed', definitionId: 'library.v9', minimumLevel: 2 };
    expect(codes(station)).toContain('workstation-reference');
  });
  it('rejects research-material bootstrap deadlocks even when the research DAG itself is acyclic', () => {
    const value = copy(); value.recipes[2]!.requiredResearch = ['basic-medicine.v9'];
    value.research[0]!.effects.push({ kind: 'unlock-recipe', recipeId: 'study.basic-insight.v9' });
    expect(codes(value)).toContain('bootstrap-deadlock');
    expect(codes(value)).not.toContain('prerequisite-cycle');
  });
  it('requires the candidate stone source before stone-dependent research rather than spending a fictional renewable root', () => {
    expect(Object.values(STARTER_RECIPES).some(recipe => recipe.outputs.some(line => line.resourceId === 'stone'))).toBe(false);
    const value = copy(); value.recipes[0]!.requiredResearch = ['basic-medicine.v9'];
    value.research[0]!.effects.push({ kind: 'unlock-recipe', recipeId: 'gather.stone.v9' });
    // Stone gates the library and spirit-stone source, both needed by Basic Medicine.
    // The research DAG and reverse effect references remain valid; renewable bootstrap does not.
    expect(codes(value)).toEqual(['bootstrap-deadlock']);
    expect(validateSectCatalog(SECT_V9_CANDIDATE).valid).toBe(true);
  });
  it('requires an adjacent outside entrance, sequential levels and exactly the fixed bounds', () => {
    const inside = copy(); inside.buildings[0]!.footprint.entrance = { x: 1, y: 1 };
    expect(codes(inside)).toContain('outside-entrance');
    const corner = copy(); corner.buildings[0]!.footprint.entrance = { x: -1, y: -1 };
    expect(codes(corner)).toContain('outside-entrance');
    const levels = copy(); levels.buildings[1]!.levels.reverse();
    expect(codes(levels)).toContain('building-levels');
    const limits = copy(); Object.assign(limits.limits, { activeJobs: 37 });
    expect(codes(limits)).toContain('catalog-limits');
  });
  it('rejects accessor/cyclic/non-plain authoring data without executing it', () => {
    let invoked = false; const accessor = copy(); Object.defineProperty(accessor, 'recipes', { get() { invoked = true; return []; }, enumerable: true });
    expect(validateSectCatalog(accessor).valid).toBe(false); expect(invoked).toBe(false);
    const cyclic = copy(); Object.assign(cyclic, { extra: cyclic });
    for (const value of [cyclic, Object.create(null), null, [], { ...copy(), extra: true }]) expect(validateSectCatalog(value).valid).toBe(false);
  });
  it('keeps zero-initialized stock at three fixed 99-unit entries and validates reservations', () => {
    const stock = createEmptySectStock(); expect(validateSectStock(stock)).toEqual([]);
    expect(createEmptySectStock()).not.toBe(stock);
    for (const entry of Object.values(stock)) expect(entry).toEqual({ owned: 0, reserved: 0, capacity: 99 });
    for (const entry of [{ owned: 100, reserved: 0, capacity: 99 }, { owned: 0, reserved: 1, capacity: 99 }, { owned: 1, reserved: -1, capacity: 99 }, { owned: 1, reserved: 0, capacity: 100 }, { owned: 0.5, reserved: 0, capacity: 99 }]) expect(validateSectStock({ ...stock, 'spirit-stone': entry })).not.toEqual([]);
    expect(validateSectStock({ ...stock, wood: { owned: 1, reserved: 0, capacity: 99 } })).not.toEqual([]);
    expect(validateSectStock({ ...stock, 'spirit-stone': { owned: 99, reserved: 99, capacity: 99 } })).toEqual([]);
  });
  it('pins the frozen local candidate identity and refuses caller-authored definitions as authority', () => {
    const identity = SECT_V9_CANDIDATE_IDENTITY;
    expect(sectCatalogFingerprint(SECT_V9_CANDIDATE)).toBe(identity.fingerprint);
    expect(resolveSectCatalogIdentity(cloneJson(identity))).toBe(SECT_V9_CANDIDATE);
    const spoof = copy(); spoof.buildings[0]!.levels[0]!.costs[0]!.quantity = 1;
    expect(validateSectCatalog(spoof).valid).toBe(true);
    expect(sectCatalogFingerprint(spoof)).not.toBe(identity.fingerprint);
    expect(resolveSectCatalogIdentity({ ...identity, fingerprint: sectCatalogFingerprint(spoof) })).toBeNull();
    expect(resolveSectCatalogIdentity({ ...identity, catalog: spoof })).toBeNull();
    expect(resolveSectCatalogIdentity({ ...identity, schemaVersion: 9 })).toBeNull();
    expect(Object.isFrozen(SECT_V9_CANDIDATE.buildings[0]!.levels[0]!.costs[0])).toBe(true);
    expect(Object.isFrozen(SECT_RESOURCE_IDS)).toBe(true);
    expect(getSectBuildingDefinition('__proto__')).toBeUndefined();
  });
  it('does not change default v7, registered World identities or old recipe authority', () => {
    const old = contentIdentity(LEGACY_V7_CONTENT); const v8 = contentIdentity(RELEASE_V8_CANDIDATE);
    expect(resolveContentIdentity(old)).toBe(LEGACY_V7_CONTENT);
    expect(resolveContentIdentity(v8, { allowCandidate: true })).toBe(RELEASE_V8_CANDIDATE);
    expect(resolveContentIdentity(SECT_V9_CANDIDATE_IDENTITY, { allowCandidate: true })).toBeNull();
    const world = createWorld('sect-v9-isolation');
    expect(world.simulationVersion).toBe('0.7.0'); expect(world).not.toHaveProperty('sectExpansion');
    expect(Object.keys(world.inventory)).toEqual([...RESOURCE_IDS]);
    expect(getRecipe('craft.plank')!.inputs).toEqual([{ resourceId: 'wood', quantity: 3 }]);
  });
});
