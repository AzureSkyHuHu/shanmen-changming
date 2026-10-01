# TASK-016 · 实现修炼与突破风险事务

状态：planned · 负责人：人物成长（unassigned） · 里程碑：[M2](../milestones.md#m2)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-010](../../00-overview/requirements.md#req-010)、[REQ-009](../../00-overview/requirements.md#req-009)

设计段落：[02-detailed-design/04-cultivation-legacy.md#breakthrough](../../02-detailed-design/04-cultivation-legacy.md#breakthrough)

依赖任务：[TASK-003](TASK-003.md)、[TASK-005](TASK-005.md)、[TASK-008](TASK-008.md)、[TASK-013](TASK-013.md)

## 文件/模块责任
- `src/core/cultivation/`（未来目标路径，当前没有创建此实现）
- `src/core/queries/breakthrough/`（未来目标路径，当前没有创建此实现）
- `tests/unit/cultivation/`（未来目标路径，当前没有创建此实现）

## 输入
- 境界和公式基线
- 预留与风险停表接口
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 风险纯查询
- 闭关状态机
- 一次性抽样结果

## 执行步骤
1. 统一预览与结算因素计算
2. 预览版本过期重新评估
3. 保存成本/sampleId/随机流位置与结果

## 验收测试
- AT-016-01：70%成功不能显示成30%死亡；状态not_run
- AT-016-02：重复确认不重扣或重抽；状态not_run
- AT-016-03：闭关短粮能停在安全检查点；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
