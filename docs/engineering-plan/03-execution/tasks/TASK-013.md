# TASK-013 · 实现需求日程和调岗政策

状态：planned · 负责人：人物模拟（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-006](../../00-overview/requirements.md#req-006)、[REQ-009](../../00-overview/requirements.md#req-009)

设计段落：[02-detailed-design/03-agents-navigation.md#selection](../../02-detailed-design/03-agents-navigation.md#selection)

依赖任务：[TASK-011](TASK-011.md)、[TASK-012](TASK-012.md)

## 文件/模块责任
- `src/core/agents/needs/`（未来目标路径，当前没有创建此实现）
- `src/core/agents/schedules/`（未来目标路径，当前没有创建此实现）
- `src/core/queries/agents/`（未来目标路径，当前没有创建此实现）

## 输入
- 生理安全优先级
- 角色特质与岗位政策
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 需求变化
- 确定性工作选择
- 调岗原因

## 执行步骤
1. 落实安全/照护/承诺/日程/兴趣顺序
2. 过滤伤员/闭关/出征独占状态
3. 提供批量配额与冲突说明

## 验收测试
- AT-013-01：饥饿可中断非紧急工作；状态not_run
- AT-013-02：远征角色不继续产资源；状态not_run
- AT-013-03：同分候选按稳定ID且可解释；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
