# TASK-035 · 实现可见宗门Phaser场景

状态：planned · 负责人：场景表现（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-002](../../00-overview/requirements.md#req-002)、[REQ-003](../../00-overview/requirements.md#req-003)、[REQ-024](../../00-overview/requirements.md#req-024)

设计段落：[02-detailed-design/11-ui-rendering.md#projection](../../02-detailed-design/11-ui-rendering.md#projection)

依赖任务：[TASK-012](TASK-012.md)、[TASK-013](TASK-013.md)、[TASK-014](TASK-014.md)、[TASK-034](TASK-034.md)

## 文件/模块责任
- `src/phaser/scenes/sect/`（未来目标路径，当前没有创建此实现）
- `src/phaser/views/agents/`（未来目标路径，当前没有创建此实现）
- `tests/integration/scene/`（未来目标路径，当前没有创建此实现）

## 输入
- 地图/任务/动作意图投影
- 暂定视觉规范
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 可点选宗门
- 移动工作/练功/照护表现
- 镜头与实体定位

## 执行步骤
1. 差量创建销毁精灵
2. 显示入口排队/缺料/阻塞/施工
3. 所有互动提交领域命令

## 验收测试
- AT-035-01：不开资源表可认主要活动区；状态not_run
- AT-035-02：暂停动画不产经济资源；状态not_run
- AT-035-03：重复场景切换无监听器累积；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
