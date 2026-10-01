# TASK-012 · 实现路径入口与堵塞诊断

状态：planned · 负责人：空间模拟（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-002](../../00-overview/requirements.md#req-002)、[REQ-006](../../00-overview/requirements.md#req-006)

设计段落：[02-detailed-design/03-agents-navigation.md#path](../../02-detailed-design/03-agents-navigation.md#path)

依赖任务：[TASK-007](TASK-007.md)、[TASK-011](TASK-011.md)

## 文件/模块责任
- `src/core/agents/navigation/`（未来目标路径，当前没有创建此实现）
- `src/core/world/navigation/`（未来目标路径，当前没有创建此实现）
- `tests/integration/navigation/`（未来目标路径，当前没有创建此实现）

## 输入
- 地图与job目的地
- 入口/排队规则
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 有预算寻路
- navVersion缓存
- 阻塞原因查询

## 执行步骤
1. 建立可达区域和入口令牌
2. 地图变更局部失效路径
3. 加入让行/排队/超时诊断

## 验收测试
- AT-012-01：断路不穿墙完成任务；状态not_run
- AT-012-02：移动建筑后缓存失效；状态not_run
- AT-012-03：36人寻路预算有界且任务最终可诊断；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
