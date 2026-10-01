# TASK-020 · 实现属性求值与目标仲裁

状态：planned · 负责人：战斗核心（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-018](../../00-overview/requirements.md#req-018)、[REQ-020](../../00-overview/requirements.md#req-020)

设计段落：[02-detailed-design/08-effects-statuses-triggers.md#modifier](../../02-detailed-design/08-effects-statuses-triggers.md#modifier)、[02-detailed-design/07-combat-pipeline.md#pipeline](../../02-detailed-design/07-combat-pipeline.md#pipeline)

依赖任务：[TASK-019](TASK-019.md)

## 文件/模块责任
- `src/core/combat/modifiers/`（未来目标路径，当前没有创建此实现）
- `src/core/combat/targeting/`（未来目标路径，当前没有创建此实现）
- `tests/unit/stats-targeting/`（未来目标路径，当前没有创建此实现）

## 输入
- 属性/目标定义
- 稳定ID和取整工具
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 统一属性桶
- 快照/live读取
- 目标筛选排序

## 执行步骤
1. 实现来源账本和缓存revision
2. 固定加法/乘区/上限/取整顺序
3. 实现距离/低血量同分稳定选择

## 验收测试
- AT-020-01：移除甲光环不删乙贡献；状态not_run
- AT-020-02：快照不持有可变对象；状态not_run
- AT-020-03：同位置同血量总选相同合法ID；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
