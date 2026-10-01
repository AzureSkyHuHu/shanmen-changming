# TASK-015 · 验证基础经济与恢复路线

状态：planned · 负责人：玩法验证（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-003](../../00-overview/requirements.md#req-003)、[REQ-007](../../00-overview/requirements.md#req-007)、[REQ-027](../../00-overview/requirements.md#req-027)

设计段落：[02-detailed-design/02-world-economy.md#recovery](../../02-detailed-design/02-world-economy.md#recovery)

依赖任务：[TASK-013](TASK-013.md)、[TASK-014](TASK-014.md)

## 文件/模块责任
- `tools/simulate-economy/`（未来目标路径，当前没有创建此实现）
- `tests/property/economy/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/scenarios/`（未来目标路径，当前没有创建此实现）

## 输入
- 生产维护与人物系统
- 4/12/24/36人口夹具
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 经济批量模拟报告
- 反套利和困境恢复案例

## 执行步骤
1. 建立稳定/坏收成/主力伤病等场景
2. 追踪供需/有效劳力/关键材料
3. 用失败seed定位并提出参数修订

## 验收测试
- AT-015-01：基础觅食不需口粮启动；状态not_run
- AT-015-02：拆造/交易/配方循环不净增资源；状态not_run
- AT-015-03：150年中锁死均有记录与修复路径；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
