# Internal v9 finite teaching continuation stage

Status: integration-verified on 2026-10-02. Frozen source 495094c passed the complete serial check: 138 files / 2615 tests, both typechecks, content/boundaries and production build. The author did not run parallel checks; the integration result is recorded below. This does not register a codec, save/import capability, Session, UI, content entry point or gameplay milestone.

## Compatibility boundary

- `deriveProgressionReservations` keeps its original whole-month operands, numeric diagnostic order and frozen result. Its record derivation/numeric tail are extracted, not replaced with a v9 policy.
- `assessManagementCapacityV9`, the `.3` record-only command/tick APIs and all v7/v8 entry points retain their existing behavior.
- Only the separately named `deriveProgressionReservationsTimeV9` and `assessTeachingManagementCapacityV9` feed the internal gated runtime. The new derivation starts with a numeric-free record envelope and actually computes fresh numeric evidence from its v9 operands. It never clears an old failed numeric result or diagnostic.
- The five-scalar private idle carry still excludes teaching, attempts and work. Teaching-bearing boundaries always use exact assessments; carried conservative reserves never authorize releases.

## Finite time and rows

Let `T = 1200`, `phase = calendarTick % T`, and `S` be the **sum** of all already-funded remaining teaching/seclusion months from the existing progression owner derivation. The shared finite horizon is `H = S > 0 ? T*S - phase : 0`. The phase is subtracted once globally; parallel lessons do not use a maximum. Per-owner nominal whole-month fields remain identifiers of owned months; only the adjusted total is shared clock authority.

The new query reserves H once in each of simulation tick, calendar tick, construction revision, production revision and research revision. The three sect revisions retain their independent terminal allowances in addition to H. No teaching ticks are charged to care revision, which the actual idle reducer does not increment.

Month rows are the actual month boundaries in `(calendarTick, calendarTick + H]`. Off-month birthday rows are the actual distinct living birthday residues in that interval; simultaneous birthdays coalesce and residue zero coalesces with the month row. Existing progression month action/revision costs remain intact; only off-month groups add actions/revisions. Existing alive lifecycle trigger rows remain reserved. Paused calls advance neither time nor these reservations.

S deliberately remains an upper bound after cancelling unrelated attempts or when parallel lessons progress together. It is never a promise that supply-blocked seclusion finishes, or that arbitrary work/path/storage blocking is affordable.

## Proved teaching subset

Both source and candidate must have pairwise-disjoint teacher/student pairs. Each participant is alive, home, not traveling, without an attempt, external activity/build lock, assignment, care or other work owner. The teacher still owns the requested knowledge and the student does not. A student cannot simultaneously be a teacher; incoming/outgoing chains, cycles and shared roles are unsupported. New commands that introduce an unsupported combination are discarded atomically. Structurally valid but unprovable historical `.3` sources are explicitly refused at construction/replacement/advance rather than admitted into a stranded runtime.

Every teaching-bearing transition is authenticated against a complete actual next-tick preparation, or an actual immediate command preparation recovered from its newly recorded receipt. This comparison binds lesson identity, participants, knowledge, progress, due month, taught event/provenance and death cleanup to real reducers, including when both assessments fit. Forged progress, shorter deadlines, changed participants and mere owner disappearance do not confer authority. The original terminal discharge checks remain in place, behind this stronger transition authentication.

## Explicit reachable recovery route

The no-optional tick still runs old production. Blocked-event churn is therefore **not free** and is not funded as an arbitrary horizon.

`inspectTeachingContinuationV9` reports `recoveryActions`: actual player-callable cancellation commands for unrelated legacy production, planned/active construction, sect production, research, care and breakthrough attempts, followed by any existing pending-death finalization. This is a conservative chosen route; it is not an automatic cancellation policy. No reported command is executed on the user's source. The caller must request these actions explicitly to follow the route; future pending deaths require their real finalization when reached. Ordinary external pauses must be resumed explicitly.

The proof prepares each command against the previous complete candidate, checks accepted results and exact source validation, freshly measures capacity, verifies every deficient dimension is nonincreasing, and requires existing authenticated cancellation/death discharge evidence. The final route boundary must fit the entire remaining lesson horizon. The first real no-optional tick is also checked when unpaused. Cancellation that fails because of terrain, positions, claims, IDs, resources or receipt/counter capacity makes this subset unsupported. No owner is deleted, no worker is teleported, and no eventual work completion is assumed.

After this route, no old work or attempt remains to churn or pause on seclusion. No-optional ticks suppress new planner starts and maintenance purchases, while the H/clock/lifecycle/record envelopes fund the finite lesson path. A real participant death can end a lesson early; an unrelated death pauses and retains its genuine lifecycle/finalization route.

## Authored validation

- Phases 0, 1 and 1199; one/two disjoint lessons; sum-not-max and one global phase subtraction
- Exact tick-by-tick revision spending and grouped birthday edge accounting
- New numeric calculation versus preserved failed old numeric evidence (explicitly unreachable arithmetic fixture)
- Full real two-month continuation at exact three-revision headroom, split into 40 bounded 60-tick checkpoints; strict/private snapshots agree at every checkpoint; one-short sources and commands reject
- Pause/resume, participant and unrelated death, authentic finalization/archives, forged progress/deadline/identity/owner-drop rejection
- Student breakthrough and incoming/outgoing teaching-role rejection while record-only `.3` behavior is preserved
- Real blocked old production plus supply-blocked seclusion, explicit cancellation and a subsequent 1200-tick continuation split into 20 bounded checkpoints
- Successful construction and sect-production cancellation routes preserve paired settlement evidence and actual positions, then resume real lesson ticks
- Surviving lesson reaches genuine completion after unrelated expiry/finalization, with all remaining 2399 fixed ticks split into 40 bounded checkpoints and strict/private equality
- Deficient-byte source with a genuine cancellation route restoring finite lesson capacity; unreachable cancellation due to terrain/position
- Separate action, byte, revision, clock row/structural-node and archive arithmetic edges; invalid chronology/counter-pressure fixtures are labelled and never admitted as real sources
- Existing blanket-exclusion tests now accept the proved subset and retain explicit unsafe-headroom rejection and retry/conflict protection

No timeout is raised, no global runner settings are changed, and the full continuation proof never substitutes month jumps for fixed ticks. The within-month setup and synthetic counter/row pressures are explicitly labelled. Correctness is separate from the unresolved active-work/heavy-history performance gate. The exposed runtime metrics count top-level source/candidate queries; this stage adds bounded recovery-route subqueries and reducer replays and makes no teaching throughput claim.

## Integration reconciliation

The staged private runtime includes the current history-only internal-candidate adapter unchanged: only the archive module may authenticate/preserve its immutable identity; source/replacement imports and snapshot exports still detach. All accompanying archive-preservation, isolation, retry and hostile-getter tests are retained. Their capacity spies now target the new gated sizing entry point. Exported runtime metric declarations explicitly exclude internal teaching recovery assessments/replays from `fullQueries`; no authority callbacks or behavior-changing metric hooks were added.

## Parent validation (2026-10-02 11:31 UTC)

Frozen source commit `495094c13338d0d42b86e83f2c18e0907f84e794`, tree `045d99ddfe4d2edc910bd4c85a0746bb74d9cd50`, passed the complete check: 138 files / 2615 tests in 789.35 seconds, 1041 Chinese keys, content/boundaries, both strict typechecks and production build. An initial focused assertion incorrectly expected a real cultivation rejection to leave no receipt; it now checks exact established rejection-receipt and retry equivalence without changing production behavior. No teaching performance or browser acceptance is claimed.
