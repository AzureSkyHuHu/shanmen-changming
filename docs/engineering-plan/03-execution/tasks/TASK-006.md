# TASK-006 · 实现指令事务事件入口

状态：planned · 负责人：模拟核心（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-005](../../00-overview/requirements.md#req-005)、[REQ-007](../../00-overview/requirements.md#req-007)、[REQ-019](../../00-overview/requirements.md#req-019)

设计段落：[02-detailed-design/01-kernel-contracts.md#idempotency](../../02-detailed-design/01-kernel-contracts.md#idempotency)

依赖任务：[TASK-004](TASK-004.md)、[TASK-005](TASK-005.md)

## 文件/模块责任
- `src/core/kernel/commands/`（未来目标路径，当前没有创建此实现）
- `src/core/kernel/events/`（未来目标路径，当前没有创建此实现）
- `src/application/command-dispatcher.ts`（未来目标路径，当前没有创建此实现）
- `tests/unit/commands/`（未来目标路径，当前没有创建此实现）

## 输入
- 指令/事件合同
- ID与时钟
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 有序dispatcher
- 事务结果与去重账本
- 不可变事件包

## 执行步骤
1. 区分接受/拒绝/提交反馈
2. 执行同ID同payload幂等与异payload拒绝
3. 事件序号/根因关联在提交时生成

## 验收测试
- AT-006-01：双击只扣一次；状态not_run
- AT-006-02：非法命令不消耗随机流；状态not_run
- AT-006-03：同ID异payload不能复用旧成功；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
