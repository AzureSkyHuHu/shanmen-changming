# Internal v9 → v10 copy coordinator

Status: implemented as an internal, unmounted application boundary. Validation is owned by the serial integration lane; this document does not claim a passing run, browser migration flow, public v10 entry, or complete-game acceptance.

## Scope

`src/application/v9-v10-copy-coordinator.ts` joins the existing fixed v9 source controller, pure quiet-boundary migration, opaque prepared v10 Session, and isolated v10 repository. Nothing imports it into a route, changes ordinary save admission, redirects an old database, or activates UI.

The caller supplies an already-open `IndexedDbManagementV10Repository`, an actual `ManagementSaveControllerV9` in a `V9V10CopyHost`, an explicit empty target-slot choice, a writer identity, and save metadata. The repository retains its fixed v10 database identity and independently validates source, quiet boundary, exact target, lease, backup, snapshot, and target pointer.

The fresh source export uses the supplied metadata. Its exact text, including formatting, is the migration backup. It is not substituted with a stored older snapshot, even when the source controller reports clean. Existing old snapshots keep their original bytes and pointers.

## Sequence and ownership

1. Guard against reentrant/concurrent copies before descriptor-safe option capture. Only the three declared option fields are accepted.
2. Capture the host's actual source-controller identity and private generation.
3. Acquire a fresh `beginV10CopySource` token. The source controller owns the busy hold, current Session boundary, old binding/lease fence, and abort signal. Public token fields or copied lookalikes never confer authority.
4. Run the existing `prepareV9ToV10Migration` unchanged. Active work, enabled automatic work, pending progression/lifecycle obligations, and other unsupported boundaries are rejected; the coordinator does not cancel or settle them.
5. Call `ApplicationSessionV10.prepareSession` and serialize the admitted target before any target-copy write transaction. The candidate's owner, projections, frame state and successful Session-bind result are already allocated. Only its opaque one-use prepared token is held; no independently runnable staged Session is exposed.
6. Recheck source token and host generation immediately before the repository call. Pass the token's actual `AbortSignal` into the single `commitV9Copy` call.
7. Await the target transaction's real completion, record its durable receipt, and recheck both fences. The receipt is retained even if this check fails. Its ownership-bearing records are frozen before exposure.
8. On a current host/source, consume that exact prepared token once through the fixed Session binder and publish the real Session plus target lease ownership into the concrete host. There is no injected binder, World factory, validator, arbitrary callback, route notification, or await between Session binding and host publication.
9. Only after both commit and actual bind, finish the source token with `bound`. Every other path finishes `failed` or an already-recorded host cancellation. Host invalidation and coordinator cleanup share one completion promise, installed before synchronous source listeners can reenter.
10. Discard every unbound candidate. Release a committed target lease only when it never transferred to the host. Once transferred, the host alone owns Session close and target-lease release. Source/host fences are observed after asynchronous cleanup, but cleanup cannot recreate authority.

The source controller's successful bound finish protects the old live source and releases its writer lease. The old saved generations remain available. A source lease cleanup failure is reported separately; it cannot undo an already committed and bound target.

## Concrete host contract

`V9V10CopyHost` keeps its state in a module-private identity map. The coordinator uses this state directly rather than trusting a host callback to validate or bind a World.

- `replaceSource(controller)` is allowed only while the host is open and still v9. It invalidates the prior generation even when the supplied controller identity is unchanged. It cancels an in-flight copy, leaving the old Session and source database available.
- `getBoundTarget()` returns the transferred Session/repository/receipt binding only after real binding. It returns null before binding or after host close.
- `close()` invalidates synchronously. Before binding it cancels the pending source copy without closing the old Session. After binding it closes the owned target Session and releases the transferred lease, returning separate cleanup diagnostics. Repeated close calls share the same completion.
- Repositories themselves remain caller-owned. Closing the host never deletes a target slot, backup, snapshot or old source. The host is not a new persistence controller or a lease-renewal loop; a future mounted target flow still needs its own explicit lifecycle/storage integration.

