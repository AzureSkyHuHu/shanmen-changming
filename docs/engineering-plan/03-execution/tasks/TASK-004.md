# TASK-004 · 实现确定性ID随机与数值

状态：planned · 负责人：模拟核心（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-005](../../00-overview/requirements.md#req-005)、[REQ-020](../../00-overview/requirements.md#req-020)

设计段落：[02-detailed-design/01-kernel-contracts.md#data](../../02-detailed-design/01-kernel-contracts.md#data)

依赖任务：[TASK-002](TASK-002.md)

## 文件/模块责任
- `src/core/kernel/`（未来目标路径，当前没有创建此实现）
- `tests/replay/kernel/`（未来目标路径，当前没有创建此实现）

## 输入
- 数值单位与精度决策
- 稳定ID契约
- 所有前置任务已批准的输出与当前设计版本

## 输出
- ID序列器
- 多随机流
- 统一数值工具与黄金向量

## 执行步骤
1. 选定并记录PRNG算法版本
2. 分离generation/combat/offers等随机流
3. 固定取整与序列化规则

## 验收测试
- AT-004-01：同种子向量完全相同；状态not_run
- AT-004-02：消费表现查询不动核心流；状态not_run
- AT-004-03：存读后下一个ID和随机值连续；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
