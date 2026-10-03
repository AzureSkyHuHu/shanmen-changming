# Internal copied-target service transfer

Status: internal application implementation and new tests only. The integrator owns serial validation; no test, type-check, build, Git, route activation, or browser action was run by this worker. This document extends the previously separate copy-coordinator and normal-save-controller contracts without enabling an entry point.

## Public operation and result

After a successful, settled `V9V10CopyCoordinator.copy`, call the concrete `V9V10CopyHost.transferToController()` once. Success returns an `AdoptedManagementServiceV10`:

- `session` is the exact already-bound copied `ApplicationSessionV10`; there is no replacement, new World, reconstruction, automatic load, or Session publication during handoff
- `saves` is an active `ManagementSaveControllerV10` bound to the existing durable slot/revision and the same writer owner/epoch
- `dispose()` is idempotent and returns the same preallocated Promise and a preallocated `{ storageStopped, sessionClosed }` result; it waits for save-controller stop, then closes the owned Session

Failure returns a bounded code and leaves ownership with the host unless the host independently closed while preparation was awaiting storage. No failed adoption closes or releases a still-owned host resource, deletes a slot, writes a new generation, or claims a migration rollback.

`storageStopped` reports that controller stop completed. It does not upgrade the ordinary controller's contained lease-release failure handling into proof that a storage release succeeded. The separate Session-close result is retained even if stop fails.

## Exact ownership split

| Resource | Before transfer | After transfer |
| --- | --- | --- |
| Live copied Session | Copy host | Adopted service wrapper |
| Existing writer lease | Copy host | Save controller inside the service |
| Repository connection | Caller | Same caller |

Host close after transfer cannot close the service's Session or release its lease. Service disposal delegates lease teardown to `saves.stop()` and then closes the Session once. Repeated service disposal or controller stop cannot issue a second release for the same controller lease handle.

An adopted controller has a private connection-ownership flag: stopping its adopted binding does **not** close the shared caller-owned repository. The future mounted entry remains responsible for explicitly closing its own connection after all owners are done. No implicit ownership transfer of that connection occurs.

Ordinary controller construction/start/stop retains its previous contract: an ordinary start owns the connection it opens, and stop closes that connection but never the caller's Session. Explicitly starting a previously stopped adopted controller is a new ordinary start, rather than reviving a transferred copy token. Only the adopted service owns Session disposal.

## Preparation before relinquish

1. The host must still own a real bound target and have finished source cleanup. It exposes a target during copy cleanup for diagnostics, but `COPY_PENDING` prevents premature transfer.
2. The host issues an identity-authenticated, module-private offer with its generation, exact binding object, original saved Session boundary, and the current Session boundary. Callers cannot supply a World, Session, receipt, trusted validator, controller factory, or activation callback.
3. The fixed controller preparer authenticates that offer through the concrete host. Only one dormant preparation is allowed per offer.
4. It reads the actual complete slot list, verifies that the target still matches the committed manifest, and renews only the already-owned writer owner/epoch. It never acquires a new lease, performs takeover, imports a save, or writes a generation. Host and Session identities are checked after each await.
5. It allocates the controller, inert Session subscription, frozen slot/status projection, lease handle, periodic renewal timer, adopted service, successful result, disposal Promise, and disposal results. The timer and listener remain inert until activation.
6. A second opaque one-use token identifies that exact prepared controller and its original offer. If any allocation or final check fails, only the dormant subscription/timer is discarded. The host still owns its Session and lease. A completed renewal preserves the same owner and epoch and therefore remains compatible with the host's original release token.
7. Final handoff is synchronous: the host rechecks the authentic offer, opens a gate only for the paired prepared token, and calls the fixed controller activation method. Activation consumes the token and performs preallocated assignments only. The host immediately relinquishes its binding. There is no await, arbitrary callback, or status/Session notification between those assignments.

The narrow cross-module methods are internal protocol entry points. A direct activation call fails outside the host's short synchronous gate. Copied tokens, a token paired with another offer, replayed tokens, and hostile token proxies cannot activate or expose private host state. The offer reader returns only the frozen bounded view; it does not return the host state, generation cell, or transfer gate.

## Clean/dirty and current-source honesty

The coordinator records the copied Session's original `sessionEpoch/worldRevision` at durable binding. Adoption uses that saved boundary, never a later snapshot, as the clean baseline.

- A live World that advanced before transfer is allowed and starts dirty; the durable slot is still revision 1 until an explicit save
- UI-only publications do not make the World dirty, following the normal controller's existing epoch/worldRevision rule
- Any Session boundary change during asynchronous preparation rejects that attempt rather than freezing a stale status; a new attempt can capture the new boundary
- An externally replaced Session epoch, closed Session, busy storage hold, or runtime failure is rejected before transfer
- Foreign storage read-only holds are preserved and reflected in adopted status; neither successful transfer nor later controller stop clears them

The actual complete slot list is loaded before status preparation, so unrelated occupied slots are not falsely displayed as empty. Later normal refresh/renew/save operations follow the normal controller's current storage fences.

## Source cleanup diagnostics

The coordinator now distinguishes `SOURCE_PROTECTION_FAILED` from an unknown finish result and also preserves its `holdReleased` and lease cleanup subdiagnostics. Thus source-protection failure can appear with `SOURCE_HOLD_RELEASE_FAILED` and/or `SOURCE_LEASE_RELEASE_FAILED` without losing detail.

Automatic service adoption is rejected with `SOURCE_UNPROTECTED` after source protection failure or unconfirmed source cleanup. The already-durable target remains present, and the copy result retains its durable/bound classification and cleanup diagnostics. A source lease release failure alone does not imply that source read-only protection failed. No adoption path pretends to repair source cleanup or restore two writers.

An `ok: true` source finish is not by itself retirement evidence: a stale bound finish may have legitimately performed cancellation cleanup, with `sourceCurrent: false` and/or `lease: retained`. After an actual target bind these results are classified as `SOURCE_CLEANUP_UNCONFIRMED`, with any explicit hold/lease failures still retained, and cannot authorize adoption. Ordinary failed/cancelled copies may retain their source writer without being misclassified as a protection failure.

## New test inventory

`tests/application/v10-copy-controller-transfer.test.ts` uses actual v9/v10 Sessions, both actual application controllers, and the actual isolated repository over `fake-indexeddb`:

- live Session identity and no activation publication; real complete slots; no lease acquire, import or generation write during transfer; explicit subsequent revision-2 save
- same-epoch renewal and continuing controller renewal lifecycle; exact v9 source backup retained
- host close after transfer, idempotent service disposal, one lease release/Session close and continued use of the caller-owned connection
- live progression before adoption stays dirty until save
- failed allocation discards subscription/timer while preserving host ownership, plus successful retry
- stale Session after await, overlapping transfer refusal, host close after renewal and after full preparation
- direct/copy/forged/replayed/cross-offer token refusal, one preparation per offer, no private state exposure or hostile reflection
- source cleanup readiness, stale/current-but-retained source retirement refusal, detailed source-protection failure diagnostics, and protected-source adoption despite a separately reported lease-release failure
- foreign read-only holds, external Session replacement, and zero-read storage failure handling

This is not a public migration UI, browser/physical quota certification, activation of v10, or complete-game acceptance. Validation results belong to the integrator's exact-tree evidence.
