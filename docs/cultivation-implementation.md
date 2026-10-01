# Cultivation and legacy domain implementation

Status: pure domain and World/kernel integration implemented; parent verification is tracked separately. Battle settlement, full content progression, and browser UI acceptance remain separate work. Prototype data is unbalanced.

## Entry point and ownership

`src/core/cultivation/index.ts` exports:

- `createCultivator(discipleId, options)`
- `createCultivationState(disciples, calendarMonth)`
- `validateCultivationFrame(unknown)`
- `previewBreakthrough(frame, discipleId, preparation)`
- `applyCultivationCommand(frame, command)`
- `stepCultivationMonths(frame, months)`

The current serializable schema is `CultivationState.schemaVersion = 2`; frozen v3 World saves used cultivation-schema1. A `CultivationFrame` holds that state plus the existing shared `InventoryLedger`, `RandomStreams`, and `SequenceState`. A successful transition returns all four together. The integrating world must commit all four atomically at a complete command/month boundary. Failed transitions return the original frame and a stable error code.

No DOM, wall clock, timers, network, global randomness, or persistence APIs are used. This module imports existing deterministic numeric, RNG, ID, inventory, and source-ownership contracts.

### Integration constraints

1. Choose one owner for age progression. Do not increment both the existing World disciple age and this module's `ageMonths` for the same month.
2. Project initial disciples explicitly, rather than casting World disciples to `Cultivator`. This schema adds cultivation, lifespan, teaching, inheritance, and source ownership fields.
3. Use the world's shared ID sequences and random streams. Cultivation samples the existing `events` stream; its position in the world's deterministic system order must be fixed before integration.
4. Resource reservations are shared safely. This module validates its own escrow totals are covered by the shared ledger, and never spends food reserved by another system. The whole-world validator must still reconcile reservations across every subsystem.
5. Cultivation events use global `event:*` IDs, action roots, and explicit month numbers. The schema-v3 bridge mirrors them into the extended kernel event union without allocating a second event ID.
6. `DeathRecord.cleanupDiscipleId` and `revokedSourceInstanceIds` identify cleanup ownership. The World bridge now releases production jobs, seats and navigation. Full relationship and battle modifier cleanup remain with their respective future adapters.
7. Schema-v3 saves include command receipts, attempt samples, death archives and shared RNG state. Frozen v1/v2 migrations initialize the cultivation state explicitly, as described below.

## Command contract

Every command includes `commandId` and `expectedRevision`.

- Accepted command IDs persist their full canonical input fingerprint and result.
- Exact retries return the prior result with `replayed: true`; they add no event, ID, material debit, or random draw.
- Reusing an accepted ID with different arguments or revision is `COMMAND_CONFLICT`.
- A new command with an old revision is `REVISION_CONFLICT`.
- Rejected commands do not mutate state or create receipts. Retry with a fresh command ID after correcting the problem.

Commands:

- `breakthrough.confirm`: carries the complete pure preview
- `breakthrough.begin`: starts the reserved attempt
- `breakthrough.cancel`: releases reserved materials; already consumed meals are not refunded
- `breakthrough.resolve`: resolves a `DecisionReady` attempt with `acknowledgeRisk: true`
- `death.finalize`: explicitly acknowledges a pending natural death or supplies an already-confirmed permanent combat death
- `training.set`: chooses duty, training, or rest
- `legacy.setHeir`: designates a living heir
- `talent.grant`: installs one registered character-owned source
- `teaching.begin`: starts two months of teaching an already-known item to one living student

The acknowledgement flags are game-UI decisions, unrelated to external assistant confirmation policy. `UnitDowned` must never be passed as a permanent combat death.

## Breakthrough phases and risk

`previewBreakthrough` is a pure, serializable `Prepared` proposal. Confirmation recomputes the whole proposal, including the state revision, character state and shared inventory fingerprint. A changed injury, preparation, ledger, or revision invalidates the old preview. The UI cannot submit different success percentages or smaller costs.

Accepted lifecycle:

`Prepared proposal → Reserved → InSeclusion → DecisionReady → Resolved`

Cancellation produces `Cancelled` and releases outstanding material escrow. It is permitted before resolution, including at `DecisionReady`, because no outcome has been sampled yet. Resolved attempts cannot be cancelled or resampled.

The preview exposes:

- Material costs, monthly meal cost, and seclusion duration
- Factor-by-factor success probability in integer basis points
- Death probability conditional on failure
- Overall death probability, calculated separately
- Remaining lifespan and a warning if expiry occurs at or before the planned completion month
- Warnings when current unreserved meals cannot support the planned duration, or when a forced/high-risk attempt can kill

