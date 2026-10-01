# DD-01 内核合同、时钟与确定性

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-004](../00-overview/requirements.md#req-004)、[REQ-005](../00-overview/requirements.md#req-005)

<a id="data"></a>
## 数据合同

| 类型 | 最低字段 | 规则 |
|---|---|---|
| WorldClock | simulationTick, calendarTick, mode, speed, pauseReasons | tick整数；单位不混写 |
| Command | commandId, sequence, kind, issuedTick, payload | sequence由会话入口排号；同ID只提交一次 |
| DomainEvent | eventId, kind, tick, rootActionId, parentEventId, payload | 提交后不可变，禁止依赖消费者顺序 |
| RandomStreams | generation, economy, combat, offers, events | 每流算法/状态存档；UI预览无权消费 |
| SequenceState | nextEntity, nextEvent, nextAction, nextInstance | 单调序列随档保存，不能用系统时间造ID |

算法名称、浮点/整数边界及取整方式在TASK-004锁定。不同内容/模拟版本不承诺天然同哈希。

<a id="advance"></a>
## 推进与暂停

每帧由适配器计算可推进tick数量并设追赶预算；核心只接收整数步。步骤：接纳本tick已排序指令→执行到期/失效清理→按固定系统表推进→提交领域事务→发布事件→结成完整快照。各域系统顺序写成版本化常量并以回放测试锁定。

暂停使用原因集合（玩家、关键选择、危险、隐藏、错误），撤销一个原因不能清掉其他原因。经营模式推进calendar；战斗模式只推进Encounter.tick。旅行节点通过同一经营推进函数申请N个月，分检查点执行，若短粮/致死预告触发则中断等待，节点保存剩余月数，最终才写settled标记。

3×或快进不能直接赋目标年月。低帧率可以少展示帧，不能跳过风险/消耗；表现插值不回写位置真值。

<a id="idempotency"></a>
## 重试与异常

命令去重记录包含ID、提交结果摘要及相关事务ID。相同ID不同payload拒绝为冲突；已提交同命令返回原结果。保存边界不得位于资源扣除与事件提交之间。长会话去重压缩必须保留所有仍可重试的事务ID，不能简单按UI日志长度删除。

核心错误返回typed rejection；不改变随机流或扣资源。无法继续的内部不变量错误暂停并保留可导出的诊断快照，禁止随机改值“修好”。

<a id="tests"></a>
## 验收夹具

同seed分别逐tick/3×/100ms帧抖动/暂停恢复推进到同tick，领域哈希相等。重复命令、同ID异payload、多个暂停原因、旅行半途中风险暂停、保存后恢复ID序列均有黄金测试。属性测试验证tick单调、库存非负与事件序号唯一。
