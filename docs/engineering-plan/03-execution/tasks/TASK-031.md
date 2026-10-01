# TASK-031 · 实现远征退出损失与清理

状态：planned · 负责人：远征系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-015](../../00-overview/requirements.md#req-015)、[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-011](../../00-overview/requirements.md#req-011)

设计段落：[02-detailed-design/05-run-lifecycle.md#exit](../../02-detailed-design/05-run-lifecycle.md#exit)

依赖任务：[TASK-023](TASK-023.md)、[TASK-029](TASK-029.md)、[TASK-030](TASK-030.md)

## 文件/模块责任
- `src/core/expeditions/settlement/`（未来目标路径，当前没有创建此实现）
- `tests/integration/run-exit/`（未来目标路径，当前没有创建此实现）

## 输入
- 封存/未封存规则
- source生命周期管理
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 唯一EndRun事务
- 损失报告
- 安全重试接口

## 执行步骤
1. 汇合胜利/安全撤回/紧急撤退/全灭入口
2. 结算返程月耗和资产
3. 清理run/encounter并恢复幸存者岗位资格

## 验收测试
- AT-031-01：重复EndRun不双奖励；状态not_run
- AT-031-02：character树留下而run机缘清除；状态not_run
- AT-031-03：Ending中途读档和新run重试无旧队列；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
