# v10 丹房升级：冻结的有界扩展合同

日期：2026-10-02。状态：**合同设计，尚无运行时、存档迁移、UI、测试或发布验收**。

本次仅新增本文及 `src/core/sect-expansion/upgrade-types.ts`。该类型文件是独立实施者的交接面，不是功能入口。本文将原[扩建首片](sect-expansion-first-slice.md)中的下一段缩为：

> 真实取得材料 → 药性配伍 → 丹房 L1 升 L2 → 无粮替代伤药 → 原有真实照护。

不含搬迁、L3、扩占地、拆除、新物品/战利品、远征、研究/升级/新配方自动调度。原有六资源自动生产的已实现行为不借本片扩展。完整游戏、150 年、36 人、3 倍速、移动设备与长期性能仍是独立验收。

## 1. 版本决定与不变的历史

### 1.1 唯一新身份

冻结为以下组合，禁止实现者自行选 `.4` 或把扩展塞进 `.3`：

| 层 | 新值 |
| --- | --- |
| Envelope `saveVersion` | `10` |
| World / envelope `simulationVersion` | `0.10.0` |
| World `runtimeProtocol` | `management-v10-alchemy-upgrade.1` |
| World / envelope `contentVersion` | `shanmen-management-0.10.0-upgrade.1` |
| World `contentIdentity.registryId` | `content.management-v10.upgrade-1` |
| `sectExpansion.schemaVersion` | `2` |
| `sectExpansion.upgrade.schemaVersion` | `1` |
| `sectExpansion.upgrade.protocol` | `alchemy-l1-l2.1` |

八字段 envelope 不变：`saveVersion, simulationVersion, contentVersion, seed, buildId, savedAt, payload, checksum`。新字段只在新 World 的宗门域内出现。未知/损坏 v10 不尝试当作 v9 或旧版读取。`.1/.2` 管理试验也不是迁移源。

新 World 内容指纹的**精确输入形状**为：

```ts
stableHash({
  protocol: MANAGEMENT_V10_PROTOCOL,
  base: MANAGEMENT_V9_IDENTITY,
  sect: SECT_V9_CANDIDATE_IDENTITY,
  upgradeLimits: SECT_UPGRADE_LIMITS_V10,
  powderRecipes: SECT_POWDER_RECIPE_IDS_V10,
  maintenanceIntervalTicks: 1200,
  tickOrder: MANAGEMENT_V10_TICK_ORDER,
})
```

上述常量名来自新合同及现有冻结内容文件；对象字段、数组顺序均为协议的一部分。`combatFingerprint` 直接保留 `MANAGEMENT_V9_IDENTITY.combatFingerprint`，`buildRulesVersion: 2`。实现时计算并登记精确常量，不在本设计中捏造十六进制指纹。现有 sect 目录及指纹完全不改；目录早已含两研究、L2 和替代方，本片补真实执行与证明。

### 1.2 World 身份不等于永久构筑历史身份

`world.contentIdentity` 采用新 v10 组合身份；**`world.builds.contentIdentity` 仍精确等于 `MANAGEMENT_V9_IDENTITY`**。其 `rulesHash`、origin、migration、revision、receipts、history、装备、点数、退役者和全部序列不重写。以后在 v10 做永久构筑也继续绑定该固定构筑上下文，因为规则没有改变。

新增固定 `managementV10BuildContext(worldIdentity)`：先严格核对新 World 身份，随后返回现有 `.3` 的构筑上下文。不能把新 World 身份写进旧 BuildDataV2；不能提供“任意旧身份也可用”的参数。必须覆盖已研习、已配装、已分配、已退役及未来继续追加历史的真实夹具。

同样保留培养 schema 3、`cultivationClock` 的全部来源行、护理 effect `care.wound-powder.reduce-injury.v9.1`、基础地图/导航、六资源定义、研究/建造来源与旧命令去重。新根身份是组合协议升级，不是给历史行为换标签。

## 2. 已有价格锁定，不重新平衡

| 事项 | 实际要求 |
| --- | --- |
| 药性配伍 `herbal-compatibility.v9` | 基础药理完成；心得 4、灵石 4；400 有效刻；现有藏经阁 L1 研究席 |
| 丹房 L1→L2 | 已完成的 `alchemy.v9` L1；药性配伍；石 6、木板 6；400 有效刻 |
| 第 200 有效刻 | 石 3、木板 3 原子消耗 |
| 第 400 有效刻 | 余下石 3、木板 3 消耗与升级完成同一次提交 |
| 基础伤药 | 草药 3、粮 1；160 有效刻；基础药理；L1 或 L2 |
| 替代伤药 `craft.wound-powder-alt.v9` | 草药 5、木 2；200 有效刻；药性配伍；真实 L2 |
| L1 维护 | 木 1 / 1200 经营刻 |
| L2 维护 | 木 2、草药 1 / 1200 经营刻 |
| 真实护理 | 一份已送达的伤药；40 有效刻；伤势减 20，最低 0 |

不得凭 UI 选择、库存数量或 `level:2` 获得解锁。研究材料继续来自现有真实采灵/整理；迁移不赠资源、药品、研究或伤势。