Success uses the design's bounded factor formula. Healthy standard early-realm failures have zero lethal probability. Forced attempts, serious existing injury, and higher-realm tribulation are explicitly exposed risk sources. All coefficients and realm requirements live in `rules.ts`; they are prototypes, not balance claims.

Material costs are reserved at confirmation and committed at resolution in the same returned frame as the outcome and RNG trace. Meals are spent one per progressed seclusion month. A food shortage blocks seclusion progress without spending reserved food; age still advances. This can extend a retreat past its initially projected completion date.

Resolution stores one `sampleId`, the success roll, the conditional fatal roll if needed, and event-stream before/after states. Outcome validation checks the trace against the deterministic RNG. Ordinary failure reduces cultivation and adds recoverable injury. Rest heals injury; further training repairs the cultivation deficit. Success changes the realm's absolute lifespan ceiling and resets cultivation progress, while preserving chronological age.

## Monthly order and bounded stepping

`stepCultivationMonths` accepts 0–12 months per call and at most 36 full disciples. It uses stable disciple-ID order.

For each month:

1. Advance the month and every living disciple's age
2. Mark anyone at their lifespan ceiling as `pendingDeath`; cancel/release their breakthrough escrow and stop incomplete teaching
3. Advance surviving seclusion, teaching, training, or rest
4. Complete the full monthly boundary, then stop if any expiry or breakthrough decision requires presentation

Thus a disciple who reaches their lifespan ceiling in the same month their breakthrough would complete expires first. The preview explicitly warns about that boundary. Other living disciples still finish that month's ordinary progress, so the returned state is a complete boundary.

Pending natural death does not silently transfer relics or finalize death. A later acknowledged `death.finalize` performs that transaction. A acknowledged breakthrough resolution may directly settle its previously previewed lethal branch.

No offline elapsed-time catch-up is inferred. The runtime must stop calling this module while hidden/paused and present pending decisions in the foreground. Further monthly stepping is blocked while any death or `DecisionReady` result awaits action. Integer exhaustion returns the last fully completed boundary.

## Death and inheritance

Death is deduplicated by both death ID and disciple identity. Archives retain the original disciple ID and learned history.

- Outstanding breakthrough reservations are released
- The deceased's permanent talent source instances are deactivated and listed for cross-domain cleanup
- Explicitly owned relic IDs transfer once to the living designated heir, or to sect custody
- Completed teachings remain on the student, with teacher and teaching-instance provenance
- Incomplete teaching is stopped; personal talents, untransmitted knowledge, and cultivation power are not copied
- Heir references to the deceased are cleared
- An all-dead state retains disciples, death records, receipts and sect relics; it does not erase the campaign

The three registered prototype cultivation talents supply small training, understanding, or recovery effects. They use the existing character/infinite-duration source contract. This is not the existing 36-node combat tree's point allocation or respec implementation; those definitions need an explicit later adapter. The module does not implement full relationships, successor appointment, revival choice, breakthrough medicine production chains, or content-complete late-game tuning.

## Validation and test scope

`tests/cultivation/cultivation.test.ts` covers risk decomposition, stale/forged previews, insufficient preparation/materials, resource reservations, cancellation, food shortage, successful/injurious/lethal outcomes, acknowledgement gates, duplicate/conflicting commands, no post-outcome reroll, monthly replay equivalence, same-month expiry priority, death-once and relic ownership, completed/incomplete teaching, owned talent revocation, malformed states and integer boundaries.

Input validation rejects unknown realms, invalid resource counts, uncovered escrow, mismatched registered costs/durations/risk factors, malformed sample traces, dangling identities, duplicate source instances, duplicated relic ownership and inconsistent lifecycle records. History collections are conservatively capped at 100,000 entries; archival/compaction is a later whole-save concern and must preserve deduplication information.

## World/kernel integration, schema v3

The isolated module is now connected to `World.cultivation` through `src/core/world/cultivation-bridge.ts`.

