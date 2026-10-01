# Registered v8 exit budget: standalone candidate

## Status and scope

`src/core/world/expedition-exit-budget.ts` is an independent, read-only assessment. It is not connected to departure, optional commands, combat ticking, save admission or UI. Existing v8 hooks check some capacities and the current run/encounter quotas; they do not yet enforce this complete certificate. A successful query does not establish that production gameplay has the end-to-end guarantee.

The goal is narrower than unlimited campaign history or guaranteed combat wins: every newly admitted registered run should retain room for a real retreat, mandatory calendar work, terminal return and a valid save. Earlier histories, receipts, proofs, archives and extension bytes remain intact. A quota cannot justify deleting or relabeling them. No changes are made to frozen v7 or its accepted legacy continuation.

The result separates:

- `supported`: the complete source validates and this registered recovery derivation is known
- `actualFits`: the present envelope fits the 4 MiB file cap using worst legal metadata; on an unsupported input no affirmative size claim is made
- `fits`: every enumerated current-plus-reserved dimension and underlying progression numeric check fits
- `unknowns`: why the derivation cannot certify this boundary
- `violations`: independently exhausted dimensions for a supported boundary

The source and RNG are untouched, and the returned record is deeply frozen. The typed maximum records are size witnesses, not executable game facts. They are never fed to an adapter, used as combat outcomes, or stored as proof.

## Byte composition

For an active registered run:

`F + 2R + C + P + X <= 4,194,304`

- `F`: exact current worst-metadata World envelope, subtracting only the exact current run value and current WorldEncounter value (including `null` when applicable). Existing historical proof copies stay in F
- `R = 196,608`: named product quota for one run, conditional on `currentRunBytes + finishDeltaBytes <= R`
- `2R`: the current Ended run and its possible serialized shared-proof copy. Object sharing in memory is not assumed to save JSON bytes
- `C = 262,144`: named product quota for one WorldEncounter. Its current actual size must fit; this is not an inferred natural maximum of every battle
- `P`: existing typed progression reservation, including build/cultivation/lifecycle/estate/archive records. Its build-row subtotal is not added a second time
- `X`: the new registered proof wrapper, existing production/journal reservations, return-clearance reservation, additional typed World records, and the pre-existing named 1 MiB general margin

The general margin is deliberately retained. There is no exact coverage map proving it wholly overlaps the new envelopes, so the module does not subtract or silently replace it. The extra fatal-emergency World receipt also deliberately overlaps the existing generic continuation reserve. This is conservative overcount, rather than relying on accidental spare bytes in another fingerprint.

For an already Ended run, the query counts its actual current run/encounter values once; any existing shared proof remains in F. It adds no new run, history or proof records.

### `finishDelta`

The run envelope funds:

- Every indispensable remaining domain command and receipt, using a typed largest-command witness
- A current encounter's genuine emergency outcome, retained both in its command and its result array
- Terminal settlement, with every resource line at the registered numeric width
- One possible in-flight checkpoint, completed ledger rows and possible all-dead abandonment
- Member death/injury/resource widths and pending-offer forfeiture metadata
- Run revision, month, phase, lock and forfeiture-counter widths

It does not credit shrinking fields, removed talents, cleared encounters or discarded cargo against these new records. Actual costs can therefore be considerably lower.

Additional World records include effect acknowledgements, actual combat-to-World death mappings, terminal history with mappings, a possible already-earned clear/reference, unlock insertion, pause/mode/return state, and inventory digit growth. No future victory is assumed. A victory already earned before return may retain its sealed settlement reason when all returners later die; clear and personal-victory entitlement still follow the actual adapter's survivor rule.

## Real recovery path

The supported registered candidate identity is `content.release-v8.candidate-2` with `release-v3` / schema 3, at most six squad members, three encounters, one month per travel node and one return month.

- Travelling: finish the existing or necessary current travel checkpoint through ordinary ticks, then retreat at the node
- AtNode / RewardPending: invoke the ordinary safe retreat
- InEncounter: invoke emergency retreat against the real running controller and its current review stamp; do not advance extra combat to manufacture an outcome
- Ending: pay remaining return checkpoints and settle through ordinary hooks
- Ended: save the already-completed boundary

At most the current travel month plus one return month is mandatory. A partly completed month uses its actual remaining ticks. A checkpoint already at its target still needs a `time.commit` row even when it has zero ticks left. Prepaid meals stay spent, and future unpaid meals must already exist in carried supplies.

Before recovery calendar ticks, cancel current production through existing commands and cancel unsampled active breakthrough attempts. Existing production and progression reservations fund those acknowledgements. Automatic starts are currently suppressed during an active v8 expedition; the future admission integration must preserve that protection. No optional new build, enrollment, lesson, production or expedition choice may spend the certificate without recomputing the complete candidate.

