# TASK-034 · 建立应用会话只读投影

状态：planned · 负责人：应用集成（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-024](../../00-overview/requirements.md#req-024)、[REQ-005](../../00-overview/requirements.md#req-005)

设计段落：[02-detailed-design/11-ui-rendering.md#projection](../../02-detailed-design/11-ui-rendering.md#projection)

依赖任务：[TASK-009](TASK-009.md)、[TASK-013](TASK-013.md)、[TASK-025](TASK-025.md)、[TASK-031](TASK-031.md)

## 文件/模块责任
- `src/application/session.ts`（未来目标路径，当前没有创建此实现）
- `src/application/projections/`（未来目标路径，当前没有创建此实现）
- `src/core/queries/`（未来目标路径，当前没有创建此实现）

## 输入
- 核心状态与事件
- 模式切换合同
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 唯一Session
- 稳定查询订阅
- 实体差量与命令反馈

## 执行步骤
1. 建立场景/UI共用只读DTO
2. 按查询revision局部刷新
3. 统一挂载卸载与错误暂停

## 验收测试
- AT-034-01：UI不能直接改核心字段；状态not_run
- AT-034-02：无变化查询保持稳定引用；状态not_run
- AT-034-03：模式切换不新建第二份世界；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
