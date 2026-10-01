export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** A complete sentence in each branch, not sentence fragments. */
export interface PluralMessage {
  readonly plural: {
    readonly parameter: string;
    readonly one?: string;
    readonly other: string;
  };
}

export type MessageTemplate = string | PluralMessage;
export type Catalog = Readonly<Record<string, MessageTemplate>>;
export type TranslationParams = Readonly<Record<string, string | number>>;

export type ParameterSpec =
  | { readonly type: 'string'; readonly format: 'text' }
  | {
      readonly type: 'number';
      readonly format: 'number' | 'integer' | 'percent' | 'seconds';
    };

export interface MessageSpec {
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
}

export type MessageSpecifications = Readonly<Record<string, MessageSpec>>;

export interface LocaleDiagnostic {
  readonly code:
    | 'unknown-key'
    | 'invalid-base-message'
    | 'invalid-translation'
    | 'invalid-parameters';
  readonly key: string;
  readonly locale: Locale;
}

export type DiagnosticReporter = (diagnostic: LocaleDiagnostic) => void;
