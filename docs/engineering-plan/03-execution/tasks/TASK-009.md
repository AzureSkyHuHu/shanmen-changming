# TASK-009 · 实现早期完整快照保存

状态：planned · 负责人：平台持久化（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-025](../../00-overview/requirements.md#req-025)、[REQ-005](../../00-overview/requirements.md#req-005)

设计段落：[02-detailed-design/10-save-and-recovery.md#envelope](../../02-detailed-design/10-save-and-recovery.md#envelope)、[02-detailed-design/10-save-and-recovery.md#write](../../02-detailed-design/10-save-and-recovery.md#write)

依赖任务：[TASK-006](TASK-006.md)、[TASK-008](TASK-008.md)

## 文件/模块责任
- `src/application/save-coordinator.ts`（未来目标路径，当前没有创建此实现）
- `src/platform/persistence/`（未来目标路径，当前没有创建此实现）
- `tests/integration/saves/`（未来目标路径，当前没有创建此实现）

## 输入
- 世界和事务可序列化状态
- 版本字段
- 所有前置任务已批准的输出与当前设计版本

## 输出
- SaveEnvelope
- IndexedDB端口
- 写新再切指针协议

## 执行步骤
1. 定义最小完整快照与checksum
2. 仅在完整tick/事务边界取快照
3. 写新记录验证成功后更新current

## 验收测试
- AT-009-01：roundtrip领域hash不变；状态not_run
- AT-009-02：写新后断电仍可读上一成功档；状态not_run
- AT-009-03：保存失败UI不能收到成功事件；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
