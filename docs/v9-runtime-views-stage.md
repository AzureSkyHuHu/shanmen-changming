# v9 私有运行实例：固定视图与窄时钟控制

实施基线：`495094c13338d0d42b86e83f2c18e0907f84e794`。本片只扩展内部私有实例，准备下一阶段 Session 所需的固定只读查询与播放器时钟操作。集成负责人已在隔离源码树完整通过140文件2736项测试，817.87秒，以及1041中文键、内容/边界、双类型与生产构建；作者未并行运行检查。

不接 ApplicationSession、world-engine、React、Phaser、内容注册表、平台存储或玩家入口。另行开发的 v9 headless codec 不在本片文件范围。普通 v7 与 v8 战役路由不变。宗门升级、搬迁、维护恢复命令、新配方自动计划、远征和战役未因这些视图而开放。

## 固定 API 与私有所有权

新增 `frame()`、`cultivation(discipleId | null)`、`build(discipleId | null)`、`expansion()`、`previewBreakthrough(unknown)`、`previewPlacement(unknown)`、`nextApplicationCommand(start)`、`controlClock(unknown)`。

查询返回真正的 `ok` 判别联合：成功的 `error` 为 null 且有深只读 `value`；失败的 `value` 为 null，并有明确错误。调用方仍收到同一实例局部的 stamp、stop 和逐操作 metrics，这些是观测值，不是跨实例授权。原命令保持 `CapacityLimitedResultV9`，没有降格成旧 CommandResult。

查询与控制均先进入重入保护，随后描述符复制输入；getter、非数据、额外字段和不合格式的参数不会取得权限。未知查询/控制输入返回固定错误，不读取外部抛出对象的 message。关闭或重入状态在反射输入前返回。没有外部 selector、回调、World 根、评估对象、所有者标记或 trusted flag 参数。查询模块里的映射是固定的内部代码，不能由调用者替换。

映射结果按固定字段选择，再完整隔离、递归冻结。只冻结实例生成的副本，不冻结调用方参数。已有历史查询与 v9 领域视图可以内部借用私有根；实际输出不返回这些来源对象。`snapshot()` 仍是唯一显式整棵 World 导出方法。普通查询不调用它，也不会把 World 包装进 `value`。

## 输出范围与精确上限

- frame：最多 36 名当前人物、200 个站点对象、256×256（65,536）格基础地图、6 种基础库存、36 个工作计划及每计划最多 6 项优先级、最近 5 个事件；生产只显示最多 36 个活动旧生产加这 5 个事件引用的事务，即最多 41 行
- cultivation：最多 36 个当前人物摘要、最多 72 条死亡/突破决定；只显示一个选中人物的状态、一个活动突破、一个待死亡、一个既有死亡摘要及最近突破结果。授课选择最多 64 项，每项最多 35 名其他学员，并另给真实总数；遗物只给数量，不返回完整知识、遗物或历史列表
- 突破预览的固定子字段最多 6 项成本、8 项风险因素、6 项阻挡原因及 5 项警告。风险仍来自真实 `previewBreakthroughV3`；额外给出实际 v9 工作所有者，避免把领域预览误当成宗门占用许可
- build：一个当前人物、注册规则允许的最多 5 个分配节点及当前目录范围内的已学技能 ID、固定三槽装备、合计成长点/学习额度、最多 512 个该人物持有的装备选择。不返回 acquisition、origin、source operations、历史或回执。没有把 v9 强转为旧 BuildPanel 所需的完整 BuildDataV2
- expansion：恰好 3 个额外库存余额；最多 16 个未开工草图，加最多 36 个已开工草图，合计最多 52 个可见草图；站点与完成建筑总共最多 200；所有类型工作所有者合计最多 36，扩建活动任务因此也不超过 36；最多 2 个真实研究完成引用；最近终态跨四域统一最多 8 条，并另给总数
- 建筑几何由注册目录推导，每个当前新建筑/草图只有 4 个占地格及 1 个入口。维护仅给当前经营状态、到期 tick、缺口与停止原因，不返回付款历史。护理终态仅额外给实际治疗前后伤势
- 缓存固定 4 个槽，每个视图一个。选中人物变更替换原槽，不累积 ID→视图缓存。预览和 command ID 查询不建立缓存。替换成功/关闭时清空；替换拒绝保留旧缓存

这些界限只限制投影，没有删除、压缩或截断权威历史。若内部来源突破固定非截断边界，查询失败，不擅自裁掉当前人物/工作。唯一明确截断的显示集合是最近事件、最近终态和授课选择，后两者提供实际总数。

frame 的 map 是基础地形；expansion 的完成建筑及已开工草图足迹表达额外碰撞，不把基础 map 改写成第二权威地图。cultivation/build 使用对应私有分支身份缓存，合法空闲标量刻可保持其 DTO 引用；frame/expansion 在新根上重建。失效后首次读取仍按原实例约定重新认证一次。

## 重用既有纯查询

