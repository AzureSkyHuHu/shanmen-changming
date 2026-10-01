# TASK-032 · 制作首地区路线与首领

状态：planned · 负责人：遭遇内容（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-021](../../00-overview/requirements.md#req-021)、[REQ-012](../../00-overview/requirements.md#req-012)

设计段落：[02-detailed-design/12-campaign.md#quests](../../02-detailed-design/12-campaign.md#quests)、[02-detailed-design/05-run-lifecycle.md#encounter](../../02-detailed-design/05-run-lifecycle.md#encounter)

依赖任务：[TASK-025](TASK-025.md)、[TASK-029](TASK-029.md)、[TASK-031](TASK-031.md)

## 文件/模块责任
- `src/content/encounters/`（未来目标路径，当前没有创建此实现）
- `src/content/maps/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/encounters/`（未来目标路径，当前没有创建此实现）

## 输入
- 近山区域设计
- 预告/打断/净化能力
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 近山路线
- 千藤妖木首领
- 普通敌群切片

## 执行步骤
1. 用数据建立营地/分支/战斗/返程
2. 首领加入藤核与蓄力处理
3. 配置侦察与材料保底

## 验收测试
- AT-032-01：首领有可见预告/阶段/主动处理；状态not_run
- AT-032-02：不同合理队伍可击败；状态not_run
- AT-032-03：失败可疗伤重试而非经济锁死；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
