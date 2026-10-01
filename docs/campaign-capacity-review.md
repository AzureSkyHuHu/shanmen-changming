# v8 campaign capacity and settlement review

Date: 2026-10-01, reviewed 15:00–15:13 UTC. This is a review of the shared working tree and a narrowly implemented build-history reservation component. It is **not** a whole-World byte-bound proof, v8 release acceptance, long-campaign certification, or browser result.

## 1. Verified deliverable and remaining gate

Implemented only:

- `src/core/save-budget/build-obligations.ts`
- `tests/save-budget/build-obligations.test.ts`

The integration owner reported **36 focused tests passed and both strict TypeScript projects passed** at 15:12 UTC. A transient TS7022 inference error in the work-in-progress module was fixed with an explicit member type, without changing strict compiler settings. The review worker did not run tests, installation, builds, or Git operations. This document is the only subsequent addition by that worker; the two code files remain frozen after that validation report.

The implemented API proves a conservative count of outstanding **build command-history entries**, conditional on the World adapter supplying the complete authenticated facts and re-admitting all new obligations. It does not measure future bytes, cultivation collection limits, World archive expansion, battle peaks, or sequence headroom. Those remain integration gates below.

## 2. Failure modes in the existing boundary

`builds/v2.ts` checks `history.length >= maximumCommands` before every new accepted command. Every accepted command appends one history entry and one receipt and increments revision, including a fresh-ID command whose effect is otherwise a no-op.

The existing `save-budget/admission.ts` reserves production work, pending supported commands, journal growth, and a 1 MiB nonautomatic safety margin. It does not reserve build commands or cultivation collections. Consequently, without the new integration:

1. A departure can consume the last build history slot on its multi-member lock and later have no slot for its unlock
2. A teaching plan can be admitted with no space for the build knowledge grant two months later
3. A finalized death can lack its retirement, equipment-transfer, cultivation-archive, or World-archive capacity
4. An unrelated new claim, build edit, tactical command, or rejected public command can consume capacity needed by those prior commitments
5. Counting only the small `CampaignClear` misses the full registered Ended-run evidence retained for each first clear

Rollback preserves the previous exportable state but does not by itself provide a way to finish these commitments. A repeatedly failing mandatory terminal transition is still a gameplay deadlock.

## 3. Build-history reservation contract

### API

`assessBuildHistoryObligations(facts)` returns:

- `historyCount`, `maximumCommands`
- `remainingCommands = maximumCommands - historyCount`
- `reservedCommands`, with the component breakdown below
- `availableCommands = remainingCommands - reservedCommands`
- `fits = availableCommands >= 0`

Inputs are a read-only derived DTO, not saved budget authority:

| Field | Required meaning |
| --- | --- |
| `disciples` | All not-yet-retired build identities, including finalized deaths awaiting cleanup; each has `discipleId`, `lifeState`, and current `heirId` |
| `retiredDiscipleIds` | Known retired identities, used to distinguish an already dead target from a dangling reference |
| `equipment` | Every equipment instance exactly once; `ownerDiscipleId: null` means sect-estate ownership |
| `pendingEstates` | Every unsettled death estate, whether locked or unlocked; its committed `beneficiaryId` overrides the deceased owner's `heirId` |
| `teachingIds` | Distinct admitted teachings whose build grants have not been committed |
| `realmMilestoneIds` | Distinct missing realm awards, plus possible target awards for accepted Reserved/InSeclusion/DecisionReady breakthroughs |
| `activeRun` | An uncompleted run owes one multi-member unlock; `firstVictoryDiscipleIds` lists at most six surviving/pending members still eligible for their first-victory award |

The adapter must derive a pending-estate edge from the actual finalized death beneficiary if a migration has not yet materialized the estate record. A publishable boundary cannot contain an item still owned by a retired disciple: retirement plus all promised transfers must be atomic.

