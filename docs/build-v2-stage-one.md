# Permanent build v2: additive stage-one evidence

2026-10-01. Parent-run focused validation passed both TypeScript projects and all **46 build/registry tests** in `build-v2-initial.log` (3.17 seconds). This is an independent domain stage. World remains save7/simulation0.7.0 and still calls build-v1 APIs. No campaign reward, recruitment, estate UI or v8 save migration is activated by this patch.

## API and selected rules

`core/builds/v2-types.ts` defines `BuildContentContext`: selected registry identity, combat catalog, explicit build rules, and frozen legacy identity/catalog. `content/registry/build-context.ts` resolves this from registered identities. Untrusted save data never supplies executable rules.

Exports from `core/builds/v2.ts`:

- `createBuildFrameV2`, `upgradeLegacyBuildFrameV1`, `validateBuildFrameV2`
- `applyBuildCommandV2`, `applyBuildAuthorityCommandV2`
- `getBuildProgressV2`, `getBuildChoicesV2`, `buildCombatLoadoutV2`
- `serializeBuildsV2`, `restoreBuildsV2`

Authority-only additions are `disciple.enroll`, `skill.grantKnowledge`, `disciple.retire` and `equipment.transfer`. Player commands remain the original respec/study/loadout union. The v2 frame records concrete content identity and a hash of the actual equipment/learning/limit rules.

## Historical boundary

`core/builds/legacy-v1` freezes build rules/reducer/types from commit `98e7026c9dfef68754a3ad9369d70aa3c2475195`. Its additional prefix helper invokes that unchanged reducer once per historical command. It is not allowed to use candidate equipment or learning rules.

The v2 migration boundary stores the frozen identity, exact legacy prefix length, original state hash and sequence values at migration. Validation recreates the old origin under v1, replays its old prefix, checks the boundary, structurally upgrades ownership, then replays only the new suffix under v2. Migration allocates no ID and does not rebuild existing sources, items, receipts or lock hashes. Existing exact command retries preserve their original fingerprints/results.

Four genuine parent-generated v7 source fixtures are covered: active automatic work plus a public cancel pin, active battle, pending offer and completed return. Their original SHA-256 values and generation provenance are in `tests/integration/fixtures/README.md` and `save-v7-campaign-provenance.json`. Their bytes remain unchanged.

## Enrollment, knowledge and estate semantics

- Enrollment creates one new identity's explicit `rules.starterSkills`, three training items and six owned skill/equipment sources. Recommended candidate support skills are not free starter skills. Existing origin/identities remain untouched.
- Archive/teaching knowledge has acquisition and provenance metadata, costs zero study credits and installs no source until equipped. Teaching requires the donor's matching real learned knowledge; retirement retains historical donor knowledge. The later World bridge must verify actual paid campaign claims or completed teaching facts.
- Equipment ownership is an explicit disciple/sect-estate union. Retirement requires an unlocked build, removes all installed sources and keeps a compact deceased build record. Equipment retains the same instance and acquisition IDs.
- Death transfers require the corresponding retired owner and death ID. Transfers to an expedition-locked heir change ownership only, leaving the heir's loadout, sources and lock hash untouched. The World bridge must retain a pending estate until normal run settlement unlocks the dead owner, then commit retirement and all transfers atomically.
- The standalone build authority API does not prove World death, campaign victory, tuition payment or invitation ownership. Cross-domain provenance checks are required before World activation; an authority-shaped record alone is insufficient.

## Remaining work and limits

Add cultivation enrollment/knowledge/deceased identity authority, explicit campaign relief rules, frozen expedition protocol selection, World atomic claims/estates and v7→v8 migration. Then verify shared capacity obligations, Session/UI flows and genuine browser interaction. Existing 1024-command/512-equipment limits remain finite. This focused pass is not a full v8, balance, long-campaign or browser acceptance result.
