# 阶段门与完成条件

所有阶段当前都是planned，所有游戏验收均not_run。阶段是成果关口，不是日历承诺。任务DAG定义实际依赖，编号不等于执行顺序；TASK-051需在切片内容/UI完成前实现。M3内部可以并行，但不能跳过M1保存和M2规则验证。

<a id="m0"></a>
## M0 · 开工决策与可复现基线

完成条件：范围/run/版本/环境与实现授权明确；无授权所有实施保持planned。

任务：[TASK-001](tasks/TASK-001.md)、[TASK-002](tasks/TASK-002.md)

<a id="m1"></a>
## M1 · 纯模拟与早期保存

完成条件：确定性时钟、事务、可解开局、快照/坏档恢复成立；不等到UI完成才开始存档。

任务：[TASK-003](tasks/TASK-003.md)、[TASK-004](tasks/TASK-004.md)、[TASK-005](tasks/TASK-005.md)、[TASK-006](tasks/TASK-006.md)、[TASK-007](tasks/TASK-007.md)、[TASK-008](tasks/TASK-008.md)、[TASK-009](tasks/TASK-009.md)、[TASK-010](tasks/TASK-010.md)

<a id="m2"></a>
## M2 · 宗门规则与代际原型

完成条件：任务/导航/需求/经济/建筑/突破/死亡传承可无头回放，困境恢复可说明。

任务：[TASK-011](tasks/TASK-011.md)、[TASK-012](tasks/TASK-012.md)、[TASK-013](tasks/TASK-013.md)、[TASK-014](tasks/TASK-014.md)、[TASK-015](tasks/TASK-015.md)、[TASK-016](tasks/TASK-016.md)、[TASK-017](tasks/TASK-017.md)、[TASK-018](tasks/TASK-018.md)

<a id="m3"></a>
## M3 · 完整纵向切片

完成条件：6弟子/6建筑/8技能/12机缘/2树原型/1首领/关系/筑基/传承/中英切换可实际操作；两构筑可启动。

任务：[TASK-019](tasks/TASK-019.md)、[TASK-020](tasks/TASK-020.md)、[TASK-021](tasks/TASK-021.md)、[TASK-022](tasks/TASK-022.md)、[TASK-023](tasks/TASK-023.md)、[TASK-024](tasks/TASK-024.md)、[TASK-025](tasks/TASK-025.md)、[TASK-026](tasks/TASK-026.md)、[TASK-027](tasks/TASK-027.md)、[TASK-028](tasks/TASK-028.md)、[TASK-029](tasks/TASK-029.md)、[TASK-030](tasks/TASK-030.md)、[TASK-031](tasks/TASK-031.md)、[TASK-032](tasks/TASK-032.md)、[TASK-033](tasks/TASK-033.md)、[TASK-034](tasks/TASK-034.md)、[TASK-035](tasks/TASK-035.md)、[TASK-036](tasks/TASK-036.md)、[TASK-037](tasks/TASK-037.md)、[TASK-038](tasks/TASK-038.md)、[TASK-039](tasks/TASK-039.md)、[TASK-040](tasks/TASK-040.md)、[TASK-041](tasks/TASK-041.md)、[TASK-042](tasks/TASK-042.md)、[TASK-043](tasks/TASK-043.md)、[TASK-051](tasks/TASK-051.md)

<a id="m4"></a>
## M4 · 完整1.0与验证

完成条件：完整数量、三地区、四境界、终章与继续经营；平衡、性能、恢复、可访问实测有证据。

任务：[TASK-044](tasks/TASK-044.md)、[TASK-045](tasks/TASK-045.md)、[TASK-046](tasks/TASK-046.md)、[TASK-047](tasks/TASK-047.md)、[TASK-048](tasks/TASK-048.md)

<a id="m5"></a>
## M5 · 候选审计与交接

完成条件：同一构建可复现、无阻断缺陷、许可/版本/回滚/未测项明确；发布仍须另行授权。

任务：[TASK-049](tasks/TASK-049.md)、[TASK-050](tasks/TASK-050.md)