Malformed facts throw `TypeError`. Validation rejects unsafe/fractional/out-of-range counts, unknown fields, accessors, sparse arrays, non-plain records, duplicate identities/items/obligations, live/retired overlap, dangling owners or heirs, self inheritance, a dead owner without its pending estate, a pending estate for a living owner, and invalid first-victory recipients. Input data is not mutated or frozen. Result objects are owned and frozen. This local structural validation does not replace cross-domain provenance validation by World.

### Formula

Let:

- `H` be existing build history entries, with the unchanged limit of 1024
- `D` be not-yet-retired build identities
- `E` be equipment still owned by those identities, excluding items already in the sect estate
- `L(item)` be the number of distinct future owners along that item's current effective inheritance chain
- `T`, `A`, `U`, and `V` be teaching grants, realm awards, run unlocks, and first-victory awards

Then:

`R = D + sum(L(item)) + T + A + U + V`

The death portion is bounded by `D + E*D`. **This is an upper bound, not a second reservation to add to the chain calculation.** Do not separately reserve the same deaths again for expedition members or pending estate records.

The chain includes the current owner. For a finalized owner, use the pending estate's committed beneficiary; otherwise use its current heir. A recipient must still be alive to inherit. Null, pendingDeath, dead, or retired recipients terminate at the sect estate, without relaying through their heirs. Repeated identities terminate the walk: an inheritance cycle cannot make an identity die twice.

Every fresh command must preserve `H + R <= maximumCommands` in its complete candidate. Exact receipt retries are resolved first. Changing heirs, assigning an estate item, adding a person/item, or changing other commitments can increase `R` even if that command itself uses no build-history row.

### Why a single-transfer-per-item reserve is insufficient

If A dies and transfers an item to living B, the item still needs B's later death transfer. A naive `D + E` reserve does not decrease for that transfer, while `H` increases. The chain reserve pays one row now and preserves the remaining suffix of the item's chain.

When an owner retires, its retirement term disappears and its items' chains each lose at least one step, or end at the estate. Other chains can only shorten as dead targets are cleared. Therefore an atomic retirement and its transfers do not increase `H + R`. All new heir edits or ownership grants must be re-admitted to preserve this property.

### Concrete population boundaries

| Facts | Death reserve |
| --- | ---: |
| Initial four people, twelve training items, no heirs | 16 |
| Coarse bound for that same initial roster | 52, **not additionally charged** |
| 36 people, 108 training items, no heirs | 144 |
| 36 people, 512 owned items, no heirs | 548 |
| 36-owner chain, all 512 items at its start | 18,468; correctly unfundable under 1024 |

These are derived-fact bound fixtures, not claims that every fixture is reachable with the stated current history count. Existing history also uses the 1024 slots.

Using the coarse quadratic bound everywhere would unnecessarily restrict population: with three items per person, 18 people already reserve 990 death rows before enrollment/history or other commitments; 19 require 1102. With four additional campaign items, the 18-person coarse bound is 1062. The implemented actual-chain method avoids that false restriction when no long inheritance chain was promised.

## 4. Exact immediate build operation counts

Every row below includes one build receipt for each build history entry.

| Transition | Build commands | Other bounded growth |
| --- | ---: | --- |
| Expedition departure | 1 multi-member lock | Current departure candidate pays this immediately |
| Expedition settlement | 1 multi-member unlock + 0–6 first-victory awards | No separate per-member unlock |
| Teaching completion | 1 `skill.grantKnowledge` | No new installed source or cultivation acknowledgement command |
| Successful breakthrough | 1 realm milestone award | Only if not already awarded |
| One finalized death | 1 `disciple.retire` + one `equipment.transfer` per owned item | Retirement retains up to 11 source-removal operations: three skills, three equipment sources, five tree nodes |
| Equipment claim | 1 `equipment.grant` | One new equipment instance ID; increase its future death-chain obligation |
| Lesson claim | 1 `skill.grantKnowledge` | One cultivation authority grant; no new source until equipped |
| Recruit or relief | 1 `disciple.enroll` | Three items, six sources, nine instance IDs, one World entity ID, one cultivation enrollment |
| Recovery | 2 `disciple.enroll` | Six items, twelve sources, eighteen instance IDs, two World entity IDs, two cultivation enrollments, resource credit |
| Estate assignment | 1 `equipment.transfer` | No equip/source installation; changes the item's future ownership-chain obligation |

