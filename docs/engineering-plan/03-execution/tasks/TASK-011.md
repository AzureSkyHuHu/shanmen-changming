# TASK-011 · 实现任务岗位与恢复

状态：planned · 负责人：人物模拟（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-002](../../00-overview/requirements.md#req-002)、[REQ-006](../../00-overview/requirements.md#req-006)

设计段落：[02-detailed-design/03-agents-navigation.md#model](../../02-detailed-design/03-agents-navigation.md#model)

依赖任务：[TASK-005](TASK-005.md)、[TASK-008](TASK-008.md)、[TASK-009](TASK-009.md)

## 文件/模块责任
- `src/core/agents/jobs/`（未来目标路径，当前没有创建此实现）
- `src/core/agents/reservations/`（未来目标路径，当前没有创建此实现）
- `tests/unit/jobs/`（未来目标路径，当前没有创建此实现）

## 输入
- 事务接口
- Job状态图
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 岗位令牌
- 任务状态机
- 中断恢复序列化

## 执行步骤
1. 将每个状态的申请/释放动作显式化
2. 工作只累计合法有效工时
3. 取消/读档恢复复用原job与事务ID

## 验收测试
- AT-011-01：任务中断不重复产出；状态not_run
- AT-011-02：一个席位最多一名合法占用；状态not_run
- AT-011-03：保存后恢复不再预约同材料；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
