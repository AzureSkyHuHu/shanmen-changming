# 远征、永久树与局内构筑

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-013](../00-overview/requirements.md#req-013)、[REQ-014](../00-overview/requirements.md#req-014)、[REQ-015](../00-overview/requirements.md#req-015)、[REQ-016](../00-overview/requirements.md#req-016)、[REQ-017](../00-overview/requirements.md#req-017)、[REQ-021](../00-overview/requirements.md#req-021)

使命：出发底盘能玩，路线抉择与三选一使一趟远征形成不同打法。

拥有：RunState、路线节点、补给/封存战利品、配装锁、个人与团队机缘、offer/刷新记录、返回结算。

入口：准备出征、选路、进入战斗、选卡和持有人、刷新、撤回。出口：单场战斗输入、奖励事务、来源生灭、清晰损失报告。

关键选择：整趟远征为run仍待确认；战略月份按节点提交；encounter状态与run机缘独立清理；抽选预览不消耗正式随机数。

恢复策略：读档保留已生成选项；合法池不足有通用与补给退路；持有人死亡即失效，不隐形转赠；所有退出共用幂等入口。

下钻：[run状态机](../02-detailed-design/05-run-lifecycle.md)、[树与offer](../02-detailed-design/06-builds-offers.md)
