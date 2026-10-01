# TASK-010 · 实现迁移导入与坏档保护

状态：planned · 负责人：平台持久化（unassigned） · 里程碑：[M1](../milestones.md#m1)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-025](../../00-overview/requirements.md#req-025)、[REQ-026](../../00-overview/requirements.md#req-026)

设计段落：[02-detailed-design/10-save-and-recovery.md#migration](../../02-detailed-design/10-save-and-recovery.md#migration)

依赖任务：[TASK-009](TASK-009.md)

## 文件/模块责任
- `src/platform/persistence/migrations/`（未来目标路径，当前没有创建此实现）
- `src/platform/files/`（未来目标路径，当前没有创建此实现）
- `tests/fixtures/saves/`（未来目标路径，当前没有创建此实现）

## 输入
- 保存schema
- 最早版本fixture
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 纯迁移链
- 导入校验/预览端口
- 原始备份保留

## 执行步骤
1. 按vN到vN+1编写纯迁移
2. 导入做大小/结构/范围/引用/版本检查
3. 覆盖提交需明确目标槽和确认

## 验收测试
- AT-010-01：坏JSON/超大/未知新版本不覆盖；状态not_run
- AT-010-02：逐版与链式迁移结果一致；状态not_run
- AT-010-03：迁移失败保留原始字节；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
