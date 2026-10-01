# TASK-007 · 构造可解的开局世界

状态：planned · 负责人：世界模拟（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-001](../../00-overview/requirements.md#req-001)、[REQ-003](../../00-overview/requirements.md#req-003)、[REQ-007](../../00-overview/requirements.md#req-007)

设计段落：[02-detailed-design/02-world-economy.md#data](../../02-detailed-design/02-world-economy.md#data)

依赖任务：[TASK-003](TASK-003.md)、[TASK-004](TASK-004.md)、[TASK-006](TASK-006.md)

## 文件/模块责任
- `src/core/world/`（未来目标路径，当前没有创建此实现）
- `src/content/maps/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/scenarios/`（未来目标路径，当前没有创建此实现）

## 输入
- 开局4人混合年龄规则
- 地图基础资源和道路约束
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 种子开局生成器
- 4人/6人/36人夹具

## 执行步骤
1. 生成地块灵脉资源与稳定人物ID
2. 约束至少两人能承担生计
3. 验证关键资源及突破路线可达

## 验收测试
- AT-007-01：同seed生成同世界；状态not_run
- AT-007-02：4人开局可达食物与住处；状态not_run
- AT-007-03：硬上限36不能越界招募；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
