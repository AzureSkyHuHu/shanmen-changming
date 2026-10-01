# TASK-014 · 实现建筑研究维护闭环

状态：planned · 负责人：经济模拟（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-008](../../00-overview/requirements.md#req-008)、[REQ-007](../../00-overview/requirements.md#req-007)

设计段落：[02-detailed-design/02-world-economy.md#buildings](../../02-detailed-design/02-world-economy.md#buildings)

依赖任务：[TASK-008](TASK-008.md)、[TASK-011](TASK-011.md)、[TASK-012](TASK-012.md)

## 文件/模块责任
- `src/core/economy/construction/`（未来目标路径，当前没有创建此实现）
- `src/core/economy/research/`（未来目标路径，当前没有创建此实现）
- `src/content/definitions/buildings/`（未来目标路径，当前没有创建此实现）

## 输入
- 蓝图与入口校验
- 建筑/研究源目录
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 建设升级/取消/搬迁
- 维护结算
- 研究解锁图

## 执行步骤
1. 预览和提交均验地形/入口
2. 施工预算与已耗材料分账
3. 升级和研究奖励用独立提交ID

## 验收测试
- AT-014-01：缺料蓝图不清空仓库；状态not_run
- AT-014-02：拆除返还低于投入且重复操作幂等；状态not_run
- AT-014-03：研究图无环且奖励只发一次；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