## 3. 唯一权威、精确保存形状

规范 TypeScript 见 `upgrade-types.ts`；该文件不导出 reducer/validator/codec 的实现。

### 3.1 不复制世界

`SectExpansionOwnedRecordsV10` 保留原五域，加 `upgrade`，外层 schema 改 2。construction 内 schema 仍 1。World 是当前 tick、地图、人物、基础库存与 RNG 的唯一所有者。`SectUpgradeFrameV10` 只是同步内部投影，不能持久化第二份地图/人物/余额/时钟。

升级不新建建筑：`construction.buildings[*].level` 永远为建造原值 **1**；`sourceJobId`、完工刻、首期维护到期、位置、朝向、实体 ID 均不改。有效等级是：存在唯一合法完成升级记录则 2，否则 1。没有独立 `levels`、`unlocks`、`operational`、`paidThrough`、完成 ID 列表或第二库存。

### 3.2 升级状态与 ID

空升级域的精确值：

```ts
{
  schemaVersion: 1,
  protocol: 'alchemy-l1-l2.1',
  catalogIdentity: SECT_V9_CANDIDATE_IDENTITY,
  revision: 0,
  nextId: 1,
  jobs: [],
  receipts: [],
}
```

每次成功 start 只分配两个局部编号：`sect-upgrade:N`、`sect-upgrade-reservation:N+1`，nextId 加 2。全历史不删除，因此起始 N 必须依次为 1、3、5…，`nextId = jobs.length * 2 + 1`。不花 World entity/action/event/instance 编号，不消费 RNG。升级回执为该命令唯一所有者，不额外复制到 World commandReceipts/events。

每份 job 保存目标/工人、不可变 L1 来源/入口、仓库来源、药性配伍完成引用、起始位置/两时钟、phase、真实访问/有效工作区间、两个耗材检查点、navigation、阻塞与终态。价格来自固定 catalogIdentity + `alchemy.v9` L2；不允许命令自带价格、工时、等级、claimed payment 或 provenance。

上限：128 jobs、256 receipts、全系统合计 36 活跃工作、每建筑最多一个活跃升级、每建筑最多一个完成升级；401 次 site visits、400 work spans、2 checkpoints。共享 paired reservations 仍受现有 384 上限，不为了新功能随意扩容。有限记录耗尽就拒绝新开工，不删记录让路。

`revision` 从 0 起。成功 start/cancel 每次加 1；升级 tick 阶段仅在本阶段任一升级状态/移动有变化时整体加 1，多个同刻 job 共用该阶段的 post-revision；纯 no-op 不加。已接受命令回执严格递增，等于 command.expectedRevision+1；terminal.upgradeRevision 是真实提交修订。每个源码→候选转换核对单调及精确增量。历史静态验证核对范围、回执归属与时间一致性，不声称仅凭历史记录可重放所有未保存的阻塞变化。

所有数值为非负安全整数（nextId 从 1 起），计算先检查溢出；两时钟始终相等且等于 World 当前管理时间。局部 ID、引用和 commandId 最多 128 code units。玩家 commandId 仅 `[A-Za-z0-9._:-]{1,128}` 且拒绝 `__proto__/constructor/prototype`；玩家不得发送 `system/` 命名空间。升级域系统死亡取消 ID 唯一为 `system/v10/death/<deathId>/<jobId>`。其他原有域的 `system/v9/...` 历史和固定来源规则保持，不能批量改名；新 v10 root 对两类记录各用其真实所属协议校验。

数据只接受有界普通 enumerable data objects 与 dense arrays；字段集精确，拒绝未知字段、getter、prototype、symbol、洞、NaN、Infinity、undefined、别名环。可选 `never` 的字段意味着必须缺席，不是允许显式 undefined/null。所有输出与外部输入隔离。描述符读取与 hostile Proxy 的既有限制如实保留。

## 4. 命令、工作与取消

### 4.1 命令入口

仅新增：

```ts
{ domain: 'upgrade', command: { kind: 'upgrade.start', commandId, expectedRevision, buildingId, workerId } }
{ domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId, expectedRevision, jobId } }
```

外层仍是 `sect.command`，外层/内层 commandId 必须相同。Session 给 sequence/issuedTick，并同时对照会话 epoch/worldRevision、upgrade revision 与目标。同 commandId/完整相同 body 先返回原接受结果，即使 expectedRevision 已旧；同 ID 不同 body 拒绝，不分配编号、写回执、改钱或推进 RNG。新 ID 指向已终态 job 返回 TRANSACTION_FINISHED。全部域命令 ID（含归档）仍只允许一个所有者。

start 必须同时满足：

1. 完整 v10 源记录、当前支持的生命周期/容量范围已通过；管理模式、未暂停、无远征
2. 目标是由真实 L1 建造完成的 `alchemy.v9`；不是旧站点、library、草图、L2 或已开始的其他升级
3. 真实药性配伍完成记录在 start 两时钟之前或同刻；其 prerequisite 指向真实基础药理，整条研究付款/工位/有效工时来源成立
4. 目标已经付费；没有任何活跃生产引用其 productiveSite（包括已释放工位仍在送货/等待送货者）、研究使用或入口/seat owner；不悄悄取消对方
5. 工人在家、活着、可劳动、duty、无旧生产/修炼/教学/护理/建设/其他升级/构筑锁；现有 shared work-owner union 包含 upgrade
6. 仓库有效、入口存在且占地仍合法；目标入口/席位/工人无冲突，当前位置安全；新保存与未来终止余量满足
7. 石 6、木板 6 作为同一 paired reservation 成功预留；上述失败全部回滚

