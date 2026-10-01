# TASK-017 · 实现寿元倒地外死亡接入

状态：planned · 负责人：人物成长（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-011](../../00-overview/requirements.md#req-011)、[REQ-004](../../00-overview/requirements.md#req-004)

设计段落：[02-detailed-design/04-cultivation-legacy.md#death](../../02-detailed-design/04-cultivation-legacy.md#death)

依赖任务：[TASK-005](TASK-005.md)、[TASK-006](TASK-006.md)、[TASK-016](TASK-016.md)

## 文件/模块责任
- `src/core/legacy/lifespan/`（未来目标路径，当前没有创建此实现）
- `src/core/legacy/death/`（未来目标路径，当前没有创建此实现）
- `tests/unit/legacy/`（未来目标路径，当前没有创建此实现）

## 输入
- 经营年龄
- 突破致死与统一死亡ID合同
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 年龄/寿元逻辑
- CharacterDeath事务
- 一次性历史

## 执行步骤
1. 区分寿元上限和年龄
2. 统一不同死亡源的提交入口
3. 解除任务预约并保留死者档案

## 验收测试
- AT-017-01：突破不重置年龄；状态not_run
- AT-017-02：重复deathId不重复遗物；状态not_run
- AT-017-03：隐藏/暂停不推进自然致死；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
