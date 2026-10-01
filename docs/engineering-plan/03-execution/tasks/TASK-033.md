# TASK-033 · 制作垂直切片内容包

状态：planned · 负责人：内容制作（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-013](../../00-overview/requirements.md#req-013)、[REQ-014](../../00-overview/requirements.md#req-014)、[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-017](../../00-overview/requirements.md#req-017)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/09-content-authoring.md#catalog](../../02-detailed-design/09-content-authoring.md#catalog)

依赖任务：[TASK-003](TASK-003.md)、[TASK-018](TASK-018.md)、[TASK-026](TASK-026.md)、[TASK-027](TASK-027.md)、[TASK-030](TASK-030.md)、[TASK-032](TASK-032.md)、[TASK-051](TASK-051.md)

## 文件/模块责任
- `src/content/definitions/`（未来目标路径，当前没有创建此实现）
- `src/content/locales/zh-CN/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/content/`（未来目标路径，当前没有创建此实现）

## 输入
- 源§2切片数量
- 两套核心构筑与已实现操作
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 8技能/12机缘/2树原型
- 6类建筑/8配方/12事件切片
- 内容manifest

## 执行步骤
1. 先选能自启动且有对比的两套构筑
2. 逐条制作定义/说明/能力依赖/测试
3. 按切片标签计数并校验引用

## 验收测试
- AT-033-01：没有未实现操作混入包；状态not_run
- AT-033-02：每卡显示来源/持有人/触发约束；状态not_run
- AT-033-03：切片计数达标且每项实际可用；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