开始就停用目标生产/研究，派同一真实工人先走仓库、再走目标入口；停用期间 footprint 不消失。worker claim key 是 workerId；seat key 是 **buildingId**；entrance key 是 `x,y`。三项由活跃 job 全程独占，不在旧 assignmentTransactionId 塞升级 ID。仓库访问沿用当前空间/入口冲突检查，不把仓库长期锁给全部在途升级。

### 4.2 真实访问与有效工时

四向寻路、4 刻移动一格、重试策略沿用已冻结导航；所有系统共享同一每 tick 寻路预算。升级不会改变占地/入口，因此 start/checkpoint/cancel/complete 均不增加 navVersion；其他真实地图改动仍按原协议失效所有路线。严禁为了“刷新 UI”增加导航版本或传送人物。

storageVisit 只能由真实到达产生，不能与 start 同刻；siteVisit 在 storageVisit 之后。两段最短时间满足 Manhattan 距离×移动刻（即使零距离也另占到达边界）；到达刻不加工时。失去工作地点后重新取得真实 siteVisit，最多 401 次；容量不足返回可取消的阻塞，不丢失已耗材料。

每 span 绑定已存在的 siteVisit；firstTick 大于该 visit，区间有序、不重叠，同 visit 相邻可合并则必须合并。有效刻总数精确为区间长度和，最多 400；calendar 区间同长。每个工作刻必须站在入口、工人可用、无冲突、当前管理未暂停且建筑已付费。旅行、排队、缺维护、生命周期暂停不计工。

第 200/400 个有效刻的位置/两时钟可由 spans 按**有界行数**算出，必须分别等于 checkpoint 证据。配对账本沿用 `policy: 'construction-checkpoints'` 和 `construction.half` / `construction.remainder`，不另发明语义相同的支付协议；两个账本都记录同名检查点，sect 侧无资源行。每次消耗只由现有检查点原语一次提交；重复不得二扣。

完成必须同时：400 work ticks、两个检查点、石/板各耗 6、remaining 为空、两个账本 committed (`complete:<jobId>`)、无 outputs、terminal completed/resultLevel2、navigation 清空、释放三个工作 claims。terminal 自身就是唯一 L2 完成事实，不新增建筑或单独奖励回执。

### 4.3 取消与死亡

- 0–199 工时：释放石 6/板 6；200–399：释放石 3/板 3；已耗部分永不返还
- 400 与完成原子化，不存在 activeTicks400 尚可取消退款的保存边界
- cancellation requested 需同一 job 的真实 cancel receipt；death 需真实当前/历史死亡及 World 生命周期镜像，不能由命令附带 deathId 授权
- 取消形成 released (`cancel:<jobId>`) 的 paired settlement，terminal 明列 consumed/released，保留全部访问与工作历史
- 取消后有效等级仍 L1，恢复是否可工作由原维护到期决定；不退款建造费，不重置首期或续费日期
- 工人留在最后真实安全位置，清空该任务导航/traveling，解除对应 claims；不能修改别的任务。没有安全位置则保留原完整边界并停下
- 寿尽/pending death 清理先于当刻任何升级工作；同刻本来会到 400 也须先取消，不能让死亡后的工人完成。归档后历史引用需版本认证的 historical identity source

## 5. 冻结阶段次序与维护历史

### 5.1 一刻的顺序

外层 immediate commands 仍先按 `(issuedTick, sequence, commandId, canonical command body)` 稳定排序、逐个准入。之后每个实际刻：

1. clock
2. cultivation/lifecycle，包括月结、自然痊愈、寿尽、全域强制取消；如新 pause，保留合法已前进时钟但不运行后续工作
3. 旧六资源 automatic starts（没有新自动任务）
4. construction
5. maintenance
6. **upgrade**
7. sect production
8. research
9. care
10. legacy production
11. 完整根记录、numeric/byte/reader/未来义务检查后，一次发布

升级 jobs 用 `(startedTick, jobId)` 排序；维护保留 buildingId 顺序。全部阶段共用导航预算。研究本刻完成后，玩家可在该完成边界发升级命令；本片不增加自动串联开工。

### 5.2 维护的历史级别

维护必须用**付款发生时该阶段的级别**，绝不能拿今天 L2 去重算过去 L1 的费用：