The reused progression vector may conservatively retain calendar/ID allowances for an accepted attempt until its real cancellation discharges them; those additive allowances are not additional mandatory exit months.

Real lifespan expiry still pauses and requires its ordinary death acknowledgement. Distinct off-global-month birthdays and global month boundaries are counted against actions, cultivation revision, calendar and simulation counters. Lifecycle terminal records remain charged to their existing progression owner. Deaths may shorten the actual route, but that saving is not required to make the bound fit.

If incoming cargo itself fits physical capacity, at most six all-available-resource discards after releasing production reservations can clear existing stock. The existing clearance helper funds both the discard events/receipts and continuation acknowledgements; partial discards do not discharge that full reservation.

### Identity widths

Recovery IDs must satisfy both the outer command grammar and the complete derived effect ID:

`runId + '/command/' + commandId`, maximum 120 characters

Only canonical adapter-allocated `run:<positive safe integer>` roots (below the next shared action counter), and canonical pending away-death instance IDs, are certified. Other reader-valid namespaces remain preserved but unsupported.

`isRegisteredExitCommandId` checks this without truncating, hashing or rewriting anything. The query reports `commandIdMaximumLength`; callers must still choose a fresh ID and use ordinary conflict/retry validation. Existing internal checkpoint, death reconciliation and settlement IDs are accounted for at maximum legal widths.

Reader-valid histories can already occupy a future adapter-owned ID with a different command. The assessor refuses occupied remaining run settlement/month/death-reconciliation IDs, required build unlock/award/realm/teaching IDs, and possible death-finalize/retirement/item-transfer/archive namespaces. Both ordinary and authority cultivation receipts are checked. The current encounter's fixed result ID and independent build transfer IDs and milestone IDs are checked too; a different receipt command ID does not make an occupied effect identity safe. Future death namespaces use the bounded assessed nextInstance interval, rather than treating every historic internal prefix as a conflict. An old no-op row must never be removed or renamed to make a future command work.

## Non-byte dimensions

The assessment retains the underlying production and progression vectors and adds explicit limits for:

- World archive production/receipt/event rows and decoded characters/nodes
- Shared action/entity/event/instance allocation counters and event-RNG headroom
- Build command/history/receipt/retired/award/skill collections, revision and reader limits
- Cultivation lifecycle collections, sect-relic accumulation, revision and reader size
- Legacy estate and archived-identity rows
- Run command and receipt rows, revision, month, forfeitures, outcome/ledger/abandonment arrays
- World effect receipts, expedition histories, death mappings and shared settled-run proofs
- Campaign clear/reference count, revision and full standalone reader-envelope characters/nodes
- World calendar/simulation ticks and every living actor's chronological subtraction
- Standalone run, battle and controller reader character limits, including nested battle-string escaping

A byte surplus does not compensate for a row, parser, identity or numeric deficit. All dimensions are checked independently, with unsafe/non-finite values rejected. Battle state is not stepped by the exit derivation, so it does not claim future battle-tick, combat-RNG or combat-ID capacity.

## Fail-closed inputs

The query does not certify missing/pre-departure runs, current legacy runs, unregistered identities/protocols/routes, an optional command queue, an invariant-error pause, impossible incoming cargo, insufficient carried meals or unsupported underlying progression obligations. Validation errors, accessors and unsupported data also fail closed without touching the source.

A RewardPending imported boundary with a pending death of an away member is explicitly unsupported: finalizing that death regenerates an offer and uses RNG, outside this immediate-retreat derivation. An encounter whose controller has already resolved, whose emergency retreat is blocked by an existing cultivation decision, or whose imported running controller has no non-permanently-dead participant likewise needs a separate real transition proof. None of these cases permits changing a version label or weakening a validator.

## Reachable decisions and fallback locations

A home disciple can enter DecisionReady during mandatory travel or return. Travelling and Ending remain supported in that state; the plan includes the attempt ID to cancel. Active Reserved, InSeclusion and DecisionReady attempts are required by `cultivation/v3/validation.ts` to have `sample === null`. Resolution samples and publishes phase Resolved in one command. There is no valid saved “sampled but still DecisionReady” boundary.

Cancellation is a real management-mode command accepted in each of those three unsampled phases. The existing Cultivation panel's active-attempt section always offers Cancel and Confirm Cancel. For a home disciple, the button is blocked only by storage read-only/core-error or activity ownership, not by the save-capacity or cultivation pause. The app's pending-decision review button selects that disciple and opens the cultivation tab. This is source inspection of the current UI, not browser interaction certification.

The expanded integration test exercises a home attempt through confirm, begin, a genuine travel tick reaching DecisionReady, strict restoration, cancellation without any RNG draw, and final retreat/return. It must pass before relying on that behavior in future admission hooks. No hypothetical future tick rejection is claimed tested here because the new certificate is not connected to ticks yet.

