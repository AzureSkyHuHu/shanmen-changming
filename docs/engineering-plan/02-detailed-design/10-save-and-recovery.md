# DD-10 版本化存档、迁移与浏览器恢复

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-025](../00-overview/requirements.md#req-025)、[REQ-026](../00-overview/requirements.md#req-026)、[REQ-005](../00-overview/requirements.md#req-005)

<a id="envelope"></a>
## 完整存档合同

SaveEnvelope记录saveVersion、simulationVersion、contentVersion、buildId、seed、savedAt、checksum与payload。savedAt用于显示，不能参与领域随机。checksum用于损坏检测，不是安全/防作弊证明。

Payload包括World及随机流、ID序列、命令去重/事务账本、人物/任务/关系/历史、CharacterProgression、RunState与BattleState。Run必须保留路线节点、月耗进度、offer及选择、持有人、封存/未封存物和结束标记。Battle必须保留动作预约、队列、状态/修正来源、快照、到期/冷却、ICD与proc预算。只保存可序列化领域值，UI设置独立；禁止存函数/精灵/DOM。

<a id="write"></a>
## 保存原子性

SaveCoordinator仅在完整tick和事务边界请求快照；去抖周期保存与关键事务后保存并存，不依赖卸载最后一刻。每槽写新记录→读回/校验→原子更新current指针→再按保留策略回收旧自动版本。失败不切指针，明确显示最近成功时间。

建议3战役槽各3自动版本+手动/关键安全档，具体配额实测。应用内配额告警时提供导出；存储完全不可用仍能显示当前会话导出，不能伪报保存成功。

<a id="migration"></a>
## 导入迁移与兼容

读取只做大小上限、JSON结构、版本、哈希、ID引用、数值范围验证；通过后纯函数vN→vN+1连续迁移，再全量验证。先保存原始字节备份，迁移失败不覆盖原档；较新不支持版本明确拒绝，不降级猜字段。

导入显示来源版本、战役摘要和目标槽，用户确认覆盖后才提交。伪造/恶意数据不执行代码。被删内容用明确兼容映射/补偿策略，不能把未知ID静默丢弃。release回滚必须考虑新档是否能读；二进制回退不等于存档可回退。

<a id="tabs"></a>
## 单写实例与恢复

用浏览器支持的锁机制或带epoch租约的适配器实现单写；具体API由版本核验任务确定。第二标签页只读或显式接管；旧writer在每次提交验证epoch，失去写权暂停。Broadcast消息用于提示不能单独作一致性保证。

隐藏/失焦安全状态加入暂停原因，恢复展示停在哪，不推进离线年龄或致死事件。页面恢复不得重新抽offer、重发奖励、重置proc预算或另开run。

<a id="tests"></a>
## 故障注入

写payload前/后、切指针前/后断写；配额失败；损坏字节；未知版本；缺内容引用；两标签同写/接管；暂停战斗和Ending半月中存档。roundtrip规范化领域哈希相同，迁移fixture逐版与链式相等，坏档不改变当前指针。所有故障测试结果当前均未执行。