- 建造首期仍 `[completedCalendarTick, firstMaintenanceCalendarTick)`，由原 L1 建造付款，字段永不延长
- 现有九字段 payment 完全原样保留；它严格表示 L1 的木 1 付款，新 v10 L1 付款仍生成同样形状
- L2 payment 在那九字段之外增加且必须增加 `rate: { level: 2, upgradeJobId }`，引用真实已完成升级
- 在 maintenance 阶段查询历史级别时，只有 `upgrade.terminal.tick < payment.paidTick` 才是 L2；**同刻相等仍为 L1**，因为维护先于升级完成
- 在 production/边界查询阶段则 `terminal.tick <= queriedTick` 得到 L2；该查询 phase 是封闭 union，不是任意回调
- 升级开始、经过中点、取消、完成都继承原 due；完成不立刻重付或延长周期。当前 L1 已付周期可继续支持新 L2 工作，下一次到期才按 L2 付
- 例：due=1200，升级在 tick1200 完成。当刻先付 L1 木1，due=2400；2400 才付 L2 木2+草药1。若升级1199完成，则1200付 L2

每笔 payment 的 predecessor、previousDue、paidTick、due=paidCalendarTick+1200、成对 reservation、实耗、无 outputs、稳定顺序与 ID 必须保留原强度验证；L2 只改变其有据可查的费率。无 rate 的付款若发生在真实完成升级**之后**则拒绝；带 rate 的付款若先于/同刻升级完成也拒绝。

当前实现是正常 tick 对已到期建筑尝试至多一次续费，资金不足则停用，无累计欠款；本片**保留此已发布行为**。最初首片设计里的“明确恢复命令”不是当前代码事实，不在本片顺手改成另一个支付协议。升级期间仍按 L1 续费；缺费暂停升级工时并保留预留，可取消。no-optional-growth 恢复路径不续费，已付区间中的升级才可继续工作。

不可让升级 claims 阻止纯库存维护付款；维护只取 available，不能吃掉升级等任务的预留。容量拒绝不可把付款成功而升级失败的半个世界发布出去。

## 6. L2 生产与两种药的照护证明

### 6.1 生产记录的显式联合类型

保留原 production state、ID、receipts 和历史 job 形状。新增的 L2 `productiveSite` 必须同时是 placed、level2、真实 sourceJobId、真实 firstMaintenanceCalendarTick 和 `upgradeJobId`。旧 L1/legacy 形状不新增占位 null 或 version 字段。

- 原 L1 记录继续用原 shape；其历史时点必须尚未完成升级，不能因当前 L2 就失效
- L2 制基础药的 gate 仍为基础药理；L2 替代方的 gate 为药性配伍。不能强迫旧基础药 gate 改成新研究
- 两种 L2 药 job 都必须绑定同一 building 的真实升级完成，start 两时钟不早于完成，生产全过程避开活跃升级区间
- L1→L2 start 会拒绝该建筑全部未终态生产，包括送货途中，避免升级改变未提交 job 的产品前置条件
- 替代方只有正确 `recipeId`、真实 L2、正确 gate、原料预留、200 工时、真实送仓才产一份伤药；不接受把其他 recipe 改名或用 outputs 相似推断真实性
- 完工/交付重新检查固定 recipe、level provenance、gate、该任务实际工作时段的 paid ranges 与 owner，保留原现时准入规则。仓满仍可取消，不先扣原料或丢产出
- 成本已在目录中，原六资源不扩枚举，sect stock 三资源及 99 容量不改

### 6.2 护理不增加另一份药物账本

`SectCareJob`、doseProductionJobId、previousCancelledCareId 与减伤 primitive 均保留。v10 独有 `deliveredPowderJobsV10` 只允许两个 exact IDs：

1. `craft.wound-powder.v9`
2. `craft.wound-powder-alt.v9`

在完整生产/研究/升级/维护验证**之后**，只选 terminal completed、有真实 deliveryVisit、terminal tick≤care start、唯一 outputs 精确为 wound-powder1 的 job，按 `(terminal.tick, transactionId)` 稳定排序。不得接受“凡是输出伤药都可用”。选最早尚未被有效使用的物理 dose；取消链可重用，任何 active/completed care 已占用的不可再选。

两种药共用相同库存与消费价格，无独立“替代药库存”；同一 output 只能消费一次。跨两配方先后剂量、取消后重用、死亡/休养释放、读档后重试都需真实来源用例。患者资格、到仓、40 有效刻、伤势25→5/5→0、效果修订闭合和突破风险查询维持旧强度；迁移本身不改变伤势。旧 `.3` care validator 仍只能接受其原来的基础配方，不放宽它。

## 7. 验证组合：可复用实现，不借旧根身份

### 7.1 固定版本入口

`parseSaveV9`、`admitSaveWorldV9`、`inspectUnregisteredWorldV9Records`、`.3` identity/content fingerprint、旧 local standalone validators 保持原可接受集合。不得接受可选 protocol、传入 validator、信任 bool、泛型 callback、caller certificate，或临时更改 world version 后调用旧 validator。

允许集成负责人做**无旧语义变化**的窄共享 leaf 抽取：版本 wrapper 私有绑定固定 policy，并用旧 golden/negative suites 锁住旧行为。v10 组合必须验证真实完整所有权，不能删 upgrade/care reservations、隐藏 L2 payment、把 level2 降成1 或构造 fake v9 World 让旧校验通过。类型 `Omit` 只是声明共享字段，不是运行时擦除字段的许可。

### 7.2 验证顺序及避免循环

