# TASK-046 · 测量性能资源与长帧预算

状态：planned · 负责人：性能工程（unassigned） · 里程碑：[M4](../milestones.md#m4)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-003](../../00-overview/requirements.md#req-003)、[REQ-027](../../00-overview/requirements.md#req-027)、[REQ-024](../../00-overview/requirements.md#req-024)

设计段落：[02-detailed-design/13-assets-performance.md#budget](../../02-detailed-design/13-assets-performance.md#budget)、[02-detailed-design/13-assets-performance.md#worker](../../02-detailed-design/13-assets-performance.md#worker)

依赖任务：[TASK-044](TASK-044.md)

## 文件/模块责任
- `tests/performance/`（未来目标路径，当前没有创建此实现）
- `tools/profile/`（未来目标路径，当前没有创建此实现）
- `docs/performance/`（未来目标路径，当前没有创建此实现）

## 输入
- 标准设备浏览器seed
- 完整资源与规模夹具
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 帧时间/内存/tick耗时报告
- 加载/存档预算结果
- 必要优化或Worker决策

## 执行步骤
1. 固定36人128×128约200对象6v20基准
2. 采集分位数长任务与资产传输
3. 优化后重放校验逻辑结果不变

## 验收测试
- AT-046-01：记录设备版本而非笼统60fps；状态not_run
- AT-046-02：低帧率不丢模拟tick；状态not_run
- AT-046-03：未证实瓶颈不得自动迁入Worker；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