The authority APIs are not evidence of a real campaign claim, teaching completion, or death. World provenance checks remain mandatory.

## 5. Other finite histories and collection bounds

### Cultivation v3

The following top-level arrays each have a separate 100,000-entry validator ceiling: disciples, attempts, pendingDeaths, deaths, sectRelicIds, receipts, events, legacyIdentities, archivedDisciples, and authorityReceipts. The active full roster additionally remains capped at 36.

- One finalized death produces one `DeathRecord` and one `cultivation.died` event. A `death.finalize` command adds one ordinary cultivation receipt; combat uses an internal cultivation command, while lifespan finalization also has a public World receipt
- Lifespan expiry first adds one pending-death record and one `cultivation.expiryPending` event. If it cancels an active breakthrough, cancellation adds another event. Finalization removes the pending record and adds the death record
- Archiving each deceased cultivator adds one authority receipt and one archived summary. World also retains one archived identity and one estate record
- Teaching start adds one ordinary cultivation receipt and one started event. Completion adds one learned-knowledge entry and one taught event, plus the single build grant. There is **no** extra cultivation completion receipt
- From an accepted Reserved breakthrough, reserving two further ordinary cultivation/public receipts for begin plus resolve-or-cancel is conservative. Separately reserve each person's possible death-finalization receipt. Up to three additional attempt events (started, ready, resolved, with cancellation replacing the appropriate terminal path) plus the person's expiry/died event reserve cover the terminal branches. Avoid charging those general death events twice
- Cultivation events are also published into permanent World event history. The same event identity appears in two storage domains; measure both representations, without allocating a second event ID
- Relic transfer copies IDs into the death record and moves ownership to an heir or sectRelicIds. Account for the actual existing relic lists and final sectRelicIds capacity; legacy inputs do not have a small fixed relic-list assumption

The month engine allocates shared month/action metadata even if multiple teachings complete together. Numeric revisions and sequences require separate safe-integer headroom; table rows alone do not prove they can advance.

### World history archive

Keep all existing limits and accounting:

- 100,000 records per production, command-receipt, and event table
- 64 Mi canonical decoded UTF-16 characters
- 4,000,000 charged decoded nodes, including the codec's 32 units per record
- Exact recent tails plus authenticated archived counters

Use `retainedRecordBytes` or an equivalent bound covering raw fallback rows, pooling, separators, new pages, and count-digit growth. Do not count a new campaign command as a zero-byte pending operation. Unsupported imported pending effects remain unknown rather than receiving invented capacity.

### Domain validation/snapshot bounds

- Builds: 1024 commands, 512 equipment, 36 active builds; `builds/shared.ts::assertJson` also limits traversal to 300,000 nodes and imposes field/collection/string bounds
- Campaign: 2048 claims, five first-clear facts; `campaign/shared.ts::assertJson` limits traversal to 200,000 nodes
- Build and cultivation standalone snapshots: 4,000,000 UTF-16 characters
- Campaign standalone snapshot: 2,000,000 UTF-16 characters
- Registered expedition's inner snapshot: 4,000,000 UTF-16 characters, 512 domain commands, and its JSON tree bounds
- Whole World: 4,194,304 **UTF-8 bytes**, including its envelope and worst legal metadata

The standalone limits do not allocate that much space to each domain inside World. When World validation serializes through these readers, their independent limits must also remain funded.

## 6. Registered-run remaining obligations

All five currently registered campaign routes have three encounters, one travel month per encounter, and one return month. World departure admits at most six people. For a normal complete victory:

| Domain work | Commands/receipts |
| --- | ---: |
| Depart | 1 |
| Four months, each admit + commit | 8 |
| Three encounter begin + resolve pairs | 6 |
| Two reward resolutions | 2 |
| Settle | 1 |
| Total | 18 |