## Result contract

| `kind` | Meaning |
| --- | --- |
| `rejected` | No target commit receipt was produced. Failure includes source/host fences, migration/preparation admission, or a repository transaction rejection. |
| `committed-and-bound` | The target transaction committed, the preallocated Session bound, and the host still owns that live binding when the operation finishes. |
| `committed-not-bound`, `bindingState: never-bound` | The target committed but binding was refused or fenced out. The prepared candidate is discarded and its untransferred target lease is released when possible. The old source remains usable unless independently closed/replaced by its owner. |
| `committed-not-bound`, `bindingState: closed-after-bind` | Binding really happened, but the host closed while source cleanup was awaited. The old source's successful handoff is not reversed. The host owns target teardown and its cleanup is awaited/reported without a second lease release. The durable target is reloadable. |

All results carry a separate cleanup issue list. A cleanup failure never becomes a fake transaction rejection, successful bind, or rollback. In particular:

- `SOURCE_CLEANUP_UNCONFIRMED` means source finish threw, rejected, or no longer accepted the token, including a controller independently stopping or refusing a busy finish. The coordinator does not pretend the source hold/lease was released.
- `SOURCE_HOLD_RELEASE_FAILED` and `SOURCE_LEASE_RELEASE_FAILED` preserve the source controller's explicit cleanup report.
- `PREPARED_DISCARD_FAILED`, `TARGET_SESSION_CLOSE_FAILED`, and `TARGET_LEASE_RELEASE_FAILED` expose teardown failures independently of durable data.

Expected copied/forged errors do not confer diagnostics. Coordinator failures and the narrow `managementV10PersistenceErrorCode` accessor use module-owned WeakMap identity, never an arbitrary exception's prototype, name, message or code getter. The storage error constructor's existing public API is unchanged.

## Persistence guarantees and limits

- The atomic unit is the v10 repository's strict transaction over its own backup, snapshots, lease and slot stores. The source and target databases are not one transaction.
- Abort before target completion may cancel the target transaction. Cancellation after completion cannot erase its durable receipt or data.
- Host close or source replacement during an await is fenced before live binding. Host replacement/close also finishes the source token as cancelled, propagating its abort signal to a pending target transaction.
- An occupied target is rejected. There is no overwrite, target deletion, compensation transaction, automatic retry, downgrade, or migration rollback.
- Reopening/loading the committed target and exporting its exact v9 source backup remain possible after failed binding. A failed target-lease release can require the existing lease policy to expire or explicitly resolve ownership; it does not make the slot disappear.
- Cleanup failure after handoff does not justify silently resuming both old and new writers.
- This is application correctness coverage, not browser quota certification, public migration UX, mobile validation, or a proof of unrestricted v10 simulation closure/performance.

## Test inventory

`tests/application/v9-v10-copy-coordinator.test.ts` uses real v9/v10 Sessions and the real repository with `fake-indexeddb` transactions. Its cases cover:

- fresh dirty live source, exact formatted backup, unchanged old pointers/snapshots, strict prepare → transaction completion → bind → source-finish ordering
- one-use source/prepared tokens and a single host target
- malformed export, read-only source, valid active-work source, malformed options, and failed candidate allocation
- existing target, actual quota exception, and real transaction abort
- blocked ordinary source controls, overlapping coordinators, and Session replacement during an awaited operation
- host closure/generation change at the actual transaction-complete event, source replacement after durable completion, unbound candidate disposal and target reopen
- refused binding, source lease failure, untransferred target lease failure, and one-owner host teardown
- host close during delayed real source cleanup, both successful and failed teardown, with `closed-after-bind` and no duplicate lease release
- descriptor-reflection reentrancy and zero-read arbitrary thrown-error classification

The worker did not run tests, type checks, builds or Git operations. Integrator results must be recorded in the development status with the exact validated tree; this file is a contract and test inventory, not execution evidence.
