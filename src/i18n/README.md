# Chinese-first localization foundation

This is a small local-only TypeScript adapter for the initial project shell and
parameterized-message contract. It is **not** i18next, ICU MessageFormat, or a
completed translation library. The full game's content, campaign logs, combat
panels, and their visual language-switch acceptance checks remain future work.

## Public API

- `DEFAULT_LOCALE` is always `zh-CN`; supported `Locale` values are `zh-CN` and `en`
- `translate(locale, key, params?)` returns a plain string; `TextKey` is the
  registered stable key union. Render it as React children or a DOM text node
- `createTranslator({ baseCatalog?, englishCatalog?, specifications?,
  onDiagnostic? })` creates an isolated adapter, including for content tests
- `readLocalePreference(storage?)` returns a `Locale`
- `writeLocalePreference(locale, storage?)` returns whether the write succeeded
- Storage is an optional `getItem`/`setItem` port. Omit it for guarded browser
  localStorage access; pass `null` to disable persistence. Never let a failed
  preference write prevent an in-memory language switch
- `validateLocales(base, english, specifications?)` reports errors and English
  fallback coverage. `getLocaleDiagnostics()` returns copies of bounded local
  runtime diagnostics; no network, telemetry, or parameter values are recorded

The adapter has no imports from simulation or save code, no random generator,
and no tick or command authority. Only the separate
`shanmen-changming:settings:locale:v1` key is read or written. Browser language
does not override the explicit Chinese default. The UI owner is responsible for
rerendering its text when its locale state changes; this module does not reset
worlds, selections, offers, focus, or pending commands.

## Message contract

Add a stable key and shared parameter schema to `messages.ts`, then a nonempty
Chinese entry. Chinese coverage is mandatory for every registered key. English
entries may be missing, empty, or whitespace-only and will fall back one key at
a time. Malformed English entries are rejected by validation and recover to the
Chinese sentence at runtime. Missing/malformed Chinese or an unknown key yields
the safe Chinese message `文本暂不可用` and a diagnostic, never the internal key.
Runtime recovery does not make broken content valid for release.

Templates are complete sentences using `{namedParameter}` tokens. Parameter
names use ASCII letters initially, then letters/digits/underscores. Every
sentence/branch must use exactly the declared names; repeat occurrences are
allowed. Both locales use the same parameter type and unit schema:

| Format | Input | Unit / display |
| --- | --- | --- |
| text | string | Original custom name or plain text, unchanged |
| integer | safe integer | Number, no fractional digits |
| number | finite number | Number, up to three fractional digits |
| percent | finite number | Ratio: `0.125` displays `12.5%` |
| seconds | finite number | Seconds, up to three fractional digits; unit in sentence |

Numeric presentation uses native `Intl.NumberFormat` for the selected locale.
No values are clamped or written back. Plurals use an explicit object with a
numeric `parameter`, optional complete `one` sentence, and required complete
`other` sentence. Native `Intl.PluralRules` chooses the branch for the sentence's
actual language, including Chinese fallback. The currently supported languages
need only `one`/`other`; do not add new languages without extending validation.

The adapter intentionally does not support HTML, markup interpolation, nested
tokens, expressions, ICU syntax, grammatical gender/select, date formatting, or
literal braces inside authored templates. Parameter values are inserted once
with a replacement function and never reparsed. User names containing braces,
`$&`, angle brackets, quotes, or ampersands remain unchanged. React/textContent
must perform output escaping; **never** use the result as `innerHTML` or
`dangerouslySetInnerHTML`. No `eval` or content-supplied code is used.

## Initial shell keys

`app.title`, `app.subtitle`, `app.phase`, `app.status`, `app.hint`,
`app.scene.label`, `app.scene.caption`, `app.next.title`,
`app.next.description`, `app.foundation.label`, `app.foundation.detail`,
`settings.language.label`, `settings.language.zh-CN`, `settings.language.en`,
`settings.language.switch`.

The approved Chinese game title remains unchanged in the English display.
The other registered parameterized messages establish formatting contracts;
their existence does not imply implemented gameplay.

## Validation

Run `npm run validate:locales` (Node 24 native TypeScript stripping) and the
integration owner's test suite. Validation blocks missing Chinese, undeclared
catalog keys, malformed templates, undeclared/missing parameters, and invalid
plural parameters. Shared schemas define parameter types once rather than
duplicating potentially divergent locale metadata. Static `TextKey` checking
catches undeclared literal keys in regular UI calls; dynamically loaded content
must additionally register and validate its references when that pipeline exists.

The tests in `tests/i18n` cover fallback, unknown-key diagnostics, typed
parameters, 0/1/multiple plurals, fractions/percentages/seconds, React plain-text
escaping, independent preferences, failed storage, and unchanged frozen domain
input across two language switches. This is not evidence of live battle/offer
switching or 150% visual-text expansion; those require future UI interactions
and screenshot review.
