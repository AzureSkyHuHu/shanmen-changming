# 执行任务总表

全部51项为planned / 未分配；每项详细页提供模块、输入、输出、步骤和验收测试。机器可读同源登记：[tasks.json](tasks.json)。所有依赖均是前置输出依赖，不授权现在实施。

| ID / 任务 | 阶段 | 前置 | 需求 | 状态 |
|---|---|---|---|---|
| [TASK-001 · 冻结范围与待定决策](tasks/TASK-001.md) | M0 | 无 | REQ-001, REQ-015, REQ-029, REQ-030 | planned |
| [TASK-002 · 建立可复现工程基线](tasks/TASK-002.md) | M0 | TASK-001 | REQ-024, REQ-027, REQ-030 | planned |
| [TASK-003 · 建立内容模式与校验器](tasks/TASK-003.md) | M1 | TASK-002 | REQ-013, REQ-014, REQ-016, REQ-018, REQ-031 | planned |
| [TASK-004 · 实现确定性ID随机与数值](tasks/TASK-004.md) | M1 | TASK-002 | REQ-005, REQ-020 | planned |
| [TASK-005 · 实现三种时钟与调度](tasks/TASK-005.md) | M1 | TASK-004 | REQ-004, REQ-005 | planned |
| [TASK-006 · 实现指令事务事件入口](tasks/TASK-006.md) | M1 | TASK-004, TASK-005 | REQ-005, REQ-007, REQ-019 | planned |
| [TASK-007 · 构造可解的开局世界](tasks/TASK-007.md) | M1 | TASK-003, TASK-004, TASK-006 | REQ-001, REQ-003, REQ-007 | planned |
| [TASK-008 · 实现库存与原子生产事务](tasks/TASK-008.md) | M1 | TASK-003, TASK-006, TASK-007 | REQ-007, REQ-008 | planned |
| [TASK-009 · 实现早期完整快照保存](tasks/TASK-009.md) | M1 | TASK-006, TASK-008 | REQ-025, REQ-005 | planned |
| [TASK-010 · 实现迁移导入与坏档保护](tasks/TASK-010.md) | M1 | TASK-009 | REQ-025, REQ-026 | planned |
| [TASK-011 · 实现任务岗位与恢复](tasks/TASK-011.md) | M2 | TASK-005, TASK-008, TASK-009 | REQ-002, REQ-006 | planned |
| [TASK-012 · 实现路径入口与堵塞诊断](tasks/TASK-012.md) | M2 | TASK-007, TASK-011 | REQ-002, REQ-006 | planned |
| [TASK-013 · 实现需求日程和调岗政策](tasks/TASK-013.md) | M2 | TASK-011, TASK-012 | REQ-006, REQ-009 | planned |
| [TASK-014 · 实现建筑研究维护闭环](tasks/TASK-014.md) | M2 | TASK-008, TASK-011, TASK-012 | REQ-008, REQ-007 | planned |
| [TASK-015 · 验证基础经济与恢复路线](tasks/TASK-015.md) | M2 | TASK-013, TASK-014 | REQ-003, REQ-007, REQ-027 | planned |
| [TASK-016 · 实现修炼与突破风险事务](tasks/TASK-016.md) | M2 | TASK-003, TASK-005, TASK-008, TASK-013 | REQ-010, REQ-009 | planned |
| [TASK-017 · 实现寿元倒地外死亡接入](tasks/TASK-017.md) | M2 | TASK-005, TASK-006, TASK-016 | REQ-011, REQ-004 | planned |
| [TASK-018 · 实现师承关系与继任传承](tasks/TASK-018.md) | M2 | TASK-013, TASK-017 | REQ-009, REQ-011 | planned |
| [TASK-019 · 定义战斗强类型协议](tasks/TASK-019.md) | M3 | TASK-003, TASK-004, TASK-006 | REQ-012, REQ-018 | planned |
| [TASK-020 · 实现属性求值与目标仲裁](tasks/TASK-020.md) | M3 | TASK-019 | REQ-018, REQ-020 | planned |
| [TASK-021 · 实现施法预约提交与打断](tasks/TASK-021.md) | M3 | TASK-019, TASK-020, TASK-008 | REQ-019, REQ-012 | planned |
| [TASK-022 · 实现伤害护盾濒死倒地](tasks/TASK-022.md) | M3 | TASK-020, TASK-021, TASK-017 | REQ-019, REQ-011 | planned |
| [TASK-023 · 实现状态叠层到期与清理](tasks/TASK-023.md) | M3 | TASK-020, TASK-022 | REQ-018, REQ-020 | planned |
| [TASK-024 · 实现触发队列与防递归](tasks/TASK-024.md) | M3 | TASK-021, TASK-022, TASK-023 | REQ-020, REQ-017 | planned |
| [TASK-025 · 实现自动战斗战术与撤退](tasks/TASK-025.md) | M3 | TASK-021, TASK-022, TASK-023, TASK-024 | REQ-012, REQ-013 | planned |
| [TASK-026 · 验证战斗回放与数据扩展](tasks/TASK-026.md) | M3 | TASK-024, TASK-025 | REQ-005, REQ-018, REQ-019, REQ-020 | planned |
| [TASK-027 · 实现永久树与点数重配](tasks/TASK-027.md) | M3 | TASK-003, TASK-016, TASK-020 | REQ-014, REQ-013 | planned |
| [TASK-028 · 实现技能配装与装备词条](tasks/TASK-028.md) | M3 | TASK-019, TASK-020, TASK-027 | REQ-013, REQ-017 | planned |
| [TASK-029 · 实现远征节点战略时间](tasks/TASK-029.md) | M3 | TASK-005, TASK-009, TASK-025, TASK-028 | REQ-004, REQ-015, REQ-021 | planned |
| [TASK-030 · 实现三选一保底与刷新](tasks/TASK-030.md) | M3 | TASK-003, TASK-024, TASK-027, TASK-029 | REQ-016, REQ-017 | planned |
| [TASK-031 · 实现远征退出损失与清理](tasks/TASK-031.md) | M3 | TASK-023, TASK-029, TASK-030 | REQ-015, REQ-016, REQ-011 | planned |
| [TASK-032 · 制作首地区路线与首领](tasks/TASK-032.md) | M3 | TASK-025, TASK-029, TASK-031 | REQ-021, REQ-012 | planned |
| [TASK-033 · 制作垂直切片内容包](tasks/TASK-033.md) | M3 | TASK-003, TASK-018, TASK-026, TASK-027, TASK-030, TASK-032, TASK-051 | REQ-013, REQ-014, REQ-016, REQ-017, REQ-031 | planned |
| [TASK-034 · 建立应用会话只读投影](tasks/TASK-034.md) | M3 | TASK-009, TASK-013, TASK-025, TASK-031 | REQ-024, REQ-005 | planned |
| [TASK-035 · 实现可见宗门Phaser场景](tasks/TASK-035.md) | M3 | TASK-012, TASK-013, TASK-014, TASK-034 | REQ-002, REQ-003, REQ-024 | planned |
| [TASK-036 · 实现战斗表现预告和日志](tasks/TASK-036.md) | M3 | TASK-025, TASK-032, TASK-034 | REQ-012, REQ-023, REQ-024 | planned |
| [TASK-037 · 实现管理突破与存档界面](tasks/TASK-037.md) | M3 | TASK-010, TASK-016, TASK-018, TASK-034, TASK-035, TASK-051 | REQ-023, REQ-010, REQ-025, REQ-031 | planned |
| [TASK-038 · 实现配装三选一和结算UI](tasks/TASK-038.md) | M3 | TASK-027, TASK-028, TASK-030, TASK-031, TASK-034, TASK-051 | REQ-014, REQ-016, REQ-023, REQ-031 | planned |
| [TASK-039 · 实现隐藏暂停单写标签页](tasks/TASK-039.md) | M3 | TASK-009, TASK-010, TASK-034, TASK-037 | REQ-026, REQ-004, REQ-025 | planned |
| [TASK-040 · 实现键盘焦点与辅助设置](tasks/TASK-040.md) | M3 | TASK-035, TASK-036, TASK-037, TASK-038 | REQ-023 | planned |
| [TASK-041 · 实现事件主线与终章骨架](tasks/TASK-041.md) | M3 | TASK-018, TASK-031, TASK-032, TASK-034, TASK-051 | REQ-022, REQ-009, REQ-011, REQ-031 | planned |
| [TASK-042 · 建立素材规范与许可证账本](tasks/TASK-042.md) | M3 | TASK-002, TASK-035, TASK-036 | REQ-028, REQ-023 | planned |
| [TASK-043 · 验收端到端垂直切片](tasks/TASK-043.md) | M3 | TASK-015, TASK-026, TASK-033, TASK-035, TASK-036, TASK-037, TASK-038, TASK-039, TASK-040, TASK-041, TASK-042 | REQ-001, REQ-017, REQ-027 | planned |
| [TASK-044 · 扩充完整1.0内容目录](tasks/TASK-044.md) | M4 | TASK-043 | REQ-008, REQ-013, REQ-014, REQ-016, REQ-021, REQ-022 | planned |
| [TASK-045 · 验证四构筑战役与经济平衡](tasks/TASK-045.md) | M4 | TASK-044 | REQ-007, REQ-017, REQ-021, REQ-022, REQ-027 | planned |
| [TASK-046 · 测量性能资源与长帧预算](tasks/TASK-046.md) | M4 | TASK-044 | REQ-003, REQ-027, REQ-024 | planned |
| [TASK-047 · 执行存档故障兼容与长跑](tasks/TASK-047.md) | M4 | TASK-039, TASK-044, TASK-046 | REQ-025, REQ-026, REQ-027 | planned |
| [TASK-048 · 执行真实交互与可访问回归](tasks/TASK-048.md) | M4 | TASK-040, TASK-045, TASK-047 | REQ-023, REQ-027 | planned |
| [TASK-049 · 审计发布候选与许可兼容](tasks/TASK-049.md) | M5 | TASK-042, TASK-045, TASK-046, TASK-047, TASK-048, TASK-051 | REQ-027, REQ-028, REQ-030, REQ-031 | planned |
| [TASK-050 · 交接实施证据与后续变更](tasks/TASK-050.md) | M5 | TASK-049 | REQ-029, REQ-030 | planned |
| [TASK-051 · 实现中英映射切换与回退](tasks/TASK-051.md) | M3 | TASK-003, TASK-034 | REQ-031, REQ-023, REQ-025 | planned |
