# v9 弟子成长界面接入

此片只把既有 v9 修炼权威接到经营候选；不改变模拟/存档协议、数据库、内容身份、初始库存、授课知识或旧 v7/v8 入口。2026-10-02 本工作分支只完成代码与测试编写，未自行运行测试、类型检查、构建或浏览器；实际集成验收由根集成者执行后记录，不能将下列测试用例当作已通过证据。

## 有界范围

- `ManagementCultivationPanelV9` 只读取 Session 的固定 `frame`/`cultivation`/选择/暂停快照，年龄来自同帧人物 DTO，寿元、伤势、修为、境界与师承来自已定义培养 DTO
- 当值、修炼、休养使用真实 `training.set`。新文案明确经营占用限制，避免复用旧版“切换会自动取消工作”的不适用描述；照护患者仍可选择核心支持的休养
- 突破预览通过 `prepareBreakthrough` 取得 Session 签发原对象，确认只调用 `confirmBreakthrough`；预留后开始、取消、待决结算分别调用已有窄指令。没有构造假 World、复制提案充当授权、注入材料/奖励、随机结果或人工推进月份
- 显示实际预留材料、月耗和总计划饭食、闭关月数、成功率、总体死亡率、失败条件死亡率、因素、阻碍与警告；预留后的原方案标记为已预留方案，不冒充当前重新估算
- 待决目录来自 `cultivation.decisions`，即使没有选择弟子仍可定位需处理人物。只对真实现存寿尽记录暴露 `death.finalize`；不会生成战斗/突破死亡记录
- 继承人只可选固定 DTO 中的合法存活对象或宗门。存活且突破待决时允许调整；已经待陨落时不允许改继承人，明确显示实际合法受益人或宗门兜底
- 师承只展示实际教/学进度及可用知识数量；没有新授课入口、知识奖励或假设的内容名称

## 暂停与命令边界

`management-v9-cultivation-contract.ts` 是单独有界的呈现合同。原 `managementBlockedV9`/普通经营守卫保持不变。

只在所选人物与现存待决记录相符时，针对对应的 `resolve`、`cancel`、寿尽 `death`，以及仍存活的突破待决者 `heir` 操作允许越过唯一的 `cultivation` 暂停。玩家、隐藏、error、save-capacity、danger、choice、expedition、storage/readOnly、storageBusy、overlay、他人 review、closed、stopped、runtimeFailure 仍然阻止动作。核心保留最终决定权。

每个事件边界核对 Session epoch、所选人物、world/cultivation revision、generation/publication stamp、资源 stamp，并检查实际目标/阶段/合法继承人。提案还核对真正 Session 已发身份、预览 revision/person/resource stamp 和非空 basis hash。仅 `ok: true` 不代表操作已被业务接受；必须读取 `result.status`，培养领域细分错误单独翻译，真实 outcome 再展示。

## 审阅生命周期

独立 `createManagementCultivationReviewV9` 管理真实提案和取消/风险/陨落确认，仅使用共享 UI hold coordinator 取得并释放自己的 review。不可逆结果前必须勾选当前审阅对象对应的风险/永久结果确认；新的预览对象不继承旧勾选。

- 同步消费审阅对象，重复点击原按钮立即失效
- 提案确认保留 review hold，由 Session 仅允许确认已发提案的专用端口处理
- 普通决定指令先请求释放本组件 hold，在微任务后的边界重新核对只读、暂停、目标、所有 stamp 和生命周期，再派发；不会为通过 Session 守卫全局删暂停
- 存储 busy 时延后释放自己的 hold。别的组件尚持有的 review 不会被移除，也不能使普通决定穿过
- 选人、实际存档替换、隐藏、存储锁或其他失效发布会取消审阅；卸载阻止仍在排队的确认。start/stop 支持 StrictMode 重挂
- Document Escape 取消当前审阅；不越过存档 overlay/busy。采用可聚焦的内联审阅组，进入时聚焦确认控件，退出时尽可能回到原触发控件，不谎称独占模态框

## 根组件集成合同

导入 `ManagementCultivationPanelV9`，在已有 roster 之后渲染，传入 `session`、同一 `snapshot`、`readOnly`、同步 `getReadOnly`、`t`、`onFeedback`。可与构筑面板置于现有响应式 `management-v9-panels` 中。锚点为 `#management-v9-cultivation`；样式只复用经营候选已有样式，不新增大表格或粘性控件。

根 shell 保存按钮、时钟控件和放置准备必须识别全局 `snapshot.holds.review`；放置修改只在自己拥有放置审阅时可允许 review。仅检查 shell 本地 placement-review 会让两种审阅重叠。不要在此组件外拷贝突破 proposal，也不要把组件的 review 写入存档。

本片新文案由集成者加入共享中英目录与 schema，11 个 key；原培养文案凡语义仍正确则直接复用。原候选 care 中的只读风险摘要未改变。

## 已编写的验证范围与待验收

`tests/application/management-v9-cultivation-panel.test.ts` 包含：

- 通用守卫仍阻止 cultivation pause；有界真实死亡出口及所有其他暂停/hold/stopped/readOnly 反例
- epoch/person/world revision/cultivation revision/stamp/resource 变化和重复旧边界拒绝
- 真 Session 当值/修炼/休养，真实月份结算修为和休养伤势，工作占用/合法继承人
- 真已发预览 → 明确勾选 → 一次预留 → 真开始；伪造 identity/basis 拒绝
- 更换方案、取消、Escape、选人、隐藏、存储锁、替换、StrictMode 重挂和他人 hold 隔离
- 真预留取消且归还资源；真实月边界到 DecisionReady 后改合法继承人并结算；真实寿尽确认与冷保存解析
- 延迟确认前只读变化、卸载与 busy 期间 release 的交错检查
- 中英文只读 SSR、年龄/伤势/知识空态及总体/条件死亡概率正确区分；组件无 World/storage/reward 转换端口

部分测试使用明确的充足库存/临界修为或生日/月末初始夹具以缩短实际操作路径，之后仍通过真实 Session 指令和固定刻。它们不是从全新普通资源状态培养至飞升的平衡证明，也不替代真实浏览器点击、滚动/中文英文重排、焦点返回、后台恢复、存档跨页以及完整回归与发布检查。


## 集成验证补记（2026-10-02 17:11 UTC）

最终修正后的6文件121项定向检查通过14.00秒。冻结源码35ec73da333c4f8af8b582c4b09dc6e252c6ac98完整通过150文件3016项测试、1205文案、边界/内容、双类型和默认/启用版生产构建，测试944.12秒。前述设计时待检查事项以此实际结果更新；浏览器验收、精确远端CI和部署仍待执行，不能视为完整游戏验收。
