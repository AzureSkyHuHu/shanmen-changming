# 内核、时间与事务

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-004](../00-overview/requirements.md#req-004)、[REQ-005](../00-overview/requirements.md#req-005)、[REQ-007](../00-overview/requirements.md#req-007)、[REQ-025](../00-overview/requirements.md#req-025)

使命：保证每个系统共享同一份事实，暂停、加速、读档都不改变规则。

拥有：tick、历法、随机流、稳定ID、Command/DomainEvent序列、事务去重表；不拥有UI时间和数据库实例。

入口：经过验证的命令与固定步推进请求。出口：新的领域状态、不可变事件、稳定查询版本号。

依赖：内容只读定义；平台只经端口保存完整快照。经济、突破、战斗、run奖励不得各自维护去重逻辑。

关键选择：整数tick与明确单位；多随机流防表现行为扰动奖励；单线程权威写入；低帧率限制追赶且不能丢逻辑tick。

失败策略：非法命令返回结构化原因；超预算停在可恢复边界；导入失败不覆盖现档。

下钻：[内核](../02-detailed-design/01-kernel-contracts.md)、[经济事务](../02-detailed-design/02-world-economy.md)、[保存](../02-detailed-design/10-save-and-recovery.md)
