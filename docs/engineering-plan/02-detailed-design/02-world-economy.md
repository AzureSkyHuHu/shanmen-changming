# DD-02 世界、库存与建设经济

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-003](../00-overview/requirements.md#req-003)、[REQ-007](../00-overview/requirements.md#req-007)、[REQ-008](../00-overview/requirements.md#req-008)

<a id="data"></a>
## 世界与库存模型

World持有地图种子、地块、实体索引、库存和全局解锁。地图生成确保住房/食物/基本矿木和首个突破路线可达；失败种子可重试生成但记录重试规则，不能随玩家操作变更地图。

InventoryLedger记录resourceId、owned、reserved、capacity；Reservation记录reservationId、ownerTransactionId、lines、state。available=owned−reserved。InTransit是任务责任的物流记录，不能再计一次总拥有量。稀有任务物禁止无提示溢出销毁。

RecipeDefinition包含输入、输出、可替代组、岗位、有效工时、技术要求与返还规则。BuildingOrder包含blueprintId、位置/旋转/入口、锁定预算、已耗材料、工时和维护启用tick。

<a id="transaction"></a>
## 事务状态与提交

状态：Requested→Validated→Reserved→Running→Committed，或Cancelled/Blocked。开工预约输入，不立刻等同全部消耗；按配方提交策略记录已消耗部分。完成时原子执行预留检查、扣投入、加产出、完成标记及事件；重复完成返回原事务结果。

取消释放未耗预留，返还仅按明确规则，已成产物不能与全部原料同时返还。生产/研究/建造/拆除/交易共用事务账本，动画回调只播放。产出公式的activeTime只累计工位、材料、人员有效且未旅行的时段。

<a id="buildings"></a>
## 建设与维护

预览验证地形、碰撞、入口道路和关键交通；提交时再次验证。蓝图无材料时可存在但不占用未获得资源；施工按锁定预算走订单。搬迁有工时并重验通行，不能瞬移绕过物流成本。完成tick起启用维护，升级先停止重复创建旧等级收益。

研究按有向无环图解锁，不重复发节点奖励。16节点只是首发目标，正文文案与数据同源。路线专精必须保留生计、疗伤与主线获取替代。

<a id="recovery"></a>
## 经济安全与验收

维护/食物预估展示至少一个明确未来检查点的缺口，不把灵气当可无限存货。觅食不需要先花口粮；紧急采购无可循环套利。配方图静态筛查潜在正收益环，再用模拟检查时间/劳力/价差约束，不能仅靠静态图判平衡。

测试：并发两订单抢同材料、取消后重载、双击拆除、满仓关键物、36人缺粮与减员、受伤农夫、研究重复奖励。150年经营长跑记录基础资源、死亡原因与恢复步骤，目标不是永远富裕，而是可理解、可恢复。
