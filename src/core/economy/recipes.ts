import type { RecipeDefinition } from './types';
import { SUSTAINABLE_RECIPES } from '../sect-economy/recipes';

/** Frozen identity set for pre-v5 restore validation; never append later content here. */
export const LEGACY_V4_RECIPE_IDS = Object.freeze(['gather.wood', 'gather.herbs', 'cook.meal', 'craft.plank'] as const);

/** Small bootstrapping content fixture, not the final content pipeline or balance. */
export const STARTER_RECIPES: Readonly<Record<string, RecipeDefinition>> = {
  'gather.wood': { recipeId: 'gather.wood', nameKey: 'recipe.gatherWood', inputs: [], outputs: [{ resourceId: 'wood', quantity: 4 }], workTicks: 120, workstation: 'forest', commitPolicy: 'on-completion' },
  'gather.herbs': { recipeId: 'gather.herbs', nameKey: 'recipe.gatherHerbs', inputs: [], outputs: [{ resourceId: 'herbs', quantity: 3 }], workTicks: 100, workstation: 'herb-garden', commitPolicy: 'on-completion' },
  'cook.meal': { recipeId: 'cook.meal', nameKey: 'recipe.cookMeal', inputs: [{ resourceId: 'grain', quantity: 2 }], outputs: [{ resourceId: 'meal', quantity: 3 }], workTicks: 80, workstation: 'kitchen', commitPolicy: 'on-completion' },
  'craft.plank': { recipeId: 'craft.plank', nameKey: 'recipe.craftPlank', inputs: [{ resourceId: 'wood', quantity: 3 }], outputs: [{ resourceId: 'plank', quantity: 2 }], workTicks: 160, workstation: 'workshop', commitPolicy: 'on-completion' },
  ...SUSTAINABLE_RECIPES,
};

export function getRecipe(recipeId: string): RecipeDefinition | undefined {
  return Object.hasOwn(STARTER_RECIPES, recipeId) ? STARTER_RECIPES[recipeId] : undefined;
}
