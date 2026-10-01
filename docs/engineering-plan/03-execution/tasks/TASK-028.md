# TASK-028 · 实现技能配装与装备词条

状态：planned · 负责人：构筑系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-013](../../00-overview/requirements.md#req-013)、[REQ-017](../../00-overview/requirements.md#req-017)

设计段落：[02-detailed-design/06-builds-offers.md#tree](../../02-detailed-design/06-builds-offers.md#tree)

依赖任务：[TASK-019](TASK-019.md)、[TASK-020](TASK-020.md)、[TASK-027](TASK-027.md)

## 文件/模块责任
- `src/core/builds/loadout/`（未来目标路径，当前没有创建此实现）
- `src/content/definitions/items/`（未来目标路径，当前没有创建此实现）
- `tests/builds/loadout/`（未来目标路径，当前没有创建此实现）

## 输入
- 技能学习与主树
- 槽位/装备基线
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 合法装配查询
- 配装事务
- 词条来源映射

## 执行步骤
1. 校验技能已学/境界/槽位
2. 终极替换主动而非扩槽
3. 统一词条来源与静态强度桶

## 验收测试
- AT-028-01：两个主动槽不能装三项；状态not_run
- AT-028-02：更换装备清理旧来源；状态not_run
- AT-028-03：普通底盘能启动四套代表循环；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
