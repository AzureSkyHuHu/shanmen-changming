import type { MessageSpecifications } from './types.ts';

const noParameters = { parameters: {} } as const;

/** Registry of stable UI/content keys. Add a Chinese entry whenever adding a key. */
export const messageSpecifications = {
  'app.title': noParameters,
  'app.subtitle': noParameters,
  'app.phase': noParameters,
  'app.status': noParameters,
  'app.hint': noParameters,
  'app.scene.label': noParameters,
  'app.scene.caption': noParameters,
  'app.next.title': noParameters,
  'app.next.description': noParameters,
  'app.foundation.label': noParameters,
  'app.foundation.detail': noParameters,
  'settings.language.label': noParameters,
  'settings.language.zh-CN': noParameters,
  'settings.language.en': noParameters,
  'settings.language.switch': noParameters,
  'errors.translation.unavailable': noParameters,
  'world.disciples.summary': {
    parameters: { count: { type: 'number', format: 'integer' } },
  },
  'disciple.welcome': {
    parameters: { name: { type: 'string', format: 'text' } },
  },
  'cultivation.progress': {
    parameters: { progress: { type: 'number', format: 'percent' } },
  },
  'production.remaining': {
    parameters: { seconds: { type: 'number', format: 'seconds' } },
  },
  'resource.amount': {
    parameters: {
      name: { type: 'string', format: 'text' },
      amount: { type: 'number', format: 'number' },
    },
  },
} as const satisfies MessageSpecifications;

export type TextKey = keyof typeof messageSpecifications;
export const requiredTextKeys = Object.freeze(Object.keys(messageSpecifications) as TextKey[]);