There can additionally be at most two successful rerolls, at most six separate natural-death batches, and at most one effective safe-retreat transition. Thus **27 total progressing domain commands is a conservative route-specific envelope**, including mutually exclusive branches. Departure currently consumes depart plus first time admission, leaving at most 25 of that envelope. This is not a cap on arbitrary new-ID no-op commands: repeated admission of an already admitted checkpoint and other optional commands must be charged/rejected separately while preserving necessary completion space.

A conservative effect-receipt envelope is 24: departure 1 + month effects 8 + encounter effects 6 + talent commits 2 + natural-death effects 6 + settlement 1. Other bounded records include three encounter results, four completed travel checkpoints, two offers, at most six permanent-death mappings, and one World run-history row. An all-dead run can shorten the route and return, but must still unlock and archive safely.

The first clear of a route also retains one complete `RegisteredExpedition` Ended proof in `WorldCampaignState.clearEvidence`, in addition to the small campaign clear and the live/last run. At most five such proofs exist, but their command histories, origins, offers, and outcome records are still substantial and must be included in future bytes. Replays of a cleared route do not append another proof.

World receipts for necessary player continuations/reward choices must also be reserved. Unlimited fresh-ID tactics, redundant continues, invalid attempts, and unrelated commands are new requests, not an entitlement to consume the run's settlement reserve.

### Full inventory remains a release dependency

`runSettled` can currently stop at `INVENTORY_FULL`. `inventory.discard` itself adds a permanent World event and receipt. If those necessary space-clearing actions cannot fit, merely reserving the run's unlock is insufficient. There are six registered resource types; a finite clearance plan can reserve the actual required discard commands, while preventing automatic production from immediately refilling the freed capacity.

If the incoming quantity of one resource alone exceeds its total storage capacity, discarding current stock cannot solve it. That case requires an explicit existing recovery/overflow/disposition contract, or must be ruled out before departure. This review does not invent such a gameplay rule.

## 7. Byte-proof design, still unimplemented

### Measurable future record envelopes

For each future terminal operation, construct typed maximum fixtures and measure them with `canonicalUtf8ByteLength`. Include:

- The domain history entry and receipt, including JSON-escaped fingerprints
- Source-operation copies, ownership tags, learned-knowledge/retired summaries, and their array/object punctuation
- Cultivation receipt/event and World event/archive representations
- World estate `itemInstanceIds`, `transferCommandIds`, `settledOwner`, deceased identity, and terminal metadata
- Maximum legal identity widths, sixteen-digit safe integers, sequence/revision field growth, and escaped save metadata
- Actual retained legacy extension fields and actual relic/knowledge lists; do not replace accepted large legacy data with a modern small fixture

For build transfers, the chain count can multiply a proved maximum transfer-record envelope. For retirement, use the actual retained skills/sources where possible and a proved maximum of future changed fields. New learning, source changes, items, and heir changes must re-admit the increased future record envelope.

### Owner-based remaining byte potential

Use explicit owners such as teachingId, runId, and deathId/estateId. A run budget must include remaining run growth, one live battle peak, necessary domain/World receipts, final history/clear, and its possible full Ended proof copy.

For a bounded owner component, prefer:

`used owner bytes + remaining reserve = proved owner ceiling`

Count the current World once and reserve only the justified remaining growth, or fund both a deliberately double-counted current maximum and its future reserve at admission. Do not reserve a constant small number and then assume every actual state expansion consumes that reserve automatically. Keep the obligation through all intermediate in-memory steps and release it only after the complete transaction commits.

The aggregate condition remains current exact World bytes + existing production obligations + progression/run obligations + journal/pending obligations + any additional safety margin <= 4,194,304. The generic 1 MiB remains a safety margin, not the proof.

### Explicit unresolved byte questions

