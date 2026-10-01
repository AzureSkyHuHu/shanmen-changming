# TASK-002 · 建立可复现工程基线

状态：planned · 负责人：工程基础（unassigned） · 里程碑：[M0](../milestones.md#m0)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-024](../../00-overview/requirements.md#req-024)、[REQ-027](../../00-overview/requirements.md#req-027)、[REQ-030](../../00-overview/requirements.md#req-030)

设计段落：[00-overview/architecture.md](../../00-overview/architecture.md)、[02-detailed-design/13-assets-performance.md#release](../../02-detailed-design/13-assets-performance.md#release)

依赖任务：[TASK-001](TASK-001.md)

## 文件/模块责任
- `package.json`（未来目标路径，当前没有创建此实现）
- `lockfile`（未来目标路径，当前没有创建此实现）
- `tsconfig.json`（未来目标路径，当前没有创建此实现）
- `vite.config.ts`（未来目标路径，当前没有创建此实现）
- `docs/adr/`（未来目标路径，当前没有创建此实现）

## 输入
- 范围批准
- 官方框架文档和目标浏览器
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 精确工具链锁定
- 干净构建和检查脚本
- 依赖许可初表

## 执行步骤
1. 复核Phaser/React/Vite兼容与官方模板统计脚本
2. 建立单仓纯core导入限制与基础测试入口
3. 记录可重复安装及nolog构建流程

## 验收测试
- AT-002-01：干净环境安装/typecheck/build可重复；状态not_run
- AT-002-02：core反向导入框架时CI失败；状态not_run
- AT-002-03：当前阶段只登记计划不安装依赖；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
