# TASK-037 · 实现管理突破与存档界面

状态：planned · 负责人：管理界面（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-023](../../00-overview/requirements.md#req-023)、[REQ-010](../../00-overview/requirements.md#req-010)、[REQ-025](../../00-overview/requirements.md#req-025)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/11-ui-rendering.md#screens](../../02-detailed-design/11-ui-rendering.md#screens)、[02-detailed-design/10-save-and-recovery.md#migration](../../02-detailed-design/10-save-and-recovery.md#migration)

依赖任务：[TASK-010](TASK-010.md)、[TASK-016](TASK-016.md)、[TASK-018](TASK-018.md)、[TASK-034](TASK-034.md)、[TASK-035](TASK-035.md)、[TASK-051](TASK-051.md)

## 文件/模块责任
- `src/ui/hud/`（未来目标路径，当前没有创建此实现）
- `src/ui/panels/`（未来目标路径，当前没有创建此实现）
- `src/ui/dialogs/`（未来目标路径，当前没有创建此实现）

## 输入
- 只读查询/命令
- 风险和保存状态
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 弟子/岗位/库存/建设面板
- 突破风险页
- 存档导入导出页

## 执行步骤
1. 布局按信息重要性分层
2. 风险预览过期时刷新不可沿用
3. 显示最近成功保存与覆盖预览

## 验收测试
- AT-037-01：风险数值与结算同源；状态not_run
- AT-037-02：双击确定不双扣；状态not_run
- AT-037-03：返回面板保留镜头/选中/暂停；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
