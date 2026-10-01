# TASK-018 · 实现师承关系与继任传承

状态：planned · 负责人：叙事模拟（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-009](../../00-overview/requirements.md#req-009)、[REQ-011](../../00-overview/requirements.md#req-011)

设计段落：[02-detailed-design/04-cultivation-legacy.md#progression](../../02-detailed-design/04-cultivation-legacy.md#progression)、[02-detailed-design/04-cultivation-legacy.md#death](../../02-detailed-design/04-cultivation-legacy.md#death)

依赖任务：[TASK-013](TASK-013.md)、[TASK-017](TASK-017.md)

## 文件/模块责任
- `src/core/legacy/mentorship/`（未来目标路径，当前没有创建此实现）
- `src/core/legacy/inheritance/`（未来目标路径，当前没有创建此实现）
- `src/core/world/relationships/`（未来目标路径，当前没有创建此实现）

## 输入
- 人物ID/死亡事件
- 授业与记忆规则
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 三轴关系及原因
- 授课和继承事务
- 掌门继任/复兴状态

## 执行步骤
1. 给关系变化附原因与周期上限
2. 按生前传授记录转交合法资产
3. 最后一人死亡触发明确复兴选择

## 验收测试
- AT-018-01：师父死亡不删弟子已学技能；状态not_run
- AT-018-02：未传授战力不无损复制；状态not_run
- AT-018-03：继任保留宗门库存与建筑；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
