# Battle paper heading contrast

## Verified defect and scope

The public candidate boss encounter's **查看战况** inspector showed 林青 almost disappearing into its pale paper panel. The integration owner's actual cloud-browser screenshot `14-boss-paper-contrast-before.jpg` was inspected as pixels before this correction. The supplied computed style was `rgb(228, 218, 183)` at 18px; its battle panel parent used the intended dark ink, `rgb(38, 62, 60)`.

This is a bounded battle presentation correction. It does not change simulation, saves, localized content, commands, layout, or the surrounding dark expedition palette.

## Cascade cause

`ExpeditionPanel.tsx` imports `BattlePanel` and then `expedition.css`. The expedition stylesheet has broad descendant rules:

- `.expedition-panel h3`: `color: #e4dab7`
- `.expedition-panel h4`: `color: #e6dbb9`

Those are directly specified heading colors, so `.battle-panel`'s inherited `--battle-ink` cannot replace them. The inspector name and status heading had no direct color. Roster, field, and equipped-skill headings had their own colors, but only equal-specificity selectors, leaving them vulnerable to stylesheet order as well.

The previous inspector heading color against the darker inspector gradient stop (`#e9dfc3`) has approximately **1.05:1** contrast. The intended ink `#263e3c` against that same stop has approximately **8.61:1**. These are source-palette calculations, not a claim of complete accessibility conformance.

## Correction

Only `src/app/battle.css` changes runtime presentation. One color-only rule explicitly applies `var(--battle-ink)` to five paper-surface heading selectors, each rooted at `.battle-panel`:

1. Inspector character/summon name (`h3`)
2. Inspector status section (`h4`)
3. Ally/enemy/summon roster heading (`h3`)
4. Active field heading (`h3`)
5. Equipped skill heading (`h3`)

Two class selectors beat the enclosing expedition's one-class heading selector regardless of import order. The rule does not use `!important`, does not target all expedition or battle headings, and only sets color so existing responsive font sizes continue to apply. Roster headings also use the stronger ink rather than reverting to their original muted color, which alone is below 4.5:1 against the roster paper.

The battle title already inherits dark ink without a competing expedition `h2` color. Nearby side/life labels, resource labels, casting text, log summary, and skill metadata have explicit battle-specific colors and are not affected by this particular `h3`/`h4` cascade. Their typography and colors remain unchanged; this is not a full small-text contrast audit. Light text on the dark outcome banner, keyboard help, and surrounding expedition headings remains unchanged.

## Verification and integration handoff

`tests/battle-presentation/paper-contrast.test.ts` adds source contracts for all five scoped heading colors, normal-text contrast checks across the inspector gradient endpoints, ordinary/summon rosters, fields and skills, and preservation of the dark-surface colors. These tests deliberately do not claim to implement a full CSS cascade or substitute for browser QA.

The worker inspected the supplied before screenshot and traced the source cascade. Tests, type checking, production build, Git operations, and browser execution were not run by this worker; the integration owner runs those serially.

Required integration checks:

- Run the new contrast test and existing battle presentation tests, then the required type/build checks
- Reopen the same boss encounter in the real cloud browser and inspect the selected name and status heading; expected name color is `rgb(38, 62, 60)`
- Inspect ally/enemy roster and equipped-skill headings; inspect summon/field headings when those states are available, clearly recording any unavailable states
- Check the surrounding expedition headings still use pale text on dark green, including after locale changes
- Review the actual desktop and narrow/zoomed page for readability and confirm responsive heading sizes and battle interactions remain intact

This document records the source correction and the outstanding checks. It does not claim that the correction is already deployed or visually accepted after the change.

集成记录（2026-10-03 04:02 UTC）：四份battle-presentation测试共29项通过，耗时1.46秒；生产构建及其中双类型检查通过。仍待部署后的真实浏览器颜色和窄屏复核。
