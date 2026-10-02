# v9 私有 Session 适配

独立 `src/application/session-v9.ts` 已与经营 UI、窄渲染适配及专用存档控制器集成。检查结果、完整回归、发布状态和浏览器关口统一记录在[集成与实际验收](v9-management-integration.md)。本文说明 Session 接口、所有权和验证边界，不代表完整游戏验收。

既有 `ApplicationSession` 与 v7/v8 行为保持独立。`ApplicationSessionV9` 只直接使用私有运行实例，没有把 v9 转成旧 World、旧 Session、旧 BuildData 或旧 CommandResult；平台对 v9 的识别与旧存储路由隔离由专用存档层负责。

## 真正的私有所有权与固定视图

Session 使用 JavaScript 私有字段持有 `PrivateRuntimeInstanceV9`，不提供 World getter、任意 selector、调用方回调、trusted flag、可注入工厂或公开 owner。四个 UI 分支完全来自已有固定查询：`frame`、`cultivation`、`build`、`expansion`。选择输入只包含受支持的实体类型与 ID，或 null；显示采用只读、隔离、冻结的 DTO。

`getSnapshot()` 保持同一次发布的稳定身份，适配订阅式 UI。它包含四个 DTO、选择、Session/World 修订、epoch、实例 stamp、最后命令结果、停止原因、投影错误、临时 holds、paused 和 closed。没有保存历史、领域回执、随机流、全库存预约或完整权威树。空闲标量刻可复用未变培养/构筑 DTO。选中已完成蓝图或已归档人物会清空选择，不保留越界人物面板。

选择分为 `disciple`、旧 `building`、`blueprint` 和 `sect-building`，分别验证对应固定 DTO 中的 ID。Renderer 可把 Session 的 getSnapshot 结构子集 `{frame, expansion, selection, paused}` 作为输入，不需另外读取或转换 World。

如果真实操作已经提交，但后续固定视图读取失败，Session 保留整组旧 DTO，明确显示 `runtimeFailure` 并暂停。不会把新旧领域拼成一帧，也不假装回滚已提交的模拟。`refresh()` 只重试固定查询；成功后恢复一致缓存，不能清除核心锁存停止。

## 时间与暂停

- 只接受平台提供的时间戳，复用已有 `accumulateFrame`，每次最多 20 个固定刻
- 1 倍和 3 倍速度由同一累加器计算；达到 catch-up 预算后保留积压，不跳过模拟刻
- 背景/失焦、恢复、暂停、速度切换和替换重设基线，暂停期间的墙钟时间不会在返回后补算；保留暂停前未满一刻的余量
- 真正加载丢弃旧累加器和基线，按当前前台状态清理/恢复 hidden，并设置 player 暂停
- 只开放 speed、player 和 hidden 控制。领域 danger/choice/error/cultivation/save-capacity 等暂停不能由 UI 控制删除，runtime 的 capacity/unsupported-continuation/invalid-records 停止也不能由它们解除
- player/hidden 字符串若会超出真实容量，使用 Session 内临时 hold；原 World 与可导出字节不变
- storage-readonly、storage-busy、overlay、review 始终只属于 Session，不写入 World 或存档。review 仅允许确认其仍有效的私有已发预览；普通命令仍被阻止

这只是计时正确性，不是 20Hz、3 倍速、36 人、150 年或移动浏览器性能保证。

## 类型化命令与预览

命令端口只包含已有基础生产/取消/清理、玩家修炼、永久构筑，以及实际 construction/production/research/care 四域命令。不存在远征、战斗、战役或新自动配方开工的公开方法。Session 为外层和适用的内层命令分配同一 ID，使用私有实例 `nextApplicationCommand` 跳过当前/归档 World 回执及四域独立回执；不解析不可信数字后缀。

`SessionCommandResultV9.ok` 表示收到正常类型化领域结果，实际接受/拒绝以 `result.status` 判断。完整 `CapacityLimitedResultV9` 原样保留，包括 `sectResult`、`SECT_EXPANSION_REJECTED`、`UNSUPPORTED_CONTINUATION`、旧领域细分拒绝，以及独立 `runtime-failure`。没有把失败压成布尔值或丢掉 v9 判别字段。

请求先做描述符数据复制，再检查精确端口形状；不调用 getter，不允许外部 commandId，不从额外字段获得权限。进入重入保护后才反射输入。UI 订阅异常被包含，不能造成半次替换或阻止后续订阅者。

突破与放置预览来自真实固定查询。提案是 Session 自己签发的冻结对象；通过私有弱集合身份、epoch 和运行时 stamp 校验。复制、伪造、其他 Session、旧世界、真正命令/刻/clock 发布后的旧提案均不能确认。选择与纯临时 review hold 不会使未变世界的提案失效。放置仍明确是 geometry/research 范围的建议，不是资金、工作者或完整保存容量保证；最终命令照常经过核心准入。

