# Progression terminal-record envelope contract

Status: candidate implementation, not a World v8 activation or a complete saveability proof. Repository validation is owned by the integration owner; the worker that wrote this module did not run tests, builds, installation or Git commands.

## API and trust boundary

`deriveProgressionReservations({ world, buildFacts })` is a pure query in `src/core/save-budget/progression-bounds.ts`.

- `world` is an already authenticated, complete `WorldStateV8` boundary
- `buildFacts` comes from `worldBuildHistoryObligationFacts(world)`; it is not saved state, an import field, or caller-supplied budget authority
- The module checks data-only structure without evaluating accessors, checks correspondence of the current build identities/equipment/lifecycle facts, and reuses `assessBuildHistoryObligations`
- It does not replace domain replay, World validation, source-proof validation or candidate byte measurement
- `supported` means a finite envelope was derived for the enumerated covered records. It does not mean that the current candidate plus this envelope fits any capacity
- A failed record derivation returns `supported: false` and diagnostic `unknowns`; derivation errors clear partial owners and totals
- `numeric` is an independent numeric-gate report. Its `fits` checks only enumerated terminal counter requirements, and `uncovered` states the remaining shared-month, lifetime, production/run/battle and RNG analysis. A successful byte derivation does not authorize ignoring either this gate or its uncovered scope
- Inputs, random streams and ID sequences are never changed or consumed. Returned amounts and detail records are owned and frozen

## Fields and aggregation

Each owner and `totals` contain:

| Field | Meaning |
| --- | --- |
| `bytes` | Additional encoded bytes for covered future domain records, mutable-field growth, and World event/receipt representations |
| `archiveBytes` | The World event/receipt portion of `bytes`; do not add it to `bytes` again |
| `archiveRows` | Future World event and command-receipt rows; no production rows |
| `archiveDecodedCharacters` | Exact canonical UTF-16 character charges of decoded World records |
| `archiveDecodedNodes` | Value-node charges of those records, already including the codec's 32-node surcharge per row |
| `domainDecodedCharacters`, `domainDecodedNodes` | Covered non-archive record growth, with no World codec surcharge |
| `cultivationRows` | Future ordinary receipts, events, pending deaths, deaths, archived profiles and authority receipts |
| `buildRows` | Future paired build-history and build-receipt records; equal to the existing exact build-obligation count |
| `buildCollections` | Same build history/receipt counts plus retirement, award and learned-skill record counts |
| `legacyRows` | Future World estate and archived-identity records |
| `sequenceReserve` | IDs needed by the enumerated terminal operations and finite required progress steps; no speculative new enrollments |
| `counterReserve` | Enumerated cultivation revision/calendar steps and number of breakthrough samples; samples are not raw RNG draws |
| `records` | Per-owner labeled record charges and domain/replacement/World-archive placement |
| `discharge` | Complete-candidate ownership requirements, not an instruction to mutate a saved budget |

The current complete World is measured once by the aggregator. Do not add `buildRows` to another copy of `assessBuildHistoryObligations(...).reservedCommands`: both describe the same rows. Similarly, `archiveBytes` is a subtotal, and `archiveDecodedNodes` must not receive a second `32 * rows` surcharge.

`domainDecoded*` and `archiveDecoded*` have different scopes. Only the latter is the charge for the current World history codec's expanded-character/node limit. Domain-reader limits still require an exact current-domain usage check by the aggregator. A byte count cannot substitute for checking the cultivation/build/legacy collection limits.

## Measurement and explicit overhead

Every operation uses typed fixture records built from actual owner IDs, current profiles, sources, learned provenance, relics and equipment. Unknown valid legacy attempt/reservation/preview/profile extension fields are preserved when the reducer preserves them. Archive summaries select exactly the fields retained by their reducers.

Fresh generated `instance`, `event` and `action` IDs use the maximum allocatable safe-integer width. Safe-integer fields use their maximum decimal width; bounded stats use 100, random states use `0xffffffff`, and random sample rolls use 10000. Independent per-field maxima need not be simultaneously reachable. They form a structural envelope and are not a valid state that can be imported or passed to a reducer.

Build fixtures contain both history and receipt, the actual source-removal operations, and the complete JSON-stringified command fingerprint inside its outer JSON string. Cultivation fixtures similarly include ordinary and authority receipts, plus the nested fingerprint in a necessary player World receipt. Unicode, quotes, backslashes, control characters and lone surrogates are measured by `canonicalUtf8ByteLength`; decoded characters follow canonical UTF-16 length. Nodes count every JSON value, matching the history codec.

Domain-array insertion adds one possible comma. Mutable domain replacement reserves the nonnegative difference between its maximum representation and its current representation. Existing profile data is not subtracted from a distinct future archived profile: that archive is a separate retained copy.

World cultivation events and receipts containing `cultivationResult` take the history codec's raw fallback. The encoded envelope takes the maximum of the tail-map representation and `[1, id, record]`, plus:

- 3 bytes for a fresh page's brackets and possible page separator
- 1 byte for a possible row separator
- the full safe-integer width for count growth

These are codec/container terms, not a fixed kilobyte margin. The decoded charge uses the original event/receipt, not the encoded raw wrapper, and adds the codec's documented 32 nodes.

Each surviving owner also carries an explicit, measured shared scalar-width delta for build/cultivation revisions, calendar month, sequence counters, World clock counters, event-stream draw count and the root event-stream uint32 state. The root RNG state has its own measured width delta; the two states retained in a breakthrough sample do not pay for root state growth. This is deliberately conservative duplication across owners. It is not another history row and is not a claimed reserve for arbitrary future commands.

