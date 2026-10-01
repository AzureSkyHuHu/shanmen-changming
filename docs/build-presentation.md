# Permanent paths and loadout panel

Implemented 2026-10-01 as an independently mountable React panel. Files owned by this task: `src/app/BuildPanel.tsx`, `src/app/build-panel.css`, `tests/build-presentation/**`, and this document. App/session integration and localization registry merges are owned by their respective integration workers.

## Props and command contract

`BuildPanelProps`:

- `frame: BuildStateFrame` is recursively readonly and accepts the session's detached DeepReadonly snapshot
- `catalog: CombatContentCatalog` must be the exact catalog used for World.builds; current integration uses `EXPEDITION_COMBAT_CATALOG`
- `discipleId`, `locale`, optional localized `discipleName`
- `readOnly?: boolean` covers storage/core mode restrictions; `locked?: boolean` covers outer expedition restrictions; the actual disciple BuildState lock is always honored
- `nameFor?: (definitionId: string) => string | undefined` may override localized definition labels. Missing values or a resolver echoing the raw ID fall back to the standard combat catalogs
- `onCommand: (request: BuildPanelRequest) => { ok: boolean; code?: BuildError }` reports the real synchronous session/reducer result

`BuildPanelRequest` is the distributive `Omit<BuildCommand, 'commandId'>`. It retains `expectedRevision` and only permits `tree.respec`, `loadout.set`, and `skill.learn`. The session allocates command IDs; the panel never allocates IDs, gives points/credits/items, sends authority commands, advances simulation or mutates frame data. False callback results leave authoritative displays unchanged. A successful callback disables mutation while waiting for a changed authoritative revision; it does not optimistically install nodes, equipment or learned skills.

The panel only scans the current disciple, owned equipment and award ledger for its numeric summary. It does not call the standalone semantic-history replay validator on every React render. World save/state validation remains authoritative. The complete readonly frame is accepted for the reducer and ownership contract; the display never serializes it into the DOM.

## Tree and draft behavior

Four school buttons browse all existing catalogs. Only the disciple's native tree is editable, matching the existing build/expedition rules. Each tree has three clearly labeled branches and three ordered tiers. All nine authored names, descriptions, one-point costs and prerequisite names remain visible. Unsupported content has a readable blocker and is never substituted.

Node clicks alter a local whole-allocation draft only. Adding requires prior tiers and earned capacity. Removing an earlier node also removes its dependent descendants from the draft. The separate confirmation shows proposed count and added/removed totals, and submits the complete allocation at the captured revision. Earned/allocated/available counters continue to show authoritative state. There is no point-grant control.

Only one kind of transaction can be drafted at a time: tree or loadout. Other mutation controls are disabled until that draft is applied or discarded, preventing an unrelated accepted command from silently dropping another draft. Any newer authoritative revision invalidates an existing draft; the player must explicitly discard/reload it. Drafts are never silently rebased onto the new frame. Player-facing notices explain stale, readonly, locked and pending conditions.

## Learned skills and loadout

The panel distinguishes all permanently learned skills from the currently equipped two actives and one passive. The fixed school basic attack is displayed separately. Ultimates appear in an ordinary active selector, never in a separate extra slot. Selectors contain only learned, supported, native-school skills whose requirements are met. Choosing in a selector updates a labeled loadout draft and requires explicit confirmation.

The school skill library retains supported and unsupported definitions. Study buttons show actual credit prices, remaining earned credits and named prerequisite skills. Study is disabled without credits, prerequisites, runtime support, or permission to change the disciple. Learning only sends `skill.learn`; it does not auto-equip. Browsing another school's library explains that off-school knowledge can be studied permanently but cannot be equipped by this disciple's current school.

Weapon/robe/artifact selectors contain only exclusively owned compatible item instances. Duplicate instances are labeled with their real localized prototype name and a local copy number, never a raw technical ID. Declared gear bonuses are shown as such. The panel does not synthesize drops or bonuses. Draft selections are explicitly labeled as proposed; permanent equipped badges use only the authoritative frame.

## Localization and presentation

The handoff `/tmp/build-presentation-locales.json` contains 111 `buildView.*` entries in zhCN/en plus parameter specifications; its test fixture is kept under `tests/build-presentation`. The integration owner merged these keys into the main registries. Existing skill/tree/node names and passive/node descriptions use the established combat locale catalogs and `createTranslator`, with no dependency on Phaser or another UI component.

Active-effect summaries have separate localized UI keys because authored combat descriptions append ticks. Numeric cost, cooldown and wind-up are read directly from actual SkillDefinition values; time is divided by `COMBAT_TICKS_PER_SECOND` and displayed as seconds. Runtime support errors are translated into plain descriptions of unavailable movement, persistent areas, summons, staggered chains, duration handling or uncertified content. Technical error strings and IDs are not rendered as visible text.

The visual treatment uses warm parchment, muted jade, ochre seals and thin branch connectors. Wide containers show three branch columns; narrow inspector containers show stacked branches with compact node rows. Native buttons/selects/details support keyboard use, visible focus, true disabled states, text labels and selected states. All buttons explicitly have `type="button"`; there is no implicit form submission. A second event-boundary guard rejects readonly/locked/stale, foreign-disciple and authority-shaped requests before invoking the session. Reduced-motion preferences suppress nonessential transitions.

## Validation scope

Tests cover static output for all four native trees, actual point/credit projection, gear ownership, slot labels, unsupported explanations, timing conversion, localized names, no visible technical IDs, input immutability, prerequisite draft behavior and guarded command dispatch. These tests do not exercise a real browser layout or prove visual acceptance.

The parent owns all test/type-check/build execution. Actual browser screenshot and interaction QA remains blocked by the existing preview login restriction. Do not label this panel visually accepted until narrow/wide screenshots, keyboard-only draft/apply/discard, stale revision, locked expedition and real session updates have been tested in an accessible browser.
