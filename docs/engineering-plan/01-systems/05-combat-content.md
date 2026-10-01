# 可扩展战斗与数据内容

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-012](../00-overview/requirements.md#req-012)、[REQ-018](../00-overview/requirements.md#req-018)、[REQ-019](../00-overview/requirements.md#req-019)、[REQ-020](../00-overview/requirements.md#req-020)

使命：技能、天赋、状态复用规则积木；能追踪复杂连锁为何发生。

拥有：动作、目标、资源预约、伤害/治疗/护盾、倒地、状态、修正来源、后续触发队列和因果统计。内容定义不执行任意代码。

入口：自动/玩家意图与白名单定义。出口：不可变战斗事件、领域结果、解释日志与表现提示。

关键选择：唯一ActionCommitted提交点；防御先于盾；濒死保命先于倒地/死亡；同事件冻结触发器快照；同类proc默认禁止递归。

扩展门槛：普通新技能只加数据+映射+测试；新操作必须新增有类型纯解析器与统一权威执行器，不得靠场景脚本特判。

下钻：[动作管线](../02-detailed-design/07-combat-pipeline.md)、[状态触发](../02-detailed-design/08-effects-statuses-triggers.md)、[内容制作](../02-detailed-design/09-content-authoring.md)
