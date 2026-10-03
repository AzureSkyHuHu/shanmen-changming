# 私有 v10 普通存档控制器

本片仅新增 `ManagementSaveControllerV10`、专项测试与本文。没有注册路由、修改旧数据库、接入页面/渲染器、自动迁移或发布新入口。验证执行由唯一集成负责人串行完成；实施者未运行测试、类型检查、构建、Git 或浏览器。以下描述实现及已编写检查，不能当作通过记录。

## 固定依赖与生命周期

控制器持有真实 `ApplicationSessionV10`，使用固定 `openManagementV10Repository` 和严格 `parseSaveV10`。不提供可注入 Session factory、可信 validator、任意提交回调、旧版 World 强转或数据库重定向。配置仅透传现有独立仓库的 IndexedDB、租约时钟及同步故障注入点。

`start()` 打开独立 v10 库并读取三槽清单，不自动读取或覆盖现场。活动中的旧操作先被取消并完成清理；启动时用同一 storageBusy 围栏保护异步打开/读取。存储不可用时状态是 `unavailable`，手动保存拒绝，但真实当前进度的文件导出仍可使用；不把内存副本称作持久保存。

`stop()` 同步递增 generation、取消操作信号、停止续租并解除存储绑定，返回等待操作和租约清理的 Promise。订阅者可直接调用而不等待，以免重入死锁。控制器只关闭自己打开的仓库，不关闭调用者的 Session。Session 关闭或非本控制器提交的 Session epoch 替换会停止控制器。重新启动必须显式发起。

writer lease 五秒续期，默认有效期沿用仓库十五秒。续期也持有 storageBusy，并核对全部 Session 围栏；没有强制接管。续期、已绑定保存或同一绑定槽显式重读发生租约丢失、revision 冲突或保留档保护时，控制器停止写入并设置临时只读 hold。租约释放由共享 handle 记账，一次 handle 只发起一次释放；过期/丢失释放失败不重试、不冒充仍有写权。

## 手动保存与明确读取

`canSave(slotId)` 只允许空槽或当前有效 writer 绑定槽。`save(slotId)` 在 hold 内导出新鲜完整 v10 文本，空槽用仓库原子的显式 new-slot 导入获取写权；已有绑定用当前 revision 与续租 token 写 manual generation。只有持久结果完成且围栏仍当前才绑定新 revision、更新时间及清除 dirty。World 没变的选中对象/hold 发布不让已保存进度变脏；真实 World、owner 变化或 runtime failure 会变脏。

读取两步：

1. `reviewLoad(slotId)` 生成一次本控制器拥有身份的 review，包含清单 revision、dirty 和 Session epoch/worldRevision/revision
2. `load(review, replaceDirtyConfirmed)` 再核对身份与现场；若 review 时 dirty，必须显式 true 才能丢弃现场

复制 token、过期清单、现场变化或旧 review 不得读取。获取目标 lease 之后再读一次实际数据；别的 writer 占用时也重新读取并核对已审核 revision，然后只读绑定。恢复 fallback 永远只读，保留坏 current 指针和原始文本，不修复或回写旧槽。其他目标的 revision 冲突不会释放原本正常的当前 writer。

替换使用 `prepareReplacement` 完整预备，在旧现场 storageBusy 未释放期间调用一次 `commitReplacement`。准备、绑定、释放临时 hold 都不向 World 注入 player/hidden 暂停，不重置速度或领域暂停。普通可继续的存档加载后可继续运行；不能套用旧版“已暂停读取”的文案。状态以 `lastAction: loaded/imported` 表达成功，未来渲染器需按实际投影解释状态。没有新增暂停/恢复界面。

## 严格导入与真实导出

`selectImportFile` 限制声明大小和真实 UTF-8 文本，完整解析严格 v10，保存原文作为私有候选。文件读取的选择序号、generation 与全部 Session 围栏防止迟到文件替换新选择；现场发生变化时撤回陈旧读取。状态只保留256字以内文件名及种子/时间摘要，不暴露 World 或原文。

