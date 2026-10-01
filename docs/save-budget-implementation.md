# R2 saved-byte admission implementation

Status: source and focused tests authored; integration-owner execution pending.
This module does not change a World/save/simulation version, enable the planner,
alter previous source snapshots, or replace the file adapter's final byte cap.

## Public pure API

`src/core/save-budget/index.ts` exports:

- `canonicalUtf8ByteLength(value)`, `jsonStringByteLength(text)`, and
  `utf8ByteLength(text)`; none uses a browser, platform encoder, clock, persistence,
  random stream, or World validator
- `createCanonicalByteCounter()` for isolated counters and optional cache-visit
  instrumentation; its measurements have the same semantics as the default counter
- `measureWorldSaveBytes(world, {saveVersion?, metadata?, counter?})`: full actual
  compact World plus envelope fields. The checksum is represented by eight ASCII
  hex characters, which is exactly its wire width. Omitted metadata uses maximum
  legal escaping. Omitted version uses a one-digit sizing representative: all
  existing v1–v7 versions have that width; pass the actual version at integration,
  and certainly before a future two-digit version
- `assessAutomaticWorkBudget({world, map, liveAutomaticJobCount, pendingCommands,
  maximumNewStarts, journalBytes?, save?})`: complete byte and finite-record
  accounting plus a single shared `0 | 1 | 2` allowance
- `verifySaveCandidate(input)`: typed, transient, nonrecording precommit decision
- `verifyReservedRelease(before, candidate)`: a real-cap-fitting release can still
  proceed when general headroom was already deficient, if complete byte and row
  obligations do not grow. This is exclusively for a real reserved cancellation or
  release, not an escape hatch for a new growing operation

Inputs are already schema-validated complete boundaries. `map`, live count, and
pending queue must be derived from that boundary, not stale projections. Include
currently dispatching commands when they still own pending settlement obligations.
`journalBytes` must be measured now with `canonicalUtf8ByteLength(actualJournal)`;
it is not an accepted saved byte-count authority. Omission conservatively treats
the current journal as empty. Dimensions, counts and a supplied journal byte count
are checked, including the maximum legal journal size.

`actualFits` means the encoded envelope is within 4,194,304 bytes.
`obligationsFit` additionally means bytes, finite archive rows, and decoded archive
expansion capacity are available for the quantified future commitments. Separate
`archiveSlotsFit`, `archiveExpansionFit`, and their component breakdowns explain
finite exhaustion even with a small encoded snapshot.
`unsupported-pending` means a proof is unknown, not that the file is oversized.
Existing imported queues remain valid; this reason disables new automatic work.

## Exact encoding and cache ownership

Canonical object ordering cannot change byte length. The counter accounts for
every key, colon, comma, quote, bracket, numeric representation, and UTF-8 code
point without building an entire canonical string. Numbers use the same finite
`JSON.stringify` representation as the kernel, including negative zero and
exponent forms. JSON short escapes are two bytes, other controls are six; a lone
UTF-16 surrogate becomes six ASCII bytes inside JSON, while a valid pair becomes
four UTF-8 bytes. The raw-text helper instead counts the replacement-character
encoding of lone surrogates, matching the platform encoder for already encoded
text.

Build metadata permits 128 UTF-16 units and saved-at metadata 64. Repeating NUL
therefore realizes the maximum JSON string widths of 770 and 386 bytes including
quotes. Multibyte text and lone surrogates do not exceed this maximum. World seed
and identity strings are measured exactly, including their repeated envelope
occurrence. A supplied actual metadata pair yields exact actual serializer bytes;
default metadata yields exact bytes of the worst-legal-metadata envelope.

Only a recursively inspected, deeply frozen, finite, data-property-only JSON
object enters the counter's private WeakMap. Frozen outer objects with mutable
descendants are not cached. Accessors are rejected without executing them; cyclic,
sparse and non-JSON inputs also fail. Mutable imports never receive identity size
reuse, including callers that invent `savedBytes` fields. Existing owned immutable
archive roots/pages are authenticated once and then reused by identity. Appending
a page only visits the changed archive spine/tail; unchanged historical pages do
not get reserialized on each tick. The counter never freezes or mutates caller
objects. Domain/schema validity remains the caller's separate responsibility.

## Bounds, not guessed constants

For `N = width × height`, the path bound is:

`1 + N × (12 + digits(width − 1) + digits(height − 1))`

This includes N coordinate objects, separators and array brackets. It is 2,101
bytes for 14×10, and 1,179,649 bytes for 256×256. A syntactic maximum-coordinate
fixture attains the latter; a legitimate 65,535-step maximum-map Hamiltonian snake
is separately checked under it. Neither fixture claims ordinary BFS necessarily
chooses such a long route. The bound covers permitted saved route length.

The fixed-field upper envelope imports the actual new automatic types and uses:

- Canonical safe-integer source IDs and cycle/tick values, with 16 decimal digits
- The longest registered recipe, largest registered normalized input-line encoding,
  largest work duration, longest phase and blocked reason
- All live job/reservation/origin fields and actual dictionary-key punctuation
- A minimal terminal pin plus a durable public cancellation event with settled tick
- One maximum 128-character public command ID, exact escaped cancellation
  fingerprint, result, and event reference
