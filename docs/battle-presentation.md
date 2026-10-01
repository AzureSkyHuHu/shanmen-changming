# Battle presentation integration

## Actual implementation

The new battle surface reads a real `CombatControllerState`. It does not create a fake battle, advance simulation, mutate actor positions, infer damage or perform authority-only commands. Existing auto combat remains owned by the controller and its application adapter.

Files:
- `src/phaser/PhaserBattle.tsx`: readonly projection, asset/name mapping, React lifecycle, lazy Phaser loading and camera controls
- `src/phaser/create-battle-game.ts`: thin readonly arena renderer
- `src/app/BattlePanel.tsx` / `battle.css`: accessible roster, inspector, resource/cast/status HUD, tactical callbacks, pause/speed and pending retreat presentation
- `public/assets/enemies/`: original48×64 transparent pixel art and288×192 six-pose/three-row sheets
- `assets-source/enemies/`: editable SVGs, generator, provenance and static contact sheet

## Parent-owned wiring

`BattlePanel` props:

- `controller`, `catalog`, `locale`
- optional `entityPresentation`: entity ID → `{name, art?}`. Names should already be localized world/enemy names. Art accepts `disciple-0` through `disciple-3`, `moss-boar`, `ruin-guardian`, `ember-wisp`, `ridge-raider`, `venom-adept`
- `paused`, `speed: 1 | 3`, optional `readOnly` (disables all mutation controls while keeping local inspection/zoom available)
- `onPausedChange(paused)`, `onSpeedChange(speed)`; application timing owns the effect
- `onTacticalOrder(command)` accepts the controller's legitimate `TacticalCommand` union
- optional `retreatStatus: 'available' | 'pending' | 'unavailable'`, `retreatRemainingTicks`, `onRetreat`, `onContinue`

The selected/inspected entity and command-issuing disciple are UI state only. Focus addresses a selected hostile; guard addresses another selected living ally; hold uses the chosen command actor. The panel never calls raw runtime interrupt or finish-downed. Buttons are disabled for invalid visible targets or a terminal outcome; the controller still performs final authorization and legality checks.

Retreat is a callback request only. Pending status displays the authoritative remaining duration, and never manufactures an instant retreat result. The adapter must implement and supply the actual retreat lifecycle before enabling the button. `onContinue` merely opens the parent's terminal-result flow; it does not award items or settle death.

Skill/status names use the authored combat Chinese/English catalogs through the normal translator with per-key Chinese fallback. Cast/status/retreat durations convert ticks to seconds with `COMBAT_TICKS_PER_SECOND`; raw ticks are not main HUD labels. New static UI locale keys were supplied in `/tmp/battle-presentation-locales.json` for parent-owned merge.

## Rendering rules

- Each sprite anchor is derived from its actual integer battlefield position and the fixed arena, with no position interpolation or invented movement
- Six-pose walking animation advances only when real position changes and simulation ticks advance; pause/reduced motion prevents decorative progression
- Real health, maximum health, shield amounts, life states, status stacks and windup progress are projected from battle state. Downed and Dead have distinct labels and appearances
- Cast links, slash/heal/shield flashes and numbers originate only from newly published real events. They cap at32 and expire after10 simulation ticks. New mounts suppress historical effects; rewind resets retained effects. No synthetic replacement events are created when the display log is truncated
- Arena blockers are drawn from `arena.blockedCells`. Decorative cliffs/pillars do not add collision
- Asset URLs use `import.meta.env.BASE_URL`
- Phaser is lazy-loaded after mounting and destroyed on unmount. Text-heavy and command interfaces remain in DOM. The renderer has no battle step or RNG calls
- Keyboard users can inspect all units through roster buttons, choose a commander, use standard buttons/selects, and toggle pause with Space on the panel/playfield. Handled Space prevents default, stops propagation to the application shortcut listener, and ignores repeated keydown events. Focus rings, reduced motion and narrow layouts are included

## Evidence and limits

The contact sheets at `assets-source/enemies/contact-sheet.png` and `assets-source/enemies/human-enemies-proof.png` are static proofs of actual shipped pixel assets, dimensions, palette and anchors. Both were visually inspected as raster images. Existing raider/venom-adept/stone-warden encounters map to the corresponding human raider, human adept and stone guardian; boar/wisp art must not replace human identities. They are not browser screenshots and does not validate camera scale, Canvas interaction, animation pacing, HUD overlap or touch behavior in the running application.

Focused tests cover readonly projection, real cast/shield state, localized names, seconds conversion, effect bounds/expiry/history suppression, static accessible HUD rendering, Downed distinction, PNG dimensions/alpha, BASE_URL asset paths and the renderer's no-advancement boundary. Parent owns all test/build runs and actual browser QA. No public deployment was performed by this worker.

This is a cohesive original first production pass, not a claim of finished commercial artwork. Remaining visual QA: actual desktop and narrow viewport composition, long translated names, large groups, sprite/status bar overlap, reset/zoom controls, event readability at3× speed, pause freezes, and touch selection. The renderer displays full arenas; very large64×64 layouts are simulation-safe but are not visually optimized for readable full-map combat.
