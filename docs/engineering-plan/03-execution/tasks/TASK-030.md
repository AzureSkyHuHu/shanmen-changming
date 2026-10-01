# TASK-030 · 实现三选一保底与刷新

状态：planned · 负责人：构筑系统（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-017](../../00-overview/requirements.md#req-017)

设计段落：[02-detailed-design/06-builds-offers.md#offer](../../02-detailed-design/06-builds-offers.md#offer)、[02-detailed-design/06-builds-offers.md#reroll](../../02-detailed-design/06-builds-offers.md#reroll)

依赖任务：[TASK-003](TASK-003.md)、[TASK-024](TASK-024.md)、[TASK-027](TASK-027.md)、[TASK-029](TASK-029.md)

## 文件/模块责任
- `src/core/builds/run-talents/`（未来目标路径，当前没有创建此实现）
- `tests/builds/offers/`（未来目标路径，当前没有创建此实现）
- `tools/simulate-offers/`（未来目标路径，当前没有创建此实现）

## 输入
- 合法卡/持有人查询
- offer随机流与run状态
- 所有前置任务已批准的输出与当前设计版本

## 输出
- OfferState
- 核心/补件保障
- 刷新及补给退路

## 执行步骤
1. 按合法/退路/保底/类别/权重顺序抽选
2. 立即保存offer和随机状态
3. 选择及持有人/次数原子提交

## 验收测试
- AT-030-01：1万seed无非法卡/重复卡；状态not_run
- AT-030-02：无新合法卡禁用刷新不扣次数；状态not_run
- AT-030-03：重载不重抽且空池有补给退路；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
