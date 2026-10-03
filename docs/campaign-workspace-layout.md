# 普通战役工作区整合

2026-10-03。实施候选，尚未由集成负责人运行检查或复核新截图。不能据此声称已经部署、完成真实交互验收或通过移动真机检查。

## 依据

用户要求“界面太长了，不能整合一下吗”。实施前实际查看了以下既有截图：

- `layout-review-2355/14-boss-paper-contrast-before.jpg`：战斗之前堆叠路线节点、队伍和补给，进入操作前先滚过说明
- `layout-review-2355/17-battle-paper-contrast-published.jpg`：画布、详情、两方名册、指挥、技能、战报纵向串联
- `layout-review-2355/15-campaign-first-clear-verified.jpg`：顶栏、导航、资源明细、仓储再次占用主内容之前的空间

## 新结构

- 普通 v7/v8 App 的实时资源总数留在紧凑账册摘要，容量/预留明细与仓储表单在原生 disclosure 中。真实返程溢出时自动展开账册，不新增库存命令
- 宗门保持地图为第一主区域，右侧只显示“详情 / 弟子 / 建筑 / 动态”中的一个分类；窄屏同样切换分类，不再把全部详情、名单和事件串在地图下
- 弟子或建筑名册选择后显示详情，并将焦点移到所选详情面板；Canvas 选择只更新所选详情，不抢走 Canvas 焦点
- 历练的路线、当前阶段、节点与携带补给仍在战斗之前简洁显示；完整路线/队伍/背景移到主交互之后默认折叠。危险、阻塞和强制撤退提示保持可见
- 战斗保持一个 Canvas，旁边/下方只显示“发令弟子 / 双方名册 / 查看战况 / 战斗记事”中的一个面板。所选目标的姓名、生命状态和气血一直可见
- 指挥、技能、撤退留在默认面板；双方和召唤物完整名册仍可键盘操作；区域详情与角色状态属于详情面板。战报保留最近 12 条真实日志，没有固定高度裁切
- 普通 App 以 `workspace` 显式启用 BuildPanel 的“配装 / 经脉 / 研习”分类。未传入该标志的共享管理消费者保持原来的全段展示。分类切换不更改或提交草案；离开草案所属分类时提供可返回草案的可聚焦入口

## 边界

只改变本地展示和焦点导航，未改变战斗、时间、保存、核心、内容身份、存档守卫、出征确认、撤退确认、配装提交或草案取消规则。所有标签面板保持挂载，用 `hidden` 移出可访问树/Tab 顺序，局部输入不因类别切换销毁。新导航只处理左右箭头、Home、End，没有安装全局 Escape 监听。

保留既有纸色战斗标题深色规则与原生模态根滚动锁。使用既有本地化键。普通 App 新样式以 `.campaign-shell` 作用域隔离经营候选，未编辑经营布局。

## 待运行验证

集成负责人是唯一执行者，本工作线程未运行测试、类型检查、构建、浏览器、基准或 Git 操作。

建议串行执行：

1. `npx vitest run tests/application/campaign-workspace-layout.test.tsx tests/application/public-layout.test.ts tests/application/expedition-session.test.ts tests/application/expedition-route-preparation.test.ts tests/battle-presentation/presentation.test.tsx tests/battle-presentation/advanced-presentation.test.tsx tests/battle-presentation/paper-contrast.test.ts tests/build-panel-v2/presentation.test.tsx tests/application/overlay-pause.test.ts tests/application/emergency-review-dialog.test.ts`
2. `npm run typecheck`
3. `npm run check-content`
4. `npm run build`
5. 最终整合后按仓库要求运行全仓检查

新增回归涵盖：双语 SSR 的当前面板与隐藏面板关系、键盘导航纯函数、完整名册/技能/构筑保留、默认管理消费者兼容、真实出征后检查点前移、只读展示不改变权威对象、返程容量与焦点所有权的源契约。它们不代替浏览器验收。

## 浏览器验收清单

- 桌面 1174×750 或 1280×720、150% 缩放、约 485px 与 390px 宽度，中英各检查横向溢出与可读性
- 对比战斗画布起点和整页高度；检验窄屏只出现一个辅助面板，未用固定高度遮住控制
- 键盘左右/Home/End 切标签；Tab 只进入当前面板；Space 暂停不被标签抢走；名单选择后详情有稳定焦点
- 实际 Canvas 选择敌我目标，切换名册/详情后返回指挥，所选目标与发令者不变；实际技能、集火、护卫、撤退确认继续可用
- 草案配装/经脉修改后切分类再返回仍在；不误提交，不误取消；更换弟子和存档仍按既有边界清除旧草案
- 普通休养/修炼/职务操作仍可达；地图详情分类不会自动清理其表单
- 保存/菜单原生模态打开锁住背景，Escape 关闭与焦点恢复；未改变玩家或领域暂停
- 真实返程仓储容量阻塞展开资源账册，所有丢弃确认/取消路径保留

已知另项：传承知识下拉可能显示 `knowledge.sun-piercing` 原始标识，由集成负责人另行记录，不在本布局改动中扩展修正。

## Integration validation — 2026-10-03 06:08 UTC

The combined ordinary-App and management workspace snapshot passed both strict
type configurations, 17 focused files/271 checks in 28.59 seconds, three renderer/
modal files/47 checks in 0.597 seconds, and the actual entry-flow file/19 checks
in 2.19 seconds. Module boundaries, content and 1205 locale keys passed; default
and enabled-v8/v9 Pages builds passed. An initially requested entry filename did
not exist, so the actual tests/entry-flow/entry-flow.test.tsx was run separately.
The checked 24-file snapshot exactly matched integration source before this
document update. Independent source review accepted the focused roster transfer
fix and found no remaining static blocker.

These are pre-publication checks. Real viewport height/scroll reduction, Canvas
hide/show recovery, keyboard focus, draft retention and actual interactions remain
required after deployment. Public v10 remains disabled.
