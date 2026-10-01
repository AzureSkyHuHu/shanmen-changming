# TASK-029 · 实现远征节点战略时间

状态：planned · 负责人：远征系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-004](../../00-overview/requirements.md#req-004)、[REQ-015](../../00-overview/requirements.md#req-015)、[REQ-021](../../00-overview/requirements.md#req-021)

设计段落：[02-detailed-design/05-run-lifecycle.md#state](../../02-detailed-design/05-run-lifecycle.md#state)、[02-detailed-design/05-run-lifecycle.md#entry](../../02-detailed-design/05-run-lifecycle.md#entry)

依赖任务：[TASK-005](TASK-005.md)、[TASK-009](TASK-009.md)、[TASK-025](TASK-025.md)、[TASK-028](TASK-028.md)

## 文件/模块责任
- `src/core/expeditions/`（未来目标路径，当前没有创建此实现）
- `src/core/queries/expeditions/`（未来目标路径，当前没有创建此实现）
- `tests/integration/expedition-time/`（未来目标路径，当前没有创建此实现）

## 输入
- 已批准run边界
- 出发配装/补给与路线
- 所有前置任务已批准的输出与当前设计版本

## 输出
- RunState
- 节点月耗账本
- 战斗出入接口

## 执行步骤
1. 出发锁配装与人员生产占用
2. 旅行月份走经营检查点
3. 保存节点部分月耗与提交ID

## 验收测试
- AT-029-01：三场战斗不额外增加经营月耗；状态not_run
- AT-029-02：返程只扣标注返程月数；状态not_run
- AT-029-03：旅行风险暂停后恢复不双计；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
