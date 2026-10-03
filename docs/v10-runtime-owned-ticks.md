# v10 私有实际单刻流水线

状态：首版验证与基准见文末。后续固定阶段提取已写，尚待集成负责人串行复验；首版结果不代替本次验证。

## 范围

`src/core/world/runtime-owned-ticks-v10.ts` 仅供私有运行实例使用，不加入 application、kernel、save 或 codec 的公开导出。每个运行实例创建独立 `createOwnedTickPipelineV10()`，只暴露：

- `capture(input)`：对外部根做完整有界描述符复制，认证并恢复该副本本身的历史归档，再冻结并调用固定完整 v10 容量查询；完整根、记录、当前硬限制和未来预留均须通过，且没有授课
- `advanceNormal()`：在本工厂持有的不可变完整边界上执行一次真实 `prepareOwnedNormalTickStagesV10`
- `advanceNoOptional()`：在本工厂持有的不可变完整边界上执行一次真实 `prepareOwnedNoOptionalGrowthTickStagesV10`
- `clear()`：清除本工厂持有的边界

成功仅返回深冻结的 `world`、对该 `world` 精确计算的 `assessment` 和只读 `diagnostic`。诊断记录准备种类及前后刻数；没有接受诊断或查询结果作为权限的接口。失败返回 `null`，要求外层走原严格路径。失败的单刻不会替换持有边界；失败的外部重新捕获会清除旧游标，以免误续另一个来源。

## 为什么不重放这一次实际单刻

公开候选入口面对任意调用者提交的 before/after，必须独立重放实际命令或单刻来证明候选属于其来源。外部冻结、容量充足、某个合法终态或相同刻数都不能代替这一证明。公开 `decisionV10`、`verifyCapacityLimitedCandidateV10`、严格推进及授课检查不变；释放检查只提取共享记录比较叶，保留完整捕获/根验证、义务支持预检及实际重放的原有顺序和拒绝结果。

该私有工厂没有接受 after 的方法。初始来源必须经过固定完整检查；随后来源只能来自工厂刚刚完成的实际固定 reducer。每步：

1. 取本工厂持有且不可变的根及其精确查询，不接收来源、候选、评估、策略、回调、验证器、owner 或 trust 参数
2. 拒绝暂停或授课来源；精确来源查询必须 supported、actual-fit、future-fit，无记录错误、未知项或不足维度
3. 执行固定正常/无可选增长阶段 helper。它们与严格 wrapper 共用同一个实际阶段组合，只产出原始候选，不提供准入。来源完整验证已由本工厂捕获/上一个实际单刻完成，不把任意外部冻结来源当成已验证
4. 再对真实结果做描述符隔离，恢复这个副本本身的历史归档并深冻结，对这个隔离结果进行一次固定完整容量查询，其中仍执行完整候选根/记录验证
5. 核对所有当前/预留整数维度、候选仍无授课、两类时钟恰好各加一
6. 调用共享的固定 `inspectReservedDischargeRecordsV10(before, after)`，重新派生两端结构义务，并执行原有跨边界记录比较：不可变工作/地点字段、取消前后消耗/退款/工作/新回执、完工结算、旧生产终态/通知及生命周期终结。只有没有问题，才同时安装新根及新精确查询

因此被省略的是把同一个已实际执行的普通单刻再次当成不可信提交候选来重放的工作；不是省略实际 reducer、完整根记录检查、跨边界记录比较、当前限制或未来余量检查。共享记录叶自行派生结构义务，不接收调用者预算/证明/标志；返回类型明确为 `scope: 'v10-cross-boundary-records-only'`、`issues`、`discharged`，没有 supported 或 admitted 字段，不能代替实际执行证明。公开门必须先做原有独立重放，之后才把记录比较结果映射回原有公开结果。私有流水线既不发布也不使用 discharged 标签作恢复信用。正常/无可选增长使用实际固定算法，保留月结、生日、寿尽暂停、工作取消、维修付款、寻路、资源和随机流的既有次序。

后续阶段提取另去掉私有调用中重复的前后根检查：来源仍由完整查询认证，候选仍在完整查询中检查；只有在工厂不可变所有权成立时才能复用这些已完成的工作。`prepareOwnedNormalTickStagesV10` 和 `prepareOwnedNoOptionalGrowthTickStagesV10` 仅是 INTERNAL 原始候选阶段，无来源准入、容量准入、保存准入或调用者权限，不进入公开 barrel，也不接受回调、策略、信任标志或评估。

原 `prepareNormalTickCandidateV10` / `prepareNoOptionalGrowthTickCandidateV10` 严格 wrapper 的顺序保持：描述符捕获 → 完整来源记录验证 → 恢复所捕获来源的历史 → 相同真实阶段组合 → 完整候选记录验证。暂停时也先捕获和验证来源，然后精确返回调用者的原始对象；失败仍抛出且不改来源。任何直接调用原始阶段 helper 的人都没有获得准入；私有工厂不接受其返回值作为外部候选。

