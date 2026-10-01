# Permanent BuildPanel v2 adapter

2026-10-01. Additive presentation change; the parent owns App/Session wiring, all test/type/build runs, and browser interaction/screenshot verification. This document does not establish a shipped v8 or browser acceptance.

## Session/App contract

Keep the existing `BuildPanel` call and its `key` scoped to both Session epoch and selected disciple. `frame` now accepts `BuildStateFrame | BuildStateFrameV2`; player command bodies are unchanged. Pass:

- `frame`: the already validated, detached authoritative build frame
- `catalog={session.getCombatCatalog()}`: the exact selected World catalog, not the active old run's catalog
- `context={session.getBuildContentContext()}`: `getWorldBuildContentContext(world)`/registry-resolved context for v2; `null` or omission for v1
- `lifeState={buildDisciple?.lifeState}`: the actual World `alive | pendingDeath | dead`; explicit `undefined` and `null` are accepted
- Existing `readOnly`, `locked`, selected ID, locale/name and synchronous `onCommand` behavior

For v2, only explicit `lifeState="alive"` permits editing. Missing life state is readonly. V1 callers that omit it preserve previous behavior, but an explicit deceased/pending state blocks both DOM controls and the callback boundary. A retired v2 record cannot be edited even if a caller mistakenly supplies `alive`: the panel displays its historical skill names without inventing a surviving loadout.

The `onCommand` result now accepts `BuildErrorV2` as well as legacy errors. It still receives only `tree.respec`, `skill.learn`, or `loadout.set`, with the captured build revision and without any command ID. Session allocates IDs and rechecks actual current World rules, life state, loadout locks and ownership. The panel cannot grant rewards, transfer property, retire/enroll disciples or teach archive knowledge.

## Content verification and display

V2 fails closed without context or when its identity, rules hash, catalog or legacy references disagree with the registered selection. No supplied or inferred item/rule catalog is installed, and a missing context never falls back to six training items. The trusted lookup is cached by the registry's immutable rules object, so re-created Session context wrappers still avoid full-catalog hashing on every render. Subsequent checks compare object references and compact identities. There is no build semantic-history validation, replay, sequence allocation, or history/receipt/origin scan in render.

Equipment ownership uses the v2 `owner` union, never acquisition strings, item names or instance-ID patterns. Only actual disciple-owned, school-compatible, slot-compatible items are listed. Sect-estate and other disciples' equipment are excluded. Inherited equipment owned by an expedition-locked heir may appear as an option, but the equipped selection remains the authoritative locked loadout and all changes stay disabled.

Lesson credit costs, prerequisite skills/nodes, supported definitions, school list, equipment slots and maximum allocation come from the selected context rules/catalog. Permanent archive and teaching knowledge remains learned and costs zero study credits according to its recorded acquisition; it is not silently equipped. The render summary only scans the selected disciple and awards.

Campaign equipment definitions retain their registered `nameKey` and `descriptionKey` through the registry; the panel uses those exact fields. The existing six training item labels have an explicit ID-to-key presentation mapping. Existing campaign descriptions already express the extra resistance/healing/shield stats and slot tradeoffs; no synthetic stat-name guessing or additional locale entries are needed.

## Local drafts and repeated events

The existing whole-tree and whole-loadout drafts, explicit apply/discard controls, immutable snapshots and stale-revision notice remain. A newer revision makes an old draft stale; it is never rebased. Panel editor state is keyed by selected disciple and content identity; App must continue its Session-epoch key so a replacement world with the same IDs/revisions does not reuse draft state.

`createBuildPanelController` is a pure UI request latch used by the component and independently testable. It synchronously blocks reentrancy and duplicate clicks before React rerenders. A successful callback waits for a new authoritative basis. An identical rejected intent is dispatched once per basis, while a different corrected intent can be attempted. A thrown/malformed callback is treated as uncertain and blocks further submissions until authority changes. All accepted requests are cloned. Event callbacks submit against the latest props, and stale handlers from an unmounted editor cannot submit.

## Verification requested

Run both TypeScript projects, existing `tests/build-presentation/**`, new `tests/build-panel-v2/**`, then the aggregate suite/content checks/build. New fixtures use real v2 authority/player reducers for gear grants, retirement/estate transfers, locked heirs and knowledge acquisition. Negative display fixtures cover mismatched context/rules/identity and no-history access. Browser QA must still exercise the mounted UI at narrow/wide widths, keyboard draft/apply/discard, fast repeated clicks, newer revisions, context/selection replacement, rewarded gear, retired/pending/dead members, and locked inheritance. Static markup and controller tests cannot certify that visual/interaction pass.
