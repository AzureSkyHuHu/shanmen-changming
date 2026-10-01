# ADR-005-local-saves: 本地版本存档与恢复

状态：proposed / 技术建议

## 决定/建议
IndexedDB+JSON导出，写新再切指针，纯迁移链，单可写标签页；无账号/云存档依赖。

## 原因与后果
符合单人并保留玩家控制；浏览器清理/配额仍有风险，必须提供导出和真实失败提示。

## 复审触发
用户范围变化、原型证据否定前提，或存档/表现/内容兼容发生破坏性变更时复审。不可用后续实现便利自动覆盖玩法边界。

## 落地追踪
TASK-009、TASK-010、TASK-039、TASK-047；[详细设计](../02-detailed-design/10-save-and-recovery.md)；[任务总表](../03-execution/task-register.md)
