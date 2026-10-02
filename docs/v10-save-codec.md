# 内部 v10 严格存档 codec

日期：2026-10-02。范围：独立 headless 保存、解析与序列化前置；**没有注册玩家入口**。

## 固定协议与入口

- `src/core/kernel/save-v10.ts`：`createSaveEnvelopeV10`、`serializeSaveV10`、`parseSaveV10`、`SaveCodecErrorV10`
- `src/core/world/save-admission-v10.ts`：固定 `admitSaveWorldV10` 与有界数据捕获 `captureSaveDataV10`
- 仅接受 saveVersion `10`、simulationVersion `0.10.0`、contentVersion `shanmen-management-0.10.0-upgrade.1`、runtimeProtocol `management-v10-alchemy-upgrade.1` 和固定 `MANAGEMENT_V10_IDENTITY`
- envelope 精确八字段：`saveVersion, simulationVersion, contentVersion, seed, buildId, savedAt, payload, checksum`
- 校验和为除 checksum 外完整 envelope 的既有 `stableHash`；这是损坏检测，不是密码学真实性证明
- World 与 envelope 的 seed、simulationVersion、contentVersion 必须相同；永久构筑仍由完整根验证绑定 `MANAGEMENT_V9_IDENTITY`，不改其历史

每次创建、解析、序列化均走同一完整准入，包括调用者自行组装并重算 checksum 的 envelope。入口不接收 callback、validator、trust flag、capacity assessment、外部证书或 recovery-only 选择。正常解析结果的 migration 恒为 null。

## 准入与输出所有权

先捕获有限数据，再核对固定身份，随后创建 `createPrivateRuntimeV10` 临时所有者。该固定入口负责完整根记录、六域所有权、生命周期、构筑与培养、当前字节/reader/数值上限、未来记录余量及有限授课续行范围。只有成功创建且非 recovery-only 的源可以导出。

导出使用实例的 `snapshot()`，并再次拒绝失败、空 World 或 recovery-only 快照。所有成功创建的临时实例均在 finally 中 close；不自动取消任务，不清除预留，不改调用者世界或其时钟。返回 World 是验证过的隔离、递归冻结快照，envelope.payload 与返回 world 指向同一导出树。不同 parse 调用不共享导出身份。

错误分两层：损坏记录为 `INVALID_WORLD`；固定根记录有效但不在当前完整可保存范围内、授课续行未支持或未来余量不足为 `UNSUPPORTED_SCOPE`。只能在私有运行实例实际尝试完整准入失败之后用固定记录检查区分后者；该检查不能授予保存权限。没有以“当前 JSON 小于上限”代替完整准入。

## 敌意输入、metadata 与大小

- 只接受普通 enumerable data objects 和 dense arrays；拒绝 getter、setter-only、函数、symbol、非有限数、undefined、exotic prototype、隐藏属性、循环和重复对象引用
- v10 重复引用拒绝不改变 v9 的原始接受行为；不修改旧 capture 或 parse
- 每个节点先收集自己的数据描述符，再下降到子节点；不执行 getter、toJSON 或调用者数组迭代方法，不检查调用者抛出的错误对象
- 创建入口先隔离 World，再反射 metadata；metadata 的 Proxy trap 不能回改已经捕获的 World
- metadata 精确两个字段；buildId 为 1–128 UTF-16 code units，savedAt 为 1–64；两者是显示数据，不读取墙钟，不参与模拟 RNG
- JSON 结构上限为深度 128、值节点 4 MiB 数值上限；完整文本按实际 UTF-8 计量，4 MiB 可接受，多一字节拒绝，空白同样计算
- 数组自定义键先限长度再做索引检查；不可能在预算内的 key 数先拒绝，再请求逐属性描述符
- 完整私有运行准入仍独立执行 build/cultivation/history/sect 等 reader 的字符、节点、数组与记录上限，不能由外层 4 MiB 检查替代

Proxy 的 ownKeys、getPrototypeOf、getOwnPropertyDescriptor 仍可能执行调用者代码、分配内存或在反射期间改变调用者数据。这里只保证本模块遍历有界、捕获结果完整验证及异常值不再被检查，不声称原子快照、万能 Proxy 识别或约束调用者 trap 自身成本。

## 覆盖与尚未宣称的结论

新增 `tests/persistence/sect-v10-codec.test.ts` 覆盖：

- 精确当前文本、八字段、checksum、身份不一致、11/999 等未知版本、v9 原解析保留与拒绝版本重标
- metadata 合法上下界及越界、4 MiB 字节边界、独立 reader 压力、alias/getter/cycle/throwing object、反射次序与隔离
- 临时 owner 正常关闭、快照失败关闭、recovery-only 关闭及全部入口一致拒绝
- 真实有限授课源与不支持的授课链；拒绝当前可装下但未来余量不足的源
- 真实药性配伍研究、升级开工/第 200 刻检查点/第 399→400 刻完成、半耗材取消、精确重试
- 无粮替代药的真实 L2 来源、送达来源、先消费旧基础药再使用替代药的照护及伤势归零
- 已重算 checksum 的伪升级完成、伪药剂来源与缺失 paired owner 仍拒绝

夹具中旧建造、基础研究、药品为真实旧 reducer 历史；测试明确标记的 record-only lift 只用来构造 v10 输入，**不是生产迁移**。所有新增研究、升级、替代药及照护进度来自实际 v10 command/tick candidates；后续对比用两个独立私有运行实例检验保存前后继续结果。

写入本说明时实现与测试用例已准备；实际测试、双类型、构建、全仓回归与最终审阅由集成负责人串行执行，本文不把尚未执行的用例记作通过。本片不修改旧 parseSaveV9、版本 registry、Session、平台存储、UI 或迁移路线；也不保证任意未来等待/新任务的无限可保存性、36 人/150 年/3 倍速性能或完整游戏验收。

## 集成证据：2026-10-02 21:22 UTC

最终23/23 codec测试在三文件309.25秒合跑中通过；真实药性研究延续测试使用显式30秒预算，不修改算法/断言。 双类型、边界、1205中文键、内容及默认构建通过。上述定向证据不代表全仓CI、公开v10、真机或完整游戏验收；性能仍待实际运行实例优化后重测。
