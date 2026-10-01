# TASK-005 · 实现三种时钟与调度

状态：planned · 负责人：模拟核心（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-004](../../00-overview/requirements.md#req-004)、[REQ-005](../../00-overview/requirements.md#req-005)

设计段落：[02-detailed-design/01-kernel-contracts.md#advance](../../02-detailed-design/01-kernel-contracts.md#advance)

依赖任务：[TASK-004](TASK-004.md)

## 文件/模块责任
- `src/core/simulation/`（未来目标路径，当前没有创建此实现）
- `src/core/world/calendar.ts`（未来目标路径，当前没有创建此实现）
- `tests/replay/time/`（未来目标路径，当前没有创建此实现）

## 输入
- 固定tick与历法映射
- 暂停原因集合
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 调度表
- 安全推进API
- 暂停/加速合同

## 执行步骤
1. 定义系统次序与低频tick周期
2. 实现多原因暂停和整数步推进
3. 为战略月份暴露逐检查点推进端口

## 验收测试
- AT-005-01：逐步/3倍/低帧到同tick同hash；状态not_run
- AT-005-02：取消一个暂停原因不清其余原因；状态not_run
- AT-005-03：战斗秒数不增长经营年龄；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
