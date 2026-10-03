# Responsive management map viewport

Status: implemented locally for integration review; automated checks and real browser acceptance are pending. This note is not a passing test record or a publication claim.

## Scope and problem

The v9 map-first page uses a wide, height-capped panel. A fixed 1152×768 Phaser FIT canvas inside an approximately 1110×420 panel renders at roughly 630×420, leaving large side bands. Making the CSS panel 3:2 would instead make it roughly 740px tall and undo the first-fold improvement.

Only `ManagementAppV9` opts into the responsive viewport. The ordinary v7, campaign candidate and private v10 callers continue using the fixed FIT renderer and existing defaults. No simulation, map, navigation, save identity, authority, placement command or persistence contract changes.

## Presentation contract

- Keep the world 1152×768, tile 64 and origin (128,68). Sprites, terrain, footprints, selection identities and `pointer.worldX/worldY` placement use their existing world coordinates.
- Phaser RESIZE owns the opted-in canvas dimensions. The CSS height caps remain unchanged. No CSS stretching, externally cropped oversized canvas or new map-drag behavior is used.
- A pure `sect-viewport.ts` helper converts the logical 0.85–2.2 zoom range into camera zoom. Normal 1.1 uses the panel-filling scale; higher levels are proportional. From 0.85 to 1.1 the camera scale interpolates continuously from complete-world overview to fill.
- At minimum zoom the entire world is visible with a modest margin. Background around the world is intentional in overview; default fill eliminates the old unused side bands. The map cannot simultaneously fill a wide/short viewport and show its entire original aspect ratio.
- When the visible camera area exceeds the world at overview, symmetric presentation-only camera bounds keep the world centered. These bounds are never passed to simulation or used to invent map cells.
- Resize recalculates viewport scale and clamped view center from the retained world-space target. Newly selected off-screen objects center at default zoom as well as the old high-zoom case. Artwork extents, rather than just ground points, are checked. Resize/zoom can reveal an existing off-screen selection; reset deliberately returns to the central default view.
- Phaser 4.2.1 already checks its parent bounds and window resizing. The scene subscribes to its resize event; both resize and input listeners are removed alongside the existing source subscription. A hidden/invalid size preserves logical zoom and the world-space camera target. Phaser may already have collapsed the actual canvas and camera to zero before the scene listener runs; the next valid resize reapplies the retained intent and restores the viewport. The last rendered frame is not promised to remain visible while hidden.

## React/renderer consistency

The opted-in component and renderer share the same initial/reset zoom and logical limits. A ref records zoom intent immediately, so rapid button presses before the lazy import resolves are replayed at mount. Commands issued while Phaser preloads are also retained. Source replacement uses the current logical zoom; cleanup prevents an abandoned import from creating a renderer. Legacy callers retain their former FIT/default-zoom branch.

The controls remain ordinary DOM buttons with existing labels and focus styles. No renderer action takes keyboard focus or changes Session selection/pause state. DOM object lists and coordinate inputs remain available alongside Canvas.

## Authored checks, not yet executed

- `tests/phaser/sect-viewport.test.ts`: fill and overview across desktop, mobile and short-wide dimensions; effective monotonic zoom steps and continuity; target/clamp behavior; invalid size handling; artwork visibility margins.
- `tests/phaser/sect-renderer-lifecycle.test.ts`: opt-in dimensions and legacy FIT branch; resize/zoom/reset; recovery of logical zoom and target after preceding Phaser canvas/camera collapse to zero; preload and abandoned import; source replacement and rapid React-control intent; off-screen focus; unchanged world-coordinate placement; idempotent source/input/resize cleanup.
- The Phaser and hook harnesses are contract checks. They do not validate actual WebGL/Canvas rendering, Phaser pointer transforms, browser focus or React DOM behavior.

## Integration owner's required acceptance

1. Run focused viewport/lifecycle and existing management renderer/navigation tests, both typechecks, boundaries/content checks and build. Record actual results separately.
2. Inspect real screenshots at 1174×750 and 1920×1080, 400/500px effective widths, a short landscape viewport, and 150% browser zoom. Confirm the map stays height-capped, fills its default frame, and controls remain visible and keyboard reachable.
3. In the real Canvas, select top/bottom/edge objects from both the map and DOM lists. Resize while selected, exercise every zoom button and reset, and confirm labels and selected artwork remain discoverable without relying on nonexistent dragging.
4. Reach overview and pick all four corner cells with the real pointer. Verify selected placement coordinates and preview match actual cells before confirmation. Check normal sprite selection still works outside placement mode.
5. Check locale changes, rapid clicks during initial load, source replacement, repeated mount/unmount and narrow→wide→narrow transitions. Verify no duplicate handlers, unexpected source mutation, pause changes or focus theft.

Canvas pixel area increases because the previously unused bands now render. No claim about real-device GPU performance, mobile touch accuracy, long-session memory or published readiness is made until measured.

## Integration checkpoint — 2026-10-03 03:28 UTC

Both strict type checks and module boundaries passed. The first three focused
geometry/renderer suites passed 63 tests; after correcting the hidden-host mock
and wording, the same final suites passed 63 tests in 2.30 seconds. The broader
eight-file presentation/entry/navigation/renderer lane passed 119 tests in
6.30 seconds. Content and 1205 locale-key validation plus the enabled v8/v9 Pages
production build passed. Independent source review found no blocking regression;
actual label/entrance-marker bounds, hidden-host recovery, pointer transforms and
GPU cost remain explicit browser checks. This candidate has not been published
or accepted in the real browser yet.

## Published, limited real-browser checkpoint — 2026-10-03 04:43 UTC

Commit `ac6c99074470d9240ed45e592edd5a21d8a7ed0c` completed Actions
`37093603594` and Pages deployment at 04:31:19 UTC. Validation passed 199 files,
4140 tests in 3415.03 seconds and both production builds.

In a separate fresh, paused cloud-browser v9 session, the desktop Canvas backing
size matched its CSS box (1122 × 423). Zooming out revealed the whole map;
selecting the northern spirit node from the DOM list brought it into view.
After resizing the native browser to a 485-pixel document viewport, the Canvas
matched its CSS box at 459 × 425. Document scrollWidth and clientWidth were both
485, with no horizontal page overflow. Resetting the view worked; clicking the
visible mine in the real Canvas selected the mine's pressed DOM button.

This is bounded desktop/narrow-window evidence, not real-phone acceptance.
Placement corner accuracy, hidden-host recovery, rapid initial-load controls,
1920-pixel/short-landscape/150% variants and actual-device GPU cost remain open.
Existing saved slots were not loaded or overwritten for this check.
