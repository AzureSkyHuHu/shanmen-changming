# TASK-043 · 验收端到端垂直切片

状态：planned · 负责人：集成验证（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-001](../../00-overview/requirements.md#req-001)、[REQ-017](../../00-overview/requirements.md#req-017)、[REQ-027](../../00-overview/requirements.md#req-027)

设计段落：[03-execution/milestones.md#m3](../../03-execution/milestones.md#m3)、[03-execution/qa-matrix.md](../../03-execution/qa-matrix.md)

依赖任务：[TASK-015](TASK-015.md)、[TASK-026](TASK-026.md)、[TASK-033](TASK-033.md)、[TASK-035](TASK-035.md)、[TASK-036](TASK-036.md)、[TASK-037](TASK-037.md)、[TASK-038](TASK-038.md)、[TASK-039](TASK-039.md)、[TASK-040](TASK-040.md)、[TASK-041](TASK-041.md)、[TASK-042](TASK-042.md)

## 文件/模块责任
- `tests/e2e/vertical-slice/`（未来目标路径，当前没有创建此实现）
- `tests/replay/slice/`（未来目标路径，当前没有创建此实现）
- `docs/validation/`（未来目标路径，当前没有创建此实现）

## 输入
- 切片内容与完整界面
- 固定seed及两套构筑
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 开局至首领/筑基/传承实玩记录
- 阻断问题清单
- 阶段门评审

## 执行步骤
1. 用真实页面完成生产/修炼/出征/选卡/返程
2. 检查至少一次关系与传承反馈
3. 保存重载再继续同战役

## 验收测试
- AT-043-01：8技能12机缘2树原型全部可使用；状态not_run
- AT-043-02：两套构筑自启动且有差异；状态not_run
- AT-043-03：关键失败路径可恢复且无P0/P1；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