`selectImportTarget` 必须指定三个槽之一并记录当时目标 revision 和现场围栏。`commitImport` 要求相同 selection/slot/revision；占用槽须明确 overwriteConfirmed，dirty 现场须明确 replaceDirtyConfirmed。确认数据经过描述符复制并核对精确字段与基础类型。过期目标或失败提交要求重新选择目标。

完整 Session 预备发生在任何租约获取或写入前。后续存储用显式目标、审核 revision、真实 lease 和取消信号；事务失败丢弃未绑定候选，保留旧 World 和原槽数据。导入成功后数据库仍存原始提供字符串，包括空白/排序，现场是严格准入的等价 World。

`exportCurrent()` 每次调用真实 Session 导出，buildId 固定 `management-0.10.0`，savedAt 为本次平台显示时间；不复用导入封包、不推进游戏、不清 dirty。`exportRawSnapshot(slotId, snapshotId)` 返回仓库保留的精确原文，即使不能解析也可救援。`exportMigrationSource(slotId)` 只读取仓库已有 v9 原文备份，不启动迁移。两者都返回文件描述，由将来的 UI 负责下载和 Blob URL 生命周期。

## 所有权、重入和不可回滚事实

每个异步存储步骤完成后都核对 generation、实际仓库、取消信号、Session epoch/worldRevision/revision 与自身 storageBusy。预备的成功替换是唯一允许的 owner/source 三字段变化：必须符合已预分配的一次递增。外部替换会取消未完成事务，不把新的 host 当成旧现场继续写。

取得 hold 前拒绝已经被占用的 storageBusy。释放只允许自身确实改变并仍拥有的 hold。观察到 false 发布就永久撤销本次所有权；别的调用者之后重新置 true，控制器不会清除。外部 owner 替换继承的 busy/read-only hold 同样不当成本控制器的。只读 hold 也记账：若进入时已由外部设置，成功读取/导入与 stop 都不替外部释放。

订阅者可能在持久提交后、Session 替换发布中或新绑定状态发布时调用 stop。此时不能撤销已经完成的 IndexedDB commit 或已完成的同步 Session swap。状态保留有界 `committed: {slotId, revision, bound}`，明确目标已提交但尚未绑定的情况；不删除已保存目标假装回滚。未提交的事务取消/配额/故障仍由仓库单事务完整回滚。这里不承诺磁盘与内存之间的跨系统事务。

状态使用稳定 `getSnapshot`、深冻结的三槽清单、单个导入/读取 review、单个提交结果及最多五条救援 snapshot id。查询状态和订阅通知不导出 World。观察者抛错被隔离；在操作期间的重复保存/导入不能取得第二个 hold。

## 与 v9→v10 复制 host 的边界

当前 `V9V10CopyHost` 拥有已复制目标的 Session 和 writer lease，正常控制器不能拿一个 receipt 直接冒充持有者，也不能再次获取或写同一个复制目标。此次按集成负责人要求保持两者独立，没有 `adoptCommittedCopy` 或任意 callback authority。

后续接线需要真正原子的、一次性的 host→controller Session+lease 所有权移交，并明确仓库关闭归属。移交实现与专项验证完成之前，复制后的目标仍由原 host 管理，不能让本控制器和 host 同时进行租约 teardown。普通新 Session 的独立打开/明确读取不等于该所有权移交。

## 已编写的检查与剩余范围

新增真实 Session/fake-indexeddb 检查覆盖：固定数据库、手动保存和精确世界往返、无自动读取、不可用导出、原文导入/新鲜导出、dirty 与覆盖确认、跨版本拒绝、损坏/未来档救援、只读恢复、writer 竞争/过期/续租、准备失败、三个事务故障点、源/目标过期、停止重启、双提交、原有/被重新取得的外部 hold、外部 host 替换、提交后停止、替换订阅者停止、迟到文件、冻结有界状态、外部只读所有权。

尚未执行此新增套件；没有实际浏览器/断电/配额/移动端验收，没有页面 renderer 接线，没有迁移 host 所有权移交，也没有公开激活。文件本身不是完整游戏或存档端到端验收证据。
