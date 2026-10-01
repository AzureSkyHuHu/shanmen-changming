# TASK-019 · 定义战斗强类型协议

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-012](../../00-overview/requirements.md#req-012)、[REQ-018](../../00-overview/requirements.md#req-018)

设计段落：[02-detailed-design/07-combat-pipeline.md#action](../../02-detailed-design/07-combat-pipeline.md#action)、[02-detailed-design/08-effects-statuses-triggers.md#source](../../02-detailed-design/08-effects-statuses-triggers.md#source)

依赖任务：[TASK-003](TASK-003.md)、[TASK-004](TASK-004.md)、[TASK-006](TASK-006.md)

## 文件/模块责任
- `src/core/combat/definitions/`（未来目标路径，当前没有创建此实现）
- `src/content/schemas/combat/`（未来目标路径，当前没有创建此实现）
- `tests/unit/combat-contracts/`（未来目标路径，当前没有创建此实现）

## 输入
- 白名单内容schema
- 动作/事件和生命周期合同
- 所有前置任务已批准的输出与当前设计版本

## 输出
- Skill/Talent/Status/Effect协议
- 能力注册表

## 执行步骤
1. 区分Definition与Instance及scope/duration
2. 把目标/条件/效果写成辨识联合
3. 建立未实现能力阻塞规则

## 验收测试
- AT-019-01：内容不能执行任意脚本；状态not_run
- AT-019-02：run来源5秒盾可合法表达；状态not_run
- AT-019-03：未实现Summon不能加载纸傀内容；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
