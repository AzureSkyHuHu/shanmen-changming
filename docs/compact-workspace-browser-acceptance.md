# Compact workspace browser acceptance — 2026-10-03

## Release evidence

Published source: `4f64e5a99e3be1ab243a1350bb3a64007519ca05`.
GitHub Actions run `37103638828`: validation `111147854906` and deployment
`111156379163` succeeded. The run was terminal at 07:32:08 UTC; deployment
success was observed at 07:33:16 UTC. Full CI: 205 files, 4224 tests,
3271.02 seconds; default and Pages builds passed. The outdated-main deployment
guard passed. These checks alone are not game acceptance.

## Management, actual cloud Chromium UI

Fresh unbound v9 test scene, no existing slot loaded or overwritten. Existing
slots remained revisions 4 / 1 / 4. No access or game-resource changes were made
outside normal test UI actions.

- Desktop viewport 1165 × 757: document height 784, width 1165. Map plus one
  independently scrollable detail category were visible
- Same narrow viewport 485 × 675: prior map document height 5052; new map
  document height 1000, width 485. Roughly 80% less vertical document length
  in this specific view; not a promise that every category has that height
- Selecting Lin Qing from the roster selected cultivation and transferred focus
  to its tabpanel. End moved focus without changing the selected category;
  Home plus Enter selected the map. Canvas recovered after hidden categories
- Swapped active skills into a draft, switched to map, pressed Escape, then
  returned: draft survived. Opening build review pinned navigation; Escape
  discarded the visible review draft and unlocked navigation as designed
- Repeated the swap and explicitly confirmed it: the actual equipped order
  changed and the UI reported a completed permanent-build update
- Construction retained map, coordinates, preview and worker selector together
  on narrow layout. Preview held tick 522 and pinned navigation. Clicking the
  actual Canvas moved anchor (2,2) to (6,4); the occupied geometry correctly
  rejected confirmation. Escape cancelled preview and unlocked controls
- Research and construction worker selectors were reachable; their paused
  disabled state and explanatory text were visible
- English at width 485 and 125% effective width 388 had no horizontal document
  overflow. Save dialog at effective 388 × 540 had width 368, locked root
  scrolling; Escape restored focus to Saves. No save operation was performed
- Native desktop screenshots confirmed 150% layouts at effective widths 777
  and 323. Browser full-page screenshot capture itself cropped at this zoom;
  native screenshots were used to distinguish that artifact from page overflow

Confirmed defect: a global button hover gradient replaced the management tab's
background without changing its light text. Computed unselected hover colors
were text rgb(230,220,192) against rgb(243,223,175)–rgb(225,198,139).
Source review also found the ordinary selected workspace tab could inherit a
dark secondary hover fill with dark text. Both fixes are CSS-only and require
post-deployment hover/focus verification; do not label them already browser-passed.

## Ordinary campaign, actual cloud Chromium UI

New unbound seed `qa-compact-20261003`, existing campaign slots untouched;
completed five-route campaign remained slot 3 revision 11. A temporary first
unbound QA tab was closed by session cleanup before combat; testing was restarted
in another new tab, not restored by altering simulation state.

- Departure retained real supply/risk preview and acknowledgement. Two-person
  departure consumed 8 meals; a real 3× travel month reached encounter 1
- Paused combat showed Canvas plus one selected auxiliary category. At
  1165 × 757 the command view document was 1310 high, with no horizontal overflow
- Roster selection of the poison enemy remained the current target after returning
  to commands. Focus-fire was accepted. A paused self-skill command showed the
  commander casting; its exact later effect was not individually observed
- Retreat opened the real injury/loot/return review; cancelling retained combat
- Combat journal was a separate panel. Narrow width 485 had no document overflow,
  Canvas approximately 437 × 284; journal-view document height 1401
- Resuming actual 1× combat reached the first victory's opportunity choice.
  The scene was paused there. This is not a new five-route playthrough claim

## Remaining acceptance

Post-fix hover/focus, more viewport/interruption combinations, full narrow build
flows, production/research completion in compact UI, v10 actual private copy and
expanded content, long saves, full-scale performance and complete game scope
remain open. No mobile physical-device, full accessibility, or overall game
acceptance claim is made.

## Integration follow-up

Frozen diagnostics/copy/core source `7ab917aba0383b489ca986fc47185573d1236dfd`
passed the full local aggregate check: 212 files, 4302 tests, 2810.94 seconds,
plus boundaries, content, both strict types and default build. The subsequent
hover correction changes only two CSS files; its focused checks and Pages build
are recorded separately, and exact remote CI/deployment remain required.

Final CSS-only focused run: 2 files / 31 tests passed in 3.13 seconds; both
strict types and enabled-v8/v9 Pages build passed (788 ms), with diagnostics and
v10 still disabled. This is not post-publication visual verification.
