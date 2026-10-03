# Relocation kernel stage — 2026-10-03

Status: isolated implementation work, not a playable feature or save/protocol
activation. Authority: the user's continuing full-game development request;
requirements REQ-006/007/008, TASK-014, DD-02 Buildings and
sect-expansion-first-slice section 4 provide the scope.

## Fixed scope

Only the already catalogued placed library/alchemy buildings, existing wood-2
cost and 200 effective-work ticks. Preserve immutable original construction
records; derive historical/effective positions from separate ordered relocation
records. Never rewrite original construction anchors, prior production/research
entrance evidence, building IDs, levels, research, or maintenance due time.
No legacy-point relocation, new public version entry, v9/v10 accepted command,
World/save shape, Session, storage or UI integration in this stage.

A future integrated relocation must reserve the target softly, keep the old
physical footprint until completion, disable building work, require the worker
at the old then new entrance, and count only actual work. Completion rechecks
space/connectivity/people, swaps effective placement atomically and invalidates
navigation once. Blocked completion remains waiting and cancellable. Cancellation
restores availability at the old position, releases unconsumed reservations and
does not teleport workers or refund consumed materials.

## Explicit engineering assumption

The old plan specifies two payment checkpoints for construction/upgrade but
leaves relocation's checkpoint unspecified. For this isolated candidate use the
same split: consume wood 1 at 100 effective ticks and wood 1 at successful atomic
completion. Travel/wait/pause consume no work or material. Cancelling before the
first checkpoint releases wood 2; afterwards wood 1 remains spent and wood 1 is
released. This is a reversible implementation assumption, not a claim of an
explicit user-authored balance decision. No running player save adopts it here.

## Gates and ownership

First freeze new record/types/validation/history lookup contracts and tests;
then author runtime/query code against that contract. Root owns integration,
shared extractions and all test/build/Git execution. No whole-World or save
safety claim follows from local record validation. The later version owner must
prove bounded receipts/visits/spans, future completion/cancellation obligations,
identity/RNG non-consumption on rejection, ownership, navigation, maintenance,
codec/capacity and exact round trips before command or UI activation.

## Record-stage evidence — 2026-10-03 08:56 UTC

The four isolated source/test files passed both strict type configurations and
37 focused tests (2.01 seconds). Five files covering relocation, original
construction runtime/records, layout and paired ledger passed 175 tests in
12.77 seconds. Boundaries, content/1206 locale keys and default build passed.
Independent review found and closed a one-way worker-continuity defect: completed
or cancelled relocation must also constrain the calendar-time distance to any
later construction origin for that worker. Insufficient gaps reject; same-tick,
same-cell handoff is locally allowed. World phase ordering remains a later gate.

The fixture creates original construction through real catalog-backed APIs;
relocation histories are deliberately hand-authored with actual ledger primitives.
Later construction handoff fixtures use the actual local command API with test
clock/position setup. Neither is evidence of a running relocation state machine.
Navigation/terrain at historical ticks, other-domain ownership, runtime atomic
completion, maintenance/upgrade composition and whole-save capacity are not yet
provided. The public v9/v10 engines do not accept relocation.
