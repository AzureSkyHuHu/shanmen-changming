# v10 共享宗门结构容量叶层

日期：2026-10-02。范围：内部结构计量提取与六类 owner 的固定合成；不是完整 v10 容量准入。

## 本片接口与旧行为

- `save-budget/sect-obligations-v9.ts` 新增 `SectRecordObligationSource` 和 `deriveSectRecordObligations(source)`。它们描述并计算已有五类 owner：未开工图纸、施工、生产、研究、护理
- 结构叶层不含 World 版本判断，不接受 policy、可信标志、调用方计量值、证书或验证回调。固定调用者必须先完成描述符检查和版本判断；结构错误由叶层抛出，包装层处理
- `deriveSectReservationsV9(world)` 的签名、返回字段、旧 excluded 文案、错误处理与接受范围不变。执行顺序仍为：完整数据描述符计量 → `0.9.0` / `fresh-management-v9-unregistered.3` / construction catalog 精确判断 → 地图界限 → 各 owner → 共享字段与有限数值检查
- 旧包装层仍是结构计量，不补加新的完整 World 检验条件。其原来未验证的 root contentVersion/contentIdentity 等字段，不因本次提取被偷偷改成新的拒绝条件
- 新内部入口为 `save-budget/sect-obligations-v10.ts` 的 `deriveSectReservationsV10(actualWorld)`。它先计量实际 World 的数据描述符，再核对冻结 v10 simulation/runtime/content 身份、四字段 contentIdentity、宗门 schema2、construction schema1/catalog、upgrade schema1/protocol/catalog

没有更改 save-budget barrel、旧 kernel、运行时、codec、Session、页面、数据库或发布入口。

## 使用真实记录而非旧版本伪装

新包装层把同一个完整 `WorldStateV10` 直接交给结构五-owner 叶层与 `deriveSectUpgradeObligationsV10`，不构造伪 v9 World，不删除升级域，不筛选共享 reservation book。类型只拓宽生产记录为 `SectProductionJob | SectProductionJobV10`；原施工、研究、护理和账本算法不变。

生产 live/completion/cancellation witness 都从实际 `...job`、`...peak` 展开。`productiveSite` 的 `level: 2`、`upgradeJobId`、建造来源与首期维护字段，以及该 recipe 自己的 `researchGate`，完整保留。不会把基本伤药 gate 强制换成药性配伍，也不会把 L2 重建成 L1 再计量。数量和工时继续来自固定目录：基本药为草药3/粮1、160有效刻；替代药为草药5/木2、200有效刻。

World 的完整库存、sect stock、地图 navVersion、时钟、各域 revision/nextId 和实际 worker position/traveling 仍参与原共享字段/owner 的 replacement delta。终态 jobs、claims、receipts 留在源中；不是可回收容量。upgrade 叶层仍看见整本 reservation book，因此其现有384行诊断不会因投影而被绕过。

## 合成结果与精确加法

结果分别公开本次内部派生的 `existing`、`upgrade`，以及仅由这两个结果生成的六类 `owners`。upgrade owner 添加固定 `kind: 'upgrade'`、实际 job ID 和 worker ID；不收回或信任调用者给出的 owner 列表。

对 bytes、decodedCharacters、decodedNodes 分别有：

```text
totals = existing.totals + upgrade.totals
shared = existing.shared + upgrade.shared        （仅诊断小计）
totals = sum(六类 owners) + shared
```

`upgrade.totals` 已经含 upgrade revision 的 shared digit-width growth，因此不能再把 `upgrade.shared` 加一次。`shared` 也不能在 totals 外重收。各 owner 仍在完整互斥 live/completion/cancellation 分支之间逐 metric 取最大值，不把完成和取消相加。路径界限按真实地图大小分析计算，不展开整个最大路径。

合并 rows 保留旧键，增加 `upgradeJobs`（当前义务为0）、`upgradeReceipts`。合并 counters 保留旧键，增加 `upgradeRevisions`、`upgradeNextId`（当前义务为0）。升级不重复预留 start、paired claim、建筑、navVersion 或 World ID/event/receipt。所有 metric 合并先核对非负安全整数与加法溢出。

任意结构异常或本地 upgrade `supported:false` 使组合 `supported:false`，组合 owners/总量清零并报告原因；已计算的 leaf 诊断保留供检查。新包装层不会读取捕获异常的 `.message`。旧包装层的历史异常行为保持原样。

## 明确不证明的事项

返回 `admitted:false`、`importAuthorized:false`、`eventualCompletionSupported:false`。`supported:true` 只说明这些结构义务可计算：它不表示 root-valid、当前能保存、完整容量充足或一定完工。

本片没有完整新八字段 envelope 的 current bytes、4MiB判断、reader/headroom组合、培养/授课/寿尽续行、跨域来源/worker closure 或 exact terminal discharge。已有 upgrade 的本地 `headroom` 原样显示，例如384 claims或取消回执不足可以使该本地 `fits:false`；不得把结构 `supported:true` 当成这些限制通过。下一片再独立实现完整 v10 的容量、准入与释放证明。

typed witness 内的独立最大字段可能无法同时到达，故明确只是合成尺寸上界。它们不是合法游戏记录、已付款证明、L2解锁或任何运行权限。描述符计量拒绝普通getter/环/稀疏数组等；没有承诺识别所有 hostile Proxy、原子捕获或替代完整有界 reader。

## 测试与验证责任

新增 `tests/save-budget/sect-obligations-v10.test.ts`，包括：

1. 旧包装层的返回形状、旧接受面和 descriptor → identity → map → owner 错误顺序；v10类型也不能传给旧固定签名
2. 明确预置 BASE 资金的孤立领域链：真实建藏经阁、采灵/整理、两项研究、建丹房、L1→L2，再分别开工/完工/取消两种伤药。每步使用真实领域 reducer/validator；合成完整 World carrier 仅供本叶层计量，不声称通过 root 或迁移
3. 在记录计量调用上观察真实 L2 job 的 live/completion/cancellation witness，断言完整 productiveSite/researchGate 保留，目录工时/成本/产出正确；不为测试修改旧返回字段
4. 明确不可能作为游戏保存的六-owner压力组合，验证各 metric 最大分支、总量、全部 rows/counters和 shared只收一次
5. 完整共享账本384/385行可见性、终态历史保留、实时 stock/inventory/worker/clock/revision 重测、本地升级 unsupported 向组合关闭传播
6. 新身份字段、catalog/schema/protocol严格拒绝，以及 getter/Proxy异常/稀疏/环/非JSON 不被静默过滤

原 `tests/save-budget/sect-obligations-v9.test.ts` 与 upgrade 叶层测试保持不改。

2026-10-02 20:00 UTC，集成负责人在唯一执行 lane 回报：

- `tsconfig.json` 与 `tsconfig.core.json` 两项类型检查通过
- 新旧宗门义务、upgrade 义务、旧 v9 management capacity 与新 candidate，共5个测试文件、76项测试通过，耗时119.46秒
- 该组运行包含本片旧固定包装层的接受面、错误顺序和结果形状回归；本片没有借此声称完整 v10 容量准入通过

本片编写者没有另行运行检查、构建、Git或浏览器。本记录只覆盖上述定向检查，不代表全库检查、生产构建、浏览器或完整游戏验收。后续完整容量合成另行验证；共享时钟提取与独立构筑义务的后续工作不因本片结果自动视为通过。
