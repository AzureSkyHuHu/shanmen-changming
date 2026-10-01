# TASK-047 · 执行存档故障兼容与长跑

状态：planned · 负责人：可靠性验证（unassigned） · 里程碑：[M4](../milestones.md#m4)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-025](../../00-overview/requirements.md#req-025)、[REQ-026](../../00-overview/requirements.md#req-026)、[REQ-027](../../00-overview/requirements.md#req-027)

设计段落：[02-detailed-design/10-save-and-recovery.md#tests](../../02-detailed-design/10-save-and-recovery.md#tests)、[03-execution/qa-matrix.md](../../03-execution/qa-matrix.md)

依赖任务：[TASK-039](TASK-039.md)、[TASK-044](TASK-044.md)、[TASK-046](TASK-046.md)

## 文件/模块责任
- `tests/integration/saves/`（未来目标路径，当前没有创建此实现）
- `tests/e2e/recovery/`（未来目标路径，当前没有创建此实现）
- `tests/replay/soak/`（未来目标路径，当前没有创建此实现）

## 输入
- 所有版本fixture
- 完整Run/Battle快照
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 配额/断写/坏档/多标签报告
- 旧档迁移矩阵
- 50次场景切换与长跑报告

## 执行步骤
1. 注入保存每个关键阶段故障
2. 恢复战斗队列/offer/Ending部分月耗
3. 测50次切换及长期内存增长

## 验收测试
- AT-047-01：坏档永不覆盖成功档；状态not_run
- AT-047-02：恢复不重抽/重发/重置ICD；状态not_run
- AT-047-03：多标签接管只保留一个writer；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
