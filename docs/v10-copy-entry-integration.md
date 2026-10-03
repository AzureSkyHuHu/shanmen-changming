# v10 显式来源复制入口接线

日期：2026-10-03。此片将既有复制协调器与一次性存档控制器移交接入 `management-next.html` 的存档窗口。仍只接受构建开关 `VITE_ENABLE_V10_MANAGEMENT === '1'`；没有修改默认值、CI、已有入口或公开访问设置。默认构建不创建 v10 Session 或打开数据库。原 `v10-preview-entry.md` 中“未接复制”的描述是此前阶段记录，本片在它之上新增下列显式流程。

## 玩家步骤与限制

1. 打开 v10 存档窗口本身不打开 v9 数据库。点击“列出 v9 来源与 v10 空位置”才建立隔离的 v9 检查 Session、启动原 v9 控制器，并列出两个版本的槽位描述。此阶段不读取任何槽位成为来源。
2. 选择非空 v9 槽位，再点击“读取所选来源用于检查”。读取使用玩家看到的版本号、原控制器的严格校验和 `takeover: false`。它在不接时钟泵的独立 Session 中恢复保存状态，不替换当前 v10 世界，不推进旧游戏。其他页面持有写租约或恢复保护时保留只读；本流程没有强行接管。
3. 选择明确的空 v10 槽位。占用位置显示版本但禁止选择；检查和真正事务仍独立核对占用，不相信下拉列表的旧状态。
4. 点击检查，临时取得/释放真实来源复制令牌，调用原纯迁移准备，以稳定中英文键显示安静边界障碍。只报告自动经营、进行中工作、蓝图、突破/授课/锁定、生命周期、遗产、容量等障碍；不会替玩家取消、结算或修改历史。
5. 核对来源版本、目标、来源备份语义；当前 v10 进度未保存时需明确勾选替换确认。确认只接受本次审阅对象、完整来源/当前 Session 边界和当前 dirty 状态。
6. 确认期间持有当前 v10 存储暂停，原协调器重新准备、原子提交并绑定；只有固定 `host.transferToController()` 成功后才把实际 Session 和实际普通控制器交给入口。入口递增视图身份重新挂载游戏，异步关闭旧 v10 服务；不重建目标 World、不自动推进、不自动保存。

## 原档、备份及结果诚实性

- 从未调用 v9 保存、导入、覆盖或删除。v9 槽位版本、存档正文和快照保留；正常读取/退休仍会取得、续期、释放既有 v9 写租约
- v10 备份是原协调器捕获的“本次复制所用完整 v9 导出原文”，按原样单独追加保留并同目标原子提交。它不是对更早的槽位 JSON 空白、旧元数据或旧隐藏暂停文本的字节相等承诺；更早原始槽位仍原样留在 v9 数据库
- `committed` 独立记录目标槽位/修订与是否接入当前游戏。事务完成后发生取消、绑定或移交失败仍保留真实回执；不称作回滚，不删除目标。玩家可取消流程，再使用普通 v10 存档列表显式刷新和读取
- 移交成功后的普通手动保存沿用同 owner/epoch。原来源导出备份仍由既有 v10 仓库独立保留，可在普通存档界面原文导出
- 来源清理问题、目标清理问题、已提交未接入都保留区分。清理诊断在此入口生命周期内累计保留，优先于后续失败/取消提示；面板独立展示逐项诊断，重新列出来源也不会抹除此前不确定性。普通控制器的原有清理结果不能升级为浏览器故障/断电保证

## 生命周期和交互所有权

