# v9 bounded management renderer

The bounded renderer is integrated with the management Session and UI. Current check results, full-regression status, publication status and browser gates are recorded in [the integration status](v9-management-integration.md). Adapter coverage is not browser acceptance or a performance claim.

## Scope

- A renderer-only contract replaces Phaser's dependence on an entire legacy Session projection. It contains base terrain, visible characters, the existing point-based stations, selection, the simulation tick, effective pause, visual work, expansion objects, and an optional local placement preview.
- The legacy adapter retains the old assignment lookup, stable authored character presentation/fallback, legacy station selection, pause/tick-driven poses, and old texture keys. Both `mountSectWorld(parent, session, locale)` and `<PhaserWorld session={session} locale={locale} />` remain structurally accepted.
- A separate v9 adapter consumes only `RuntimeFrameViewV9` and `RuntimeExpansionViewV9` plus Session-local selection and effective pause. It neither calls a full World snapshot/export API nor manufactures a `SessionProjection`. It never writes an expansion job ID into `assignmentTransactionId`.
- Actual v9 `workOwners` determine visible progress, matched by domain, owner ID, and worker/patient ID. Missing, ambiguous, mismatched, or terminal owners yield no work bar. Construction progress additionally requires the actual blueprint/job relationship.
- New entities are separate `blueprint` and `sect-building` selections, never fake legacy buildings. The eight original `BUILDING_ART` entries and all original assets are unchanged.
- Planned footprints use dashed soft cells, active construction uses a timber scaffold, and completed buildings use distinct original Graphics: books and a teal roof for the library; cauldron and a warm roof for alchemy. Entrances use actual footprint coordinates, levels are visible on alchemy, and non-operational buildings receive both a slash and reduced opacity. No missing texture is referenced.
- A separate translucent placement overlay displays the real advisory footprint/entrance and allowed/rejected state. Rejection also uses an X, so color is not the only cue. This layer does not alter map walkability or imply a submitted blueprint.
- Renderer subscriptions are disposable; removed entities destroy their containers, pointer handlers leave with their owners, the scene's placement listener is removed on shutdown/destroy, and renderer destruction is idempotent. Legacy battle rendering/control is outside scope and untouched.

## Exact application glue

The adapter exports `createManagementV9RendererSource(port, options?)` from `src/application/management-v9-renderer.ts`.

The structural port is:

```ts
interface ManagementV9RendererPort {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly frame: RuntimeReadonlyV9<RuntimeFrameViewV9>;
    readonly expansion: RuntimeReadonlyV9<RuntimeExpansionViewV9>;
    readonly selection: SectRendererSelection;
    readonly paused: boolean;
  };
  select(selection: SectRendererSelection): void;
}
type SectRendererSelection = null | {
  readonly kind: 'disciple' | 'building' | 'blueprint' | 'sect-building';
  readonly id: string;
};
```

`ApplicationSessionV9` implements this structurally without importing Phaser or renderer types. Its fuller immutable snapshot and returned selection-control result are compatible with this read-only subset. The Session publishes frame and expansion from one boundary; this adapter is not a validation or admission gate.

Use a stable source for the lifetime of the Session:

```tsx
const source = useMemo(() => createManagementV9RendererSource(session, {
  onPlacementCell: cell => updatePlacementCoordinates(cell),
}), [session]);
<PhaserWorld source={source} locale={locale} />
```

The source also exposes `setPlacementPreview(preview | null)`, where preview is `{ anchor: {x,y}, footprint: {cells, entrance} | null, allowed: boolean }`. Supply the bounded footprint/allowed fields of the actual Session placement proposal and its request anchor. Rotation is reflected by the proposal's cells and entrance. Inputs are copied, not frozen or mutated; footprints are limited to four cells. Equivalent preview updates do not notify subscribers again.

While a preview is present, an in-map Canvas pointer click calls `onPlacementCell({x,y})` and suppresses ordinary entity selection. The callback only edits form coordinates. It must not place a building or dispatch a command; UI performs a fresh proposal and separate explicit confirmation. No hover-driven preview computation is installed. Set preview to null on close/cancel or when placement mode ends to restore ordinary selection. Coordinate/rotation controls and equivalent selectable lists remain the UI's responsibility.

## Files

Contract, adapter and tests:

- `src/phaser/sect-renderer-contract.ts`
- `src/application/management-v9-renderer.ts`
- `tests/application/management-v9-renderer.test.ts`
- `docs/v9-renderer-stage.md`

Renderer integration:

- `src/phaser/create-sect-game.ts`
- `src/phaser/PhaserWorld.tsx`

The renderer layer does not own Session, entry, UI, codec or persistence behavior. It leaves original content/assets and legacy battle control unchanged.

## Verification and pending gates

The focused renderer typecheck and tests passed; exact counts and timings are recorded centrally in the integration status. This is adapter coverage, not completed browser acceptance.

Unit cases are provided for bounded field extraction, detached immutable output/non-mutated input, authored faces and positions, all five owner domains, invalid owner relationships, planned/started/completed overlays, exact entrances/maintenance/level, no fake legacy stations or modified terrain, pause truth, legacy source and React prop compatibility, source caching/selection, disposable subscriptions/late notifications, advisory preview copy/bounds/deduplication, and in-map pointer coordinates. Synthetic DTO mapping scenarios do not claim a valid authoritative construction journey.

Complete-check outcomes are tracked in the integration status. Real Phaser/Canvas evidence is still required: both completed silhouettes; planned versus started versus rejected preview; rotated entrances; actual owner progress/blocked/paused states; selecting each entity kind; coordinate clicks under desktop and mobile zoom; close/cancel restoring entity clicks; repeated mounts/unmounts and legacy battle round trips; locale changes; and no missing textures. Screenshot and interaction inspection cannot be replaced by the provided unit tests.

The exact build flag can include the isolated management entry; compilation alone does not establish publication or acceptance. Full journey, save/resume, replay/capacity gates and real browser acceptance belong to the combined candidate.
