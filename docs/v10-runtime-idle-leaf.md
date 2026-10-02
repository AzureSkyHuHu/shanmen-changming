# v10 私有标量空闲叶

日期：2026-10-02。此片是内部固定变换与保守容量延续；不是 v10 存档/导入准入、任意候选免检、恢复释放证明、公开运行入口或性能验收。

## 所有权与接入约束

`createOwnedIdleLeafV10()` 每次创建独立的私有游标与所有权集合。它只提供：

- `capture(input)`：先以现有有界描述符捕获完全隔离输入，再检查窄空闲条件，并调用固定 `assessManagementCapacityV10` 做完整记录、容量及未来余量检查。只有 supported/actualFits/fits 全部通过、无缺口或未知义务的来源才能安装游标。返回隔离冻结的 World、该来源的精确 assessment，以及单独的保守容量类型
- `advance()`：没有参数，不接受调用者的候选、assessment、所有者、策略回调或布尔信任标志。只从自己的完整冻结游标生成固定后继；失败返回 null，保持上一完整游标不变
- `clear()`：丢弃游标；不取消领域任务，也不改变已返回的不可变边界

另一实例的冻结 World、相等结构、复制出来的 assessment 或借用方法的 `this` 均不能创建所有权。再次 capture 仍重新捕获并完整检查，不能依据 `Object.isFrozen` 跳过验证。源反射期间有同步重入保护；不会读取被抛出对象的 message 或原型。不承诺识别所有 Proxy，也不承诺限制恶意 ownKeys 陷阱本身的执行时间。

接入者必须是现有私有 runtime，并将游标绑定自己的精确 World 身份与 generation。仅在没有安全停止时调用；command、control、replace、invalidate、close 及离开该精确分支时清除旧游标。停止、发布编号、外部命令及快照仍由原 runtime 负责。capture 拒绝的来源继续原严格检查，尤其不能把该叶当作活动授课来源准入。没有修改原 `runtime-capacity-v10.ts` 严格入口。

## 固定适用边界

每一刻都要求：

- 精确 v10 内容/运行身份、management、无暂停、待处理队列与出征
- 无旧生产或自动生产 live 记录，无 planned blueprint
- 施工、宗门生产、研究、照护、升级均无 live job；travel、尚未到开始刻、blocked、未消耗第一份材料等阶段没有例外
- 所有当前修炼角色 alive，且无待决死亡、突破尝试、授课、活动所有者、永久构筑锁、生产指派或旅行
- 精确来源 assessment 只有弟子生命周期 progression owner、零 sect owner、零有限 calendarTicks horizon
- 下一刻仍在本月，并未到任何角色的独立生日相位
- 下一刻严格早于每座已建成建筑的最新实际付费到期；没有付费则取 construction origin 的 firstMaintenanceCalendarTick
- 自动计划器已关闭、等待激活审阅，或其下一次决策严格晚于下一刻
- 五个增长标量远离近 MAX 边缘；旧严格路径仍负责这些排除区的准确拒绝顺序

L2 不改写不可变的 L1 建造来源。到期判断读取包含 L2 rate 标签在内的全部真实支付历史，而不是根据 origin.level 重算或赠送新周期。到期的可选续费必须走原真实候选与完整检查。

## 固定变换与数值证明

World 仅有以下五个存储整数 +1：simulationTick、calendarTick、construction.revision、production.revision、research.revision。care.revision、upgrade.revision 不变；角色、地图、库存、随机流、队列、义务所有者及全部历史不变。

安全非负整数的 JSON 数字与十进制字符串有相同的 ASCII/UTF-8 长度。因此每刻 wireBytes 精确增加这五个整数各自的十进制长度差，覆盖 9→10、99→100、999→1000 等边缘。不添加节点、字符串或行数费用。

capacity 还有未存储在 World 的导出算术维度：每个当前人物的 `birthday.<id>.elapsedTicks` 和每个归档人物的 `birthday.<id>.archivedElapsedTicks`。两者也必须 +1，并独立检查安全整数上限；它们不产生第二次 wireBytes 收费。即使 calendarTick 本身仍很小，负出生时刻与当前刻的差也可能已到 MAX，不能遗漏归档人物。

`CarriedIdleCapacityV10` 与 `ManagementCapacityV10` 不同，没有 fits/admitted/terminalDischarge 等字段。它保留原 reserved/limits，不伪造新的精确 assessment。每次检查 current、reserved、limits 的完整键集与每个安全非负整数操作数，并以 current ≤ limit − reserved 检查，避免不安全加法与舍入。

该窄变换不改变生命周期记录和阶段，因此所有 owner 与有限期限保持不变：

- 旧生产/自动生产/队列为空，固定通用与日志余量不变
- 生命周期 future row/ID/节点义务不变；它们的共享计数器宽度上界减去当前宽度，只能不变或下降
- 无 sect owner；共同 inventory/stock/navigation/domain/clock 标量宽度余量只能不变或下降
- 无升级 owner；不会引入升级 receipt、checkpoint、revision 或新的 shared reserve
- 零有限 progression horizon 下，month/birthday horizon 行数不增长，生命周期终态 trigger 数量不变

故保留旧余量仍保守，但可能大于精确重算的余量。例如跨十进制位数时，carried wire cost 可能超界，而精确重算因共享宽度余量下降仍可前进。这时只能返回 null 并让原严格路径重新准备/判断，不能设置停止、发布部分候选，不能把多算余量用于恢复缺口比较或终态释放。

`carryScalarCapacityV10` 暴露的是内部算术叶，接受的只是单独容量数据；它不接受 World，也不被任何入口作为调用者提供的准入证书使用。工厂内部只延续自己保存的容量，绝不接收外部算术返回值。

## 测试与验收状态

新增 `tests/sect-expansion/v10-runtime-idle-leaf.test.ts`：

- 新鲜来源与三个十进制边缘逐个对照真实 raw candidate 和原严格 oracle；核对所有 current/limits 与保守 reserved，不仅对比总字节
- 来源可写性、冻结输出、共享不变子树、跨实例重新审查、伪候选附加实参、借用 this、getter/未知 clock/冻结外来数据及反射重入
- 月份、独立生日、自动计划器相位、暂停、队列、计划蓝图、live 旧工作
- 真实寿尽/归档后的 elapsed 维度；独立合成 MAX 算术边缘，明确不冒称合法游戏来源
- 每个容量 map 的不安全操作数、键缺失/多出、未来不足与保守 wire 边缘；严格重算可以通过时不产生错误停止
- 真实药理配伍研究和付费升级的三种 live phase，blocked 变体排除，完成 L2 仍保留 construction L1
- 真实 L2 payment 之后及下次到期前一刻，照护/升级修订不变，到期交回真实续费

当前编写者未运行测试、类型检查、构建或 Git 操作；由唯一集成负责人串行执行并记录结果。这里不宣称通过，也不以这些有界检查承诺活动工作、冷捕获、大历史、36 人、长期会话、3 倍速或移动端性能。

## 集成证据：2026-10-02 21:22 UTC

首次18项中17项通过169.70秒，仅一个enabled+unreviewed非法规划器夹具错误；修正为真实合法状态后该项单独通过，其余17项跳过（2.24秒）。没有声称最后一轮全18项重跑或已接入运行实例。 双类型、边界、1205中文键、内容及默认构建通过。上述定向证据不代表全仓CI、公开v10、真机或完整游戏验收；性能仍待实际运行实例优化后重测。
