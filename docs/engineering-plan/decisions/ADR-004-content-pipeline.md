# ADR-004-content-pipeline: 受限积木而非内容脚本

状态：proposed / 技术建议

## 决定/建议
技能/天赋/状态统一白名单schema；实例/定义分离；新机制经有类型操作扩展。

## 原因与后果
内容易增量且可验证；新机制有工程成本。禁止eval和场景私有结算，schema不能只停在类型声明。

## 复审触发
用户范围变化、原型证据否定前提，或存档/表现/内容兼容发生破坏性变更时复审。不可用后续实现便利自动覆盖玩法边界。

## 落地追踪
TASK-003、TASK-019至TASK-026；[详细设计](../02-detailed-design/09-content-authoring.md)；[任务总表](../03-execution/task-register.md)