- `birthCalendarTick` is the chronology authority. Exact birthdays, including historical births offset from the global month boundary, synchronize cultivation ages without awarding monthly progress.
- Cultivation owns life, realms, preparation, teaching and inheritance. World disciple `ageMonths` / `lifeState` are compatibility projections validated against that authority. They must not be independently edited.
- Training, seclusion and teaching advance once when the management calendar crosses each 1200-tick month boundary. The bridge supplies exact birthday ages, disabling the standalone module's additional monthly age increment.
- Tick order is commands → clock → expiry/monthly cultivation → production. Expiry cancels the affected worker through the existing production transaction API before a same-tick storage delivery can commit.
- The dedicated `cultivation` pause reason is set for pending deaths or breakthrough decisions and cleared only when no such decision remains. Other pause owners are preserved. Foreground decisions use direct kernel dispatch while simulation stepping is paused.
- Kernel player commands use `kind: 'cultivation.command'`, `payload: { command }`; nested and outer command IDs must match. Accepted results expose `cultivationResult`; rejected domain actions return `CULTIVATION_REJECTED` with a `cultivationCode`.
- The player wrapper excludes `talent.grant` and non-lifespan death commands. Registered talents currently have no milestone/point-spending rules. Grants and permanent combat death are authority-only settlement operations; the UI must never expose arbitrary grants or force-death controls.
- Existing production reservations and breakthrough attempt escrows jointly account for the shared ledger exactly. Cross-domain instance-ID reuse, mismatched event projections and mismatched accepted command receipts are rejected.

Save version3 / simulation0.3.0 retains frozen v1/0.1.1 and v2/0.2.0 validators. The v1 navigation migration is pinned to historical output0.2.0 before the next step. Migration metadata reports the original version and checksum. Source strings remain unchanged; persistence export still returns original legacy text until an explicit new-generation save.

Legacy deceased characters receive explicit `legacy-unknown` archives; their recorded month is the migration observation month, not an invented death date. Living historical characters already beyond the introduced lifespan ceiling load as paused `pendingDeath` and require acknowledgement. Conflicting historical worker reservations are safely released using ordinary production cancellation. No migration samples RNG or grants knowledge, talents, relics or progression.

New worlds currently start with no learned knowledge, relics or granted cultivation talents. Teaching/legacy UI must display actual stored content rather than manufacturing selectable IDs.

### Remaining acceptance risks

- The production receipt/event ledgers and cultivation history can eventually push long campaigns over the existing4MiB file cap. Benchmarking and semantically safe archival/compaction remain follow-up work; do not prune deduplication receipts casually. No per-tick cultivation history events are added.
- Full relationship repair, combat-source removal, content-complete milestones/trees, campaign revival, and multi-hour balance are still outside this patch.
- This document describes implementation, not unrun integration/browser test results. Parent-run evidence is recorded separately.

## World schema v4: builds and expedition ownership

Current World save/simulation versions are4 /0.4.0. Cultivation schema2 adds `activityOwner: { kind: 'expedition', runId, lockId } | null` to each profile. Frozen cultivation-schema1 remains separately validated when reading v3 sources.

Away profiles continue birthday aging and lifespan checks, while training, rest and teaching grant no progress. The original trainingMode remains the return intention. Player role/build changes are locked; pending natural death can still be acknowledged. Dead expedition members retain their exact profile/build lock until the run adapter settles and releases all members. The kernel reconciles newly finalized deaths into the run in the same outer World transaction.

Permanent builds are in `World.builds`, share global ID sequences, and use the same frozen authored catalog as expeditions. Bootstrap creates registered starter equipment/skills in deterministic school order and allocates9 instance IDs per existing identity. No new tree points are given merely for migration: existing authoritative realm attainment produces one keyed milestone award per earned realm, with namespace-reserved authority receipts. New mortal characters have zero earned points. Empty historical identity archives remain empty and allocate nothing.

The public kernel `build.command` wrapper accepts only the build module's player union. Realm awards, equipment grants and expedition locks are authority-only. Slash-delimited authority command IDs cannot collide with the kernel's player ID grammar. `expedition.command` similarly accepts only its bounded player union; encounter outcomes, elapsed months, deaths and return settlements are trusted adapter operations.

The independent `expedition` pause owner preserves player, hidden, choice and cultivation pauses. Before/after tick hooks never recursively call advanceTicks. An exact reached travel checkpoint may be committed before the next clock tick; otherwise ordinary kernel stepping advances chronology, cultivation and production once, then the encounter controller/checkpoint adapter.

Departure atomically moves supplies out of the shared inventory into the run's sole cargo ledger. There is no second travel inventory or persistent World travel reservation. The expedition domain freezes each admitted month's living roster and prepaid food cost; committing that checkpoint does not debit it a second time. Source-owned profile and build locks are checked against the same run member lock IDs.

Source v1/v2/v3 validators run before migration. The chain is explicit1→2→3→4, and old source checksums/strings are retained for export. Registered build initialization intentionally advances only the required new instance IDs; original simulation identities, RNG and progression remain intact. A genuine v3 in-progress fixture and a genuine schema-valid empty archive were captured from committed b230078 before version changes.

New World integration tests cover milestone-derived points, legal spending, public authority rejection, away age without free progression, lock/source tampering, v3 source preservation and empty migration. Parent-run verification results are tracked separately; this section does not claim an unrun test or browser pass.
