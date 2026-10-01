import type { MessageSpecifications, ParameterSpec } from '../../i18n/types.ts';
import { allCombatDefinitions, combatCatalog } from './index.ts';

/** Merge with the application's specifications alongside the two combat catalogs. */
export const combatMessageSpecifications: MessageSpecifications = Object.fromEntries(
  allCombatDefinitions(combatCatalog).flatMap((definition) => [
    [definition.nameKey, { parameters: {} }],
    [definition.descriptionKey, { parameters: Object.fromEntries(Object.entries(definition.descriptionParameters).map(([name, value]): [string, ParameterSpec] => [name, typeof value === 'number' ? { type: 'number', format: 'integer' } : { type: 'string', format: 'text' }])) }],
  ]),
);