建议固定以下有向依赖，所有结果都在最终 owner closure 前不得作为 admission：

1. bounded capture、精确 v10 root/envelope/sect shape、旧共享基本数值、RNG、ID、地图、人员、archive/reader 与 ledger arithmetic
2. 新 root 专属生命周期/clock validation，永久构筑固定旧内容上下文； mint v10 lifecycle evidence，再造只供历史人物引用的 source。不能给 v10 偷用 `.3` lifecycle token
3. 真实不可变 L1 construction，以及 library 的所有 L1 维护（library 从不升级），研究的结构/费用/真实完成 DAG 和 library paid-work
4. 丹房 L1 maintenance 记录及 upgrade 结构/来源/chronology：先认证 L1 付款、不依据未经认证 L2 completion 给其收费权限
5. 真实 upgrade：已认证研究、L1 periods、访问/work/checkpoints/terminal/receipts。此时才产生 L2 completion authority
6. L2 maintenance：引用已认证完成；随后所有新旧生产的 paid-work、gate、历史有效等级、delivery/settlement
7. care：两 exact recipe 的真实剂量、消费/取消、效果与培养时钟来源
8. **六所有者** exact closure：construction、production、research、maintenance、care、upgrade；每 paired reservation 恰有一个 owner，每 owner 恰有一份对应 reservation，反向引用、ID 与命令全局唯一
9. 本时刻 shared claims、全体工作≤36、旧生产+培养 reservation 全额与 base.reserved 对齐、sect 余额全历史 provenance、取消/终局所有容量维度

没有 maintenance↔upgrade 的验证环：升级工作只使用目标的 L1 付款时期，L2 付款严格在升级完成之后。所有结构相符但缺工作/付款/历史链的伪完成最终拒绝。现有 research validators 如将结构/paid 检查混合，需要窄 leaf 抽取，由固定 root 按上述顺序调用；不复制旧 validator 后逐项删检查。

### 7.3 必须拒绝的代表反例

- 原 .3 根夹带 upgrade、schema2、L2 proof、L2 payment、替代方伪来源；新 envelope 包旧内容/旧 envelope 包新内容
- 直接改 ConstructionBuilding.level=2、伪造完成 job、一个 building 两完成、完成后再开 L1→L2、取消变成完成
- research ref 指向不同研究/取消/未来完成/不符建筑效果；新 recipe 借基础药理解锁
- 少扣一份成本、把剩余预留算 owned、检查点早一刻/双扣/乱序、400 未终态、已完成退款
- 工人/seat/entrance 双占、原生产送货途中开始升级、待决死亡本刻完成、归档者保持活跃工作
- L2 费率重算旧维护、完成同刻提前收 L2、重置到期免维护、没 rate 的完成后付款
- L2 base medicine 历史 gate 被错误替换；alt 输出伪造；两药共用一个 dose；不同 recipe 输出伤药但不在 exact allowlist
- 稀疏/巨大数组、getter/Proxy 异常、危险字段、超安全整数、最后回执/编号/解码节点或字节差一

## 8. 端口与界面界限

新类型文件冻结了领域 reducer/validator/claim/query 的方法签名。`applyValidated...`、`tickValidated...` 只是内部准备候选；返回 frame 不等于发布 World。外部固定 root dispatch 必须完整认证前后，容量不通过时返回原 source。

`sectBuildingLevelAtV10` 的 phase 只有 maintenance / after-upgrade；`sectBuildingStatusV10` 返回有效等级、source、active upgrade、paid/operational、继承 due、下次真实费用与缺口。`previewSectUpgradeV10` 返回成本、半耗、工时、研究引用、revision/tick 和拒绝原因，不能当作授权或预留。UI 发最小 command，内核重新检查所有条件。

后续有限查询应加 upgrade revision/jobs/building effective-level；不在每次渲染导出整个历史。确认面板需清楚显示“400 有效刻，先取材到场；200 刻耗3石3板；取消只退剩余；升级中停产；下一维护日期不延长”。L1→L2、研究完成、送药、减伤皆显示真实状态，不能用动画完成替代提交。

保留老 `.3` 入口和 v9 DB 的继续游玩能力。v10 的独立入口/明确“复制并升级存档”流程通过浏览器验收前，不切换 management.html 的默认加载，不把现有按钮无提示指向新格式。新版本的继续/导入/迁移应可区分；没有发生转换就不能显示“已升级”。

## 9. 安静边界纯迁移与原字节保全

### 9.1 只有真实 `.3` 源

`prepareV9ToV10Migration(sourceText, metadata)` 先调用**原样的完整 parseSaveV9**，得到 fully funded、supported 的旧 .3；不能先 JSON spread 改版本、剪字段或只跑结构校验。原校验失败、recovery-only 或 unsupported continuation，转换拒绝，原文本保留。只读恢复档不转换写入；只读权限由 controller 检查，不伪装成 pure World 属性。

安静边界的精确定义：

