# Platform v7/v8 save dispatch

## Implemented boundary

`src/platform/save-codec.ts` is the shared platform save router. It peeks only after enforcing the 4 MiB UTF-8 byte limit, rejects malformed JSON or unregistered versions, and selects exactly one core codec:

- Source save versions 1–7 use the existing legacy codec and its authenticated migrations, ending at v7
- Source save version 8 uses the strict v8 codec, with no legacy retry on failure
- Unknown save, simulation or registered content versions remain rejected and protected in storage

The router exports genuine v7/v8 World, envelope and parsed-data unions. World snapshots choose a core creator by the existing simulation/content-identity boundary. That creator validates the full World; an unknown or conflicting identity fails rather than guessing a format. Serialization uses the envelope's registered version and applies the same byte cap.

This adapter does not activate the v8 game runtime. The current `WorldState`, `createWorld`, Session and main dispatch aliases remain v7 until separately integrated. There is no automatic v7→v8 upgrade.

## Storage guarantees retained

File import/export, IndexedDB load, save, import, transaction read-back and prior-generation protection all use the shared router. In particular, a valid retained v8 generation no longer looks like an unsupported future save to the second save operation.

`SnapshotRecord.text` retains the exact supplied source string, including whitespace. Reading and exporting do not reserialize source bytes or change the current pointer. Saving a loaded World is a separate explicit operation that creates a new revision in that World's existing version. An explicit overwrite import may replace supported data after the existing lease/revision checks.

Corrupt-current fallback remains read-only. Unsupported versions in any retained generation prevent ordinary saving and explicit overwrite; exact-text rescue remains available. Existing lease epochs, revision checks, automatic/manual/checkpoint rotation, read-back verification and transaction rollback are unchanged. IndexedDB remains schema version 1; no upgrade, deletion, repair or save clearing is introduced.

## Verification status

`tests/persistence/versioned-codec.test.ts` adds authentic legacy fixtures, fresh-v8 roundtrip, strict version dispatch, original bytes, second-v8-save regression, mixed-generation rotation, corrupt/future protection, UTF-8 bounds, lease/revision fencing, read-back failure and fault-stage rollback cases. Existing frozen fixture files are untouched.

The implementation worker has not run tests, type checks or builds. These checks are owned by the parent integration task and must be recorded from the exact tested tree. Browser storage/device fault verification is not implied by fake-indexeddb tests.
