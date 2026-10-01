# TASK-023 · 实现状态叠层到期与清理

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-018](../../00-overview/requirements.md#req-018)、[REQ-020](../../00-overview/requirements.md#req-020)

设计段落：[02-detailed-design/08-effects-statuses-triggers.md#status](../../02-detailed-design/08-effects-statuses-triggers.md#status)

依赖任务：[TASK-020](TASK-020.md)、[TASK-022](TASK-022.md)

## 文件/模块责任
- `src/core/combat/statuses/`（未来目标路径，当前没有创建此实现）
- `tests/combat/statuses/`（未来目标路径，当前没有创建此实现）

## 输入
- 状态身份和duration
- 伤害事件
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 状态实例管理器
- 驱散与来源回收
- 周期调度

## 执行步骤
1. 实现刷新/延长/独立/强者覆盖策略
2. 排他到期先清再周期
3. 按scope和sourceInstance统一回收

## 验收测试
- AT-023-01：到期tick不多跳伤害；状态not_run
- AT-023-02：不同施法者独立状态按规则共存；状态not_run
- AT-023-03：每shieldInstance只触发一次破裂；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