- adapter 的构造无数据库副作用，入口拥有创建/启动/销毁。未挂载的复制来源没有 RAF、Canvas 或游戏 UI
- 显式打开流程后由 adapter 订阅来源控制器与来源 Session。审阅完成后若续租发现失去来源写入权，立即作废审阅并发布只读阻碍，无须当前 v10 世界推进或玩家再次点击。自己持有的在途暂停通知不作误报，操作结束重新检查，并在通知后重新核对 generation 与在途所有权，避免旧操作清除重入新操作的忙态。已写入但绑定失败且来源可复用时保留订阅；已绑定来源若被再次显式读取则重新订阅；取消、成功移交与销毁解除订阅
- 操作开始先同步安装在途标记，再发布 UI 状态；重复提交、尚未读取来源、过时审阅和未确认 dirty 替换均拒绝
- 复制开启期间普通 v10 存档控件用禁用 fieldset 隔离。异步期间存档标题关闭按钮禁用；复制的取消按钮与 Escape 仍可取消后续绑定。已提交回执不因取消而消失
- 取消先作废 generation、关闭 host 并通知来源停止，再等待在途操作结束、关闭自有 Session 和 caller-owned 目标仓库。实际已移交服务不因旧组件卸载而被取消；页面销毁才停止控制器、关闭目标 Session，最后关闭自有仓库
- v9 控制器的既有 `stop(): void` 自己排队等待并关闭其仓库；本片只发起该既有清理，不能把没有 awaitable 回执说成浏览器已证实连接完全关闭
- StrictMode effect 清理/重放不拥有服务启动。每个 controller 的挂载 token 延后一个微任务确认真实卸载，避免 effect 重放误取消；更换 controller 则取消旧流程
- 显式列出后焦点落在来源选择；审阅出现时聚焦可读标题区域；取消后回到开始按钮。焦点只移到仍连接且仍属当前组件的节点；控件保持可换行，英文、中文使用相同参数校验与逐键回退

## 所有权文件与未运行验证

实现：`src/management-next.tsx`、`src/app/management-v10-storage.tsx`、`src/app/ManagementCopyPanelV10.tsx`、`src/app/management-v10-copy.css`、`src/application/management-v10-copy-entry.ts`。

新增测试：

- `tests/application/management-v10-copy-entry.test.ts`：真实 v9/v10 Session、控制器和 fake-indexeddb；显式列表/选择/读取、dirty 确认、重复提交、真实手动续存、审阅后实际来源写租约丢失及即时通知、结算通知重入新操作的忙态保护、绑定失败后不重开流程的再次审阅/租约丢失、清理诊断跨移交失败/取消/重新列表保留、旧存档原文/版本保留、精确来源备份、安静边界、其他写者只读、审阅后目标占用、过时当前会话、取消未提交与事务完成后取消、移交/挂载失败及一次性销毁
- `tests/application/management-v10-copy-panel.test.tsx`：稳定双语/回退、静态面板状态、禁用目标和提交、可取消忙态、真实结果文案、焦点守卫和 StrictMode/卸载 token
- `tests/application/management-v10-copy-preview.test.tsx`：新增模块的未启用隔离；实际入口服务成对切换、旧 Session 退休、目标手动保存语义与最终销毁

实施工作者没有运行测试、类型检查、构建或浏览器复制，也没有提交或发布。建议集成负责人串行执行：

```sh
npm run typecheck
npm test -- tests/application/management-v10-copy-entry.test.ts tests/application/management-v10-copy-panel.test.tsx tests/application/management-v10-copy-preview.test.tsx tests/application/management-v10-preview.test.tsx tests/application/management-v10-storage.test.tsx tests/application/v9-v10-copy-coordinator.test.ts tests/application/v10-copy-controller-transfer.test.ts
npm run check:boundaries
npm run check-content
npm run build
VITE_ENABLE_V10_MANAGEMENT=1 npm run build
```

静态 React 输出和 fake-indexeddb 不能代替真实浏览器的模态焦点、StrictMode effect、上传下载、配额、断电、跨页旧写者和 Canvas 交互验收。公开 v10、真实旧档复制、移动端、长期性能和完整游戏验收仍未完成；不得据此片启用公开 v10。

## Integration checks — 2026-10-03 06:41 UTC

Both type configurations passed. Seven copy-entry/panel/preview/coordinator/transfer/storage suites passed139 tests in59.71s after a test-only module-mock isolation repair; the disabled-import assertion remains intact. Independent source review found and verified repairs for source lease-loss notification, persistent cleanup diagnostics, settlement reentrancy and failed-bind retry observation.

The combined compact layout, seventh serializer and copy-entry snapshot passed21 presentation/renderer/entry files and337 checks in29.74s. Boundaries,1205 locale keys and content passed. Default, enabled-v8/v9 Pages and local opt-in-v10 production builds passed. No runtime/public v10 flag or access scope was changed. These results do not certify an actual browser copy, old-source preservation in the browser, or full-game acceptance.
