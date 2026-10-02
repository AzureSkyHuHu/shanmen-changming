# v10 安静迁移的纯准备

日期：2026-10-02。范围：内部纯函数、fresh 构造器及专项用例；没有接存储、注册表、Session 或玩家入口。冻结约束见 [升级合同第 9 节](v10-alchemy-upgrade-contract.md#9-安静边界纯迁移与原字节保全)。

## 固定入口

- `prepareV9ToV10Migration(sourceText, metadata)` 返回合同已有的 `PreparedMigrationV10`
- `createUnregisteredWorldV10(seed?)` 只创建确定性的全新世界，不接收已有 World 或存档
- 不导出“任意 v9 对象直接改身份”的通用 helper；不加 validator、budget、callback、认证布尔值、恢复开关或目标槽参数
- 没有修改 `parseSaveV9`、`admitSaveWorldV9` 或 `inspectQuietV9ToV10Boundary` 的接受集合

## 纯准备的顺序

1. 首先调用未改变的 `parseSaveV9(sourceText)`。旧 envelope、校验和、精确 `.3` 身份、完整记录与全额未来余量必须先成立。未知版本、早期管理试验与 recovery-only 来源均不能进入转换
2. 对旧 parser 返回的隔离世界调用原 `inspectQuietV9ToV10Boundary`。活跃任务、待决生命周期、开启的自动安排及未开工图纸照原边界报告，不会自动结束、取消、关自动安排或删除记录
3. 只替换根 simulation/runtime/content 身份，sect schema 改为 2，添加精确空 upgrade。除此之外，不映射或重建任何历史子项，尤其不改写 construction level、旧 productiveSite、system/v9 命令或永久构筑身份
4. 用固定 `admitSaveWorldV10` 对整个候选执行全额目标准入。旧 parser 接受的内容仍可能不属于新目标支持范围；这时返回失败，不能删除、重命名或补造来源使其通过
5. 描述符捕获 metadata 后，使用固定 `createSaveEnvelopeV10` 建立新八字段 envelope。metadata 只影响新 `buildId`、`savedAt` 和相应 checksum；不会推进游戏时间或生成迁移事件
6. 成功返回隔离的新 World/envelope、原 `sourceText` 及旧 envelope checksum

`sourceText` 保留原字符串，包括空白、换行与字段排列，没有重新序列化。checksum 是损坏检测/诊断值，不是密码学证明，也不是写入权限。

## 精确不变项

除了合同列出的根身份、外层 sect schema 和空 upgrade，所有旧数据都做 canonical equality 保留，包括字段存在性、数组次序、Map/导航、人物位置与伤势、每个 RNG 流、World/local ID 序列、clock 与所有 revision、旧/归档回执及事件、资源与预留、建设/研究/生产/照护的完整历史、培养时钟来源、永久构筑全部 origin/migration/rules/装备/研习/分配/退休历史。

训练与休养设置、全局关闭时仍 enabled 的个人工作计划、决策计数及 activation review、合法 pause reasons 与 speed 原样保留。过期维护不是转换阻塞；迁移不会续费、补资源、修改 due 或自然回血。

旧 `system/v9/death/...` 来源继续原样成立。已知旧验证器能接受、但 v10 严格系统命名空间不能接受的日志由目标准入明确拒绝；没有 schema laundering。

## 失败诊断与边界

- 旧格式/校验失败：`INVALID_SOURCE`；已知版本/协议/内容不支持：`UNSUPPORTED_SOURCE`
- 原安静边界问题：不变地返回其 code/path
- 旧源大小限制：`CAPACITY_EXCEEDED`；目标 gate 失败路径为 `target`，大小失败报告 `CAPACITY_EXCEEDED`，其他不支持的目标范围报告 `UNSUPPORTED_SOURCE`
- metadata 捕获/结构问题路径为 `metadata`；不执行 getter/toJSON，也不读取反射时由调用者抛出的不可信错误对象
- `UNSUPPORTED_SCOPE` 沿用实际固定准入分类，不伪称能从这个分类区分所有容量或续行原因
- 与旧捕获器相同，Proxy 的反射 trap 自身执行/分配不受复制预算保证；返回数据仍需完整准入

纯函数不知道来源是否只读、源会话 epoch、当前是否存在更新的未保存进度、目标槽是否为空或 writer lease 是否有效。这些都不能从成功值推导。之后的 controller 必须验证最新源和会话 fence，并完成原字节持久备份、读回比对、空目标槽核验、候选保存/读回、lease 核验及 durable pointer commit。这里没有 source/target slot 绑定，也不授权写回任何存档。

## Fresh 构造

fresh 入口仅接 string/number seed，使用原确定性初始化生成新的地图、人物、RNG、初始状态和固定旧构筑上下文，再加同样的精确 v10 字段及空 upgrade，最后完整目标准入。不会用新开局替代已有存档；普通对象甚至不会被 seed 的字符串转换调用。每次输出相互隔离，不消费外部随机数或 wall clock。

## 专项用例与验证状态

新增 `tests/sect-expansion/v10-migration-preparation.test.ts` 覆盖：

- 完整旧 parser → quiet → 完整目标准入与新 codec roundtrip，旧/新 parser 互相拒绝另一版本
- 精确 whitelist diff、原 source 字符串与 checksum、新 envelope 八字段/metadata/hash、多个调用相互隔离
- 训练/休养、计划与 review、pause/speed、真实永久配装及已取消旧生产历史
- 真实建设、付费研究、药品送仓、护理开始拒绝与完成效果/时钟来源保留、过期维护不变
- 旧 quiet 结果不缓存授权，随后出现实际活跃任务仍拒绝；旧 source string 本身不能代替 controller 最新来源检查
- 未知版本、`.1/.2`、旧校验和、错误身份、队列、悬空 claims、未开工图纸、开自动安排、recovery-only 与新目标独立余量
- 真实待决死亡拒绝、正常寿尽处理后的遗产/归档/永久构筑退休与旧 system/v9 来源保留
- 旧 parser 接受但新目标不兼容的日志明确拒绝，不删除或改名
- metadata getter/敌意反射异常不执行、不被当作成功；fresh seed 的确定性与拒绝任意 World 参数

测试基础库存的加量和零历史寿龄边界是明确标注的压力/边界夹具，不声称来自游玩；宗门材料、建设、研究、送药、护理、死亡和退休历史使用真实已有 reducer/tick 产生，没有伪造奖励。

本文件初次写入时专项及全仓验证均尚未执行；由集成负责人串行运行后记录实际证据。这里没有数据库、备份读回、Session 切换、浏览器或发布验收，也不代表整个 v10 功能已向玩家开放。

## 集成证据：2026-10-02 21:22 UTC

25/25纯迁移测试在三文件309.25秒合跑中通过；同次运行实例新夹具1项失败已在独立27/27复验修正。源字节与完整旧历史保留，不涉及浏览器数据库写入。 双类型、边界、1205中文键、内容及默认构建通过。上述定向证据不代表全仓CI、公开v10、真机或完整游戏验收；性能仍待实际运行实例优化后重测。