## 冷导出与严格构造/替换

`exportWorld()` 是显式冷路径，返回独立冻结 World；`exportSave(metadata)` 才调用 headless v9 codec，返回文本。全局平台路由也已使用该 codec，但这不扩大旧 v7/v8 路由的接受范围，亦不重命名实际内部协议身份。普通投影、frame、选择与命令不调用 snapshot，也不遍历完整 World 生成 UI。构造/替换属于冷入口，先执行与 headless codec 相同的 `admitSaveWorldV9`，再创建新的私有 owner。因此同样拒绝 recovery-only、未证明授课链、错误身份和未资助未来余量，不把单纯 runtime 可以持有的根当成可保存 Session。

替换从不对旧 owner 调用 replace。它在临时 owner 中提前完成完整准入、时钟策略、初始四视图、合法默认选择、下一命令游标、Session epoch/修订余量、新累加器/提案集合和待发布 snapshot。任何准备失败都关闭新 owner，保留旧 owner、停止状态、缓存快照、选择、命令序列、时间余量/基线、holds 和旧预览。全部成功才赋值交换；之后关闭旧 owner。旧 owner 关闭和订阅异常均不能把已完成交换伪装成失败回滚。

## 存储协调端口

具体方法：

- `getSnapshot()` / `subscribe(listener)` / `close()`
- `setStorageReadOnly(boolean)` / `setStorageBusy(boolean)`，均返回 `SessionControlResultV9`
- `exportWorld(): SessionValueV9<WorldStateV9>`、`exportSave(metadata): SessionValueV9<string>`
- `prepareReplacement(unknown): SessionValueV9<PreparedReplacementV9>`
- `commitReplacement(token)`、`discardReplacement(token)`、`replaceWorld(unknown)`，均返回 `SessionControlResultV9`

`SessionValueV9` 成功为 `{ok:true,value}`；控制成功为 `{ok:true,changed,ephemeral}`。失败分别是 `{ok:false,kind:'session-rejection',code}`、`{ok:false,kind:'runtime-failure',error,stopped}` 或 `{ok:false,kind:'save-rejection',code}`。

准备替换时只保留一个私有候选。token 只有呈现用 kind/epoch/revision，没有 owner/World；必须是同一 Session 发出的同一个对象。复制字段没有权限。没有存储 busy 时，新的 prepare 会关闭前一候选；任何真正 Session 发布都会关闭候选并让 token 过期。显式 discard、成功 replace 和 close 同样释放候选。重复提交/丢弃返回明确拒绝，不再次更换世界。

持久层必须先取得 `storageBusy`，再 prepare，在异步写入结束并 commit 之后才释放 busy。在 busy 且有候选期间，选择、命令、速度/暂停、其他 hold 变化、refresh 及竞争 prepare/replace 被拒绝；相同 busy=true 是幂等无操作。这样普通 UI 不能在存储写入等待时使 token 过期。可见性只记录最新值并清除基线，不发布、不改 token；释放 busy 之前重新协调实际 hidden 暂停，失败仍以临时 hold/错误保持安全。显式 commit/discard/close 仍由持久协调器负责正确排序；Session 不实现 IndexedDB、writer lease、事务取消或文件上传。

`sessionEpoch` 区分替换；`worldRevision` 只在 owner stamp 真正变化或成功替换时递增。选择/临时 hold 不递增它，持久层可用 epoch/worldRevision 标记 dirty；遇到 runtimeFailure 须先处理视图不一致，不能拿旧 worldRevision 断言保存最新。

## 测试覆盖与当前限制

测试包含：无隐式全 World 导出、只读缓存和选中隔离、1x/3x/后台/部分刻/有界积压、实际字节上限的临时暂停、真实计数容量停止、领域暂停保护、类型化拒绝、有限授课及不支持链拒绝、真实归档/宗门命令 ID 读档碰撞、提案过期、真实寿尽/归档后选择安全、六种准备失败注入和旧会话各项状态保持，以及存储 busy 期间 token 的生命周期。

另有完整 Session 驱动的实际流程：带明确充足基础库存夹具 → 真实采石 → 永久配装 → 放置/建成藏经阁 → 实际制备研究材料 → 付费研究 → 建造丹房 → 送达伤药 → 取消护理归还药品 → 重开护理 → 实际伤势降低。流程中的建筑、新增库存、研究和药物均来自真实命令与固定刻，多处显式保存、解析和替换重载；每个运行检查点有界分段。这不是从空库存赚钱或最终平衡证明。

Session 定向测试与类型检查已通过，各轮完整检查和修正后定向结果以集成记录为准。浏览器实际点击、Canvas、可访问性、真实存储故障恢复和性能另有独立关口；Session 测试不能替代浏览器验收。
