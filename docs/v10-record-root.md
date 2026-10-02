# v10 内部完整记录根

日期：2026-10-02。阶段：内部记录组合；没有新增玩家入口、存档 codec、迁移、Session 或运行时准入。

## 唯一固定入口

`kernel/validation.ts` 新增 `inspectUnregisteredWorldV10Records(input: unknown)`，只调用私有 literal `version: 10` 分支。原 v1–v9 wrapper、其输入语义和旧错误先后顺序保留；没有将 v10 改写成 v9、放宽旧域或公开 caller policy/callback。

新根首先按数据描述符复制输入，随后核对精确根字段及 v10 身份：`0.10.0`、`management-v10-alchemy-upgrade.1`、固定内容版本/指纹。共享基础数值、地图、实体、RNG、序列、培养、自动与旧生产记录继续走已有记录检查。管理两时钟严格同步，encounterTick 为零，campaign/expedition 为空，持久化 pendingCommands 为空；campaign 事件和相关 World 回执也不开放。

复制拒绝 getter、toJSON、自定义原型、symbol、非 enumerable 字段/数组索引、稀疏数组、非有限值、环和重复对象引用。逐层先捕获 descriptor value 再递归；不读取外部异常对象。固定 128 层与 4 MiB 数值节点/数据字节上界仅约束当前记录遍历。Proxy reflection 可以执行调用者代码，不保证原子外部快照或识别全部 Proxy。复制只产生内部数据，不修改或冻结调用者输入。

这不是新八字段 envelope 的完整字节度量，也不提供未来工作/终止义务、decoder 所需余量、有限恢复、保存或新开工准入。

## 同源生命周期与旧构筑身份

历史恢复后只构造一个 v10 record source object。`inspectV10LifecycleRecords` 和 `inspectV10SectOwnerClosure` 共用它；不能使用两份 spread 结果，因为 lifecycle evidence 同时绑定对象身份与完整 canonical data。

v10 生命周期叶继续验证 schema-3 培养及完整时钟来源、死亡 World 镜像、遗产/归档、里程碑与 authority receipts。永久构筑通过 `managementV10BuildContext` 固定旧 `.3` 构筑身份，保持已有 history、loadout、revision 等记录。历史工人来源只由绑定本源的 lifecycle evidence 生成。

## 完整账本的固定组合顺序

`world/v10-sect-records.ts` 不过滤原有 book、reservation 或历史费率：

1. construction 与完整 paired ledger
2. L1 maintenance 结构、链和付款
3. 完整研究 DAG、费用、工时及 library 已付时期
4. 固定 `validateWorldSectUpgradeRecordsV10(world, frame, lifecycle)`
5. 完整 L2 maintenance 费率及升级完成来源
6. 新旧 production records 和 receipts
7. construction/production research gates
8. 两 exact 药方的 care dose、取消与减伤记录
9. 六域 owner/reservation 双向一一闭合
10. 旧经济所有权与共享 base reserved totals、sect 零起源 stock provenance、全局 claim/worker/实体与 command ID 归属

六 paired owners 是 construction、production、research、maintenance、care、upgrade。工作 owner union 另包括旧 production；所有活动工作总数最多 36，worker ID 唯一。共享 claims 使用已经包含一次 care 的 v10 helper，不能再重复附加 care。旧与新所有者的 claim 一起检查。

真实寿尽/突破待决 World 镜像产生全局 pre-work pause tick；新 v10 根拒绝这些刻上的访问、工时、检查点、完成和维护付款，包括其他活着的工人。旧手动 production 的真实 Committed completedTick（包括归档）、自动生产 committed journal/pin 结算刻同样受此限制。自动 started/blocked notice 与活动自动任务的 startedTick 也仅属于生命周期之后的 tick 阶段；不能在该暂停刻产生。只看实际结算/来源记录，不把取消或重试回执的镜像事件时间冒充生产完成。决策解除后同边界的手动命令开始/取消仍可存在，自动取消 pin 与重试回执亦保留。

所有确实持久化两时钟的历史对都要求相等，包括 upgrade 起始、storage/site visits、work span 两端、checkpoints 和 terminal。旧 construction visits/spans 与 care spans 原来只有一类 tick，不新增伪 calendar 字段。

独立的旧 `system/v9/...` construction/production/research/care 取消保留原来源核对。新 v10 根在旧 construction/production/research 域关闭其他 `system/` 名空间，只允许真实认证的原 `system/v9/death/...` 取消；不修改旧 v9 可接受集合。此类旧日志继续留在 v9，后续迁移必须明确报告不受支持，不能悄悄换标签。升级死亡终态只通过上述 World 专属升级端口验证绑定的真实死亡及 exact unavailable tick；standalone 升级验证器继续拒绝 system cancellation。记录通过仍不代表可以在活动升级中发布死亡前工作或调度新 tick。

## 验证夹具与边界

`tests/sect-expansion/v10-world-records.test.ts` 从严格新鲜/安静 v9 World 构造明确标注的 record-only v10 测试输入，完整保留历史与账本。它不是迁移实现或旧存档授权；没有以单独组件推进、缺培养 clock rows 的世界冒充完整有效 World。

覆盖新鲜记录、旧永久配装历史、真实建造/研究/维护/送药/照护与培养时钟、真实 upgrade start/cancel、六域缺失/重复/伪 owner、base/sect 账本闭合、归档命令碰撞、真实退休建造工人、旧系统死亡取消、版本混装、精确字段、getter/异常/别名/稀疏/深度与输入不变。旧 v9 对额外 upgrade 字段及旧公开 root 对 v10 的拒绝保持。

本片由唯一集成负责人串行验证：根记录专项 26/26 通过，4.31 秒；此前同源核心/应用双类型检查通过，升级死亡及原升级/退休历史 3 套共 63 项通过。根专项最初因夹具只取得两份新灵石而在药性配伍开始时缺料；修正为真实送达四灵石及四心得后复验通过，没有直接赠送 sect stock 或放宽验证。

这些是定向证据，不是完整回归、完整容量或运行时验收。完整 envelope、whole-v10 future headroom、运行时发布、codec、迁移、UI 和浏览器验收仍须分别完成。

独立审阅发现旧手动归档生产终态未参与新 pre-work 检查，已补入上述 v10-only 约束。新增真实其他弟子 tick1000 寿尽、提前完成手动采集、暂停刻手动/自动取消和重试的夹具；篡改 committed pair 与对应 live/archived World mirror 或自动 committed/start notice 时只改其时间，保留实际价格、回执、工人和归档编码。新增检查待集成负责人复验；原 v9 对这些历史的接受行为没有修改。

集成复验（2026-10-02 20:15 UTC）：暂停/死亡修复后的记录根、死亡与共享时钟叶合计49项通过；候选与旧建造、研究、护理、时钟、codec兼容合计7文件358项通过（237.17秒）。双类型、边界、1205中文键、内容和默认构建通过。独立只读复审未发现这两处修复的遗留实质问题。仍未进行新 v10 玩家浏览器或全游戏验收。
