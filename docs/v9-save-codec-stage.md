# Headless v9 save codec prerequisite

Status: integration-verified on 2026-10-02. Frozen source cf5314f passed the complete serial check: 139 files / 2690 tests in 826.84 seconds, 1041 Chinese keys, both typechecks, content/boundaries and production build. The 75 focused codec tests passed in 39.75 seconds. This is not complete-game acceptance, browser support, public content registration or a general proof of save closure.

## Narrow format and compatibility

The internal codec accepts exactly saveVersion 9, simulationVersion `0.9.0`, the current management content fingerprint/version, and runtimeProtocol `fresh-management-v9-unregistered.3`. It preserves the existing eight-field envelope: version, simulation version, content version, seed, build ID, display timestamp, payload and checksum. The existing canonical FNV-1a checksum detects corruption; it is not cryptographic authentication or a replay-provenance certificate.

There is no v7/v8 migration, `.1`/`.2` relabeling, field stripping, owner deletion, automatic cancellation or domain repair. The codec does not create a new identity. World queues remain empty and departures/campaigns remain closed. Root/clock/content identity, receipts, archive, resource reservations, ID sequences, domain history, care/teaching and lifecycle mirrors must satisfy the full current private-runtime checks.

The platform version selector, file imports, IndexedDB repository, Session, UI and content registry are unchanged. They still reject version 9. The new files are directly imported only by headless tests; there is no kernel/public barrel export or browser activation.

## One fixed complete admission

Creator, parser and serializer all call `admitSaveWorldV9`. It accepts only unknown data, with no callbacks, owner handles, assessment parameters, trust flags or configurable relaxations.

1. Capture a bounded, detached plain JSON tree from data descriptors before reading supplied fields
2. Require the exact simulation, content and `.3` runtime identities
3. Create a temporary private runtime, which performs its full current record, capacity and finite-teaching source validation
4. Refuse recovery-only roots: actual wire fit alone is insufficient; every current plus reserved dimension must fit
5. Export an independent deeply frozen snapshot
6. Close the temporary owner in `finally`, including scope refusal and failed export

The serializer does not trust a nominal SaveEnvelopeV9 type, existing checksum, frozen payload or a previous successful creator call. It checks complete envelope fields/types before classifying an otherwise well-formed unsupported numeric version, then rechecks checksum, identity and complete World admission. Parsing uses that same envelope path. Returned payloads have no mutable aliases into caller data or another parse/runtime. Creator metadata is descriptor-captured after the World, so metadata Proxy reflection cannot mutate an already captured source into a different accepted payload.

`UNSUPPORTED_SCOPE` is distinct from invalid records. It covers record-valid unproved finite continuation, actual-capacity/reserve-subset exclusions, recovery-only sources and unsupported runtime protocols. It is not reported as corrupt legacy data and is never passed through another codec. Malformed queues/departures and failed record/provenance checks remain `INVALID_WORLD`; exact simulation/content mismatches retain their version-specific errors. Create and serialize throw SaveCodecErrorV9 with the same machine-readable code the parser returns.

## Bounded hostile input

The raw text limit is 4 MiB UTF-8, checked before JSON parsing. Descriptor capture additionally counts canonical UTF-8 bytes, including key escaping, commas, brackets, Unicode and lone-surrogate escaping; it stops above the same file limit. Depth is capped at 128 and visited JSON values at 4 MiB nodes. The latter is conservative because each wire value consumes at least one byte; existing domain-specific row/decoded-character/node limits still apply independently.

Finite primitives, ordinary enumerable string-keyed objects and dense ordinary arrays are supported. Cycles, getters, custom prototypes/methods, hidden/symbol properties, holes, non-finite numbers and non-JSON values reject. Array-index keys longer than ten characters reject before regex scanning or numeric conversion. Repeated object references are separately copied and charged for their actual repeated wire representation. Catch paths never inspect caller-thrown values, including `instanceof`, message getters or Proxy error prototypes.

The initial Reflect.ownKeys operation may allocate its whole key list or execute an arbitrary Proxy trap before the codec can check its count. A key-count/minimum-wire-cost check runs before descriptor reads. Property descriptors are then inspected one at a time under byte/node/depth traversal limits rather than allocated as one unbounded descriptor map. The codec bounds subsequent traversal/copy, not arbitrary trap execution or this unavoidable initial reflection allocation. Reflection traps can still run and mutate other caller objects; this is not an atomic snapshot of hostile external mutable data, nor a claim to identify all Proxies. The fully detached resulting tree is validated in its entirety. Nothing from source freezing confers trust.

## Authored evidence and limits

Tests cover:

- Fresh exact identity, eight fields, canonical/checksum stability, explicit metadata and unchanged legacy routing
- Actual permanent loadout change, retained source/history identity and exact retry after restoration
- Genuine paid library construction, extraction/study, medicine research, gated alchemy, wound-powder production and care start/cancel/restart/completion
- Isolated uninterrupted/restored private-runtime equivalence around active work checkpoints; intermediate setup work uses every actual fixed tick via the existing record fixture helper
- One real two-month lesson from an explicitly authored knowledge origin, all 2400 fixed ticks, with 40 sequential 60-tick save/resume checkpoints and equality to independent ordinary preparations; one taught event and teacher/lesson provenance at completion
- Genuine lifespan expiry, pause, death finalization, permanent-build retirement, legacy archive and idempotent retry; zero-history age preparation is explicitly a fixture
- Fully funded exact-wire-cap start, atomic new-growth refusal, authentic cancellation and subsequent save
- Explicit record-valid actual-fit/reserve-deficit rejection across every entrance, including owner closure without cancellation
- Checksum-valid corruption, changed versions/identity, unsupported teaching chains, `.1`/`.2`, queue/departure rejection, UTF-8 and JSON-depth limits
- Hostile getters/Proxy errors, metadata-reflection mutation, source/metadata/envelope/parse alias isolation, serializer bypass attempts, and temporary owner closure on success and failure

Paid work fixtures start with clearly labelled base-stock funding; sect resources, buildings, research and doses are earned by real operations. Teaching knowledge and lifespan proximity are authored origins rather than invented progression history. Sampled work checkpoints do not claim every possible runtime boundary is saveable. A funded-root boundary rejected by save admission is an integration blocker to report and investigate, not a reason to weaken the gate or advertise general save closure.

Headless admission does not prove eventual arbitrary work completion, unlimited generations, the full content campaign, all-population performance, browser recovery, browser interaction, 20 Hz rendering or complete-game acceptance. Those remain separate activation gates.

## Exact integration evidence

Source commit `cf5314fa2c82039520bb9659108428c3eb7b5b24`, tree `225c8d517a9f224c448871485bcc6179c64d0923`, was checked in an isolated directory. This includes the finite teaching source already separately verified at 2615 tests. Later publication changes only these status documents. No untested runtime-view implementation is included.
