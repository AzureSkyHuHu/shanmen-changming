# TASK-008 · 实现库存与原子生产事务

状态：planned · 负责人：经济模拟（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-007](../../00-overview/requirements.md#req-007)、[REQ-008](../../00-overview/requirements.md#req-008)

设计段落：[02-detailed-design/02-world-economy.md#transaction](../../02-detailed-design/02-world-economy.md#transaction)

依赖任务：[TASK-003](TASK-003.md)、[TASK-006](TASK-006.md)、[TASK-007](TASK-007.md)

## 文件/模块责任
- `src/core/economy/inventory/`（未来目标路径，当前没有创建此实现）
- `src/core/economy/transactions/`（未来目标路径，当前没有创建此实现）
- `tests/property/economy/`（未来目标路径，当前没有创建此实现）

## 输入
- 库存/预留/在途定义
- 配方schema
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 资源账本
- 预约提交取消接口
- 流水解释查询

## 执行步骤
1. 定义库存和预留不变量
2. 统一生产/交易/拆除事务提交
3. 故障注入每个提交阶段

## 验收测试
- AT-008-01：两订单抢同材料不负库存；状态not_run
- AT-008-02：完成重试不双产出；状态not_run
- AT-008-03：取消只退未耗且不复制产物；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