- Explicit source-counter, inventory-number, assignment and coordinate growth

The components are measured, rather than set equal to the candidate 4KiB/2KiB/
2KiB/1KiB figures in the review. Focused tests assert those loose targets still
cover the current typed maximum fixtures. This fixture is a conservative per-field
envelope, not a claim that all maximum fields constitute a simultaneously reachable
World state. Exhaustive current recipe/phase/reason combinations are checked under
the envelope. Source-schema changes must update these proofs before automatic work
uses the revised schema.

The journal reserve is exactly the measured 64-maximum-notice array minus actual
current journal bytes. It includes array separators. A job reserve includes its
whole future live pair/path, terminal pin/event, direct public-cancel receipt and
bounded side effects. It deliberately double-counts the current live bytes.

Archive retention budgets include both live placement and raw fallback-row
placement, potential pool-string insertion, new page punctuation and count-digit
growth. This intentionally does not rely on compression. Existing manual live
jobs reserve possible routes, terminal production/reservation, durable event and
direct cancellation receipt too. Their actual legacy extension fields are retained
and charged, not replaced by a modern small fixture.

## Admission equation and finite archive limits

`reserved = 1,048,576 + journalRemaining + autoLiveFuture + manualLiveFuture + pendingFuture`

`available = 4,194,304 − encodedEnvelope − reserved`

Each proposed automatic start spends its complete future reserve plus the maximum
live representation/source deltas, including its largest permitted current route.
This extra term is necessary because subsequent candidate measurements deliberately
count live bytes again in future reserve; funding only the empty-path insertion
could otherwise cause an edge-admitted job to pause when its route grows.
`perLiveJobBytes` and `perNewJobBytes` expose that distinction. The total
allowance is the minimum of two, available worker slots, byte-funded starts and
archive-funded starts. The second proposal cannot reuse the first's byte allowance.

History production/receipt/event tables remain capped at 100,000 rows each. The
guard counts current archive rows plus relevant live tails and reserves production,
event and receipt rows for live/manual/pending obligations. Automatic public
cancellation needs one durable event and one receipt per live or proposed job.
This intentionally conservative calculation does not exploit spare recent-tail
slots to run exactly up against a full archive. No record is silently pruned.

The codec also caps summed decoded canonical UTF-16 JSON characters at 64Mi and
charged decoded nodes at 4,000,000, including its 32-unit surcharge per record.
`getHistoryArchiveUsage` reads the authenticated index in O(1) for owned archives;
unowned inputs must be validated/owned by that helper before their counters can
be used. No saved usage field is trusted. The guard reserves live receipt/event
tails plus each future retained production/event/receipt. Canonical UTF-8 record
bytes are a conservative upper bound for both canonical UTF-16 characters and JSON
value nodes, with the 32-per-row charge added separately. This deliberately loose
future node bound avoids decoding historical records and can stop admission early.
Current usage counters remain exact. All three archive ceilings independently gate
new starts and candidate publication, and reserved releases may not increase their
total current-plus-reserved cost.

Pending production starts, cancellations, inventory discards and bounded work-plan changes receive
per-command byte and row obligations. They remain pending commands, not fabricated
receipts; repeated queued identities are conservatively charged separately. Complex
cultivation/build/expedition pending commands currently have no proved whole-effect
budget, so any such queue gives zero new automatic allowance. Future manual blocked
event churn is not claimed to have a finite lifetime budget: complete candidate
checks must guard each growing transition.

A queued inventory discard reserves exactly one future durable event and receipt
slot, with no production/pin obligation. Its byte envelope charges the actual
validated command fingerprint and payload, the discard result, maximum event/action
IDs and tick, raw archive fallback plus potential receipt-string pooling. A fixture
uses the maximum command ID and safe integer quantity/sequence/tick.

The 1MiB nonautomatic margin is safety room, not a proof of arbitrary manual,
cultivation, battle, build, or expedition history growth. Finite build-history and
perpetual player receipt limits remain separate work. This module does not claim
infinite whole-game sustainability, nor recover an already imported boundary whose
future commitments exceed available bytes or finite archive rows.

## Required integration order

1. Return an existing exact receipt/conflict before capacity checks, unchanged
2. Pre-admit new external operations and queue batches atomically; a capacity refusal
   is transient and must allocate no receipt, ID, event or retry diagnostic
3. Preserve pending/in-flight reference ownership through dispatch
4. Measure the complete proposed boundary and all remaining obligations before
   publishing every growing transition, not only planner decisions
5. Allow reserved cancellation/release without spending new headroom; compare complete
   pre/post obligations, and never publish bytes above the real file cap
6. On a real capacity failure, retain the preceding exportable boundary and one
   bounded visible pause. Do not append a fresh error every tick/retry
7. Keep final file/browser/memory adapter byte-cap checks as independent safeguards

## Validation request

The worker authored tests but did not run install, tests, typechecking, builds,
benchmarks, source-version changes, commits or deployment. Integration owner runs:

`npx vitest run tests/save-budget`

`npm run typecheck`

`npm run check:boundaries`

The final integrated tree additionally requires the parent-owned full check and
real reducer stress/save-restore/browser evidence specified in R2. Focused byte
tests alone do not establish full runtime responsiveness or game completion.