- `recentWorldEvents`、`lookupLiveProduction`、`lookupProduction` 提供有界可见旧事务
- `v9WorkOwners`、`v9WorkerAvailable` 提供跨域占用；`projectV9SectFrame` 只在内部用于真实人员、两本账与领域记录的统一视图
- `deriveSectFootprint` 和 `previewValidatedConstructionPlacement` 提供目录几何与真实研究门槛；仅返回小结果，不返回 ConstructionFrame
- `sectMaintenanceStatusFromRecords` 是已认证记录的叶查询，避免每个建筑调用公开全帧验证 wrapper
- `previewBreakthroughV3(cultivationFrameOf(world), …)` 只在显式预览时调用，允许其完整领域核验成本，不放进每帧投影
- build 进度复用既有面板的纯求和语义；所有历史/来源真实性已由实例准入负责。没有为了取几个数再次导出完整构筑树

放置预览明确标记 `scope: placement-and-research`。它不证明资金、可用工人、完整保存容量或后续命令必然接受；真实命令仍经过原严格候选准入。尚未借用 v7/v8 automatic preview 的保存预算为 v9 提供虚假 allowance。

## 命令 ID 查询

只使用固定 `app-command.` 前缀。检查待决命令、当前与归档 World 回执以及 construction/production/research/care 四域回执。宗门命令没有 World commandReceipts，不能遗漏其本域 IDs。归档在单次查询中先恢复一次，再用于各候选查找；不解析不可信数字后缀。

查询不分配 ID，不记录回执。返回下一可用 commandId、sequence 和真实 issuedTick。非法数字返回 invalid-query；无可用安全游标返回 capacity。最大可返回 sequence 为 `Number.MAX_SAFE_INTEGER - 1`，保留调用方安全执行下一游标 +1 的空间。重复查询同一边界得到相同结果，真正分配及 Session 序列推进属于下一片。

## 窄时钟控制

只接受 `{kind:'speed', speed:1|3}` 或 `{kind:'pause', reason:'player'|'hidden', paused:boolean}`。内部直接由旧 clock 构造新 clock：仅改变指定速度或该一个 UI 暂停成员；保留其他暂停的顺序、全部 tick、mode 及旧边界合法保留的扩展字段。不会接收完整 clock、取消领域任务、生成命令/领域回执、推进随机流或改写存档中的历史时间证据。

操作完整评估旧边界（需要时）和新候选的来源、实际硬限制、有限教学续行与保存预算。不能把空闲 carry 当精确前态。恢复-only 边界可以移除暂停或等宽变速，但不能增加任何已不足维度；额外暂停字符串放不下时返回 capacity，保留旧根。未来 Session 可用自己的 ephemeral hold，当前实例不代建 UI 状态。

这不是通用 domain decision 的豁免开关。该分支的差异只能由固定内部构造产生，且完全不解除义务；真实命令/tick 仍需要真实 reducer 见证与原释放准入。特别是已有教学时，不能伪造一条 command receipt 来证明暂停，也不放宽 `authenticTeachingTransitionV9`。

成功控制只增加 publication，替换精确证书，清除旧导出缓存；generation 不变，私有安全 stop 原样保留。没有调用会清除 stop 的 `publish()`。无变化操作不发布。任何失败保留旧根、stamp、stop、导出与视图缓存。真正成功发布的恢复命令及成功 replace 仍按原协议清除 stop；controlClock、读取和 invalidate 都不能清除。

## 验证内容与限制

新增用例覆盖固定/隔离/冻结 DTO、4 槽缓存、空闲分支身份、80 项知识的 64 项显示上限、70 条真实命令及归档、所有四个宗门回执 ID、最大游标、显式导出、失败查询与失败替换、Getter/Proxy/稀疏数组/函数/额外字段、关闭和重入、窄时钟与暂停顺序、失败发布、容量停止保持、字节余量拒绝、真实有限授课控制，以及真实施工→付费研究→丹房→送药→护理终态。

真实宗门夹具使用已有明确标记的充足基础库存；所有新增库存、建筑、研究和药物均通过实际 reducer/刻产生。它不是从开局赚钱的完整旅程证明。测试未运行不等于通过；测试数量由最终执行结果报告。

没有性能门槛结论。输出有界不等于查询 CPU 为常数：选中人物的最新结果查找、维护状态和 ID 查询仍可读取保留的历史；显式突破预览会完整验证培养帧，frame 会复制有界地图。需要之后对完整 Session+UI 同构建实测，不能据此宣布 20Hz、3倍速、36人、150年或真实浏览器保存安全已经验收。

下一片才实现 private-owner Session 的计时、选择、存储/覆盖层临时暂停、预览代次及完整 prepared replacement；此片没有提供未完成的 Session façade。

## 集成证据（2026-10-02 12:17 UTC）

冻结源码提交 `c54a004037cfa39c94ffb0dabacb6a3db55753bc`、树 `9627c6b149798313ad508fc3791dc05e29fb0ede`。46项视图定向测试通过5.22秒；完整验证140文件2736项通过817.87秒。初次两处失败是预期误差：JSON复制的负零归一化、修订压力来源的真实严格拒绝分类；保留原行为并新增独立真实容量停止、停止对象身份、缓存刷新和失败控制保留空闲证明用例。尚无真实浏览器、渲染帧率、3倍速或完整人口验收。
