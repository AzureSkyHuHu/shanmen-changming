import type { RecipeDefinition } from '../economy/types';

/** Renewable starter content. Farming shares the existing garden seat with herb gathering. */
export const SUSTAINABLE_RECIPES: Readonly<Record<string, RecipeDefinition>> = {
  'gather.grain': {
    recipeId: 'gather.grain', nameKey: 'recipe.gatherGrain', inputs: [],
    outputs: [{ resourceId: 'grain', quantity: 1 }], workTicks: 140,
    workstation: 'forest', commitPolicy: 'on-completion',
  },
  'farm.grain': {
    recipeId: 'farm.grain', nameKey: 'recipe.farmGrain', inputs: [{ resourceId: 'grain', quantity: 1 }],
    outputs: [{ resourceId: 'grain', quantity: 5 }], workTicks: 240,
    workstation: 'herb-garden', commitPolicy: 'on-completion',
  },
};
