# 需求验收矩阵

下列均为目标测试，当前全部not_run。文档包校验通过不代表游戏通过。单元/属性/回放、集成、真实页面E2E、人工实玩和性能测量应分别出证据。

| 编号 | 检查域 | 需求 | 实施责任任务 | 测试内容 | 状态 |
|---|---|---|---|---|---|
| QA-01 | 确定性/时间 | [REQ-004](../00-overview/requirements.md#req-004), [REQ-005](../00-overview/requirements.md#req-005) | [TASK-004](tasks/TASK-004.md), [TASK-005](tasks/TASK-005.md), [TASK-026](tasks/TASK-026.md) | 同seed同指令同tick；逐步/3倍/低帧/暂停/恢复hash相等；旅行月份手算对账 | not_run |
| QA-02 | 资源/任务 | [REQ-006](../00-overview/requirements.md#req-006), [REQ-007](../00-overview/requirements.md#req-007) | [TASK-008](tasks/TASK-008.md), [TASK-011](tasks/TASK-011.md), [TASK-015](tasks/TASK-015.md) | 并发预约/取消/重载/重复完成不负库存或复制；缺粮可恢复 | not_run |
| QA-03 | 空间/活宗门 | [REQ-002](../00-overview/requirements.md#req-002), [REQ-003](../00-overview/requirements.md#req-003) | [TASK-012](tasks/TASK-012.md), [TASK-035](tasks/TASK-035.md) | 入口堵塞/挪楼/36人；可点人追踪任务和真实产出 | not_run |
| QA-04 | 突破/风险 | [REQ-010](../00-overview/requirements.md#req-010) | [TASK-016](tasks/TASK-016.md), [TASK-037](tasks/TASK-037.md) | 预览与实际同源；成功和条件死亡率分开；旧预览拒绝 | not_run |
| QA-05 | 寿元/传承 | [REQ-009](../00-overview/requirements.md#req-009), [REQ-011](../00-overview/requirements.md#req-011) | [TASK-017](tasks/TASK-017.md), [TASK-018](tasks/TASK-018.md), [TASK-022](tasks/TASK-022.md) | Downed不发遗物；deathId一次；继任/师承/最后一人死亡可恢复 | not_run |
| QA-06 | 施法/伤害 | [REQ-012](../00-overview/requirements.md#req-012), [REQ-019](../00-overview/requirements.md#req-019) | [TASK-021](tasks/TASK-021.md), [TASK-022](tasks/TASK-022.md) | 预约/前摇/提交/防御/盾/生命/濒死次序与费用黄金用例 | not_run |
| QA-07 | 状态/触发 | [REQ-018](../00-overview/requirements.md#req-018), [REQ-020](../00-overview/requirements.md#req-020) | [TASK-023](tasks/TASK-023.md), [TASK-024](tasks/TASK-024.md), [TASK-026](tasks/TASK-026.md) | 排他到期/独立来源/冻结触发快照/proc预算/两条黄金链 | not_run |
| QA-08 | 树/配装 | [REQ-013](../00-overview/requirements.md#req-013), [REQ-014](../00-overview/requirements.md#req-014) | [TASK-027](tasks/TASK-027.md), [TASK-028](tasks/TASK-028.md) | 5点不可双终点、出征锁定、重配清来源、终极占槽 | not_run |
| QA-09 | 抽选/构筑 | [REQ-016](../00-overview/requirements.md#req-016), [REQ-017](../00-overview/requirements.md#req-017) | [TASK-030](tasks/TASK-030.md), [TASK-045](tasks/TASK-045.md) | 1万seed合法/核心补件/减员/空池/无新卡刷新/同档同offer | not_run |
| QA-10 | run边界/退出 | [REQ-015](../00-overview/requirements.md#req-015) | [TASK-029](tasks/TASK-029.md), [TASK-031](tasks/TASK-031.md) | 旅行半月断点；胜/撤/全灭统一结算；来源清理且保永久 | not_run |
| QA-11 | 内容/战役 | [REQ-008](../00-overview/requirements.md#req-008), [REQ-021](../00-overview/requirements.md#req-021), [REQ-022](../00-overview/requirements.md#req-022) | [TASK-033](tasks/TASK-033.md), [TASK-041](tasks/TASK-041.md), [TASK-044](tasks/TASK-044.md), [TASK-045](tasks/TASK-045.md) | 计数、悬空引用、低运气路径、三封印终章继续经营、事件回声 | not_run |
| QA-12 | 保存/故障 | [REQ-025](../00-overview/requirements.md#req-025), [REQ-026](../00-overview/requirements.md#req-026) | [TASK-009](tasks/TASK-009.md), [TASK-010](tasks/TASK-010.md), [TASK-039](tasks/TASK-039.md), [TASK-047](tasks/TASK-047.md) | 逐阶段断写/配额/损坏/迁移/新版本拒绝/多标签接管/完整战斗恢复 | not_run |
| QA-13 | 交互/边界 | [REQ-023](../00-overview/requirements.md#req-023), [REQ-024](../00-overview/requirements.md#req-024) | [TASK-034](tasks/TASK-034.md), [TASK-037](tasks/TASK-037.md), [TASK-038](tasks/TASK-038.md), [TASK-048](tasks/TASK-048.md) | 真实页面双击/返回/关闭/隐藏；投影只读；焦点与命令路由 | not_run |
| QA-14 | 可访问 | [REQ-023](../00-overview/requirements.md#req-023) | [TASK-040](tasks/TASK-040.md), [TASK-048](tasks/TASK-048.md) | 键盘等价入口；150%中文与英文；静音/非色唯一/减少动态 | not_run |
| QA-15 | 中英与回退 | [REQ-031](../00-overview/requirements.md#req-031) | [TASK-003](tasks/TASK-003.md), [TASK-051](tasks/TASK-051.md), [TASK-048](tasks/TASK-048.md) | zh100%键覆盖；en缺键/空值回退；参数/复数/数字格式；切换hash/RNG不变 | not_run |
| QA-16 | 性能/长跑 | [REQ-027](../00-overview/requirements.md#req-027), [REQ-003](../00-overview/requirements.md#req-003) | [TASK-046](tasks/TASK-046.md), [TASK-047](tasks/TASK-047.md) | 固定36人/128×128/约200对象/6v20基准；帧分位/内存/50切场/资源存档预算 | not_run |
| QA-17 | 素材/候选 | [REQ-028](../00-overview/requirements.md#req-028), [REQ-030](../00-overview/requirements.md#req-030) | [TASK-042](tasks/TASK-042.md), [TASK-049](tasks/TASK-049.md) | 逐资产许可证/来源/原hash；干净构建相同产物；无授权不发布 | not_run |
| QA-18 | 完整闭环 | [REQ-001](../00-overview/requirements.md#req-001), [REQ-029](../00-overview/requirements.md#req-029), [REQ-030](../00-overview/requirements.md#req-030) | [TASK-043](tasks/TASK-043.md), [TASK-045](tasks/TASK-045.md), [TASK-050](tasks/TASK-050.md) | 从4人开局到生产修炼出征三选一首领传承终章；功能证据不以工时代替 | not_run |

## 缺陷门槛
P0：存档不可恢复、广泛致死/复制破坏基本规则；P1：主闭环阻断/错误风险/必需功能不可用；P2：有替代路径的明显缺陷；P3：局部表现瑕疵。P0/P1阻断阶段通过及发布候选。严重度由实际影响评估，不能为过关降级。