- 管理模式，无 active expedition/campaign/battle/travel（原 .3 本就严格为空）
- pendingCommands 空；旧 activeProductionTransactionIds、automatic live 全空；sect construction/production/research/care 无 terminal=null
- 无 planned blueprint，避免新增预留/取消义务被悄悄带入尚未证明的转换
- sectEconomy.enabled=false；保留计划、decision counters、activationReviewRequired 的既有值，不替用户切换或重置
- 无活跃 breakthrough（Reserved/InSeclusion/DecisionReady）、任何 teaching、activityOwner/build lock；无 pending deaths、未结 estate 或活着对象的待归档死亡状态
- 无 dangling station/worker claims；库存 reserved 的旧校验闭合；正常终态历史、已完研究/建筑/药品/照护/培养/构筑一律保留
- 不强制“维护尚未到期”，也不预付/重置到期；过期但安静的建筑按新运行时正常逻辑续费
- 合法 player/hidden pause 与 speed 原样保留；纯迁移不推进一刻，也不生成失败/迁移事件

不满足则返回每项 path/原因及正常结束/取消的可见指引；不自动取消/删除工作或清空未开工图纸以满足边界。

拒绝后的具体路径：ACTIVE_WORK 列出真实任务/工人，提供继续旧版等待完成或原版正常取消；PLANNED_BLUEPRINT 定位原图纸并由用户正常取消；AUTOMATIC_WORK_ENABLED 指向旧版暂停自动安排，随后等已有工作结束（暂停不会替用户取消）；ACTIVE_PROGRESSION/PENDING_LIFECYCLE 指向原版闭关/教学/寿尽决定，不替用户选风险结果；READ_ONLY_SOURCE 要先恢复正常可写来源或保留导出，不能转换写覆盖恢复档；CAPACITY_EXCEEDED 保留原档与导出能力，报告超出维度，不能建议删不可恢复历史或无意义地反复重试。重新检查只在来源确有变化后进行，不靠经过时间视为条件已满足。

### 9.2 允许的纯 World 差异清单

1. `simulationVersion`、`runtimeProtocol`、`contentVersion`、**World** contentIdentity 换成新精确值
2. sectExpansion.schemaVersion 从1变2
3. 添加上文空 upgrade 域

除此之外，所有旧值（包括对象字段存在性/数组顺序）canonical data equality 必须成立；builds 全对象尤其不能换 identity。clock、RNG 每流 state/draws、World/local sequences、所有 revision、人物位置/伤势、cultivationClock、资源、导航、archive/receipts、completed history、maintenance 到期均不变。新 root 完整验证及全部未来 headroom 通过后才返回候选。新 fresh v10 可从严格 fresh .3 构造结果走同一个纯提升；不能重运行开局去替代已有档。

纯返回的 sourceText 为原字符串，包括空白/key order；sourceChecksum 为旧 envelope checksum，仅用于诊断，不是密码学或授权证明。metadata 只影响新 envelope 的 buildId/savedAt；新 checksum 正常重算。

### 9.3 独立目标存储的精确顺序

新路由 `management-v10` 只读写10；旧 `management-v9` 仍只接受9。新库名 `shanmen-changming-v10-management-saves`；旧 `shanmen-changming-v9-management-saves` 不变、不切指针、不 prune、不覆写。此次复制转换只允许**空的 v10 目标槽**，已有目标拒绝或另选空槽；覆盖转换另列未来授权/验收。

为源文件也保证持久备份，新 v10 库使用其独立建库配置：保留 snapshots/manifests/leases 三类职责，另加 `migrationSources` store。这是新数据库的 schema1，不改变任何旧数据库版本/三 store 形状；实现者需按现有真实 store 名绑定，不能借这里的职责名猜旧 keyPath。

`migrationSources` 是专门只追加的 source records，**不放进 active/retained snapshot generations**（否则 v10 写保护会正确拒绝其中的 v9 文本）。record 精确字段：`recordVersion:1, id, targetSlotId, sourceText`。id=`v9-source:<targetSlotId>:1`；只对空目标槽 revision1 使用。相同 id 仅在原字节完全相同时幂等，否则冲突；不依赖八位 hash 避免碰撞。备份记录不参与自动代际 prune。

转换 coordinator 的顺序：

1. 捕获当前源文本/源会话 epoch/worldRevision、只读状态，hold 原会话；无最新原文时先按旧 codec 取得用户当前真实边界，不能静默用更早的磁盘档覆盖未保存进度
2. 纯完整旧验证 + 安静边界 + v10 全验证/headroom，准备可用新 Session replacement；此时不换 live World
3. 检查目标确为空、获得目标 writer lease/fence；在新库 add exact source backup
4. 从存储读回 backup，逐字符比较 sourceText，并用原 parseSaveV9 再验证；不相符立即中止，原 live 和两个 current pointers 不变
5. add 新 v10 generation；从存储读回并通过固定 parseSaveV10/完整准入，检查它精确等于已准备候选
6. 同一目标 commit transaction 中再次核对 backup 存在且原文相等、lease epoch、空槽/expected revision、readback candidate，然后原子写 manifest/current pointer；原 source backup 不删除
7. 确认 durable commit 后，以已准备 token 一次绑定新 Session；再释放旧 hold/lease。不要在磁盘提交后重做可能失败的 cold preparation

