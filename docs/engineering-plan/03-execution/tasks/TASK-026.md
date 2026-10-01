# TASK-026 · 验证战斗回放与数据扩展

状态：planned · 负责人：战斗验证（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-005](../../00-overview/requirements.md#req-005)、[REQ-018](../../00-overview/requirements.md#req-018)、[REQ-019](../../00-overview/requirements.md#req-019)、[REQ-020](../../00-overview/requirements.md#req-020)

设计段落：[02-detailed-design/08-effects-statuses-triggers.md#tests](../../02-detailed-design/08-effects-statuses-triggers.md#tests)

依赖任务：[TASK-024](TASK-024.md)、[TASK-025](TASK-025.md)

## 文件/模块责任
- `tests/replay/combat/`（未来目标路径，当前没有创建此实现）
- `tests/combat/extension/`（未来目标路径，当前没有创建此实现）
- `tools/replay/`（未来目标路径，当前没有创建此实现）

## 输入
- 完整战斗管线
- 两个代表构筑链
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 黄金回放
- 数据新增证明
- 触发异常诊断

## 执行步骤
1. 记录初态/seed/指令/版本与hash
2. 只加定义做一技能一天赋
3. 执行暴击雷引与吸盾反震黄金链

## 验收测试
- AT-026-01：增内容不修改主循环；状态not_run
- AT-026-02：暂停/低帧/重载同结算；状态not_run
- AT-026-03：日志截断不改变累计伤害；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