A running encounter with a pre-existing cultivation decision is not naturally introduced by current adapters: battle entry checks the global decision state, travel stops on the decision before checkpoint completion, management cultivation commands are refused in combat, and the combat calendar is frozen. Likewise, RewardPending with an away member's pending lifespan death is not produced by ordinary current progression: RewardPending is reached from frozen-calendar combat and then holds the expedition pause. Such imported/partial boundaries fail closed; they are not repaired by inventing an outcome or altering a proof.

A cursor-less Travelling/Ending boundary that still needs a new checkpoint must also have its run month aligned with the World month. A reader-valid skewed import otherwise cannot admit its next real cursor and is explicitly unsupported. A zero-leg all-dead Ending needs no new checkpoint and is not excluded by this guard.

An invariant-error pause has no certified autonomous recovery; preserve/export the source and diagnose it. An optional queued command must be handled by its existing authenticated queue path before re-querying, rather than discarded. A legacy current run must continue through its frozen legacy path. A new candidate that would exceed any dimension must not replace its earlier funded boundary; integrating and proving the corresponding rejection/recovery behavior is still outstanding.

## Integration still required

1. Assess the complete detached departure candidate before it becomes authoritative
2. Reassess every optional mutation and complete combat tick; reject an unfunded candidate while retaining the prior valid boundary and its still-available retreat
3. Enforce the named run and WorldEncounter quotas consistently; a natural-maximum claim is insufficient
4. Recognize actual reserved cancellation, death, checkpoint, discard and terminal transitions and release only the obligation they genuinely complete
5. Preserve recovery command identity, all dimensional limits, strict save/restore and real controller provenance
6. Keep frozen v7 and approved legacy continuation on their existing paths
7. Verify the integrated cap-edge interrupted/repeated recovery paths and UI before making a product-level guarantee

The standalone tests cover ordinary phases, exact wire and encounter-quota edges, independent ID deficits, replay-valid crowded run rows/bytes, full effect-ID width, old/unknown inputs, real interrupted emergency return, a real reached-checkpoint lifespan death and a resulting shared proof. A near-cap final-return discard uses current production hooks and strict restoration. These are targeted evidence, not a claim that the future hooks above have already been integrated or that every gameplay route has been revalidated here.

## Validation record

The parent integration runner reported the original nine tests passed (38.91 seconds), alongside both strict TypeScript checks and 1,026 locale keys. A separate four-case actual victory/return-mortality regression also passed (33.33 seconds). Those results preceded the latest namespace guard and additional tests.

The expanded 23-case file now adds genuine RewardPending retreat, production cancellation plus six resource discards, naturally reached home breakthrough cancellation, canonical namespaces, occupied future domain/build/cultivation command IDs and independent transfer/milestone/result IDs, both cultivation receipt-table channels, completed-namespace acceptance, a running all-permanently-dead controller import, month-skew imports, and the complete campaign-reader wrapper/character dimension. The reached-checkpoint death test also checks a reader-valid foreign death alias. The intervening 21-case run passed both strict type checks and 17 tests, but three new gameplay fixtures selected the 14-year-old non-worker and one invalid-sequence fixture expected the wrong rejection stage. Those fixtures have been corrected without changing age/work eligibility or weakening source validation. The next parent run passed both strict TypeScript checks and all 22 cases (44.63 seconds). The final narrow additions now bring the file to 23 cases: original next-run funding, the authority-receipt alias, a current result-ID collision in a real second encounter, and the reader-valid all-permanently-dead running-controller rejection. The first 23-case run passed both strict type checks and 21 tests. The crowded-run case exceeded its unchanged 30-second timeout, and the result-ID fixture had admitted second travel without actually reaching its encounter. The stress history now builds its known no-effect rows in bulk, compares a small sample with the real reducer, then fully replay-validates the large boundaries; its row/byte edges and timeout are unchanged. The encounter fixture now explicitly admits travel, advances it, asserts AtNode, enters combat and asserts InEncounter before aliasing. The corrected 23-case file is pending the next parent run.

No production admission hook has been switched to this helper. The remaining integration, transition-release, integrated cap-edge and browser proofs listed above remain open gates. This slice does not keep expanding into speculative future mechanisms.

## Parent-run focused verification, 2026-10-01 19:44 UTC

Both strict TypeScript checks and the complete 23-case focused file passed (37.11 seconds). The crowded-run pressure setup now constructs replay-valid import rows in linear batches, checks a one-row case against the real reducer, and fully replays the final 505/506-row and large-ID sources. Its original 30-second timeout and exact boundary assertions are unchanged. The second-encounter result-ID test explicitly admits and completes its next travel checkpoint before entering the real encounter.

This replaces the earlier focused-run failures; it does not certify the not-yet-connected runtime hooks, a full source-tree run, browser behavior, or default v8 activation.
