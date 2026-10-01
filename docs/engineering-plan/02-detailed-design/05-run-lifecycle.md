# DD-05 远征一局与战略时间

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-004](../00-overview/requirements.md#req-004)、[REQ-015](../00-overview/requirements.md#req-015)、[REQ-021](../00-overview/requirements.md#req-021)、[REQ-025](../00-overview/requirements.md#req-025)

<a id="state"></a>
## RunState合同

前置：整趟远征为run仍是[待确认决策](../decisions/ADR-001-run-boundary.md)。RunState含runId、status、region/route/nodes、squadIds、lockedLoadouts、supplies、travelLedger、currentEncounterId、offerState、talentInstances、securedLoot、unsecuredLoot、rngState、rewardCounters、settlementId。

状态：Preparing→Active/AtNode→InEncounter→RewardPending→AtNode；终态通过Ending→Ended。战斗暂停/页面关闭不是结束远征。若玩家改用单场run，必须重审scope、抽选频率、资源与退出任务，不只改一个命名。

<a id="entry"></a>
## 出发与节点

预览显示人数/装备、补给、预计总月耗、已知危险和撤退方式；出发时锁配装、移除生产岗位参与资格、预约并扣补给、生成路线和runId，原子提交。首次标准远征前底盘需合法完整，不能要求抽到核心卡才会攻击。

每节点独立nodeVisitId与timeSettlementId。旅行/返程标注月份，通过经营核心逐检查点推进；战斗节点冻结历法；返程不再扣整趟月份。nodeTimeProgress保存已经推进月数，途中风险中断不丢失。出发至返程期间队员不产资源。

<a id="encounter"></a>
## 单场边界

进入Encounter创建临时状态并应用合法character/run来源；战斗结束提交伤势、耗品、耐久和结果。encounter状态按定义清除，run机缘跨场保留；短持续护盾虽然源属run，也不能因跨场保留来源而永久保留护盾。

战斗期间的战略年龄不按真实秒数补算。安全节点可撤回；紧急撤退由战斗过程确认成功后走同一Ending入口；旧战斗队列在离场前清理且不泄漏到下一场。

<a id="exit"></a>
## 统一结束事务

EndRun(reason)读取已封存/未封存战利品，按源§13规则生成不可变结算预览与settlementId。提交顺序：验证终态未提交→提交损失/战利品/返回耗时→清理encounter/run来源与锁→恢复幸存者可用性→保留character资产→写历史与Ended标记。时间结算可因风险暂停，不能把Ending直接标为Ended。

终点不再发立即失效的机缘。读档重复结束返回原结果，快捷首领重试须完成旧run清理后新建run，禁止继承旧触发队列。

<a id="tests"></a>
## 边界验收

三次战斗+旅行/返程的已知路线手算对账；中途月耗风险暂停/恢复；每退出路径重复调用两次；胜利/撤回/全灭/页面关闭；个人持有人死亡与团队机缘保留；保存RewardPending/Ending半程后恢复结果相等。
