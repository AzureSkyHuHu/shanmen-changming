# Compact management workspace

2026-10-03. User requested integration of the overlong interface. Applies to
`management.html` (v9) and the existing, still-gated private v10 component. This is
a presentation change, not approval to open v10 or alter any saved game.

## Observed baseline

Reviewed the actual desktop and narrow screenshots from the preceding layout
pass. The map had moved into the first screen, but roster, cultivation, builds,
production, jobs, research, care and maintenance still formed one long document.
The earlier collapsed navigation only jumped within that stack.

## Current implementation

- Desktop: persistent map and one selected detail category in two columns. The
  detail area is independently scrollable at a height measured from the actual
  wrapped header. Important content is scrollable, never line-clamped or clipped
- Narrow / 150%-zoom-sized windows: one selected surface, with horizontally
  scrollable, keyboard-operated tabs. Overview shows the map; other tabs show
  their category. Construction retains a compact map above placement tools so
  coordinate picking stays available during the pinned review
- Compact single-row resource strip with the complete available/reserved/capacity
  ledger in an explicit disclosure. Candidate help stays in its existing
  disclosure. Save status, read-only state, storage errors and stop messages remain
  outside hidden categories
- All categories retain labels. Counts expose disciples, pending cultivation
  decisions, active work, blueprints and placed buildings. Construction now
  contains placement and blueprint-start/cancel controls; research is separate
- Worker selection appears with production, research and construction (and v10
  upgrade), rather than being stranded in a hidden production category
- Map entity selection can open the corresponding detail from overview/roster.
  The same renderer, camera, source, Session and editors remain mounted on tab
  changes. The UI does not export World, issue commands, or manipulate pause
  reasons to navigate

## Interruptions and keyboard behavior

- Active placement/cultivation reviews pin navigation through their existing
  Session hold. The v9 build editor reports its own confirmation visibility to
  the shell using an optional UI callback; it does not acquire a new Session hold
- Cancel, confirm, remount and unmount release only that build UI flag. It is
  combined with other review ownership, not written over another component's
  hold. Normal drafts survive tab changes
- Hidden build/cultivation editors do not listen for global Escape. The selected
  editor retains its existing Escape and focus-restoration behavior
- Pending domain decisions have a persistent count and direct cultivation
  destination outside the selected category. They remain visible while another
  review is being resolved
- Activating a focused roster button transfers focus to the newly visible detail
  panel after commit. The explicit opener owns this one-time transfer; map
  clicks, clock publications and later focus elsewhere never request it
- Manual-activation tabs use Left/Right and Home/End for focus. Enter/Space uses
  native button activation. A review-pinned tab remains focusable and explicitly
  unavailable, with an explanation linked to the tablist
- Narrow layout returns to ordinary page scrolling for the selected panel. It
  does not put long text into a fixed-height clipped box. Existing 44px controls,
  language keys and focused ink/brass outlines are retained

## Validation status and owner commands

Worker performed source/markup inspection only. Tests, typechecking, builds and
browser interaction are reserved for the integration owner and have not been
run by this worker.

Suggested focused lane:

```
npx vitest run tests/application/management-workspace.test.tsx tests/application/management-v9-navigation.test.ts tests/application/management-v9-cultivation-panel.test.ts tests/application/management-v9-build-panel.test.ts tests/application/management-v9-renderer.test.ts tests/application/management-v10.test.tsx tests/application/management-v10-storage.test.tsx
npm run typecheck
npm run check:boundaries
npm run check-content
npm run build
```

New deterministic tests cover every selected tab, pinned transitions, keyboard
indexing, one visible sect category, worker availability and non-mutating SSR.
Existing layout-only assertions were updated from anchor links and placement
accordions to the tab workspace. Existing domain/save assertions remain intact.

Required real-browser acceptance before claiming completion:

1. Desktop 1174×750 and 1920×1080; Chinese/English; 150%; 390px/485px narrow;
   short landscape. Check overall page height, tab discoverability, labels,
   internal detail scrolling and absence of horizontal document overflow
2. Mouse and keyboard tab changes, Left/Right/Home/End, Tab into panel, selected
   tab visibility after map selection, Canvas resize/hit testing after hide/show
3. Preserve build draft and selected character across tab round trips. Escape in
   another tab must not discard the hidden draft
4. Placement preview, coordinate editing, confirm/cancel/Escape, review-pinned
   navigation, cultivation risk acknowledgement and build-confirmation pinning
5. Pending breakthrough/death notice visible from every category, including
   after explicit save restore; open the associated decision without unpausing
6. Worker picker in research and construction, blueprint start/cancel, production
   start, jobs progress and cancellation; care and maintenance details reachable
7. Save overlay open/close/Escape, busy/read-only error states, focus return,
   language switch mid-review. Do not overwrite existing saved games for QA

DOM/source checks alone do not certify Canvas interaction, real phone input,
complete accessibility conformance, or game acceptance.

## Integration validation — 2026-10-03 06:08 UTC

The combined ordinary-App and management workspace snapshot passed both strict
type configurations, 17 focused files/271 checks in 28.59 seconds, three renderer/
modal files/47 checks in 0.597 seconds, and the actual entry-flow file/19 checks
in 2.19 seconds. Module boundaries, content and 1205 locale keys passed; default
and enabled-v8/v9 Pages builds passed. An initially requested entry filename did
not exist, so the actual tests/entry-flow/entry-flow.test.tsx was run separately.
The checked 24-file snapshot exactly matched integration source before this
document update. Independent source review accepted the focused roster transfer
fix and found no remaining static blocker.

These are pre-publication checks. Real viewport height/scroll reduction, Canvas
hide/show recovery, keyboard focus, draft retention and actual interactions remain
required after deployment. Public v10 remains disabled.
