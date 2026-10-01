import type { TextKey } from '../../../i18n/messages.ts';
import type { MessageTemplate } from '../../../i18n/types.ts';

/** English may be incomplete; missing or whitespace-only entries fall back per key. */
export const en = {
  'app.title': '山门长明',
  'app.subtitle': 'A single-player cultivation sect · Browser game',
  'app.phase': 'Foundation · Phase one',
  'app.status': 'Deterministic simulation, saves and interface foundations are being built.',
  'app.hint': 'This is a development preview. Full gameplay is not available yet.',
  'app.scene.label': 'Illustrative mountain gate',
  'app.scene.caption': 'A light endures among the mountains',
  'app.next.title': 'Next, bring the sect to life',
  'app.next.description': 'First connect world creation, production commands, time progression and save recovery. Sect life will follow.',
  'app.foundation.label': 'Foundation preview',
  'app.foundation.detail': 'Live sect state will appear here once gameplay is connected.',
  'settings.language.label': 'Language',
  'settings.language.zh-CN': '简体中文',
  'settings.language.en': 'English',
  'settings.language.switch': 'Change language',
  'errors.translation.unavailable': 'Text is temporarily unavailable',
  'world.disciples.summary': {
    plural: {
      parameter: 'count',
      one: '{count} disciple is cultivating at the mountain gate.',
      other: '{count} disciples are cultivating at the mountain gate.',
    },
  },
  'disciple.welcome': 'Welcome {name} to the sect.',
  'cultivation.progress': 'Current cultivation progress is {progress}.',
  'production.remaining': {
    plural: {
      parameter: 'seconds',
      one: 'Production will finish in {seconds} second.',
      other: 'Production will finish in {seconds} seconds.',
    },
  },
  'resource.amount': 'You currently have {amount} of {name}.',
} as const satisfies Readonly<Partial<Record<TextKey, MessageTemplate>>>;