若步骤3–5失败，可留下无指针的 backup/未绑定 generation，但不声称转换完成；原 `.3` 档可正常继续。事务 abort、配额、故障、读回损坏、lease失效、会话变化/关闭都不得自动重试覆盖。不在两数据库之间声称不存在的全局原子事务。若 durable target commit 已成功但 UI 绑定未完成，报告“新槽已保存、会话未切换”，可明确从目标加载；不能假称已回滚已提交存储。保留源可供旧版继续不等于 v10 后续进度可以向下迁移。

内存模式可以纯预览/导出，但没有持久 backup/readback 就不得显示“存储转换成功”。用户现有两份经营档必须在真实浏览器验收中先读其原文/摘要并确认没有覆写，测试优先用空槽/独立测试库。

## 10. 容量证据与停止条件

旧 `.3` current-fit、v8 exit certificate、原 five-owner peaks 均不是六域 v10 证书。`assessManagementCapacityV10` 必须量**完整新八字段 envelope** 的真实 canonical UTF-8，包括10/0.10.0/新身份、schema2、upgrade、L2 proof/rate 字段。

新增 `SectUpgradeObligationV10` 以具体 typed persisted records 构造三个互斥分支：

- live peak：最长合法 IDs、最大坐标与数字宽度、全部400 spans/401 visits/2 checkpoints、navigation path 上界、实际 consumed/remaining/blocked字段及worker position/traveling
- completion：同一个 job 成为完成 + 同一 paired claim 两checkpoint/committed；不增建筑、receipt、World event 或 ID
- cancellation：保留实际 work evidence + consumed/released最大宽度 + released paired claim + **一条预留 cancel receipt**，包括系统死亡 command ID 的最大长度

按整个分支的 bytes/decodedCharacters/decodedNodes 各自取 max，不把 completion+cancellation 相加。当前 job/claim 已计量的部分只能收 replacement delta；插入 receipt 计分隔符。路径空间/reader节点用真实地图界，不复制N格昂贵夹具。现场访问/ledger证据/node descriptors 的本地上界须独立推导；不能复用旧 descriptor 常量而漏算新对象。

每成功 start 已分配 job+claim，另预留一条 cancel receipt、一份取消 revision、终态/最大未来有限工作证据；`receipts.length + liveUpgrades <= 256`。start 必须保住其他所有者的取消资源，拒绝不花最后的槽位。完成/取消不再要 nextId/navVersion/entity/event。每个实际tick/命令再检查全部数值宽度、revision、clock、归档行、旧/新domain行、paired claims、decoded chars/nodes、培养时钟8192行、遗产目的地、4MiB及既有finite teaching/progression obligations。

旧永久构筑容量查询绑定 pinned build context；升级工人加入有限授课/生命周期占用及恢复判定。容量恢复只承认真实 exact terminal/ledger/receipt discharge。删除 owner、重写phase、伪造cancel日志不代表释放义务。正常候选失败时仅从同一个未改 source 尝试无可选新开工/无续费候选，仍需完整v10验证；不可用半个 normal candidate 作 fallback。

停止边界：

- 新 start 无 complete/current+reserved headroom：原世界不变，明确拒绝
- 已开始工作遇材料以外的路径/入口/维护阻塞：保留工作/预留并可取消；没有无限等到成功的保证
- 无可合法发布的下一刻/取消、记录或counter尽头：保留最后完整可导出边界，锁存 stopped；速度/查询/重复命令不能解除 stopped
- 因新有限教学/生命周期组合尚未证明：UNSUPPORTED_CONTINUATION/UNSUPPORTED_SCOPE，不降级成旧格式，不删除记录
- 本地128/256/384上限或whole-save上限耗尽：功能有界停止；本片不声称无限经营或归档压缩已解决

必须公开区分“当前可保存”“已承诺的立即取消/有限记录峰值足够”“无阻塞真实流程已跑完”。不承诺任意等待/任意未来操作后的必然完工。已接受任务的真实取消路线及停止时可保存性是必须实测的最低保证。

## 11. 分期所有权与集成文件图

### A. 合同（本次，已写文件，未执行验证）

- 仅 `src/core/sect-expansion/upgrade-types.ts`、本文
- 不改内容、旧源码、测试、路由、入口或数据库；没有跑 Git/test/build/browser

### B. 升级领域负责人

- 新 `src/core/sect-expansion/{upgrade-runtime,upgrade-validation,upgrade-queries}.ts`
- 新 `tests/sect-expansion/upgrade-*.test.ts`（集成者按实际目录约定落位）
- 消费冻结类型/现有两账本与导航；交付真实 L1+药性配伍→升级、199/200/399/400边界、取消与占用反例
- 不编辑根validator、旧contract、kernel、平台或公用测试脚本

### C. L2 消费证明负责人

- 新 `src/core/sect-expansion/{maintenance-v10,production-v10,care-v10,research-consumer-gates-v10}.ts` 及专项测试
- 固定历史级别 paid queries、两种 exact recipe dose source；与B交换最小 completion事实查询
- 如需抽现有私有 leaf，列出精确需要的入口交给集成者，不擅自改旧validator

### D. 根/版本/容量集成负责人（共享文件唯一修改者）

