# TASK-045 · 验证四构筑战役与经济平衡

状态：planned · 负责人：玩法验证（unassigned） · 里程碑：[M4](../milestones.md#m4)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-007](../../00-overview/requirements.md#req-007)、[REQ-017](../../00-overview/requirements.md#req-017)、[REQ-021](../../00-overview/requirements.md#req-021)、[REQ-022](../../00-overview/requirements.md#req-022)、[REQ-027](../../00-overview/requirements.md#req-027)

设计段落：[02-detailed-design/06-builds-offers.md#synergy](../../02-detailed-design/06-builds-offers.md#synergy)、[02-detailed-design/12-campaign.md#tests](../../02-detailed-design/12-campaign.md#tests)

依赖任务：[TASK-044](TASK-044.md)

## 文件/模块责任
- `tools/simulate-builds/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/scenarios/`（未来目标路径，当前没有创建此实现）
- `docs/balance/`（未来目标路径，当前没有创建此实现）

## 输入
- 完整内容
- 四成熟/混搭/朴素配装
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 种子批量结果
- 四构筑对比
- 全战役低运气恢复报告

## 执行步骤
1. 控制境界投入与装备比较构筑
2. 记录弃选率与第五选前联动
3. 实玩三封印/终章/继续经营并回归参数

## 验收测试
- AT-045-01：普通难度不依赖特定稀有卡；状态not_run
- AT-045-02：1万seed保底/空池/减员检查通过；状态not_run
- AT-045-03：极端短粮或主力全伤仍有可执行恢复；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
