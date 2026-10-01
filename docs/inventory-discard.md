# Inventory discard and blocked-return recovery

## Scope

The prior return-capacity regression changed inventory directly to unblock a return. That proved an atomic-credit guard but did not prove a player could recover: an expedition decision owns a global pause, so normal production cannot consume its way out while return settlement is blocked.

The new path uses an explicit available-stock discard command. It does not delete reserved materials, consume expedition loot in escrow, grant resources, skip return travel, remove expedition locks, or commit the return on the player's behalf.

## Player flow

- A compact storage disclosure sits below the resource strip and remains accessible in the Expedition view
- It displays authoritative held/capacity, available and reserved figures for every resource
- The player selects a resource and types an exact positive integer no larger than its available amount. Empty, decimal, signed, exponential and unsafe-number input is not normalized into an action
- Review freezes that resource, amount, session epoch, owned stock, reserved stock and capacity. The separate confirmation names the resource and amount, explains that the discard cannot be undone, and shows the remaining held and unchanged reserved amounts
- A changed resource basis invalidates the confirmation. A replaced campaign remounts all drafts, notices and duplicate-click guards
- When supplied by the application, current return overflow is shown as a suggested quantity. These amounts must be computed from the actual pending settlement's loot plus unused supplies and current capacity. Selecting a suggestion only fills the input; it never skips review or confirmation
- After discarding enough, the player retries return settlement in the Expedition view. The unchanged normal return path atomically credits loot and unused supplies and releases activity/build locks once

## Integration contract

`InventoryPanel` receives immutable resource rows, `sessionEpoch`, `readOnly`, optional `busy`, a translator, optional `suggestedDiscard` resource lines, and synchronous `onDiscard(request, guard)`.

The request is only `{ resourceId, quantity }`. The separate guard is `{ sessionEpoch, resourceId, owned, reserved, capacity }`, defined in `src/application/inventory-contract.ts`. The application must check it against its fresh World and session immediately before generating the command ID. Rendering props alone do not authorize a second debit. The normal session path must also enforce storage read-only, overlay and core-error restrictions.

The UI owns no World, save state, clock, pause reason, receipt ID or mutation. Its one-use confirmation latch blocks re-entrant clicks and same-render duplicate events; accepted submissions remain blocked on the same resource basis until an authoritative update is observed. A throwing callback is treated as an uncertain result and cannot issue another debit on the same basis. Reloading/replacing the campaign resets this transient latch.

The v7 command bridge owns `inventory.discard`, normal receipt replay, `discardResult`, and the durable `inventory.discarded` event. The pure `discardAvailable` reducer preserves reservations and input ownership. Neither component is implemented in the presentation layer.

## Evidence and pending acceptance

Prepared, not independently executed by the presentation worker:

- `tests/inventory-discard/presentation.test.tsx`: semantic server rendering, exact quantity parsing, detached/frozen review, selected-resource and epoch freshness, read-only/busy restrictions, same-render and re-entrant click prevention, failed/uncertain callbacks, authoritative recheck, bilingual fixture contracts and registered-catalog requirements
- `tests/inventory-discard/recovery-loop.test.ts`: 331 ordinary `gather.herbs` commands with real worksite/labor/storage delivery take herbs from 6 to the unchanged capacity of 999. An actual starter battle produces positive secured herb loot. Retreat and return block, preserving locks and settlement; validated save/reload retains that state. A normal discard frees the exact actual overflow, its receipt survives another reload, and return retry settles all credits exactly once. Duplicate discard and return replays do not change resources or duplicate settlement/events. No direct World inventory, capacity, encounter or settlement edits are used
- `tests/inventory-discard/locales.fixture.json`: complete Chinese/English entries and exact parameter definitions for registration by the integration owner

Only the integration owner runs tests, type checks and production build. Passing server-render/pure tests is not browser interaction acceptance. Real-browser review still needs keyboard review/confirm/cancel, double click, stale stock, campaign replacement, read-only state, full-return recovery, narrow viewport and Chinese/English layout checks. The presentation worker did not run tests, builds, Git or deployment.