- 新 `src/content/sect-v10/world-content.ts`；新 `src/core/world/{v10-types,create-world-v10,v10-sect-bridge,v10-lifecycle-records,v10-cultivation-clock-bridge,v10-record-headroom,management-capacity-v10,runtime-capacity-v10,runtime-instance-v10,save-admission-v10}.ts`
- 新 `src/core/kernel/{contracts-v10,commands-v10,simulation-v10,validation-v10,save-v10,migrate-v9-to-v10}.ts`；新 `src/core/save-budget/sect-obligations-v10.ts`
- 这些名称是适配边界，不要求整文件复制。优先抽狭窄共享记录/时钟/生命周期/运行实例组合，保留v9 wrapper的固定binding；禁止把simulation-v9/validation整份复制然后删约束
- 共享接线：`kernel/validation.ts`、`world/v9-*`、history identity source、runtime私有所有权、`save-budget/envelope.ts`、通用生产/培养生命周期的窄leaf。每次抽取先证明旧行为相同
- 本阶段先headless，不自动改UI/default entry。root、local domain和capacity联合通过后才让平台接收10

### E. 存档与 Session 负责人

- 新 `application/session-v10.ts`、`application/management-v10-save-controller.ts`、v10 persistence迁移coordinator/新库store配置与专项测试
- 集成者串行编辑 `platform/save-codec.ts`、`platform/persistence/*` correlated unions、新route、unknown-version protection
- 旧v9 route/DB/engine保持可用。新Session只绑定v10，转换准备不修改旧Session。完整 v9 原源与真实历史 migration cases 冻结作为fixtures
- 旧测试把10当unknown的case改为真正未知值（如11/999）时，必须同时增加10正确路由/错误身份拒绝；不能仅改期望让测试通过

### F. 查询/UI/浏览器与发布负责人

- 新/固定版本的 runtime-view/session projection 与 `application/management-v10-contract.ts`；经营面板研究选择/升级/替代方/护理来源提示，稳定i18n keys
- old management入口保留；新有限v10入口及显式复制转换面板由集成者统一接线，禁止UI直接改World
- 浏览器操作和截图覆盖真实闭环、手动存/刷新/读取、转换原文备份、失败保留、窄屏/缩放/键盘/重复确认/Back-Cancel
- 全量检查只能由集成负责人串行执行。发布前冻结精确树并跑类型、边界、文案、内容、相关测试、完整check、默认/启用构建；再验真实交互。仅有合同或passing focused tests不标功能完成

## 12. 最低验收证据清单

1. 真实旧 .3 带构筑研习/装备/突破历史、已完药理/丹房/药品/护理、研究材料、维护付款；纯迁移只出现允许差异，旧raw bytes完全保留，未来新增build command仍正常
2. 所有quiet拒绝逐项覆盖：活动旧/新工作、planned blueprint、自动启用、教学/突破/待死/estate、坏checksum/内容/version、只读恢复、无容量；输入不变
3. 真实药性配伍400tick；升级实际取材/到场400worktick；checkpoint前后保存/恢复逐刻等价，取消只退剩余；L1 origin完全不变
4. 已升级后的原基础药仍可生产；grain=0时真实alt5草2木→1伤药，库满等待/取消；两个 exact source混用的照护、自然痊愈/死亡与重复点击
5. 完成比due早1刻、相同刻、晚1刻；L1付款保留到期、不追收、不重置；L2下一次真实付款，缺款停产/升级暂停/取消
6. 每个claims交叉冲突、同刻死亡与400工作冲突、active送货与升级冲突、取消后工人不传送、无重复building/seat
7. 真实保存容量exact-fit/one-over、最大新记录width、cancel/forced-death终止余量、last IDs/revisions/clock、所有root hostile-input与旧v9negative cases
8. source backup/target generation/readback/pointer各阶段fault与quota/lease/cancel/close；完整提交后UI失败与提交前abort的结果明确区分
9. 从同seed/同源迁移边界运行直跑、分段save/reload、暂停恢复到同tick，hash/每域历史一致；语言/速度/视图查询不改变RNG或domain identity
10. 浏览器保留原两档并完成新空槽转换，刷新仍可继续新档，旧版仍能读原档；一项不满足就保持新版本候选状态

## 核对依据与当前限制

已读取仓库 AGENTS/README、最新 development-status、DD-01/02/10、原首片、v9 save/route/capacity/runtime 文档，以及当前 .3 root/codec/bridge、construction、research gate、production、maintenance、care、build/lifecycle、descriptor/obligation代码。仓库没有检索到可用的 repo-local skill 文件。

设计刻意保留当前有限候选的边界：旧 .3 identities 和所有旧验证器不改义，研究目录/成本不改，出征仍关闭。本文及类型文件尚未通过编译或执行测试；本轮职责禁止test/build/Git/browser，应由集成负责人执行并记录实际结果。本合同不证明长期性能，也不是v10已实现、已可导入或已发布的声明。

## 集成核对补记

2026-10-02 18:20 UTC：集成负责人完成本合同与新类型的双类型检查，结果通过。仅证实声明可编译，不代表升级、迁移、容量、UI或运行时已实现；阶段B的独立升级领域随后开始实施。
