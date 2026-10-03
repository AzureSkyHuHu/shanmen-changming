# Save-load warning accuracy review

## Observed behavior — 2026-10-03

In the public v8 candidate, a fresh QA campaign was saved to an empty slot. After
the first encounter and a personal-talent choice, its next-node waiting state
was saved to another empty slot. No gameplay action followed the successful
save. Clicking Read on the current slot still displayed:

> 读取将替换当前未保存的进度。是否继续？

The confirmation was cancelled; no load occurred and no existing slot was
overwritten during this observation.

## Cause and scope

`src/app/App.tsx` always opens a confirmation for an occupied-slot Read. The
prompt chooses only between `save.loadWarning` and `save.takeoverWarning`.
The v7/v8 `SaveStatus` in `src/application/save-controller.ts` has no dirty field
or saved-boundary comparison. This is unconditional replacement wording, not
an incorrect calculation that the current session has unsaved changes.

`ManagementSavePanelV9.tsx` shares `save.loadWarning`. Its controller has dirty
tracking, but the load prompt also uses this key independently of dirty status.
The private v10 panel uses its separate `storageV10.loadWarning` and a separate
dirty acknowledgement; it is not changed by this correction.

## Minimal correction

Only the two existing translations of `save.loadWarning` change:

- Chinese: 读取将以所选存档替换当前进度；如有未保存的更改，将会丢失。是否继续？
- English: Loading will replace the current session with the selected save. Any unsaved changes will be lost. Continue?

The text states the actual replacement action and warns conditionally about
unsaved changes. It does not claim that the session is either clean or dirty.
The stable key and its `noParameters` registration remain unchanged.

No changes are made to load/save logic, ordinary or takeover confirmation,
cancel behavior, dirty tracking, save identity, slots, revisions, migration,
writer ownership or storage destinations. A last-success timestamp or matching
slot identity is not used as evidence that the current world is unchanged.

## Verification

Added bilingual regression cases in `tests/i18n/translate.test.ts` for the
conditional wording and removal of the old assertion. Added source-contract
checks in `tests/application/public-layout.test.ts` that both shared consumers
retain ordinary-load, takeover, explicit-confirmation and cancel paths.

These source checks do not simulate browser events or establish native dialog
focus, cancellation or layout behavior. The implementation worker did not run
tests, types, builds or browser checks; integration-owner validation is pending.
Relevant existing coverage includes versioned v8 save/load round trips,
candidate database isolation, transient overlay pause preservation and v9 save
presentation. Real-browser verification should repeat successful save, Read,
review and cancel in both languages, without overwriting existing slots.

集成记录（2026-10-03 03:49 UTC）：双类型、1205文案键校验通过；五份翻译/入口/存档展示测试共75项通过，耗时4.23秒；生产构建通过。控制器及任何确认逻辑均未改动。新文案尚未发布，真实浏览器复核待对应部署后进行。
