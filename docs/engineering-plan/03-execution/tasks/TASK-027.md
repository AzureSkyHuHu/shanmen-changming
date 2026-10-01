# TASK-027 · 实现永久树与点数重配

状态：planned · 负责人：构筑系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-014](../../00-overview/requirements.md#req-014)、[REQ-013](../../00-overview/requirements.md#req-013)

设计段落：[02-detailed-design/06-builds-offers.md#tree](../../02-detailed-design/06-builds-offers.md#tree)

依赖任务：[TASK-003](TASK-003.md)、[TASK-016](TASK-016.md)、[TASK-020](TASK-020.md)

## 文件/模块责任
- `src/core/builds/permanent-tree/`（未来目标路径，当前没有创建此实现）
- `tests/builds/tree/`（未来目标路径，当前没有创建此实现）

## 输入
- 36节点方向目录
- 里程碑/来源账本
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 主树与点数
- 拓扑重配事务
- 解锁解释

## 执行步骤
1. 验证3×3节点拓扑
2. 按个人里程碑幂等发5点
3. 宗门内逆拓扑撤销重装来源

## 验收测试
- AT-027-01：5点不能双终点；状态not_run
- AT-027-02：重配不残留旧加成；状态not_run
- AT-027-03：读档/重复任务不重复发点；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