历史归档索引也绑定真实持有对象：工厂对自己的描述符副本调用 `restoreWorldHistory`，不是拿验证器临时恢复的另一份副本当作来源。每个实际结果同样隔离后恢复并检查。外部冻结的合法归档仍重新认证，损坏归档仍拒绝；既有历史、回执和真正生产完工的追加顺序不变。

这里的“未来余量充足”仅指完整查询规定的已知有限记录预留全部 fit。`fullyFundedContinuation`、`eventualCompletionSupported` 等原查询字段保持原值；没有声称任意阻塞、等待、续费或未来命令都必然完成。

## 失败与排除

- 授课来源和候选、恢复专用来源、当前越界、任何未来不足、未知/不支持的义务或抛出异常，均不得在此处接纳
- 正常候选失败时不更新任何状态；后续 `advanceNoOptional()` 独立从相同完整来源执行，不保存禁用自动生产或续费的伪造设置
- 无可选候选也失败时继续保留来源，包括 RNG、库存、路径、编号、事件、回执、维护和工作记录
- 没有携带式 idle 余量、跨根容量标签、单维不足抵扣、多步跳时、调用者造候选或跨工厂证书
- 已冻结的外部数据仍完整复制和检查；返回的评估/诊断也深冻结，副本修改不影响本工厂
- 方法借用只使用原闭包，额外实参被忽略，无法改写执行的固定 reducer 或来源
- 捕获前置重入锁阻止反射陷阱中的嵌套捕获、推进和清除。描述符复制不调用普通 getter；不声称 Proxy 反射本身可被沙箱化或所有 Proxy 都可识别

## 外层集成要求

运行实例必须绑定完整根身份和 generation。命令、控制时钟、替换、失效及关闭均须使私有游标失效；任何锁存停止仍由外层原逻辑处理。不可把另一个根或保守 idle 余量直接赋给本工厂。只有 `capture()` 能引入外部根，只有成功的实际固定单刻能推进根。流水线本身不发布、不清除停止、不处理导入/保存、不执行恢复命令。

## 测试与证据

`tests/sect-expansion/v10-runtime-owned-ticks.test.ts` 添加：

- 捕获一次完整查询；每步一个实际指定 reducer、一个完整候选查询、一次共享跨边界记录比较
- 严格 wrapper 每次仍做完整来源和候选根检查，暂停时保留原对象且不接受无效来源；两种 wrapper 对敌意描述符、别名、外部冻结伪造与整数耗尽仍保持拒绝
- 实际归档回执与生产完工追加差分；证明工厂持有的真实历史对象已被认证，外部冻结标志不能取得相同权限
- 连续真实活动采集、旧生产和自动开工，对完整严格入口做 World 逐字段与精确 assessment 差分
- 实际已付费的研究、升级 199→200 检查点与 399→400 完工、L2 生产、照护及终态
- 实际 L2 维修到期的正常付款与无可选增长差异；月结和寿尽在升级完工/维修/工作前暂停和取消
- 正常失败后的同源无可选重试；双失败后的完整状态和随机流保留
- 普通 getter、共享引用、恶意异常、重入、外部冻结、跨 owner、返回数据修改和额外参数注入
- 容量仍 supported/fit 的库存、RNG 状态/抽数、诊断、速度、不同来源及假自动退休日志，仍由未修改的公开候选门拒绝
- 即使记录比较 issues 为空，伪造候选仍被公开实际重放拒绝；该记录诊断也不能作为私有流水线的输入权限
- 真实授课与真实升级恢复专用完工仍回原严格入口，不能从此流水线获得普通准入

已有 v9 历史夹具的基础库存是明确的测试资金；宗门 stock、建筑、药理和药品历史均由真实付费工作产生。升级、药性配伍和后续刻均使用固定 v10 reducer。寿尽和自然月结近边界测试明确设置合法初始时点，不把该设置称作已实际推进的时间。

以下首版基准不代表后续阶段提取结果。活动工作、重历史、渲染、三倍速、36弟子和移动端仍须实际测量；减少重复重放不能单独证明性能目标达标。

## Root validation —2026-10-02 22:19UTC

Three suites /69 tests passed in399.77s: owned ticks, unchanged public discharge behavior, and strict runtime capacity. Both TypeScript configurations, boundaries and default build passed. Independent rereview confirmed the residual-comparison extraction retains every original cross-endpoint check and public rejection ordering. Five first-run failures were test mutations of intentionally frozen constructor snapshots; a sixth assumed200k exceeded current wire limits. Mutable fixture clones and explicit over4MiB pressure corrected those without production changes.

Twenty samples of the owned leaf on a genuine active gather matched complete raw candidates: p5046.995ms,p9556.203ms,max56.336ms,capture32.38ms. This improves the private-owner active baseline but is not integrated-owner/browser evidence; p95 still exceeds50ms before rendering. Further optimization remains required before player activation.
