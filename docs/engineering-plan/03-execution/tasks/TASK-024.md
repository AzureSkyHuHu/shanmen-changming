# TASK-024 · 实现触发队列与防递归

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-020](../../00-overview/requirements.md#req-020)、[REQ-017](../../00-overview/requirements.md#req-017)

设计段落：[02-detailed-design/08-effects-statuses-triggers.md#triggers](../../02-detailed-design/08-effects-statuses-triggers.md#triggers)

依赖任务：[TASK-021](TASK-021.md)、[TASK-022](TASK-022.md)、[TASK-023](TASK-023.md)

## 文件/模块责任
- `src/core/combat/triggers/`（未来目标路径，当前没有创建此实现）
- `src/core/combat/diagnostics/`（未来目标路径，当前没有创建此实现）
- `tests/combat/triggers/`（未来目标路径，当前没有创建此实现）

## 输入
- 规范事件字段
- 状态和效果执行器
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 确定性触发排序
- 预算/ICD/限次
- 因果日志

## 执行步骤
1. 冻结每事件的触发器快照
2. 按固定排序生成后续EffectCommand
3. 超预算截断并保存诊断状态

## 验收测试
- AT-024-01：新增状态不监听过去事件；状态not_run
- AT-024-02：proc默认不再同类递归；状态not_run
- AT-024-03：深度8/派生64截断可重放且不重抽；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
