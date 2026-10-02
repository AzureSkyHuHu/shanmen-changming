# Bounded v9 management UI

This document describes the integrated management UI and its verification boundaries. Current check results, full-regression status, publication status and browser gates are recorded in [the integration status](v9-management-integration.md). Neither the candidate nor the full game has passed browser acceptance.

## Scope

`ManagementAppV9` requires explicitly injected `ApplicationSessionV9` and `ManagementSaveControllerV9`. It does not instantiate a legacy app, expose a World, register an entry, select a storage version, or change old v7/v8 identity. All render and React reads use the fixed bounded Session views. The existing title and jade/paper/brass visual style are reused without external assets or services.

The action surface includes the six unchanged base recipes; sustainable sect stone and spirit-stone production; library blueprint preview/start/cancel; basic insights and basic-medicine research; level-1 alchemy blueprint/construction; wound-powder production and actual storage delivery; and care for the selected patient. No herbal-compatibility action, upgrade, relocation, alternate medicine, expedition or new automatic-planning control is exposed.

Visible stock includes owned, available, reserved and capacity for six base and three sect resources. Tasks show actual owner/person, authoritative phase, effective work ticks, progress, current blocking reason and cancellation. Travel and delivery explicitly do not count as work, and produced inventory is not claimed before delivery. Construction cancellation warns that already-consumed materials are not refunded. The fixed DTO does not include per-job consumed/reserved subtotals, so none are invented.

Care displays the selected patient's current injury and the bounded care terminal's actual before/after injury. Standard breakthrough success and overall death risk are queried again when the selected person, cultivation revision, publication stamp or resource stamp changes; display immediately requires the current epoch/stamp/resource/selection and the Session-issued current proposal before an effect can refresh it; no breakthrough command is exposed. 25 → 5 is a journey test case, never a hardcoded expected outcome.

Maintenance uses authoritative operational/due/deficit/block fields plus immutable catalog costs. It explains automatic payment/retry and contains no invented resume control.

## Placement and event boundaries

Mouse and keyboard are equivalent: choose a building, numeric X/Y and 0/90/180/270 rotation, then start a real Session preview. The stable renderer source receives the copied advisory footprint/entrance/allowed view. Canvas tile clicks change only local coordinates and request a new read-only preview. Invalid previews remain visible. Enter activates native buttons; Escape cancels the local review. No pointer event constructs domain records or alters map terrain.

Placement review sets the Session's ephemeral review hold, preventing elapsed time from silently invalidating a confirmation. The UI captures epoch, selection and construction revision and asks `isProposalCurrent` immediately before `confirmPlacement`. A stale review is rejected, cleared and refreshed; it never silently confirms a replacement proposal. Review cancellation releases only its own scoped hold. App unmount removes only its own overlay/review claims; a per-Session coordinator waits until storage-busy ends and releases in a queued microtask outside Session publication. A newer mount/dialog claim supersedes an older deferred release. Completion/closed Session removes the temporary subscription. It never clears storage, player, hidden or stopped state.

All work-event handlers reread the current Session, recheck epoch/selection/relevant domain revision and current storage-busy/read-only/stopped state. Starts recheck worker availability; the runtime still supplies complete authoritative admission. Repeated clicks cannot rely on pre-command renders. UI admission is advisory, never a replacement for domain validation.

## Saves and lifecycle

The app owns one RAF driver and disposes RAF, focus and visibility listeners. It starts/stops the injected save controller. It does not close the supplied Session on React teardown, preserving service ownership for the entry/integration layer.

The controller's actual dirty/current-slot/read-only/manual-only status is shown. New progress is explicitly unbound until its first manual save. Returning to the same browser requires loading an existing slot. No autosave, silent resume, storage migration or new-slot persistence is claimed.

