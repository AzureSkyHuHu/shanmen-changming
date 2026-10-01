# TASK-001 · 冻结范围与待定决策

状态：planned · 负责人：产品/技术负责人（unassigned） · 里程碑：[M0](../milestones.md#m0)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-001](../../00-overview/requirements.md#req-001)、[REQ-015](../../00-overview/requirements.md#req-015)、[REQ-029](../../00-overview/requirements.md#req-029)、[REQ-030](../../00-overview/requirements.md#req-030)

设计段落：[00-overview/baseline.md#开工前批准项](../../00-overview/baseline.md#开工前批准项)、[decisions/ADR-001-run-boundary.md#决定建议](../../decisions/ADR-001-run-boundary.md#决定建议)

依赖任务：无；但只有评审任务可先讨论，开发尚未授权

## 文件/模块责任
- `docs/adr/`（未来目标路径，当前没有创建此实现）
- `docs/design/`（未来目标路径，当前没有创建此实现）

## 输入
- 冻结设计源与需求目录
- 用户已确认边界
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 范围批准记录
- run边界决策与变更影响表

## 执行步骤
1. 逐项区分已确认/建议/待测试
2. 确认整趟远征为run或记录修改需求
3. 确认开发环境与实现授权后才开放实施任务

## 验收测试
- AT-001-01：需求不得把30开发小时写成游玩时长；状态not_run
- AT-001-02：未确认run保持proposed；状态not_run
- AT-001-03：没有实现授权不得将任何实现任务改为in_progress；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
