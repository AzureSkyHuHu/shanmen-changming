# Private v10 management component

Date: 2026-10-02. This stage introduces an injectable React component, not an entry, storage route, migration controller, public release or browser acceptance result. The integration owner alone runs validation and decides activation. Active-work runtime performance continues to block public v10 activation.

## Owned files and boundary

- `src/app/ManagementAppV10.tsx`
- `src/app/management-v10.css`
- `tests/application/management-v10.test.tsx`
- This document
- One specifically authorized shared type addition: `upgrade` in `SectVisualWork.kind` in `src/phaser/sect-renderer-contract.ts`. Renderer consumers use progress/blocked facts and contain no exhaustive kind switch. No previous visual behavior was changed.

The component receives a narrow `ManagementSessionV10` port. It never exports or constructs a World, casts a v10 World or Session to v9, opens IndexedDB, selects a save version, activates an HTML route or imports a legacy save controller. It reads the four fixed Session DTOs. Pure v9 resource/name helpers and build-domain validators are reused where the underlying catalog/build identity is intentionally unchanged; no v9 Session or snapshot is passed to a v9 action controller.

## Actual controls

- Existing six base recipes and all five v10 sect recipe DTOs, with available resources and actual station eligibility
- Both basic-medicine and herbal-compatibility research, real blueprint placement, construction start/cancel
- Alchemy L1 → L2 Session-issued preview/confirmation, current work progress, recorded material checkpoints, actual cancellation and terminal consumed/released summaries
- Base and no-grain alternative wound-powder recipes, actual production site/source/upgrade references, actual care dose provenance and before/after injury
- Current paid maintenance period/rate separately from next costs, due time, deficits and blockers; no invented maintenance-resume operation or back-charge
- Selected disciple training modes, standard/forced breakthrough and array preparation, exact risk/cost preview, reservation/begin/cancel/resolve, lifespan finalization acknowledgement, heir choice, current teaching information
- Pinned permanent-build progress, skill learning, owned equipment/skill loadout drafts and node respec with real content validation; player pause is required before editing
- Real map/roster/blueprint selection, numeric placement/rotation and pointer placement, resource ledgers, active jobs and bounded terminals

The renderer presents upgrade work as upgrade work, tied to the same owner ID and worker. It does not relabel an upgrade as construction. It copies/freeze only presentation data and uses no complete-save export.

## Review ownership and stale-state discipline

A single component-local review controller owns a pending intent by object identity. Every event rechecks Session epoch, source revision/world revision, runtime generation/publication stamp, resource stamp, selection, storage/read-only/stopped state and applicable pause conditions. A copied review is rejected. Session-issued placement/upgrade/breakthrough proposal identities are retained and checked at confirmation; catalog/query eligibility is never dispatched as authority.

Review ownership is consumed synchronously before dispatch or an awaited hold release. Ordinary command confirmations release only the UI review claim, await the scoped cleanup microtask, then recheck the same source and the expected single hold-release revision. Teardown increments lifecycle ownership and prevents pending callbacks from dispatching. Requests are detached and deeply frozen before review. A query failure releases its hold and produces a failure notice rather than success.

Review and overlay claims are reference-counted per Session. Old teardown during storage-busy cannot clear a newer dialog. Pending cleanup runs outside Session publication, subscribes only while necessary, and never removes storage/player/hidden/domain pause owners. Replacement and selection changes invalidate reviews; growth/build editors are keyed by epoch and selection so their drafts cannot migrate to another person.

Saved hidden pause is preserved during mount, visibility return and Session binding. Only explicit resume calls `setPaused('hidden', false)` and `setPaused('player', false)`. Other domain pauses and capacity stops remain intact. The page owns one RAF loop and removes its visibility/focus listeners; it does not close an injected Session.

## Preview policy versus recorded facts

Upgrade previews display their exact costs, halfCosts and remainingCosts and clearly describe the contractual 200/400 effective-work checkpoints. Live upgrade jobs additionally render `job.checkpoints`, copied from authenticated records by the fixed runtime selector. A checkpoint's consumed lines and simulated tick come from that DTO, never inferred from `activeTicks`. Terminal consumed/released lines come directly from the upgrade terminal DTO. No refund amount is projected from an assumed future completion.

Recipe sites are labelled candidates. Actual site/source information is displayed only from a real production job or care dose DTO. An L2 building's current paid period may still correctly show L1; the next maintenance amount is read from the separate DTO field. The component does not modify immutable construction origins or choose a medicine source that has not been recorded.

## Storage integration slot

An optional `ManagementStorageSlotV10` supplies a subscribed real status and rendered controller-owned body. The native dialog retains the fixed heading/close control, scroll body and feedback footer. The entry/controller remains responsible for lifecycle, storage leases, dirty status, actual save outcomes, exact import acknowledgements and explicit migration backups.

