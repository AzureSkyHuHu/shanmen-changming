# v10 固定有界运行时视图叶

日期：2026-10-02。状态：内部查询叶及专项测试已编写，等待集成负责人串行验证；本文件不声称 Session、UI、存档路由、浏览器或发布已经完成。

## 所有权与入口

`runtime-views-v10.ts` 只消费私有 owner 已完整认证并持有的 `WorldStateV10`，不接受外部 World、验证回调、任意价格、等级或研究令牌。它不重新调用旧 v9 整帧验证，不把 v10 World 强转成 v9，也不修改 construction 的永久 L1 origin。

固定入口为 frame、cultivation、build、expansion、placement、breakthrough、upgrade preview 和 next application command。对应导出以 `projectRuntime…V10` 命名；输入形状校验以 `validRuntime…V10` 命名。升级查询只接受 `{ buildingId, workerId }`，预览标记 `scope: 'upgrade-start-conditions'`。局部条件通过不表示完整候选的容量或续行已获准。

owner 接线必须在任何输入反射前设置重入保护，先检查关闭状态，以有界描述符复制取得查询参数，再调用形状 guard；不信任 getter、Proxy、调用者冻结或额外字段。叶返回新建的有界数据，owner 再冻结并按固定槽位缓存，不能把这些数据当成 command 或 save 的权威输入。此阶段没有修改 owner、Session 或公开 barrel。

## 版本与不变语义

- frame 精确报告 `0.10.0` 和真实 v10 World 内容身份
- 永久构筑通过 `managementV10BuildContext` 绑定原 `.3` 构筑身份，不替换构筑历史的 identity
- cultivation、breakthrough 和 work owners 使用包含 upgrade 的真实 v10 占用集合；不让升级工人同时呈现为空闲
- placement 只复用类型及语义未变的 L1 几何/研究结构叶，不传旧 production 或旧整帧验证
- 所有预览不分配 ID、不预留/扣材料、不推进时钟/RNG、不写研究或等级

## 有效等级、维护与配方

expansion 新增 upgrade 修订和真实升级任务/终态。building 的 `level` 来自真实完成升级记录，`levelEvidence` 只包含建造/升级来源 ID。没有伪造 `construction.buildings[*].level = 2`。

维护视图区分：

1. 当前有效等级与 active upgrade
2. 当前是否已付款、当前期间的原始 level/payment/upgrade 来源
3. 下次维护的固定成本、库存缺额及历史/ID/时钟限制

因此，已完成 L2 的丹房仍可能处于真实 L1 付费期间；直到下一次付款才记录 L2 的木 2、草药 1。升级不会重置/赠送维护期限。已付款但正在升级的建筑仍显示 `paid: true, operational: false`。

固定五种配方从冻结目录取得 inputs/outputs/work ticks。替代伤药只显示真实药性配伍 gate 和真实 L2 场所来源；基础伤药可引用 L1 或 L2。recipe 视图的 scope 为 `catalog-and-authenticated-sites`，payment、席位 busy 和 research satisfaction 分开呈现，不伪装成派工/路径/容量准入。

生产任务展示 compact site source；照护任务及最近终态展示实际 consumed dose 对应的生产 ID、精确配方及场所来源。升级开始预览直接复用固定 v10 start 条件，包括真实 L1、药性配伍、石 6/木板 6、400 有效刻，以及包括已释放席位后送仓阶段在内的全部生产生命周期占用。

## 输出与搜索上界

固定上界包括 36 人、36 活动任务、200 物件、65536 地图格、16 planned/52 visible 蓝图、5 最近事件、8 最近终态、2 完成研究、5 配方、64 授课知识选择和每人最多512装备选择。最近终态在遍历时只保留8项，历史不会变成展示数组。地图/人物/库存只选定字段，不携带完整 ledger、receipts、payments、history、RNG、工作 spans/visits 或归档人物。

