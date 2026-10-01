# TASK-039 · 实现隐藏暂停单写标签页

状态：planned · 负责人：平台集成（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-026](../../00-overview/requirements.md#req-026)、[REQ-004](../../00-overview/requirements.md#req-004)、[REQ-025](../../00-overview/requirements.md#req-025)

设计段落：[02-detailed-design/10-save-and-recovery.md#tabs](../../02-detailed-design/10-save-and-recovery.md#tabs)

依赖任务：[TASK-009](TASK-009.md)、[TASK-010](TASK-010.md)、[TASK-034](TASK-034.md)、[TASK-037](TASK-037.md)

## 文件/模块责任
- `src/platform/browser/`（未来目标路径，当前没有创建此实现）
- `src/platform/persistence/ownership/`（未来目标路径，当前没有创建此实现）
- `tests/e2e/multitab/`（未来目标路径，当前没有创建此实现）

## 输入
- 暂停原因集合
- 保存写权epoch
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 单writer适配器
- 隐藏/恢复反馈
- 存储错误告警

## 执行步骤
1. 核验目标浏览器锁API并选fallback
2. 每次写入验证当前epoch
3. 隐藏加暂停恢复保留其他暂停原因

## 验收测试
- AT-039-01：两个标签不能并行写同槽；状态not_run
- AT-039-02：旧writer被接管后拒写；状态not_run
- AT-039-03：离线/隐藏不自动衰老死亡；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
