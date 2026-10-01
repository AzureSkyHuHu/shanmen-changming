# ADR-002-core-and-clocks: 纯核心、三钟分离与确定性

状态：proposed / 技术建议

## 决定/建议
纯TS权威模拟；经营/战斗/表现分离；固定tick+有版本的PRNG与数值规则。

## 原因与后果
可测试、可回放、可迁Worker；代价是严格的数据/表现边界和跨时钟结算账本。

## 复审触发
用户范围变化、原型证据否定前提，或存档/表现/内容兼容发生破坏性变更时复审。不可用后续实现便利自动覆盖玩法边界。

## 落地追踪
TASK-004、TASK-005、TASK-006；[详细设计](../02-detailed-design/01-kernel-contracts.md)；[任务总表](../03-execution/task-register.md)
