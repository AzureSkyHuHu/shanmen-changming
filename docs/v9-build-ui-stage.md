# v9 永久构筑界面

本片只在既有 v9 固定 `RuntimeBuildViewV9` 和真实 Session 命令上添加呈现与审阅，不改变内容身份、存档结构、装备来源或领域规则。

## 可用范围与真实边界

- `ManagementBuildPanelV9` 显示所选人物真实流派、两主动与一被动技能、三类已持有装备、里程碑点数和研习额度
- 装备选项只来自所选固定 DTO 的 `equipment`，再按真实定义槽位和流派筛选；没有从完整目录伪造库存，没有新增授予或转移命令。新鲜世界每槽只有一件，选择器因此禁用并说明原因
- 使用 `managementV9BuildContext(snapshot.build.contentIdentity)`；没有将内部 v9 身份注册成旧 v7/v8 内容，也没有把 v9 DTO 伪装成旧 BuildFrame 或完整 World
- 实际 `loadout.set` 可以替换兼容且已持有的器物、选择已学且满足条件的技能，或交换两主动技顺序
- 实际 `skill.learn` 显示并扣除内容规则的研习额度，检查已学、流派、前置、能力支持及真实可用额度。确认说明研习不会自动装备
- 实际 `tree.respec` 检查总已获点数、上限、前置、互斥、流派和仍被已装备技能需要的节点；移除父节点同时移除依赖节点。每节点 1 点、最多 5 点，重配没有额外资源或额度费用；已学技能保持且不退研习额度

### 不能卸空装备槽

`src/core/builds/v2.ts` 的 `loadoutShape` 要求三个不同且非空的合法器物 ID，`loadoutValid` 随后要求三个 ID 都能解析成本人拥有且兼容的器物。`BuildLoadout` 及 `BuildCommand` 也没有空槽表示或 `unequip` 分支。因此当前界面明确说明只能换装，不能卸空。真实卸下功能需要独立的领域与存档设计，不在此片悄悄扩大。

## 暂停、草稿与确认

先点“暂停并编辑”，通过既有 `setPaused('player', true)` 暂停时间，然后进行多步编辑。完成或取消后时间保持暂停，由用户从顶部继续。

永久构筑领域本来允许真实的玩家时钟暂停；新构筑专用 guard 只保留这个许可，不修改通用经营 guard。临时 player hold、hidden、所有其他领域暂停、存储只读/忙、overlay/review、关闭、runtimeFailure、容量或其他停止状态均保持拒绝。人物非存活或真实 build lock 同样禁用。

普通 UI 草稿不冒充 Session 签发的突破/放置提案，也不绕过 `dispatchBuild` 的普通审阅 hold 检查。准备确认和确认提交都重新核对：

- Session epoch、Session revision、World revision、build revision
- 选择种类、ID、选中构筑人物
- 实例 generation/publication stamp 与固定 cultivation resource stamp
- 最新只读来源与当前暂停/占用/运行状态

Session revision 还使“选走再选回”“隐藏再恢复”“打开再关闭其他窗口”等不能复活旧意图。替换会通过 epoch 失效旧稿。控制器只持有一份冻结的真实 UI request 和 DTO 基线，按对象身份确认一次；确认前先消费，拒绝也不允许复用。取消、卸载和 Session prop 更换清理草稿与确认；重复点击和同步重入不产生第二次提交。Escape 只取消本面板草稿，不解除任何领域或其他窗口的暂停。

`SessionCommandResultV9.ok` 只说明收到类型化结果；成功必须是 `result.status === 'accepted'`。BUILD_REJECTED 的 `buildCode`、v9 细分拒绝和 runtime failure 保留不同反馈，不能显示假成功。

### 确认区域焦点

研习按钮位于下方技能库内，确认区域可能在它上方、当前视口之外。每次成功准备审阅时保存真实点击按钮；只有新确认区域已挂载、原 Session/人物/提案仍有效、当前没有存储或其他审阅 hold，且用户焦点还在原按钮、页面 body 或本确认区域时，才单次聚焦实际确认按钮。原生焦点滚动沿用该按钮的固定工具栏 scroll margin，不开定时轮询、不使用全局 autofocus，也不抢其他存档窗口或新交互的焦点。

取消或提交后，只有原按钮仍连接且可用、选择和 epoch 未变、组件仍挂载、没有更新的确认、其他 hold 或新的焦点目标，才恢复焦点。已经删除、disabled 或 aria-disabled 的旧按钮不会重新获焦；成功研习后消失的按钮也不强行恢复。切人、替换、关闭和卸载不恢复旧页焦点。此焦点生命周期不会发送或重试业务命令。

## 集成端口

向 App 导入 `ManagementBuildPanelV9`，传入 `session`、当前订阅 `snapshot`、`locale`、`readOnly`、`getReadOnly` 和 `onFeedback`。Session prop 只要求 `getSnapshot`、`dispatchBuild`、`setPaused`，不要求旧 Session、World getter、export、任意 selector 或历史树。

组件已有唯一锚点 `management-v9-build`、负 tabindex、h2 关联、标签与禁用原因关联；可在主导航加入对应链接。放在人物列表附近，沿用已有 management-v9 响应式卡片与网格。树和技能库默认折叠；装备和当前技能保持可见。所有新界面文字使用已提供的 18 个 `managementV9.build*` 参数化中英文键，既有技能与器物命名走注册内容翻译及逐键中文回退。

## 检查状态

本工作者只完成源码、定向测试与人工代码审阅，没有执行测试、类型检查、构建、Git、部署或浏览器。由唯一集成负责人串行执行并在总体验收记录中写入实际结果。

`tests/application/management-v9-build-panel.test.ts` 覆盖：

- 中英文固定 DTO 呈现、零实际点数、三槽真实持有集合、没有无主目录器物、无卸空选项、可访问标签与默认折叠
- 真实暂停 Session 配装交换、冷保存/解析/替换后保持；取消、复制确认对象、重复点击、重入、卸载控制器与 getter 输入
- 选择及选回、替换、后台及返回、实际刻、存储忙和最新只读失效；逐一变更所有 stamp/revision/resource guard
- `ok: true` 但领域 rejected 的真实区分，以及停止/容量分支
- 确认焦点单次进入/恢复、焦点已移走、不同窗口、禁用/移除按钮、连接状态及实时所有权否决；窄焦点端口测试与源码连接断言不冒充真实浏览器滚动验收
- 显式 qi 初始状态夹具经真实 v9 生命周期授予里程碑后，实际研习扣 2 额度、实际分配/退回树点、已学保留与零额外资源费。该夹具不是完整突破游玩证明
- 仅用于呈现的边界变体测试前置、依赖移除和流派不兼容；这些变体没有注入真实 Session，也不声称是合法存档

尚须集成负责人完成浏览器真实点击与窄屏/缩放截图验收。已有通过的领域或 Node 测试不能替代该关口；本片也不声称装备获取、战斗、远征、长期平衡或完整游戏已验收。


## 集成验证补记（2026-10-02 17:11 UTC）

最终修正后的6文件121项定向检查通过14.00秒。冻结源码35ec73da333c4f8af8b582c4b09dc6e252c6ac98完整通过150文件3016项测试、1205文案、边界/内容、双类型和默认/启用版生产构建，测试944.12秒。前述设计时待检查事项以此实际结果更新；浏览器验收、精确远端CI和部署仍待执行，不能视为完整游戏验收。
