# ADR-003-ui-engine: Phaser表现与React管理

状态：proposed / 技术建议

## 决定/建议
Phaser处理2D场景，React处理管理DOM，以只读投影/命令/事件连接；精确版本开工再锁。

## 原因与后果
中文密集管理与可访问更方便；代价是两套生命周期需统一卸载和焦点路由。无基准前不声称流畅。

## 复审触发
用户范围变化、原型证据否定前提，或存档/表现/内容兼容发生破坏性变更时复审。不可用后续实现便利自动覆盖玩法边界。

## 落地追踪
TASK-002、TASK-034至TASK-040；[详细设计](../02-detailed-design/11-ui-rendering.md)；[任务总表](../03-execution/task-register.md)
