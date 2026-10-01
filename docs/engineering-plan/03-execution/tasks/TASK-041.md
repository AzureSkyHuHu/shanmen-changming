# TASK-041 · 实现事件主线与终章骨架

状态：planned · 负责人：战役系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-022](../../00-overview/requirements.md#req-022)、[REQ-009](../../00-overview/requirements.md#req-009)、[REQ-011](../../00-overview/requirements.md#req-011)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/12-campaign.md#events](../../02-detailed-design/12-campaign.md#events)、[02-detailed-design/12-campaign.md#quests](../../02-detailed-design/12-campaign.md#quests)

依赖任务：[TASK-018](TASK-018.md)、[TASK-031](TASK-031.md)、[TASK-032](TASK-032.md)、[TASK-034](TASK-034.md)、[TASK-051](TASK-051.md)

## 文件/模块责任
- `src/core/progression/`（未来目标路径，当前没有创建此实现）
- `src/content/events/`（未来目标路径，当前没有创建此实现）
- `tests/integration/campaign/`（未来目标路径，当前没有创建此实现）

## 输入
- 事件/主线合同
- 死亡继任与区域结果
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 事件选择事务
- 主线DAG与延后结果
- 终章/继续经营状态

## 执行步骤
1. 先做师徒/冒险/短缺三条贯穿链
2. 随机事件先合法过滤再抽
3. 主线奖励与延后结果幂等保存

## 验收测试
- AT-041-01：失效参与人不强扣成本；状态not_run
- AT-041-02：低运气路线也可得关键材料；状态not_run
- AT-041-03：终章后可继续原宗门经营；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
