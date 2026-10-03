# 私有 v10 Session 与原样候选绑定

日期：2026-10-02。此片只实现 `src/application/session-v10.ts`、专项测试及本说明。公开 v7/v8/v9 路由、经营页面、React/Phaser、存储控制器、协调器与数据库均未接线。代码存在不代表新玩家入口或完整游戏验收。

## 固定所有权与冷入口

`ApplicationSessionV10` 只接受未知来源 World，使用固定 `admitSaveWorldV10` 和 `createPrivateRuntimeV10`。准入必须满足真实完整记录、容量及有限续行要求；恢复专用但未完整资助的边界不能冒充正常 Session。没有调用者提供的工厂、校验器、选择器、信任标记、容量证明或 v9 World 强转。

构造、替换预备与独立 Session 预备都先完整准入、建立私有 owner、读取四类固定 DTO 和下一应用命令游标。失败关闭已建立但未使用的 owner；准入的临时 owner 由准入器释放。冷准备可能很贵，本片没有提供性能改善证据。

最重要的 v10 差异：预备和绑定不向 World 写入任何 player/hidden 暂停，不重设速度、训练、工作、历史或随机流。导出的规范 World 内容与被接纳的输入完全相同。JSON 接纳器已有的规范化仍适用，例如负零变为零；“相同”指被接纳的 JSON World，不承诺保留非规范原始文本空白。

## 只读投影、实际命令与预览

Session 缓存 frame、cultivation、build、expansion 四个固定 DTO，并提供选择、状态订阅和稳定 `getSnapshot`。DTO 深冻结且不暴露私有 World、完整回执/历史、RNG 或来源证明树。保存导出才显式调用 owner.snapshot；帧、选择、命令后的刷新只调用固定轻量查询。输出有界不意味着每个来源 join 或领域查询已符合帧预算。

命令请求只暴露已有生产/丢弃、修炼、永久构筑及五类宗门命令，包括 upgrade.start/cancel。调用者请求先作描述符复制，拒绝 getter、外部 commandId 和额外协议字段。应用编号由真实 v10 owner 查找，精确使用 app-command.N，并避开当前/归档 World 及五个宗门回执域。Session 控制游标；非法或被 hold 阻挡的请求不消费编号。

突破、放置和升级预览携带当前 owner stamp 与 Session epoch。WeakSet 身份检查在读取外部 token 属性之前进行；复制、跨 Session、替换前或实际 World 发布前的过期预览不能确认。有效预览在一次真正提交尝试时消费，即使领域拒绝且 World 没有发布，也不能重复确认。纯 hold 拒绝不会消费预览。review hold 只允许明确的预览确认通道越过，不能越过 storage、overlay、隐藏或其他安全 hold。

升级预览保留 scope 为 upgrade-start-conditions：正预览不是容量或未来命令授权。确认仍构造实际 upgrade.start，由当前 owner 完整检查。永久构筑继续使用其冻结旧身份，新升级不会改写 construction 的 L1 起源。

## 时间、暂停与修订围栏

平台显式传入时间；Session 使用原固定刻累积器、1x/3x 速度以及每次至多20刻。正常赶帧保留积压，暂停/隐藏时丢弃经过的墙钟时间，保留暂停前未满一刻的余量。隐藏、存储、只读、overlay、review 与 staging 不改变 World。所有有效 hold 阻止实际推进和普通命令编号分配。领域暂停仍允许领域本身允许的取消/待决处理，不能由 UI 控制移除。

显式 setPaused(player/hidden) 与 setSpeed 使用真实 owner 时钟控制；玩家请求的持久暂停因容量无法写入时使用临时安全 hold。setForeground 只改变临时可见/聚焦状态，返回可见不会擅自清除存档已有 hidden 暂停；该原因只能由显式时钟控制移除。

后续 UI 接线必须说明继承自存档的 hidden 暂停并提供显式恢复路径，例如 setPaused('hidden', false)。单独的玩家暂停按钮不能让该状态毫无解释地一直停住。恢复 hidden 不得清除 cultivation、save-capacity 等领域暂停；测试使用真实寿尽待决 World 核对这一点。本片没有新增 UI 按钮或自动恢复策略。

未来协调器的 sourceSession 围栏应取现有三个平面字段，不增加另一份影子对象：

