# DD-08 修正、状态、触发与来源账本

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-018](../00-overview/requirements.md#req-018)、[REQ-020](../00-overview/requirements.md#req-020)

<a id="source"></a>
## 定义、实例与来源

DefinitionId标识不可变配方；InstanceId标识一次安装来源。EffectInstance记录sourceEntityId、sourceDefinitionId、sourceInstanceId、lifecycleScope(character/run/encounter)、duration(infinite/ticks/nodes)、createdSequence和removeReason。

来源账本以sourceInstanceId索引贡献，不能按显示名称撤销。甲/乙光环和丹药各+10护甲时，移除甲只减甲一项。团队同名光环在求值时按明确比较取最高，其余来源仍登记可恢复。

<a id="modifier"></a>
## 属性与快照

基础+固定值→同组加法百分比→独立乘区→上下限→统一取整。每Modifier有属性、运算类、tag过滤、优先级、scope、来源；不能因天赋/装备/被动分面板而各开最终乘区。

缓存key包含entityStatRevision和查询标签，来源增删/状态变化必须失效缓存。快照只记录解析后的进攻值及版本，不保留对可变对象引用。解释面板可展开每项贡献、上限截断与最终数值。

<a id="status"></a>
## 状态生命周期

StatusIdentity显式决定是否含施法者；刷新、延长、独立实例、强者覆盖分别有策略。定义maxStacks、比较强弱字段、驱散类别、跨场规则及周期tick。expiresAtTick排他：先删到期，再周期处理；在到期tick不能多跳一伤。

scope决定最晚清理边界，duration决定提前到期；run来源的5秒盾不会变成整局永不消失。状态移除按到期/驱散/死亡/退出各发一次原因事件；ShieldBroken绑定shieldInstanceId最多一次。

<a id="triggers"></a>
## 触发队列与保险

事件发布后先冻结合法触发器列表；本事件新加状态不能追溯听旧事件。排序键：阶段→事件序号→优先级→持有人ID→来源生成序号→定义内效果序号。触发器只返回EffectCommand，权威执行器写状态。

默认proc不再触发同类proc；另有oncePerRoot、perTarget、ICD、allowIndirect白名单。每根行动初始深度8/派生64预算，超限截断后续派生并记录原因，不重抽随机数。预算与ICD随存档恢复，不可通过重载清零。

日志保留root/parent、效果序号、请求/实际值、拒绝原因；UI截断日志不影响累计伤害/治疗统计。

<a id="tests"></a>
## 扩展证明

新增一个技能和三选一天赋仅改数据/映射/测试，战斗主循环零改动；再引入一个新操作证明schema/解析器/测试/文案完整注册。黄金链：暴击→雷击→感电→后续技能，以及吸盾→破裂→反震。覆盖同tick到期、两个同名来源、负费用、零伤害、无限链截断、run清理后character保留。
