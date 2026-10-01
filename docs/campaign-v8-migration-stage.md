# World v8 structural migration checkpoint

This is an additive checkpoint. The running World, save envelope and player command gateway remain version 7. Candidate version 8 is constructed only by the explicit migration helper and checked by its independent validator; no campaign claim, recruitment, estate assignment or new route is exposed by this checkpoint.

## Preserved source authority

`migrateWorldV7ToV8` requires the caller to validate the original checksum and frozen World v7 first. It does not rewrite imported file bytes. It preserves all current clocks, resources, IDs, RNG streams, automatic jobs and cancellation pins. Existing build history is an unchanged v1 prefix. Cultivation retains old knowledge/identity authority. An old run, its offers, locked loadouts and controller remain under the frozen legacy content and executable protocol through Ended.

The old World validator explicitly requires simulation `0.7.0`; it does not follow the future live simulation constant. The current candidate validator explicitly requires `0.8.0` and its registered composite content identity.

Each old disciple receives the presentation ID at its import roster position once. Later roster ordering does not change it. A complete authentic Ended victory can seed its route clear and registered proof. An unlock string or an unproven summary cannot seed a clear.

## Review corrections

The first structural test pass did not prove all cross-domain authority relationships. Read-only review identified four concrete missing checks, now covered by rejection tests:

1. A standalone campaign acknowledgement could consume a claim without World payment or the promised equipment, learned skill or recruit. Until the committing World transaction schema exists, the candidate validator rejects every nonempty claim collection. It also rejects new estate assignments without such a transaction fact.
2. A fake empty estate could leave equipment owned by a retired person, or send it to someone other than the committed eligible heir. A complete estate now requires bidirectional item/transfer history and a legal historical recipient. Currently retired identities cannot own equipment. Earlier inheritance remains valid after its recipient later dies and transfers the same items again.
3. Historical run rows were skipped when no current run existed. Their exact shape and content/protocol pairing are now checked before that branch. New first-victory awards remain closed until World records their exact settled-run/survivor proof; a route's first clear cannot stand in for a later recruit's first victory on a repeat route.
4. A truthy runtime source ID could name a nonexistent source or another actor's source. The candidate validator now reconstructs the deterministic admission under the saved catalog and checks complete character and run-talent mappings, including source owner, definition and bound recipient. Legitimate removal after death preserves the admission proof.

`tests/integration/campaign-v8-provenance.test.ts` contains the corresponding counterexamples and a valid two-generation inheritance chain. `tests/integration/campaign-v8-migration.test.ts` retains all four genuine version 7 saves and verifies source immutability.

## Pure query seam

`world/campaign-types.ts` exports the player request, preview, error and projection DTOs. `world/campaign-queries.ts` provides pure request validation, context derivation, previews and compact projections. Projection state stamps are global; preview stamps bind that state stamp and the exact request. Neither consumes IDs or changes simulation state. Session confirmation must recompute the same request preview and check the session epoch.

Equipment labels come from the exact selected registry equipment definition. Missing presentation metadata fails closed. No equipment-ID guess or default name is used.

## Remaining activation gates

The candidate is not ready to replace the live World until the committing adapters provide bidirectional receipt/event/payment proof, complete death/teaching/return settlement, and admission for both current bytes and every promised future record. Build row reservations alone do not prove save capacity. Existing imported commitments may already lack capacity, so migration must preserve their original bytes and expose a supported recovery/read-only boundary rather than fabricate room.

The registered run recovery exit, necessary inventory clearance and its receipts, full settled evidence, cultivation limits and actual battle peaks still require integration and validation. New run first-victory evidence must cover repeat-route recruits without assuming that at most five route-clear proofs cover all such awards.

## Verification record

The integration owner validated the review corrections in an isolated staged tree: 76 files and 1194 tests passed, along with 970 locale keys, content/module boundaries, both strict TypeScript projects and the production build. That candidate-only checkpoint is commit `96fa559`. This is not current v8 gameplay activation, save-growth certification or browser acceptance.

Integration verification at 2026-10-01 15:46 UTC: post-review focused run passed 66 tests and both TypeScript projects. Frozen staged tree 6c5cac8d9118dbbf25dce0f7e4bbda7eacb63522 was exported independently: full npm run check passed 76 files / 1194 tests, 970 locale keys, boundaries, content, both TypeScript projects and production build. Browser and live v8 activation remain unverified.
