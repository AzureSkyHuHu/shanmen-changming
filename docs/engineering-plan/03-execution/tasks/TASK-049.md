# TASK-049 · 审计发布候选与许可兼容

状态：planned · 负责人：发布验证（unassigned） · 里程碑：[M5](../milestones.md#m5)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-027](../../00-overview/requirements.md#req-027)、[REQ-028](../../00-overview/requirements.md#req-028)、[REQ-030](../../00-overview/requirements.md#req-030)、[REQ-031](../../00-overview/requirements.md#req-031)

设计段落：[02-detailed-design/13-assets-performance.md#release](../../02-detailed-design/13-assets-performance.md#release)、[03-execution/milestones.md#m5](../../03-execution/milestones.md#m5)

依赖任务：[TASK-042](TASK-042.md)、[TASK-045](TASK-045.md)、[TASK-046](TASK-046.md)、[TASK-047](TASK-047.md)、[TASK-048](TASK-048.md)、[TASK-051](TASK-051.md)

## 文件/模块责任
- `docs/release/`（未来目标路径，当前没有创建此实现）
- `licenses/`（未来目标路径，当前没有创建此实现）
- `tools/verify-release/`（未来目标路径，当前没有创建此实现）

## 输入
- 同一候选commit与产物
- 全部测试/许可报告
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 候选审计清单
- 产物hash和版本清单
- 阻断问题与回滚预案

## 执行步骤
1. 在干净环境跑全部必需检查
2. 对照同一产物审资源与许可
3. 核验新旧存档兼容再提出可发布建议

## 验收测试
- AT-049-01：P0/P1或迁移失败阻断候选；状态not_run
- AT-049-02：测试报告能追到commit/build/hash；状态not_run
- AT-049-03：未获发布授权不得上传部署；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
