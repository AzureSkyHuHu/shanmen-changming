# DD-07 战斗动作、伤害与生命阶段

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-012](../00-overview/requirements.md#req-012)、[REQ-019](../00-overview/requirements.md#req-019)、[REQ-011](../00-overview/requirements.md#req-011)

<a id="action"></a>
## 动作事务

ActionInstance包含actionId/rootActionId、actor、skillDefinitionId、requestTick、castEndTick、reservationId、targetIntent、attackSnapshot、state、cooldownCommitId。自动和手动入口提交同一种意图，不能手动绕过冷却/目标/费用。

状态：Requested→Reserved→Casting→Committed→Resolving→Complete；前摇中可Interrupted/Invalidated并释放预约。前摇结束重新验证施法者、目标、范围和资源，只有ActionCommitted扣费用并启动正式冷却。飞行物发出后落空默认不退费用；内容必须显式声明例外。

<a id="pipeline"></a>
## 规范结算阶段

唯一阶段顺序：意图→校验预约→前摇末重验→提交费用/冷却→目标选择→命中/免疫→基础与修正→防御→护盾→生命变化→濒死保命→倒地/死亡提交→不可变事件→冻结并收集后续触发→确定性队列。

请求伤害、防御减免、真实吸盾、真实生命损失分别记账；免疫或零生命伤害不能误触发“造成生命伤害”。护盾在防御之后承受值。治疗不可变事件区分请求、有效治疗、溢疗；溢疗转盾只能读明确字段，不能重复结算同笔治疗。

伤害示例曲线不是硬编码唯一公式；schema里锁定所用策略与取整。攻击默认castSnapshot，防御hitLive，DOT施加时攻击快照/每跳目标防御；例外须定义明确。

<a id="life"></a>
## Alive、Downed、Recovered与Dead

生命归零先运行固定濒死保命阶段；仍为零提交UnitDowned，停止行动、释放动作/任务预约，但不发死亡奖励。Downed可被合法救援成为Recovered，恢复为可行动Alive时施加明确恢复约束；Recovered的事件用于诊断，不能重复发救援收益。

只有明确致死规则、放弃救援或预告致命攻击可一次性提交deathId与UnitDied。永久死亡由角色生命周期域接收；敌人同样在定义说明生命终结策略，不默默把弟子倒地规则套到奖励刷取。倒地/死亡后排队动作重验；已死来源不得继续行动。已发射飞行物是否继续由定义策略显式规定并测试，不能受精灵是否销毁影响。

濒死效果只在死亡前固定窗口触发，死亡后不得临时复活重复发遗物。

<a id="tactics"></a>
## 自动AI与玩家指令

AI按威胁/可达/角色距离/技能条件提出意图；相同分值按稳定ID仲裁。玩家集火/护卫/位置命令有期限和失效原因，不是永久锁死目标。暂停时队列可编辑，恢复按序执行；每项都再次合法性校验。

阵法/丹药受共享预算与冷却限制；默认不自动消费稀缺救命物。撤退需出口与读条，过程可被规则中断，成功才通知run结束。移动、控制、区域和纸傀新操作先通过执行器测试后才允许内容启用。

<a id="tests"></a>
## 关键测试

同tick双技能抢资源只成功合法预约；前摇目标死亡释放费用；盾全吸收无生命伤害触发；濒死自保先于倒地；Downed不发遗物；救援不复制奖励；两个致死源仅一个deathId；暂停命令/失效集火/撤退中断与读档回放相同。
