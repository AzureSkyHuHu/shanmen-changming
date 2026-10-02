# v9 .2 内部经营容量查询

状态：内部只读实现，等待本树验证。没有注册新存档、应用引擎、Session、内容入口或 UI，没有接入运行时准入，也没有赋予导入权限。

## 覆盖范围

`assessManagementCapacityV9` 只接受明确的 `fresh-management-v9-unregistered.2` 内容身份。它区分：

- measured：完整 v9 envelope 的 UTF-8 字节，包含 saveVersion 9、全部 World 及最大合法转义元数据
- derived：现有义务的有界记录峰值、即时取消与生命周期恢复所需的记录/计数余量
- supported：上述有限范围的结构推导是否成立，当前记录是否通过内部记录检查
- fits：上述范围内全部独立容量维度均有空间
- admitted / importAuthorized：始终 false
- eventualCompletionSupported：始终 false

即使 fits 为 true，也不能据此公开保存、导入、开工、推进或释放预算。这里只给出候选查询，没有运行时副作用、调用方授权开关、持久化预算或可变缓存。每次重新测量输入；访问器、循环和稀疏数组在属性读取前被拒绝。

## 整档公式

完整 World envelope 只计一次：

    整档字节 + 已有生产/日志/通用余量 + progression 预留 + sect 预留 <= 4,194,304

已有生产部分直接使用 `assessAutomaticWorkBudget`；保留既有通用余量，不冒充无限经营证明。成长部分通过结构化 `deriveProgressionReservations` 和 `assessProgressionNumeric` 复用 build-2 / cultivation-3 记录推导，没有把 v9 转型经过 v8 World 包装层。build 字节及记录是 progression 的子项，不再重复相加。

`deriveV9BuildObligationFacts` 从原 v9-record-headroom 作等价窄抽取；原检查函数保持执行顺序和原先诊断，查询与原检查共用同一个事实来源。

## 宗门义务与类型化见证

`deriveSectReservationsV9` 为每个 planned blueprint、活动施工、生产、研究和护理所有者生成三个有界分支：live-peak、completion、cancellation。每个分支按照真实持久化类型建立字段最大见证，按同一字段的实际当前表示扣除已计字节；新数组成员另加分隔符。每个度量采用整个分支成本的最大值，而不是把互斥的完工和取消相加。

- 施工：草图状态、工单、两次材料检查点、成对账本、仓库/工地访问、全部离散工时跨度、完工建筑或取消回执
- planned blueprint：保守保留一次后续开工及终态集合，包括三个域 ID、工单/账本/建筑行和开工/取消回执；这不表示已获资源或有可用工人
- 生产：真实配方投入/产出、岗位与送仓访问、全部工作跨度、终态或取消回执；取消使用实际 Cancelled phase
- 研究：注册研究的工作刻、401 次访问上限、逐跨度访问引用、成对付款和取消回执
- 护理：40 个工作跨度、41 次访问、固定疗伤效果字段、请求/死亡/月度休养取消来源以及真实本域回执
- 所有活动路线：复用 `navigationPathByteBudget` 的全图 N 格上界，独立增加路线字符和每格三个描述符节点，不假定最短的实际寻路距离
- 共享字段：实际 World 位置/旅行状态、地图版本、库存、三个新增资源的真实 99 容量以及安全整数计数器的表示宽度

见证是字段独立最大值组成的类型化上界，可能不是一个同时可达的合法快照。例如材料的已耗与剩余数组可以各自采用最大形状；它们不能被拿来证明已付款或作为导入档。当前真实 ID、门槛来源和不可变关联会被保留；新增 ID 和可变计数使用其真实协议宽度。

宗门回执属于 construction / production / research / care 自有数组。包括 system/v9/death/* 的回执也不进入 World commandReceipts 或 archive event 表，不能重复预留那些行。

## 独立硬上限

输出 current、reserved、costs、limits 和 deficits。字节通过不会吞掉其他维度的失败：

- 旧生产、World 回执/事件档案行数，以及档案解码字符和节点
- build 命令行数，build 独立 reader 字符与 300,000 节点；cultivation 独立 4,000,000 字符 reader
- cultivation 的 receipts、events、pendingDeaths、deaths、archivedDisciples、authorityReceipts、attempts、legacyIdentities 和 sectRelicIds
- sectRelicIds 单独保留当前所有人物持有的唯一遗物最终进入宗门的行数，不按每一段继承链重复计入。恰好 100,000 和多一行分别处理
- 草图、计划草图、施工/生产/研究/护理历史、完工建筑、各域回执、共享 paired claims、维护付款及活动工人/研究数
- 每个工单的跨度/访问上限，以及真实嵌套 construction/production/research/maintenance descriptor reader 的独立节点上限
- 全局序列、成长/建筑版本、日历/模拟计数、真实随机拒绝采样开销、宗门版本/分配序列和导航版本

数字相加超过安全整数时是显式不足，不会四舍五入为一个可通过的数值。维护付款是可选的未来增长，预留未来付款行数为零；已存在付款仍完整计入当前档。后续续费、开工及其他可选增长必须由未来运行时边界重新测量和决定。

## 尚未证明的边界

施工、生产和研究的 revision 每个经营 tick 都增长，包括阻塞/等待刻。任意阻塞持续时间没有有限完工刻上界。因此本查询只保留当前边界的即时取消/恢复计数和有界记录峰值；不能用它声称无限等待后依然可以完工。后续真实运行时准入必须在可选增长消耗这些恢复余量前停止，并独立证明取消释放的所有权和单调性。

自然寿尽前任意月份、可选操作、反复续费和无限新增任务不在此有限证明里。没有永久护理完成、永久增长或整个游戏长期可存的承诺。

护理 .2 的历史 beforeRevision 与月界 tick 尚无独立重放锚点。本查询不能修复或绕过该历史来源限制；即使记录检查和字节都通过也没有导入权限。后续时钟证据协议是单独的版本门槛，必须重新评估新增字段，而不是假造字段预算。

离宗、战役、战斗、返程、终局和退出保持关闭，没有借用 v8 exit 证明。

## 测试与验证约定

新增测试包括：完整 envelope 的真实 UTF-8/转义大小、4 MiB 相等与多一字节、数值相等/差一、独立行与 reader 压力、遗物目的地相等/差一、局部回执不混入 World 档案、可变数据重测、恶意 getter/循环/稀疏数组，以及 v7/v8 codec 不变和 v9 仍未注册。

类型化见证对照真实领域 reducer 的施工旅行/分段付款/完工/取消、实际生产送仓、实际付费研究和真实制药/护理终态。这个专项用充足基础资源作明确的领域容量夹具，所有新增宗门资源、建筑、研究、药物及护理记录仍由真实 reducer 生成；它不冒充从初始基础资源赚钱的全旅程。既有 v9-care 测试负责那条完整零新增库存旅程。

另以真实 World tick 验证寿尽先释放本域预留，本域取消所有者消失而生命周期所有者仍存在。没有以查询结果放宽 import/runtime 边界，也没有在本片实现实际取消准入。

最终类型、专项、全量和构建结果由集成负责人记录；本文件不把尚未执行的验证标为通过。