1. No numeric maximal fixtures for the new World estate/archive/proof shapes were implemented or executed in this review
2. Battle runtime permits up to 4096 live contributions/sources in several collections, 128 zones, 72 summons, 256 retained completed actions plus active actions, retained root/proc data, and the World battle log. These broad legal caps do not establish a peak below World 4 MiB. The standalone battle/controller reader limits of 8M/16M characters cannot be used as a World guarantee
3. Derive a bound for the registered route, actual <=6-person locked loadouts, legal future talent choices, and reachable content effects; or adopt a separately versioned tighter state budget/recoverable terminal protocol. Sampled simulations are useful evidence, not a worst-case proof
4. The old v7 corpus may already contain an accepted run/teaching with too few remaining build rows or bytes. An unchanged 1024 cap cannot retroactively create its missing reserve. Preserve source bytes and expose an explicit supported recovery/read-only boundary; a stronger compatibility promise needs a separate versioned retention design
5. Near-safe-integer ID, tick, RNG-draw, and revision limits need their own remaining-operation analysis. For example, enrollment consumes nine instance IDs; death/expiry and teaching still need event/action identities even when no new item/source is created

## 8. Safe terminal ordering

All steps below occur in one candidate boundary, never as independently published states:

1. Resolve existing World receipt equality/conflict before admission or allocation
2. For a new operation, assess its complete candidate and all old/new obligations
3. Perform the existing cultivation death and production/teaching/breakthrough cleanup exactly once; record the death-keyed estate with original item IDs and its committed beneficiary
4. If the deceased build is locked, retain it, its sources/lock hash, and its estate obligation until run settlement
5. At `runSettled`, apply the normal resource-settlement checks, then unlock the entire squad with the original lock hashes and clear cultivation activity ownership
6. Record actual surviving first-victory awards and the route's first-clear proof/fact only in the same successful candidate
7. Retire each deceased build, removing its sources, then transfer each same equipment instance to the still-living beneficiary or the sect estate. A living away heir gains ownership only, without loadout/source/lock mutation
8. Archive the cultivation profile and World identity after external executable ownership/references are gone
9. Insert all required events/receipts, validate cross-domain provenance and every actual/future capacity dimension, and publish once

The two-month cultivation engine clears `teacher.teaching` when it emits `cultivation.taught`. Keep the pre-transition plan available until the build grant succeeds and the final candidate is admitted. Never publish or classify release from the intermediate plan-disappeared state.

An existing-obligation release path is allowed only when a recognized owner is consumed or its future work is reduced; its actual snapshot fits all hard limits and its complete current-plus-reserved cost does not increase in any relevant capacity dimension. It is not a blanket bypass for any successful command, resource discard, or smaller production count.

## 9. World integration seams

| File/symbol | Required integration work |
| --- | --- |
| `save-budget/admission.ts`: `AutomaticSaveBudgetInput`, `assessAutomaticWorkBudget`, `verifySaveCandidate`, `verifyReservedRelease` | Carry/derive full progression budgets and all capacity dimensions; preserve production/journal obligations; classify recognized terminal consumption |
| `save-budget/retention.ts`: `assessHistorySlots`, `assessHistoryExpansion` | Include progression's future World receipts/events and decoded expansion without changing codec limits |
| `world/automatic-work-bridge.ts`: `worldAutomaticBudgetInput` | Derive current v8 facts, pass the actual save version, prevent automatic work from spending other owners' reserve |
| `kernel/commands.ts`: `dispatchCommand`, `enqueueCommands`, `isSaveCapacityError` | Exact retries first; transient nonrecording new-capacity refusals; queue/in-flight obligations; typed handling of finite-domain exhaustion |
| `kernel/simulation.ts`: `checkTickCandidate`, `obligationMutation`, `capacityStopped` | Check complete month/death/battle transitions; recognize nonproduction releases; preserve the prior exportable boundary and one bounded pause |
| `world/cultivation-bridge.ts`: `publishFrame`, `dispatchWorldCultivation`, `advanceWorldCultivation` | Atomically publish teaching grants, realm awards, death cleanup, events, and changed obligation owners |
| `world/build-bridge.ts`: `reconcileWorldRealmMilestones`, `dispatchWorldBuild` | Fund future realm awards and re-admit build operations; protect ongoing teaching prerequisites |
| `expeditions/world-adapter.ts`: `startDeparture`, `applyEffect`, `settleReady`, before/after tick hooks | Reserve run completion before departure, use selected registered protocol, unlock before retirement, fund full first-clear proof |
| v8 `world/campaign-bridge.ts`, `world/legacy-bridge.ts`, `world/validate-campaign.ts`, `world/campaign-state.ts` | Claims, estates, archived identity/proof ownership, precise DTO derivation, complete atomic validation |
| `kernel/save.ts`, migrations and World validators | Actual v8 identity; frozen old source validation; no invented guarantee for an unfunded imported commitment |