## Covered owners and record ownership

### `disciple-lifecycle`, identified by disciple ID

Owns eventual expiry and death records, the ordinary death receipt, cultivation events and their World copies, retirement history/receipt and actual source-removal copies, the retired build summary, cultivation authority archive receipt/profile, World archived identity and estate terminal data.

Items are traversed through distinct currently eligible heirs exactly as in the existing row-only module. Each potential transfer is charged to the future owner whose death will cause it. There is no additional `D + E*D` charge. The committed beneficiary of an already finalized death overrides its cleared or changed live heir field. Pending/dead/retired beneficiaries terminate the chain at the sect estate; cycles visit each identity at most once.

The same traversal accounts for relic death-record copies. Their destination storage insertion is explicitly funded at each actual chain owner. Estate envelopes include item IDs and corresponding transfer-command IDs, including the provenance duplication across those arrays and build history/receipt/fingerprint. A terminal estate envelope also retains the current pending-run string conservatively; clearing that string early cannot erase the archive obligation.

The current and future learned-knowledge lists are included in the appropriate archives. A still-accepted teaching's future skill and cultivation knowledge are included before its grant occurs, so successful teaching cannot create an unbudgeted larger eventual archive. Live profile and World age/life-projection growth are measured separately from their archived copies.

Release requires the complete finalized death, build retirement, all transfers, settled estate, cultivation archive and World identity archive. An away/locked dead disciple retains this owner. A recipient that inherits an item still owns that item's later death transfer reserve.

### `teaching`, identified by teaching ID

Every active cultivation teaching owns the future student knowledge and taught event/World copy. This includes valid legacy teaching knowledge that has no permanent build mapping.

Only the authenticated permanent-knowledge teaching IDs supplied by the existing World derivation own a future `skill.grantKnowledge` history/receipt/learned-skill record. The namespace is `teaching/{teachingId}/{studentId}`. A cleared plan is not discharge: a completed taught event and retained student provenance keep the grant obligation alive until the actual build grant commits.

Cancellation can release the teaching reserve only when a complete candidate proves the relevant teacher/student unavailability transition. A vanished plan alone is insufficient.

### `breakthrough`, identified by attempt ID

Owns the admitted attempt's terminal replacement, actual retained preview/legacy fields, maximum sample, required begin/ready/terminal events and ordinary/player receipts. It owns its possible target-realm award only once. The independent disciple-lifecycle owner owns a fatal result's death/estate/archive records.

The resolved and cancelled event shapes differ only in bounded literal widths; the longer cancelled event is used for that alternative, while a full successful/fatal resolution sample remains reserved. Supply shortages can increase existing numeric fields only to their safe-integer width. This record envelope does not promise an unlimited number of waiting months, unlimited sequence operations or a bound for rejection-sampling iterations.

### `run-build`, identified by run ID

Owns exactly one complete-squad build unlock and still-eligible first-victory build awards. It does not own any run simulation, battle, clear-proof or inventory-recovery budget.

## Discharge helper

`verifyProgressionReservationDischarges` checks that disappearing owners have matching terminal facts. It is an additional ownership check, not World validation or capacity admission. In particular, teaching plan disappearance and incomplete retirement fail this check. The complete before/after byte and capacity-vector comparison remains mandatory even when it returns `supported: true`.

The integration owner must also validate every applicable surviving first-victory award and all event/receipt provenance in the full candidate before releasing run/build/breakthrough obligations. A smaller owner count is not permission to bypass a missing required record.

## Fail-closed cases and excluded work

The record derivation fails closed on missing source identities/provenance, non-data JSON, inconsistent derived facts, arithmetic overflow, and necessary authority namespaces exceeding the current 120-character grammar. The independent numeric gate reports insufficient terminal ID/revision/calendar headroom. For example, a legacy item identity can itself be legal while `death/{deathId}/item/{itemId}` is too long; no new short identity is fabricated to conceal that incompatibility.

Do not extrapolate the sequence reserve to all months until every living disciple dies. Those shared month/birthday steps require the integration owner's ongoing time-boundary admission. Likewise, one or two breakthrough samples do not prove one or two raw RNG draws: rejection sampling and intervening consumers need their own analysis. This module neither projects the current RNG prefix nor claims that prefix would bound every future ordering.

Separate obligations are still required for:

- Active run command/effect receipts, travel/outcome/talent records, final history, first clear and its full `Ended` proof copy
- Live battle peaks and reachable content effects
- Production cancellations, queued/pending commands, automatic production and journal retention
- Any required inventory clearance/recovery at run settlement
- Optional new commands, grants, purchases, enrollments, respec/source changes, heir changes or estate reassignment
- Entire World byte and domain-reader admission, counter/revision exhaustion, and migration of an already unfunded commitment

The existing run talents have run lifecycle scope and do not add permanent cultivation talents. Introducing a new permanent grant in the future must re-admit its complete candidate, including this module's changed later-death/archive obligations.

No output from this module proves a whole World stays below 4 MiB. It introduces no generic 1 MiB allowance, retention-limit widening, silent pruning, inferred campaign proof, or changes to the currently active simulation.

## Validation evidence

On 2026-10-01 the integration owner independently copied the candidate into `checkpoint-bounds-1616` and reported both strict TypeScript configurations and all 11 then-present focused tests passed (3.07 seconds). After the reviewed root event-stream state-width correction and its twelfth focused test, the integration owner reported both strict TypeScript configurations and all 12 focused tests passed in the independent directory (5.87 seconds). The worker did not run parallel validation. These results establish the focused record/charge/discharge regressions, not unimplemented run/battle peaks or whole-World admission.
