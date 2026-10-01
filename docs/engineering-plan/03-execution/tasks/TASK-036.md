# TASK-036 · 实现战斗表现预告和日志

状态：planned · 负责人：场景表现（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-012](../../00-overview/requirements.md#req-012)、[REQ-023](../../00-overview/requirements.md#req-023)、[REQ-024](../../00-overview/requirements.md#req-024)

设计段落：[02-detailed-design/11-ui-rendering.md#screens](../../02-detailed-design/11-ui-rendering.md#screens)

依赖任务：[TASK-025](TASK-025.md)、[TASK-032](TASK-032.md)、[TASK-034](TASK-034.md)

## 文件/模块责任
- `src/phaser/scenes/battle/`（未来目标路径，当前没有创建此实现）
- `src/phaser/views/effects/`（未来目标路径，当前没有创建此实现）
- `src/ui/panels/combat-log/`（未来目标路径，当前没有创建此实现）

## 输入
- 战斗事件/伤害分解
- 首领预告数据
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 战场指令反馈
- 危险图形+文本
- 因果日志

## 执行步骤
1. 用逻辑事件驱动VFX不反向结算
2. 区分命令接收/拒绝/执行
3. 展示倒地/救援/死亡区别

## 验收测试
- AT-036-01：静音/色觉差异仍识别危险；状态not_run
- AT-036-02：伤害事件与日志一致；状态not_run
- AT-036-03：慢动画不推迟权威伤害或冷却；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
