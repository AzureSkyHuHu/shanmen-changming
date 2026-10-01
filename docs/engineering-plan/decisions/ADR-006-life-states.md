# ADR-006-life-states: 倒地与永久死亡分离

状态：proposed / 设计澄清

## 决定/建议
Alive→Downed→Recovered或Dead；UnitDowned不发遗物；唯一deathId提交永久死亡。

## 原因与后果
支持救援与公平风险预告，防止0HP即时删除与双发奖励；需要生命阶段及角色历史跨域协作。

## 复审触发
用户范围变化、原型证据否定前提，或存档/表现/内容兼容发生破坏性变更时复审。不可用后续实现便利自动覆盖玩法边界。

## 落地追踪
TASK-017、TASK-022、TASK-031；[详细设计](../02-detailed-design/07-combat-pipeline.md)；[任务总表](../03-execution/task-register.md)
