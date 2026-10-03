# v9 live-source copy fence

This is an additive source lifecycle on `ManagementSaveControllerV9`, for a
future explicit v9 → v10 copy coordinator. It does not migrate, create a target
Session, write a backup, open a v10 database, or change a route. The v9 parser,
Session implementation, database schema, and normal save/load codec are unchanged.

## Fixed API

- `beginV10CopySource(metadata: SaveMetadata): BeginV10CopySourceV9` is synchronous.
  Success is `{ ok: true, token }`. Failure is `{ ok: false, code }`, with
  `READ_ONLY_SOURCE`, `SOURCE_BUSY`, `SOURCE_UNAVAILABLE`, or `EXPORT_FAILED`.
- `isV10CopySourceCurrent(token: unknown): boolean` synchronously checks the
  token's identity and source boundary. Failure aborts its signal. Call after
  every awaited step and immediately before committing or binding the target.
- `finishV10CopySource(token, outcome): Promise<FinishV10CopySourceV9>` consumes
  only the owning token. Outcomes are `cancelled`, `failed`, and `bound`.
  Invalid/foreign/already-consumed tokens return `INVALID_TOKEN`; an invalid
  outcome returns `INVALID_OUTCOME` without consuming the valid token.
  A current `bound` finish invoked reentrantly inside a Session operation returns
  `SOURCE_BUSY` without consuming/aborting the token or releasing its hold/lease.
  Retry only after that Session operation returns and source currency is checked.

The token is frozen and exposes only `kind: 'v9-live-copy-source'`, `sourceText`,
`signal`, `sessionEpoch`, `worldRevision`, and `revision`. A controller-local
WeakMap owns token identity. Copying its fields, proxying it, or presenting a
token from another controller never obtains ownership. No caller validator,
candidate, prepared replacement, repository, writer lease, or trust flag is
accepted by this API.

Successful finish resolves `{ ok: true, sourceCurrent, holdReleased, lease }`.
`ok` means the owning token was consumed, not that migration succeeded. `lease`
is `retained`, `released`, or `release-failed`. The promise settles after owned
hold cleanup and any attempted lease release have completed. `sourceCurrent`
describes the boundary at the finish request. A stale `bound` request releases
only its owned hold, retains the source lease, and reports `sourceCurrent: false`.
An unclosed Session that refuses hold release reports `holdReleased: false`.
If actual Session readonly protection unexpectedly fails during an otherwise
accepted bound finish, cleanup returns `ok: false, code: SOURCE_PROTECTION_FAILED`
with `sourceCurrent`, `holdReleased`, and `lease` cleanup details. That token is
consumed. The coordinator must handle old-source retirement explicitly and must
not treat the controller's readonly status alone as proof of actual Session
protection. This failure does not roll back the already-bound target.

## Capture and invalidation

Before capture, independently reject the controller's readonly state and the
Session's `holds.storage`; recovered loads are readonly even after a requested
takeover. Unstarted/stopped/opening/closed controllers, runtime failures, another
controller operation, or an existing storageBusy hold are also rejected.

Reserve controller ownership before calling `setStorageBusy(true)`. The hold is
ephemeral: it blocks commands and ticks without writing a World pause flag.
Because acquiring it publishes a Session revision, capture the Session epoch,
World revision, and Session revision **after** acquiring the hold. Match the
controller generation, repository identity, source binding, and writer epoch
across acquisition and the entire lifetime. Export through the unchanged v9
Session codec and parse the resulting text through the unchanged fixed v9 route.
Always export the held live World, even when `dirty === false`: loading a v9 save
can add a live player pause that is intentionally absent from the stored bytes.

The subscription synchronously aborts on Session revision/epoch/World changes,
closure, a lost hold, or source writeability changes. Controller stop/restart also
abort and cancel its own source lifecycle. Pass `token.signal` to the target
transaction, so an already-pending transaction can observe invalidation. A lease
renewal retains the same writer epoch and does not stale the token; source lease
renewal continues during the hold. Lease loss makes the source readonly and
aborts it. This is detection through the source controller, not proof that a
different tab can never change the source database between observations.

Metadata is not read by the controller before holding the source. The existing
descriptor-safe v9 codec rejects accessor metadata; getter/proxy/export failures
are contained. No stale disk text is substituted on failure. The old World and
binding remain usable after ordinary failure/cancellation.

A Session listener runs inside the Session's exclusive publication. If such a
listener calls stop or failed/cancelled finish, releasing the hold can receive a transient `BUSY`.
Only this case is deferred to a microtask, retaining the exact owning state and
preventing another begin meanwhile. Startup waits for that cleanup. If another
owner explicitly removed and reacquired storageBusy, this source permanently
relinquishes ownership of that hold and never clears its replacement. Ownership
loss remains observable while finish is pending, including between a reentrant
finish's `BUSY` refusal and its deferred release retry. Closed
Sessions require no playable hold restoration.

## Coordinator obligations and lease order

1. Begin and retain the exact successful token. Use its exact `sourceText` for
   v9 admission/migration and the persistent source backup. Preserve original
   imported-file bytes separately if the higher-level workflow also owns them;
   this token specifically represents the current live boundary.
2. Prepare and validate the new Session before target pointer commit. Do not
   replace or close the old source Session to prepare the new one.
3. Pass the source signal to all cancellable target work. Check current after
   every await, before target commit, and immediately before target binding.
4. Only after durable target commit **and successful target binding**, finish
   with `bound`. This releases the old source writer without taking over any
   lease. The old v9 controller becomes readonly while it is being unmounted,
   preventing its old engine from continuing to write or tick. Actual Session
   storage protection is installed before bound-finish abort observers run;
   their removal/reacquisition of storageBusy cannot expose an unprotected
   old engine. Bound finalization first probes the already-true owned busy hold:
   outside Session exclusivity this is a no-op, while a reentrant invocation
   returns `SOURCE_BUSY`. It never accepts a bound finish and defers its
   protection to a later microtask. The source lease is detached before any
   protection/abort publication; a reentrant stop waits for that captured
   lease's cleanup before repository close, avoiding double release or an
   unsettled cleanup promise. No Session close port or implementation change is
   required.
5. On failure/cancellation, finish with that outcome in the coordinator's cleanup.
   Its owned hold is removed; the source writer lease remains. Explicit source
   stop/close retains its existing controller shutdown semantics, including
   eventually releasing the old lease and closing the old repository.

There is no cross-database atomicity. Abort cannot undo a durable target commit.
If the source becomes stale after target storage committed but before binding,
the higher layer must report **committed-not-bound** (new slot saved, Session not
switched), retain the committed target, and offer explicit loading. It must not
claim rollback, transparently overwrite/retry, or pass `bound` merely because a
target record exists. A post-binding source-lease cleanup failure likewise does
not undo or falsify the already-successful target binding.

Memory mode supports held live preview/export, but this API produces no durable
backup/readback evidence and cannot justify a storage-conversion success claim.

## Validation scope

`tests/application/v9-migration-source-fence.test.ts` covers live-vs-disk capture,
post-hold revisions, commands/ticks, dirty and loaded-paused sources, both readonly
signals and recovery, foreign/copied tokens, lifecycle cancellation, replacement
and revision drift, metadata/export failures, reentrant listener cleanup, writer
retention/release/failure, and ownership loss during renewal. It also exercises
ordinary save/load after cancellation. Run this suite together with the existing
management-v9 controller and Session suites to check unchanged normal behavior.

The source worker did not execute tests, type checking, builds, Git, deployment,
or browser work. Integration validation and any end-to-end migration claims
remain the integration owner's responsibility.