Without that injected slot, the component displays a disabled save control and explicitly says no v10 save/import/conversion controller is connected. It does not simulate saving or conversion, claim persistence, automatically rewrite v9 or provide a fake migration callback. The previous entry and both v9 slots remain outside this component's ownership.

## Localization and presentation

All additional text has stable `managementV10.*` keys, exported component-local Chinese and English catalogs and exact parameter schemas. They use the existing validated `createTranslator`, including Chinese per-key fallback. Existing global keys remain unchanged. Local catalog validation is included in the component test; these private keys are not silently claimed as centrally registered.

The component composes existing jade/paper/brass CSS, compact resource ledgers, long-page anchors, measured sticky toolbar height, narrow layouts, reduced-motion rules, fixed save header/footer and 44px-equivalent controls. Reviews move keyboard focus to a visible confirmation and restore the connected opener when still appropriate. Native buttons handle Enter; Escape cancels review or the current non-busy save dialog. The dialog traps Tab and has a scrollable body. These are implementation properties, not evidence that real browser geometry has passed.

## Written tests and honest gaps

Focused tests cover SSR without World export/mutation, catalog fallback/schema checks, precise stale fences, actual placement one-shot confirmation, a rejected upgrade query without dispatch, copied/stale ownership, frozen ordinary requests, teardown during deferred confirmation, scoped-hold cleanup during storage busy, explicit hidden/player resume with other pause owners preserved, DTO-only checkpoint/refund presentation, actual upgrade work renderer ownership, available-stock arithmetic and source boundaries.

The component author did **not** run tests, TypeScript, build, Git, browser or benchmarks. Root must run and record results before treating the stage as validated. UI branch fixtures are explicitly synthetic presentation fixtures and are never admitted or saved; they do not prove the full real alchemy chain.

Remaining integration/acceptance:

1. Actual v10 storage/controller and explicit v9 copy-conversion body are not implemented by this component
2. No route is activated, and no public or private candidate URL is claimed
3. Real browser keyboard/Canvas/scroll/modal review, Chinese/English 150% and narrow-screen checks remain required
4. Real complete upgrade/cancel/checkpoint/save-reload, alternative medicine/dose-source, L1-paid → L2-next maintenance journeys remain required at the integrated entry
5. Growth/build controls use the real domain ports, but this new v10 presentation has not repeated the published v9 browser journey; catalog equipment/skill descriptive copy is more compact than the v9 panel
6. No new equipment acquisition, teaching start, automatic planning, relocation, expedition or speed-3 activation control is introduced
7. Runtime active-work performance, mobile hardware and long-duration acceptance are still unverified/blocking

## Independent review corrections (2026-10-02 23:10 UTC)

An independent review identified and this component stage corrects:

- Build confirmations now render the exact frozen review's before/after skill and owned-equipment changes, including distinct identical-definition copies. Tree confirmations list full before/after node sets and added/removed nodes. A cleared editor draft cannot make confirmation blind, and newer selected state is not used to rewrite the shown comparison
- Active build drafts have their own Escape handler, blocked by modal/storage/review ownership. Discard consumes local draft ownership and restores a connected, enabled staging control only while the same editor/selection still owns focus
- Review focus is explicitly captured from the triggering control. A placement refresh retains its original focus-scope identity, so coordinate, building-type and rotation edits do not refocus/scroll the confirmation after every keystroke. Focus restoration checks epoch/selection, modal state, current review ownership, connection and disabled state; it does not steal focus from another interaction
- Proposal confirmation rechecks lifecycle and the complete live guard after its synchronous `publish(null)`. A subscriber that stops the controller, changes selection or changes readonly state cannot use the consumed review as permission to dispatch
- Care buttons again explain healthy, occupied, unavailable and no-medicine states through a stable `aria-describedby` target, preserving the explanatory region before any optional result content
- Cultivation and build rejection codes retain their existing localized messages. Upgrade-specific rejections now have meaningful localized explanations instead of only raw code fallbacks

Added deterministic tests cover synchronous subscriber mutation for each proposal race, unchanged placement focus scope, draft Escape/modal/focus ownership, frozen loadout/tree/equipment comparisons, care accessibility/explanations and message mappings. These additions have not been run by the component author. The prior 14-test stage was reported passed by the root integration owner; this patch requires a new root validation pass and real browser focus/layout checks remain pending.

Narrow follow-up hardening: queued review focus cleanup also requires the latest injected Session object's identity to match its captured owner, even when a replacement instance has identical counters/selection. Both equipment dropdown and confirmation now share one per-definition copy-label helper, avoiding inconsistent copy numbers in mixed-definition inventories. Added bounded tests for both; still awaiting root execution.
