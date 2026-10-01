# TASK-025 · 实现自动战斗战术与撤退

状态：planned · 负责人：战斗玩法（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-012](../../00-overview/requirements.md#req-012)、[REQ-013](../../00-overview/requirements.md#req-013)

设计段落：[02-detailed-design/07-combat-pipeline.md#tactics](../../02-detailed-design/07-combat-pipeline.md#tactics)

依赖任务：[TASK-021](TASK-021.md)、[TASK-022](TASK-022.md)、[TASK-023](TASK-023.md)、[TASK-024](TASK-024.md)

## 文件/模块责任
- `src/core/combat/ai/`（未来目标路径，当前没有创建此实现）
- `src/core/combat/tactics/`（未来目标路径，当前没有创建此实现）
- `tests/combat/tactics/`（未来目标路径，当前没有创建此实现）

## 输入
- 动作合法性
- 选敌与导航合同
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 自动行为规则
- 玩家战术队列
- 有限消耗与撤退过程

## 执行步骤
1. 自动/手动同走意图校验
2. 实现集火/护卫/位移/保留技能规则
3. 撤退出口读条与中断明确

## 验收测试
- AT-025-01：无命令可过低风险遭遇；状态not_run
- AT-025-02：暂停排令恢复不会重复执行；状态not_run
- AT-025-03：稀缺救命品不默认自动消耗；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
