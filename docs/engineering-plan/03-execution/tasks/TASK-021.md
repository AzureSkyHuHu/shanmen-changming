# TASK-021 · 实现施法预约提交与打断

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-019](../../00-overview/requirements.md#req-019)、[REQ-012](../../00-overview/requirements.md#req-012)

设计段落：[02-detailed-design/07-combat-pipeline.md#action](../../02-detailed-design/07-combat-pipeline.md#action)

依赖任务：[TASK-019](TASK-019.md)、[TASK-020](TASK-020.md)、[TASK-008](TASK-008.md)

## 文件/模块责任
- `src/core/combat/pipeline/actions/`（未来目标路径，当前没有创建此实现）
- `tests/unit/actions/`（未来目标路径，当前没有创建此实现）

## 输入
- 动作状态机
- 资源预约端口
- 所有前置任务已批准的输出与当前设计版本

## 输出
- ActionCommitted入口
- 冷却与施法队列
- 打断释放

## 执行步骤
1. 请求时预约但不发施法收益
2. 前摇末重验再提交费用/冷却
3. 已发投射物落空按定义处理

## 验收测试
- AT-021-01：两个技能不能花同份灵力；状态not_run
- AT-021-02：前摇取消不刷天赋收益；状态not_run
- AT-021-03：投射物落空默认不退正式费用；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
