# TASK-022 · 实现伤害护盾濒死倒地

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-019](../../00-overview/requirements.md#req-019)、[REQ-011](../../00-overview/requirements.md#req-011)

设计段落：[02-detailed-design/07-combat-pipeline.md#pipeline](../../02-detailed-design/07-combat-pipeline.md#pipeline)、[02-detailed-design/07-combat-pipeline.md#life](../../02-detailed-design/07-combat-pipeline.md#life)

依赖任务：[TASK-020](TASK-020.md)、[TASK-021](TASK-021.md)、[TASK-017](TASK-017.md)

## 文件/模块责任
- `src/core/combat/pipeline/damage/`（未来目标路径，当前没有创建此实现）
- `src/core/combat/pipeline/life/`（未来目标路径，当前没有创建此实现）
- `tests/combat/life/`（未来目标路径，当前没有创建此实现）

## 输入
- 规范阶段顺序
- 角色永久死亡入口
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 统一伤害/治疗事件
- Alive/Downed/Recovered/Dead
- 真实吸盾统计

## 执行步骤
1. 区分请求/减免/盾/生命损失
2. 濒死自保先于倒地/死亡提交
3. 倒地释放行动且只死亡发遗产

## 验收测试
- AT-022-01：全盾吸收不触发生命伤害；状态not_run
- AT-022-02：UnitDowned不发UnitDied奖励；状态not_run
- AT-022-03：双致死源只产生一个deathId；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
