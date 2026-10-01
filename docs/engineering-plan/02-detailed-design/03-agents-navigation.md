# DD-03 需求、任务、岗位与寻路

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-002](../00-overview/requirements.md#req-002)、[REQ-006](../00-overview/requirements.md#req-006)、[REQ-009](../00-overview/requirements.md#req-009)

<a id="model"></a>
## 任务合同

Agent记录需求档位、日程、岗位偏好、当前jobId、位置和movementIntent。Job记录稳定ID、kind、目标、workerIds、seatToken、材料reservationIds、routeVersion、进度、已消费、产出事务、阻塞原因及中断策略。

Job状态：Planned→Reserving→Travelling→Working→Completing→Done；Waiting/Interrupted可回到有效阶段；Cancelled终态。每状态进入/退出的令牌申请与释放成对，重载不重复申请。

<a id="selection"></a>
## 调度顺序

每低频决策tick依次检查：生理安全→伤势照护→已承诺任务→日程→社交兴趣。手动指派提高相应策略优先级但不能绕过生命安全或不可能条件。食物最低人数、伤员免战等批量政策在分配前过滤，冲突返回可读原因。

先选合法候选，再按策略分/路径成本/稳定ID排序；不得用Map偶然顺序决定。远征/闭关人员被独占占用，不能同时生产；授业需师生同时可用。

<a id="path"></a>
## 寻路与空间约束

地块网格+可达区域缓存+入口/排队点。寻路仅在新目标、路径阻塞或地图版本变化时触发；设每tick寻路预算与等待队列，不能为全体每帧重算。地图变更增navVersion使相关路径失效。

席位预约与入口令牌独立；到达后才进入有效工时。相互堵路先让行/队列调序，超过明确阈值标记PathBlocked并提供定位。取消任务时人物安全返回可达点；没有退路就停表诊断，不能穿墙“修复”。

<a id="tests"></a>
## 表现与规则共同验收

6人切片和36人基准均测：同一工位争用、建筑移动阻入口、伤员被抢救打断、午餐跨任务、材料途中取消、出征召回生产人员。每个忙碌人物可点击查到任务、缺口、工时与资源流水；角色动画持续但核心暂停时不产资源。导航快照/读档保持相同任务归属。
