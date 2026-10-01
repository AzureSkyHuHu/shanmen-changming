# TASK-038 · 实现配装三选一和结算UI

状态：planned · 负责人：构筑界面（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-014](../../00-overview/requirements.md#req-014)、[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-023](../../00-overview/requirements.md#req-023)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/11-ui-rendering.md#screens](../../02-detailed-design/11-ui-rendering.md#screens)、[02-detailed-design/06-builds-offers.md#reroll](../../02-detailed-design/06-builds-offers.md#reroll)

依赖任务：[TASK-027](TASK-027.md)、[TASK-028](TASK-028.md)、[TASK-030](TASK-030.md)、[TASK-031](TASK-031.md)、[TASK-034](TASK-034.md)、[TASK-051](TASK-051.md)

## 文件/模块责任
- `src/ui/panels/builds/`（未来目标路径，当前没有创建此实现）
- `src/ui/dialogs/offers/`（未来目标路径，当前没有创建此实现）
- `src/ui/panels/expedition/`（未来目标路径，当前没有创建此实现）

## 输入
- 树/offer/结算查询
- 中文卡面同源文案
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 树重配界面
- 选卡再选持有人
- 损失原因与清理反馈

## 执行步骤
1. 显示前置/机会成本/配装锁原因
2. 处理持有人失效/空池/不能刷新
3. 结算按伤/撤/死/失物展示

## 验收测试
- AT-038-01：出征中不能重配树；状态not_run
- AT-038-02：无新卡刷新禁用且有解释；状态not_run
- AT-038-03：关页重开同offer同选项；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