The current snapshot sizing code contains explicit `saveVersion: 7` in several of the above paths. Move those coherently with the actual v8 activation; version width currently matches, but keeping an obsolete version is not a sound contract.

### Additional asynchronous semantic hazard

The reviewed `dispatchWorldBuild` only blocks activity ownership, not a student whose teaching is in progress. A student can otherwise learn the same skill first, or respec away a prerequisite, making the future teaching build grant invalid even with sufficient capacity. Admission and intervening build actions must preserve the agreed teaching contract. Do not fix that by silently dropping provenance or ignoring a failed grant.

## 10. Focused regression matrix

### Already tested in the pure module (integration-owner report)

- Initial no-heir reserve 16; no duplicate coarse-bound charge
- Equality at the ledger cap, one new-row refusal, and actual reserved death/teaching consumption
- Longest 36-owner/512-item chain, no-chain equivalent, cycles and out-of-order deaths
- Dead/pending/retired recipients, pending estate beneficiary override, beneficiary dying before unlock
- Completed retire/transfer not counted again; estate assignment recreates its future obligation
- Teaching, realm, one unlock, and first-victory components added once
- All 24 death orders for each of two four-person inheritance graphs, checking `H + R` does not increase at each atomic retirement
- Mutation/freeze ownership, input-order invariance, duplicate/dangling/unsafe/nondatum rejection

### Still required at World level

| Scenario | Required assertion |
| --- | --- |
| Departure near 1024, one row short of future unlock/awards | Reject before departure without ID/resource/receipt changes |
| Exactly funded run/teaching; spam optional/failing/fresh-ID commands | New requests fail transiently; the existing commitment still finishes |
| Six expedition deaths, full lock set, away heir | Unlock once using unchanged hashes; retire/transfer/archive once; heir loadout unchanged |
| Heir chain/cycle edits near cap; heir dies before old estate releases | Re-admit only growing promises; preserve the original committed beneficiary fact and safe estate fallback |
| Up to 36 same-month expiries, active attempts/teachings and production | Every required event, receipt, cancellation, death/archive fits; no half month or partial cleanup |
| Teaching completes while teacher dies later, or student tries duplicate study/respec | Legal knowledge is granted once; incompatible new commands do not strand completion |
| First/third/fifth full registered clear proof near 4 MiB | Entire proof copy and remaining commitments funded; no accepted half clear |
| World history tables, expanded characters/nodes, cultivation arrays, build/campaign tree limits independently near cap | Relevant dimension stops new growth before it blocks a prior terminal transition |
| Full inventory at return and near World receipt/event cap | Finite authorized clearance/recovery path remains executable; no discard-receipt deadlock |
| Queued command dispatch and temporary auto pins | Due/in-flight ownership remains visible until its actual settlement; no premature release |
| Legacy v7 active run/teaching and long fields | Original bytes preserved; any unsupported recovery is explicit; no limit widening or silent pruning |
| Claim fails at final byte/provenance check | Entire candidate discarded; costs, IDs, grants, campaign state, receipts, and assets unchanged |
| Save/reload at each release boundary and exact command retry | Same eventual state, same receipts, no repeated transfers/awards, no reused identity |
| Near-safe-integer sequence/revision limits | New commitments are not accepted without enough terminal identity/revision headroom |

Completion of the pure row-count module does not close any of these World-level byte, lifecycle, replay, migration, or browser gates by itself.
