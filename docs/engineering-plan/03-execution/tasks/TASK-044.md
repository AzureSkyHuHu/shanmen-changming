# TASK-044 · 扩充完整1.0内容目录

状态：planned · 负责人：内容制作（unassigned） · 里程碑：[M4](../milestones.md#m4)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-008](../../00-overview/requirements.md#req-008)、[REQ-013](../../00-overview/requirements.md#req-013)、[REQ-014](../../00-overview/requirements.md#req-014)、[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-021](../../00-overview/requirements.md#req-021)、[REQ-022](../../00-overview/requirements.md#req-022)

设计段落：[02-detailed-design/09-content-authoring.md#catalog](../../02-detailed-design/09-content-authoring.md#catalog)、[00-overview/baseline.md](../../00-overview/baseline.md)

依赖任务：[TASK-043](TASK-043.md)

## 文件/模块责任
- `src/content/definitions/`（未来目标路径，当前没有创建此实现）
- `src/content/encounters/`（未来目标路径，当前没有创建此实现）
- `src/content/events/`（未来目标路径，当前没有创建此实现）
- `src/content/locales/zh-CN/`（未来目标路径，当前没有创建此实现）

## 输入
- 已过切片关口
- 完整内容计数和目录
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 24技能/36树节点/48逐卡机缘
- 14建筑36配方与全部敌人区域
- 48事件12主线正式内容

## 执行步骤
1. 逐批增数据并运行所有回归
2. 补齐未命名机缘逐卡设计而非伪称现成
3. 每个新区域加入机制测试与资源路线

## 验收测试
- AT-044-01：所有1.0计数可机器验证；状态not_run
- AT-044-02：四门类均有自启动底盘；状态not_run
- AT-044-03：所有ID/资源/文案/操作引用有效；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