应用命令 ID 采用精确 `app-command.N` 查询，避开 pending、World 当前/归档回执和 construction/production/research/care/upgrade 五个本地命令域。搜索检查次数至多为已占据 ID 的保守计数加1；不解析不可信回执后缀，不猜测最大编号。最终安全整数保留给 Session 的后续游标，耗尽返回 null。该查询不分配或预占 ID。

有界 DTO 不等于恒定计算成本：历史来源 join、归档恢复、配方/维护查询、源完整准入仍有各自成本。本阶段不作36人、3倍速、移动端或长期性能承诺。

## 专项测试与待执行证据

`tests/sect-expansion/v10-runtime-views.test.ts` 编写了：

- 新鲜身份、固定字段、源只读、返回值隔离及 readonly 类型
- placement 不借用请求对象；拒绝 getter、继承、回调、额外价格/gate 和无效游标
- 真正写入的 World 当前/归档回执、巨长无关后缀、安全整数耗尽
- 真实旧 L1 历史 + 新药性配伍400刻 + 升级400有效刻，拒绝/活动/完成的视图
- L2 仍处原 L1 付费期、下一次真实 L2 维护、零粮替代伤药与送仓
- L1 药品已经释放席位但尚在送仓时，升级仍报告 busy
- 两种真实药品的照护来源、工人退休后保留已完成升级来源，且不泄漏归档树

实施者没有执行测试、构建、Git、浏览器或发布。类型检查和最终定向/回归结果由集成负责人补记；在实际执行前，上述条目只描述测试内容。

## Root verification —2026-10-02 22:05UTC

The final source passed both TypeScript configurations, boundary checking and default build. All real L2/maintenance/recipe/care/retirement cases passed;18/19 view tests passed in the last combined367.24s run. The sole remaining fixture expected a mutable source from the intentionally frozen admitted constructor. A cloneJson mutable-input fixture corrected that assumption; focused case passed (1passed/18skipped,2.00s). Earlier blanket ledger-name assertions were replaced by exact cost-row/path/domain checks with negative cases, retaining ledger/history/owner-evidence leakage exclusions. Independent read-only review found no blocker. Owner method integration and player UI/browser acceptance remain separate.

## 有界真实升级付款摘要补充（2026-10-02）

活动升级任务新增 `checkpoints`，最多2行，每行只含：

- `checkpointId`：实际记录的 `construction.half` 或 `construction.remainder`
- `activeTicks`：实际记录的200或400
- `tick`：该检查点实际提交的 simulation tick
- `consumed`：同一 job/reservation 的 base/sect 检查点实际消费资源行，最多11行，逐字段复制

没有依据当前进度补造检查点，也没有用 catalog 或 preview 的 `halfCosts`/`remainingCosts` 当作已经付款。199刻仍为空，200到399刻保留真实半程检查点；第400刻完成后任务退出活动列表，最近终态另行报告实际消耗。

仅 `recentTerminals` 中 `domain: 'upgrade'` 的条目新增 `consumed` 和 `released`，各最多11条资源行，直接复制真实 terminal evidence。其他领域不新增这两个字段。早于半程取消实际释放6石/6木板，半程后取消实际消费3石/3木板并释放剩余3石/3木板，完成则实际消费6石/6木板且释放为空。这些是此次结算记录，不是下一次操作的退款保证。

不导出 claim、reservation、账本对象、位置/访问/工作跨度或 terminal 的完整证明树。原8条最近终态上界不变。固定资源行中的 `ledger: 'base' | 'sect'` 是资源分类，测试仍拒绝对象型账本或其他路径的同名字段。

新增专项测试覆盖真实199/200/399/400边界、实际配对检查点行、局部2行上界、半程前/后取消与完成的真实结算、叶输出的嵌套隔离，以及现有 runtime owner 的冻结输出且不发生 World export。此次补充尚待集成负责人执行测试/类型检查；没有更改 parser、runtime owner 或任何领域权威。