The native save dialog traps focus and restores the opener. Manual save, load, takeover, local file import and export use only the isolated v9 controller. Load confirmation binds the selected slot revision and Session epoch/world revision/selection. The captured revision is passed to the controller as `load(slotId, takeover, expectedRevision)`, which fences the actual repository before and after lease acquisition rather than trusting the cached list. Import acknowledgement binds file selection, destination revision and Session boundary; it explicitly covers replacement of unsaved progress and, when applicable, overwriting that slot. Controller checks remain authoritative. Export failures are caught and displayed; Blob URLs are owned/revoked by the panel. No direct IndexedDB or storage write appears in the UI.

## Localization and layout

115 additive `managementV9.*` keys are registered with Chinese/English entries and shared parameter schemas. Existing keys remain intact and use the same per-key Chinese fallback. Dynamic content keys are checked against the registry before translation. React inserts all text as text nodes.

The scoped CSS uses scalable `em`/`rem` text, wrap-safe controls, responsive single-column fallbacks, scrollable dialogs, 44px-equivalent control targets, visible focus, and reduced-motion rules. Numeric coordinates and selectable person/building/blueprint lists are keyboard alternatives to Canvas. Real 150% Chinese/English layout and Canvas interaction remain unverified.

## Test coverage and remaining browser gates

`tests/application/management-v9-view.test.ts` covers fixed supported action lists, existing recipe mapping, bounded SSR view/no writes, epoch/selection/domain/storage/read-only guards, available-vs-owned resource arithmetic, real repeated-click/worker occupancy behavior, typed rejection display, honest manual-only save status, Chinese fallback/parameters, and absence of World export or direct storage routes in UI sources.

Focused tests, typechecking and locale validation have passed as recorded in the integration status; complete repository results are tracked there, and the real browser journey remains a separate gate. Browser review should include pointer/numeric rotation, invalid footprint, review cancel/Escape, stale/double-click confirmation, construction mid-way cancellation, actual delivery and care, maintenance deficit/retry, manual save/load/reopen/import stale/overwrite behavior, zh/en at 150% and narrow/reduced-motion layouts. The integrated entry is enabled only by the exact build flag `VITE_ENABLE_V9_MANAGEMENT=1`; this does not establish publication or acceptance.

## Integration files

UI and contract files:
- `src/application/management-v9-contract.ts`
- `src/app/ManagementAppV9.tsx`
- `src/app/SectManagementPanelV9.tsx`
- `src/app/ManagementSavePanelV9.tsx`
- `src/app/management-v9.css`
- `tests/application/management-v9-view.test.ts`
- `docs/v9-management-ui-stage.md`

Localization additions:
- `src/i18n/messages.ts`
- `src/content/locales/zh-CN/index.ts`
- `src/content/locales/en/index.ts`

The UI depends on `session-v9.ts`, `management-v9-save-controller.ts`, `management-v9-renderer.ts` and the renderer's `PhaserWorld source` prop. Entry setup and service ownership remain outside the UI components.

## Integrated audit corrections

The following corrections are included in the final focused UI/controller/entry checks recorded in the integration status:

- Fixed a reviewed-load race by forwarding the captured manifest revision to the controller's repository fence. Added a real repository test where another writer changes the slot after the UI's cached review
- Fixed invisible overlay/review holds after unmount during asynchronous persistence. The scoped hold coordinator counts mount/dialog claims, defers through actual Session busy state and publication exclusivity, unsubscribes when done/closed, and leaves independent holds untouched
- Added actual async controller save/load/import teardown tests, newer-mount ownership tests, and closed-session unsubscribe coverage; these exercise the helper's real cleanup scheduling rather than only SSR
- Escape now attaches to the document only while a placement review is active, so a Canvas click followed by body focus does not lose cancellation. It respects storage-busy and save-overlay state and removes its listener on cleanup
- Risk display immediately rejects stale epoch/publication/resource/selection metadata and requires the actual Session proposal to be current before rendering; real queries refresh on publication

Browser QA should explicitly include preview → pointer click → Escape with body focus, unmount/remount while persistence is gated, load consent after another tab writes, and no stale injury/risk on replacement. These interaction checks remain pending.