- sessionEpoch：仅成功替换时递增；区分不同 owner 实例，不能把 owner 局部重置的 stamp 当成同一会话
- worldRevision：成功刷新时发现 owner stamp 变化，或成功替换时递增；没有 World 变化的选中对象/hold 变化不递增
- revision：每次发布完整 Session 投影时递增，包括纯 UI/hold 变化、失败报告和成功替换

真实 owner 已前进而 DTO 刷新失败时，Session 保留整组旧视图、旧 stamp/worldRevision，同时发布递增 revision 和 runtimeFailure 安全 hold。此时不能把旧视图当成实际 World 的最新边界；显式 exportWorld 仍可以提供真实冷导出。refresh 恢复完整投影后再更新 worldRevision。持久化围栏必须同时检查 epoch、worldRevision、revision，而不能单独依靠任意一个字段或持有的 DTO。

在 storageBusy 期间不发布选择/速度/其他 hold 等变更。可见/聚焦变化只记录到临时私有状态并重设帧基线，不使稳定保存围栏抖动；因为 storageBusy 本身保持暂停，预备投影的 paused 仍正确。释放存储 hold 时才发布最终前台暂停状态，不写 hidden/player 到候选 World。

## 原会话内替换

`prepareReplacement(world)` 建立单一私有候选，预分配所有视图、完整绑定投影、hold、命令游标、WeakSet、累积器与成功结果，返回冻结身份 token。token 中的 epoch/worldRevision/revision 只用于可检查的本地围栏，真正授权来自该 Session 私有候选的对象身份。

推荐顺序：取得 storageBusy → 冷预备 → 外部持久事务 → 检查同一围栏/存储写权 → 同步 commitReplacement(token) → 释放 storageBusy。数据库事务及写权校验不属于本片。

任何发布使旧候选失效并关闭其 owner。再次准备关闭上一候选；storageBusy 已持有候选时禁止竞争准备。discardReplacement 关闭未使用 owner；close 同时关闭活动 owner 和未绑定候选。复制/跨 Session/已消费 token 无效，检查失败不触碰有效候选的 World。

commitReplacement 的成功路径不再次准入、不重建 DTO、不修改候选 World，只同步绑定已分配状态，随后关闭旧 owner并通知订阅者。最终绑定成功后，即使旧 owner 关闭或某个订阅者抛错，也不会假称回滚。订阅期间重入的状态操作返回 BUSY；其他订阅者仍收到通知。

## 新会话预备与一次性绑定

静态 `ApplicationSessionV10.prepareSession(world)` 返回仅包含 kind 与冻结 readonly preview 的 token。真正实例保存在模块私有 WeakMap 中；它已完整准入并被临时 staging hold 保护，没有可提前推进的实例逃逸。

`bindPreparedSession(token)` 一次性取出已准备实例，使用预分配的无 staging 投影与返回包装，纯同步释放临时 staging hold，不改 World、不做冷准入或视图构造。`discardPreparedSession(token)` 关闭未使用 owner。使用后、复制或伪造 token 均无效；遗弃 token 的调用者必须显式 discard，不能把 GC 当成确定的资源释放。

独立候选 token 自身不能证明另一个正在运行的源 Session 仍然当前。未来协调器必须把 token 与源 Session 的三字段围栏、事务身份和存储写权绑定，在任何失败/过期分支显式 discard，并且只在持久提交成功后消费。此片没有绕过这个外部协调义务，也没有暴露可任意释放 staging 的 setter。

## 测试内容与实际验证边界

`tests/application/session-v10.test.ts` 覆盖固定不可变投影、无隐式冷导出、帧界限、1x/3x与隐藏余量、hold期间无刻/编号、实际命令结果、精确编号重载、拒绝型与真实升级预览的一次性确认、真实部分推进/数值停止、旧版本/恢复专用拒绝、完整存档相同、候选关闭/失败/过期、独立一次性 token、存储围栏与可重入订阅者。

真实升级测试的旧 L1 建筑和材料来自已有真实经营夹具；测试明确使用记录型转换准备 v10 输入，没有把它称作正式迁移。随后药性配伍由真实 v10 命令和每刻准备器完成；Session 实际预览、开始升级、推进、导出/重载与取消升级。没有手写完成升级记录，也不声称本片测试走完400刻升级、完整手机或长期游戏性能。

实施者没有执行测试、类型检查、构建、Git、浏览器或基准。以上是已编写测试的范围，实际通过结果由唯一集成负责人串行补记。未取得验证结果前不把本片标为验收完成。
