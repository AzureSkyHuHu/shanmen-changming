# 私有 v10 存储与 v9 原文复制事务

范围：内部平台持久化基础，不注册 `management-v10` 玩家路由，不绑定 Session，不修改旧 codec、数据库或当前页面。冻结边界见 [升级合同 9.3](v10-alchemy-upgrade-contract.md#93-独立目标存储的精确顺序)。

## 固定数据库及接口

`openManagementV10Repository` 只打开 `shanmen-changming-v10-management-saves` schema1，精确四个 store：

- `slots`，keyPath `slotId`
- `snapshots`，keyPath `id`
- `leases`，keyPath `slotId`
- `migrationSources`，keyPath `id`

没有数据库名、路由策略或 validator callback 配置。唯一注入点是 IndexedDB、租约时钟、同步故障注入器；不接受额外配置。旧 `shanmen-changming-v9-management-saves` 仍为原 schema1 / 三 store，不被这个模块打开、升级、切换指针或回收。未知数据库结构与记录形状明确拒绝并保留。

普通 `saveWorld` / `saveText` / `importSave` / `loadSlot` 都固定调用完整 `parseSaveV10`；不兼容文本不会重试旧 codec。保存保留三自动、一手动、一检查点；显式普通导入覆盖仍需已有租约和 revision。未知/不支持的 retained snapshot 阻止回收覆盖。坏 current 可读取完整验证的 fallback，但不修复指针，调用方必须维持只读恢复。原文 rescue 不等于有效 World。

回收/覆盖前另有独立的有界原文身份保护探针，检查外层版本、simulation/content 及 payload runtime/content 身份，不依赖完整 codec 的错误优先顺序。未来 saveVersion11 即使带额外字段或新 checksum 形状导致先返回 `INVALID_ENVELOPE`，也不能被当成普通坏档回收；current 与非 current 都保护。超出 4MiB 读取预算的原文保守保留。探针只会拒绝写入，不提供加载/准入或猜测迁移权限。

`migrationSources` 永不加入快照代际、永不被普通保存、覆盖导入或自动 rotation 回收。每条精确字段为 `recordVersion:1, id, targetSlotId, sourceText`，id 为 `v9-source:<targetSlotId>:1`。已有同 id 仅当整个原字符串逐字符相同时复用；checksum 相同也不能允许不同原文。未知版本、额外字段、错误目标或非字符串来源均拒绝。

租约使用独立 owner/epoch、过期时间及释放墓碑；新 epoch 使过期 token 永久失效。没有强制接管活跃 owner 的 API。时钟仅用于存储租约，不推进游戏。

## commitV9Copy 的准备与事务

参数仅 `sourceText, targetText, targetSlotId, ownerId, signal?`。方法先捕获这些值，避免外部参数对象在 await 后偷换来源。

事务开始前：

1. 独立用旧 `parseSaveV9` 完整接纳原文
2. 固定 `parseSaveV10` 完整接纳目标
3. 取已验证目标的 buildId/savedAt，再运行固定纯 `prepareV9ToV10Migration`
4. 比较纯返回完整 envelope 与目标 envelope 的 canonical data equality，拒绝无关但合法的 v10 档。允许 JSON 排版差别，但目标存储/读回始终比较提供的精确 `targetText`

在包含全部四个目标 store 的一个 `readwrite`、`durability: strict` 事务中：

1. 确认目标 manifest 不存在；不提供 overwrite 转换；获取非接管式 writer lease
2. add 精确原文备份，或只复用完全相同的已存备份
3. 读回备份、精确字符串比较、再次完整旧 parse
4. 用 add 写 revision1 手动 generation；相同 key 的 orphan 即使文本相同也不得覆盖
5. 读回 generation，核对精确记录字段/目标文本并完整 v10 parse
6. 指针写入前再次读取备份、generation、空 manifest，以及 lease owner/epoch/实际时钟过期；最后再次检查取消信号
7. add revision1/manual manifest/current pointer，等待整个事务 complete 才返回 `committed: true` 的 receipt

transaction body 只 await IndexedDB 请求；纯验证都是同步步骤，不 await 网络、Session 建立或外部工作。故障注入器 `before-pointer` 位于最终 reread 之前，排队的篡改/占用/租约丢失不能绕过检查。任一步故障、配额错误、请求 abort、读回不符或过期都会中止同一个目标事务，不自动重试。事务中已有的 backup/orphan 在失败时保留原始状态；本次新写入则一起回滚。

## coordinator 仍必须完成的职责

存储成功不是 Session 切换成功，也不证明来源是最新可写进度。调用前 coordinator 必须捕获/hold 原 Session、核对 epoch/worldRevision、只读状态与最新原文，准备完整可用 replacement，确保取消/关闭/源变化能通过 signal 阻止未提交操作。本模块不执行这些 UI/Session 权威步骤。

收到 durable receipt 后只能使用已准备 token 绑定一次，再释放旧 hold/lease；不能在磁盘提交后重新做可能失败的 cold preparation。若绑定失败，应明确报告“新槽已保存、会话未切换”，receipt 含目标 manifest/generation/lease，`loadSlot` 可明确从已保存目标加载。没有删除已提交目标的“回滚”API；即使取消信号恰在实际事务 complete 后出现，也不能把已有提交伪报为未写入。

只在目标库内承诺单事务原子性，绝不声称两个数据库间全局原子。源库保留可继续旧版，不代表 v10 后续进度可以降级回 v9。内存预览/导出未获得这个 durable receipt，不得显示持久转换成功。

## 测试与验证范围

新增 `management-v10-repository.test.ts` 与 `v9-v10-copy-transaction.test.ts`：固定库/精确 schema、跨版本拒绝、原文保存/重开、rotation/覆盖保留来源、writer epoch/过期/释放、revision 冲突、坏 current 恢复、retained 不兼容保护、orphan、所有提交故障点、各 add 写入配额失败、取消前/中/后、二次读回损坏/删除、伪造 lease、目标占用与真正双连接竞争、相同/不同备份、真实 FNV 校验和碰撞、Unicode/空白/key-order、参数捕获及新旧两个数据库隔离。

本说明写入时未运行测试/类型检查/构建；这些由集成负责人串行执行并记录。fake-indexeddb 验证事务语义和请求顺序，不能代替实际浏览器断电、硬件耐久性、配额、用户真实两份旧档保全或完整 Session/UI/发布验收。新玩家入口未激活。

## Integration verification —2026-10-02 22:03UTC

Both storage suites passed (78tests total in a four-file367.24s run;7 failures there were unrelated view/pipeline fixture assumptions). Both TypeScript configurations, boundaries and default build passed. Independent review found and then confirmed closure of a preservation hole: future version markers hidden by extra envelope fields/checksum shape now conservatively block ordinary pruning or overwrite before writes. New tests retain exact old records, and cover newer database versions and lease-write quota failure. The frozen returned-World fixture was corrected to assert refused mutation and unchanged reload; production isolation was not weakened.

These are fake-indexedDB transaction tests, not browser/storage/session migration acceptance. Source-session fencing, prepared-session binding and public route registration remain separate unfinished layers; old v9 database is untouched.
