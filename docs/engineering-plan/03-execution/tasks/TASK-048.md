# TASK-048 · 执行真实交互与可访问回归

状态：planned · 负责人：交互验证（unassigned） · 里程碑：[M4](../milestones.md#m4)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-023](../../00-overview/requirements.md#req-023)、[REQ-027](../../00-overview/requirements.md#req-027)

设计段落：[02-detailed-design/11-ui-rendering.md#tests](../../02-detailed-design/11-ui-rendering.md#tests)、[03-execution/qa-matrix.md](../../03-execution/qa-matrix.md)

依赖任务：[TASK-040](TASK-040.md)、[TASK-045](TASK-045.md)、[TASK-047](TASK-047.md)

## 文件/模块责任
- `tests/e2e/`（未来目标路径，当前没有创建此实现）
- `docs/validation/screenshots/`（未来目标路径，当前没有创建此实现）

## 输入
- 完整战役与设备矩阵
- 可访问设置
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 真实页面旅程报告
- 键盘/150%/静音/减少动态结果
- 问题严重度与证据

## 执行步骤
1. 覆盖重复点击/返回/关闭/隐藏/恢复
2. 键盘完成核心管理与战斗指令
3. 标注截图状态和日志来源

## 验收测试
- AT-048-01：1280×720与1920×1080核心流程可用；状态not_run
- AT-048-02：主要状态不用只靠色或声音；状态not_run
- AT-048-03：测试通过与未测项目明确分开；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
