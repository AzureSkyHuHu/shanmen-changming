# v10 actual cultivation transition evidence

2026-10-02. Internal candidate preparation only. This stage does not register a v10
runtime, admit arbitrary source Worlds, migrate saves, or enable player gameplay.

## Fixed preparation ports

- `prepareValidatedV10CultivationClock(source)` invokes the real `tickClock`, then
  the existing schema-3 month/birthday preparation. Paused clocks remain identical;
  ordinary ticks allocate no cultivation row, revision, action or random draw
- Before invoking the schema-3 clock reducer, the stage checks the unchanged 8,192
  row limit. Exactly one real month/age-sync row is appended when needed, including
  simultaneous birthdays. Failure throws without publishing or mutating the source
- `prepareValidatedV10CultivationCommand(source, command)` invokes the actual
  `applyCultivationCommandV3`. Failed commands and exact retries return the exact
  source World and empty death authority. The root still owns command ingress,
  cross-domain command IDs, work-owner exclusions and final publication
- Both return the candidate World, its exact transient `SectUpgradeFrameV10` and
  `ConstructionContext`, and opaque transition evidence. Clock preparation also
  returns `advanced`; command preparation exposes the actual `transition` result
- Real schema-3 events are mirrored through `prepareCultivationWorldEvents` and
  `appendWorldEvents`; actor life/age/workability is projected. The cultivation
  decision pause is set before deriving the pre-work context, so expiry or
  `DecisionReady` blocks all subsequent work and further clock advance

The name `Validated` denotes an INTERNAL root-prevalidated candidate stage. The
additional fixed v10 lifecycle check authenticates the source's supported identity,
build context, lifecycle records and clock chronology. It is not complete source
economy/owner/capacity admission. Full source and candidate admission is unfinished.
An inconsistent source cultivation-pause flag rejects rather than advancing past a
pending decision. No optional validation callback, caller certificate, supplied
reducer result, death-ID list or claimed transition flag is accepted.

## Exact transition authority

The private WeakMap binds the exact source and canonical snapshot, actual reducer
result and snapshot, candidate World and snapshot, projected frame and snapshot,
and exact construction context and snapshot. It retains the complete newly emitted
schema-3 event suffix, including event identity, action identity and month.

`readV10PreWorkDeaths(evidence, frame, context)` rechecks all bindings and compares
the exact newly appended World mirror suffix, including archive-tail movement.
It joins only newly emitted `cultivation.expiryPending` / `cultivation.died` events
to the actual pending/final death records and their newly unavailable real actors.
Supported causes are lifespan and sampled breakthrough death. Combat is outside
the supported fresh management boundary and cannot mint this authority.

Expiry marks the first unavailable boundary. A later command that finalizes that
already-pending death emits its real died mirror but returns no new pre-work death
fact. It cannot authorize delayed cancellation. Direct sampled breakthrough death
does produce a new died fact. Empty/failed/replayed transitions produce none.

Copied, forged, JSON-recreated, v9 and completed-record lifecycle tokens cannot be
used. Equivalent fresh projections/contexts also cannot replace the exact objects.
Any changed source, candidate, reducer result, frame, context or mirror invalidates
the proof. There is no public evidence-rebinding function or arbitrary-death factory.
Canonical snapshots detect changed data when read; they are not cryptographic
authentication or an observation of mutations that were subsequently undone.
Existing descriptor/hostile-Proxy reflection limitations remain unchanged.

## Deliberate pending integration

No upgrade or other job cancellation, legacy reconciliation, estate settlement,
retirement, archive write, milestone award, automatic start or work is performed.
The owning root must consume the exact pre-work evidence for its fixed cancellation
batch before other reconciliation/work, settle lifecycle obligations, and validate
the entire candidate before publication. A changed frame must never borrow this
token, and no rebinding is offered.

The completed-record lifecycle inspector rejects unarchived dead actors and
unsettled estates. It is intentionally never used to inspect this pre-retirement
candidate. Such a candidate must finish root reconciliation before it becomes a
new source. Exact retry tests therefore use genuinely settled historical fixtures.

## Tests and evidence limits

The added suite covers real near-expiry birthdays/months, simultaneous expiry,
actual `DecisionReady`, sampled breakthrough death, lifespan finalization and exact
retry, failure atomicity, archived World mirror suffixes, token forgery, foreign
projections/contexts, source/candidate/result mutation, and clock-row exhaustion.
Lifted v9 records are explicitly record-only v10 fixtures, not migration or
whole-admission proof. Near-boundary/progression fixtures do not claim lifetime
simulation. Long empty month rows are labeled pressure data after real retirement.

Verification is reserved for the integration owner. No test/build result is claimed
here before that owner runs the added suite and unchanged-v9 regressions.
