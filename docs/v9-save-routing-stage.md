# v9 platform/save routing and isolated management persistence

The v9 platform route and isolated management controller are integrated. Current check results, full-regression status, publication status and browser gates are recorded in [the integration status](v9-management-integration.md). No browser, performance or complete-game acceptance is claimed.

## Exact codec and route boundaries

- Global platform types now preserve correlated v7/v8/v9 envelope and World pairs. The v9 branch delegates creation, serialization and parsing to the existing fully funded headless codec. There is no configurable trusted validator, v9-to-legacy cast, version migration, or relabeling of internal `.1`/`.2` identities
- Original bounded JSON is inspected before legacy migration. `runtimeProtocol`, `sectExpansion` and `cultivationClock` are reserved v9 authority and reject in original v1–v8 payloads, including null values; legacy v8 `contentIdentity` protection remains
- `RepositoryOptions.routePolicy` is a closed union. Default `legacy-v7-v8` retains the previously accepted versions and rejects v9. Optional `v7` allows authentic old migration through v7, optional `v8` accepts only v8, and `management-v9` accepts only fully admitted v9
- Recognizing a save in the global parser does not let an old store, controller or entry load/write it. The old controller uses a typed legacy parser and checks repository loads before binding. Its existing factories, v7/v8 switching, migration and raw-source behavior remain supported
- `ManagementSaveControllerV9` forcibly selects `management-v9` and `shanmen-changming-v9-management-saves`. Constructing it opens no database; startup is explicit. The controller does not select or open the ordinary v7 or campaign v8 databases. The separate management entry owns startup and teardown

## Persistence invariants

- Schema remains version 1 with the same three stores, manifests, source text and lease records. Imports and exports preserve supplied text exactly
- Every write kind, including explicit overwrite, examines every retained generation. Unknown versions, content/simulation identities, `UNSUPPORTED_SCOPE`, and route-incompatible versions are protected before any snapshot write or pruning, including noncurrent generations and unsupported text with damaged surrounding record metadata
- Existing lease epochs, revision fencing, add-before-readback, full readback validation before current pointer, transactional pointer/prune, rollback and readonly recovery remain in place
- Optional `AbortSignal` in write/import options only cancels the transaction. It supplies no validation or authority. A fulfilled commit cannot be undone by later cancellation; the controller does not claim otherwise

## Separate management controller

- Uses only the exact Session v9 port and structured success/session/runtime/save outcomes. It does not use `ApplicationSession` or a legacy World
- Manual save/export and load, explicit fresh campaign, file preview/target/revision confirmation, import-and-load, lease renewal, readonly recovery and memory-only manual save are provided. No autosave timer exists; `autosave: 'manual-only'` and `dirty` are explicit status fields
- Dirty state uses Session epoch/worldRevision, not full snapshots or selection/hold publications. A failed runtime projection is not labeled clean
- Save/import source validation and all runtime replacement preparation happen before repository import/write or binding. Prepare occurs after acquiring `storageBusy`; the hold remains through commit. A successfully prepared replacement needs no second cold preparation after durable write
- Failed preparation or transaction disposes the token and preserves prior live World, storage text/current pointer and binding. The only permission-state changes are actual lost-ownership/revision conflicts, which become readonly
- Storage busy/read-only changes are separate: desired readonly state is applied in both directions after releasing busy. This avoids retaining a former readonly hold after writable load/new/import
- Generation guards are checked after awaits and synchronous observer notifications. Observer-triggered stop during the completed Session swap releases the newly acquired lease instead of resurrecting ownership. That synchronous swap or an already committed transaction is not falsely advertised as rolled back
- Stop aborts pending transactions, waits for operation/token cleanup before closing storage, and prevents stale completion from rebinding. Session close triggers this cleanup as well, so a closed Session does not renew a lease forever. Startup waits for cleanup and never reopens a closed Session
- UI control failures do not silently become success: hold acquisition/release and readonly reconciliation are inspected; Session close is a deliberate terminal exception

## Test coverage and route distinctions

`tests/persistence/management-v9-routing.test.ts` covers exact v9 codec correlation, authentic legacy source behavior, old-route isolation, all legacy versions with reserved-field smuggling, routing getters, malformed/corrupt/future/unsupported errors, rejected `.1`/`.2`, original bytes and continuation after reopen, incompatible imports without writes, all retained/current write protections, leases/takeover/expiry/stale revisions, all transaction fault stages, readback tampering and cancellation.

`tests/application/management-v9-save-controller.test.ts` covers fixed storage route/name, manual save/reload/resume/dirty state, memory fallback, import prepare-before-write, exact imported bytes, legacy entry rejection, prepared failure without writes, rollback/token disposal, busy protection, stop/restart and Session close while awaiting, idle close cleanup, lost ownership, readonly recovery, stale target consent, writable transitions from readonly and synchronous subscriber-stop during replacement.

`tests/persistence/sect-v9-codec.test.ts` distinguishes global platform recognition from legacy core rejection. Old core codecs still reject v9. The corrected capacity assertion additionally checks a fabricated v9 checksum at the global parser and explicit refusal in all three legacy routes; its focused result and the failed complete-check history are recorded in the integration status.

`tests/persistence/versioned-codec.test.ts` uses `10` in its unknown-version cases (`[0, -1, 10, 999, 7.5, '8', null]`). Its retained/current-generation protection fixture still relabels v8 text as `saveVersion = 9`; that is an incompatible legacy-store record, not a valid v9 save or evidence that the global parser does not recognize v9. Legacy route policy protects it from writes and explicit overwrite.

## Remaining limits

The isolated `management.html` entry requires the exact build flag `VITE_ENABLE_V9_MANAGEMENT=1`; the ordinary and campaign entry routes remain separate. The first candidate is published; verified and pending browser flows are recorded in the integration status. No runtime/UI speed, supported maximum population or arbitrary lifecycle closure promise is made. Management admission remains exactly the bounded, funded subset supported by the existing v9 headless codec. Repository lease writes on a read/load attempt may extend or release ownership even if later live preparation fails; stored save text, pointer and binding remain unchanged. This is not a cross-system rollback of an already completed IndexedDB commit or completed Session pointer swap.
