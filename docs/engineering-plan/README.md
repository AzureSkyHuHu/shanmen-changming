# 山门长明 · 分层工程设计包

版本：0.1 · 2026-10-01 · 设计交付 / 未实现

这是单人修仙宗门浏览器游戏的仓库就绪工程文档，不是游戏代码或可运行项目。包含完整玩法源、31项需求、6个子系统方向、14份详细设计、7项决策、51项执行任务和18类验收矩阵。默认中文、可切英语、缺英文逐键中文回退已纳入1.0要求。

## 从哪里读
1. [产品范围与当前状态](00-overview/product-scope.md)
2. [需求目录](00-overview/requirements.md) → [架构总览](00-overview/architecture.md) → [范围基线](00-overview/baseline.md)
3. [子系统方向](01-systems/README.md)
4. [详细设计](02-detailed-design/README.md)
5. [执行入口](03-execution/README.md) → [阶段门](03-execution/milestones.md) → [51项任务](03-execution/task-register.md)

## 评审、实施和测试入口
- 原始玩法：[冻结设计全文](source/game-design.md)及[来源与哈希](source/PROVENANCE.md)
- 开工待定：[决策记录](decisions/README.md)，尤其整趟远征为run仍待确认
- 团队分工：[建议源代码树](source-tree.md)与[机器可读任务登记](03-execution/tasks.json)
- 质量关口：[需求验收矩阵](03-execution/qa-matrix.md)、[风险](03-execution/risks.md)、[变更控制](03-execution/change-control.md)
- 统一用词：[术语表](glossary.md)；技术和资产：[参考](references.md)
- 本包完整性：[校验报告](validation/report.md)与[校验方式](validation/README.md)

## 使用与状态
解压后保持目录结构，可整体放进未来仓库docs/engineering-plan/。相对链接在Markdown浏览器/GitHub等常见仓库工具可用；原始全文加入显式章节锚点以便稳定追踪。

所有51个实施任务均为planned，所有游戏测试为not_run。文档验证只检查结构、链接、ID、依赖和覆盖，不能证明游戏规则已运行。当前没有安装依赖、创建游戏骨架、全量英文翻译或部署服务。下一步需先评审范围并另行授权开发；任何部署也需另行决定。

“30小时以上”指用户期待的开发投入规模，不是游玩时长或完成日期。内容数量、数值和性能仍是待验证设计基线。
