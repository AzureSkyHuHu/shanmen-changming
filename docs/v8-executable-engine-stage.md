# Explicit v8 engine candidate

The v7 default exports and source-file import path remain unchanged. The candidate
engine is exported from `src/core/kernel/v8.ts`; it is an executable test and
application-integration port, not a declaration that the default application has
already switched versions.

## Runtime and codec ports

- `createWorldV8(seed, { mode? })` constructs a new v8 authority with a fresh
  build-v2 origin. It does not accept or reset an existing World.
- `dispatchCommandV8(world, unknown)` accepts the closed `CommandV8` union and
  returns `{ world, result }`. Duplicate receipts precede admission checks.
- `advanceTicksWithStatusV8(world, steps, commands?)` returns a complete boundary,
  `capacityStop` and `invariantStop`. An exact-cap input may retain its original
  bytes while the application displays an ephemeral stop.
- `advanceTicksV8` is the World-only convenience wrapper.
- `parseSaveV8` is strict version 8. It checks checksum before owning history and
  full validation; it does not migrate version 7. Unknown registered content is
  classified as unsupported content so a repository must preserve its generation.
- `createSaveEnvelopeV8` and `serializeSaveV8` enforce the existing 4 MiB UTF-8 cap.
- `migrateWorldV7ToV8` remains an explicit, detached structural conversion after
  the source v7 codec has validated the source. A caller must prove candidate
  admission before replacing a legacy Session.

Application and persistence should use one tagged version adapter. Every read,
write, previous-generation guard and readback must select the same strict codec;
there must be no version-8-to-version-7 parse fallback.

## Real expedition and progression flow

The v8 adapter uses five registered route specifications and actual combat
controllers. Each run stores its own registry identity and executable protocol.
An old active run retains its frozen legacy command algorithm, offers, locks,
controller and RNG through Ended. The next departure resolves World content.

Travel still advances the ordinary World clock and its exact monthly cultivation
boundaries. Expiry and unavailable-worker cancellation precede production commit.
A combat encounter freezes the calendar, advances one real controller tick per
World tick, and translates only actual controller results into domain outcomes.
A player-confirmed emergency retreat uses the current controller snapshot and
existing 50% unsecured-loot/normal-return rules. Its preview token excludes UI
pause flags and binds actual run, controller, inventory and pending deaths.

Return settlement clears locks, applies genuine individual first-victory awards
and records route progression. One registered Ended proof per run is shared by
first-clear references, individual awards and permanent deaths. An ordinary
repeat run without a new permanent fact keeps its ordinary history summary.

Permanent teaching is promised only when the teacher held the real permanent
knowledge before the teaching-start event. A later book purchase cannot upgrade
old knowledge merely because IDs coincide. While that promise is outstanding,
player build changes cannot remove the student's prerequisites or learn the same
skill independently and thereby break final delivery.

Finalized unlocked deaths retain immutable deceased identity/presentation and
transfer owned equipment exactly once through the already validated estate
builder. Dead locked expedition members keep their sources and items until
return unlock, then retire in the same complete World candidate.

## Capacity scope and remaining activation gate

Management candidates use the production/history budget, typed progression
records, build history obligations, standalone-reader ceilings and finite
terminal numeric obligations. Automatic work performs that v8 accounting and
currently admits no new jobs during an active expedition; an inventory discard
at blocked return therefore cannot be immediately undone by an automatic start.

The active-run candidate has actual-byte checks and explicit bounded live-run /
controller envelopes. These are test safeguards, not a complete proof that every
future registered battle, Ended proof, return-clearance command and terminal
record can always be paid. A normal new campaign is executable for genuine
journey validation; the default application must not switch to it until the
remaining run/return obligation and recovery acceptance gate is reviewed. Old
near-cap imports remain on their original version when controlled migration does
not fit.

## Verification requests

The parent owns execution and records results. The following tests were authored
for this stage; their presence alone is not a pass:

- `campaign-v8-runtime.test.ts`: real three-encounter trial, reward claim, next
  route, mid-battle save/restore, old pending-offer continuation and emergency
  retreat replay.
- `campaign-five-routes-journey.test.ts`: fresh four-member party, real farm/cook
  deliveries, fifteen actual controllers, real card choices, permanent gear and
  tree-point spending, and save/restore between all five routes.
- `lifecycle-v8-migration.test.ts`: genuine old death source, unchanged source
  bytes and rejection of forged or extended legacy exceptions.
