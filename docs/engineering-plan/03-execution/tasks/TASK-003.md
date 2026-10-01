# TASK-003 · 建立内容模式与校验器

状态：planned · 负责人：内容工程（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-013](../../00-overview/requirements.md#req-013)、[REQ-014](../../00-overview/requirements.md#req-014)、[REQ-016](../../00-overview/requirements.md#req-016)、[REQ-018](../../00-overview/requirements.md#req-018)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/09-content-authoring.md#schema](../../02-detailed-design/09-content-authoring.md#schema)、[02-detailed-design/09-content-authoring.md#pipeline](../../02-detailed-design/09-content-authoring.md#pipeline)

依赖任务：[TASK-002](TASK-002.md)

## 文件/模块责任
- `src/content/schemas/`（未来目标路径，当前没有创建此实现）
- `tools/validate-content/`（未来目标路径，当前没有创建此实现）
- `tests/unit/content/`（未来目标路径，当前没有创建此实现）

## 输入
- 统一定义约定
- 冻结目录数量
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 运行时schema
- 重复ID和引用/图校验报告

## 执行步骤
1. 列出所有定义联合类型和单位
2. 实现静态图/范围/未知操作检查
3. 设计非法数据夹具与错误定位

## 验收测试
- AT-003-01：重复ID/悬空引用/树循环均拒绝；状态not_run
- AT-003-02：未知effect操作阻断构建；状态not_run
- AT-003-03：48机缘两轴分别总计48；状态not_run
- AT-003-04：全部玩家文本有中文键且英文参数对应；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
