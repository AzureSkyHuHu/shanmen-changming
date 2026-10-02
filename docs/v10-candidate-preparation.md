# v10 内部命令与真实单刻候选准备

日期：2026-10-02。范围：未注册的、纯 TypeScript、完整记录检查后的候选准备。**不是 v10 存档准入、未来容量证明、运行时发布、Session 或玩家入口。**

## 固定入口与归属

- `prepareUnregisteredCommandCandidateV10(source, command)`：返回 `{ world, result }`。输入命令立即处理，不放入持久队列；支持原有旧生产、丢弃、自动生产计划、永久构筑、修炼及五种宗门命令域
- `prepareNormalTickCandidateV10(source)`：准备一个真实管理刻；暂停源原样返回；失败抛出且不修改源
- `prepareNoOptionalGrowthTickCandidateV10(source)`：从同一个未改写源重新准备；只跳过旧自动开工和维护续费，已付款工作及生命周期仍执行，不保存任何“关闭”设置
- `isCommandV10` 保留原支持命令的精确语法，并加入固定 `upgrade.start/upgrade.cancel` 玩家语法；外/内 commandId 必须相同，升级命令不接受附带死亡来源、价格、工时或等级

入口先用有界描述符捕获制作自己持有的源快照，再调用 `inspectUnregisteredWorldV10Records`。后续执行只读取此快照，恢复其真实 World 历史归档。不能把 inspector 内部检查过的副本误当成外部可变对象持续有效的证书。候选再次通过同一个固定完整记录检查。精确重试、普通不写入拒绝和暂停返回原完整边界；接受的新结果与调用者输入隔离。

仍拒绝 persisted pending queue、expedition、campaign。跨 World 当前/归档回执及 construction/production/research/care/upgrade 回执检查命令 ID 所有权。升级回执只存在 upgrade 域；没有第二份 World 回执或奖励事件。旧命令的领域拒绝回执行为继续保留。

## 生命周期先行

真实 clock/command 调用固定 `prepareValidatedV10CultivationClock` / `prepareValidatedV10CultivationCommand`，然后将**同一 preparation 的 frame/context/evidence 三个对象**立即交给 `cancelValidatedSectUpgradesForLifecycleV10`。在此之前不重新投影、不跑旧生产取消、宗门取消、里程碑奖励或遗产处理。

升级批次结果组成新 World 后，保留既有顺序：

1. 旧生产取消
2. construction/production/research/care 的真实失效取消；自然休养痊愈保留原修订/月结来源
3. 固定 `managementV10BuildContext` 的境界奖励；永久构筑历史身份仍为 `.3` 旧身份
4. 遗产责任登记、确认没有遗留死者工作所有权、构筑退役及物品移交、培养 archive、World 已故身份与角色移除
5. 同步培养暂停

旧域系统取消继续为 `system/v9/...`；只有升级死亡取消使用固定 `system/v10/death/...`。没有调用者 death flag、通用来源回调或新增授权。旧 pendingDeath 后续确认只结算归档，不重新制造延迟升级取消证据。

## 真实单刻顺序

clock → cultivation/lifecycle/pause → 旧 automatic starts → construction → maintenance → upgrade → sect production → research → care → legacy production → 完整记录检查。

全部工作阶段共享同一个 `WorkPathBudget`。新产生决定暂停的刻保留已经真实前进的时钟和生命周期结果，不给任何后续工作刻。既有 schema-3 伤药效果、工作路径、旧配方及旧自动计划算法保持。

v10-aware 升级、生产、研究和护理只接收 legacy-only 外部上下文，各自使用固定六域本地 claims 一次。旧建造 reducer 只收到其他本地域的工作数和 claims；返回建筑逐项核对其原始等级确为 1，随后以 L1 类型组成 v10，绝不把升级结果写入 construction 原始建筑。

新增 research runtime 保留旧算法、付款/释放、真实到达和有效工时，并固定读取已验证的 library L1 维护区间。它返回 v10 frame，包含 care/upgrade 所有权一次，不把 L2 frame 送入旧 whole-frame validator。

仅有两处旧文件改动，都是类型签名收窄：construction-runtime 的 researchAuthority；research-consumer-gates 的 resolve 和两种 construction gate 来源改为 `Pick<SectResearchFrame, 'construction' | 'research'>`。没有修改这些旧函数体或扩大旧 validator 接受范围。

## 检验材料与尚未证明的事项

新增 `tests/sect-expansion/v10-candidate-preparation.test.ts`：

- 使用真实 v9 已付款历史作为明确的记录测试 lift；额外基础库存是既有显式测试资金，宗门库存、研究、建筑、药品没有伪造来源
- 新 v10 API 执行药性配伍 400 有效刻、升级 200/400 检查点、零粮替代伤药真实生产/送仓、旧物理药剂先消费后选新药剂及两次照护
- 保存形状 JSON 往返续行、冻结源不变、确定性、各工作中间边界、原暂停身份及命令精确重试
- 原命令家族、真实短段施工/取消、跨域冲突、玩家升级语法、持久队列拒绝、独立无可选增长候选
- 显式临近寿尽的合法初始条件，实际下一月结、暂停、升级第399有效刻后先死亡取消、遗产/构筑/培养/World 身份归档；不是完整寿命推进测试

测试、类型检查和构建由唯一集成负责人串行运行；本工作者没有执行这些命令。

2026-10-02 20:00 UTC，集成负责人回报隔离验证结果：本片 candidate 测试、旧/新 sect obligations、upgrade bounds 与旧 v9 management capacity 合计 **5 文件 / 76 项测试通过，119.46 秒**；两套 TypeScript 配置均通过。此前集成检查的 v10 完整记录根 26 项与 death/旧回归 63 项也通过。此处只记录负责人实际报告的范围，不代表全仓检查、构建、浏览器、完整容量 gate 或发布验收。

还缺 v10 **完整** envelope/current bytes、reader chars/nodes、各共享序列、未来月份/生命周期/教学与所有工作终止义务的综合容量 gate。捕获器的遍历上限、单域记录/安全整数检查和升级局部义务都不能替代该 gate。没有导入 v9 headroom，也没有创建替代或伪造容量证书。候选仍必须由后续完整 gate 检查后才能原子发布。

没有新增 save codec、migration admission、private runtime、Session、UI、玩家注册、发布或浏览器验收。没有长历史性能、36人/3倍速/150年或完整游戏完成声明。

集成复验（2026-10-02 20:15 UTC）：暂停/死亡修复后的记录根、死亡与共享时钟叶合计49项通过；候选与旧建造、研究、护理、时钟、codec兼容合计7文件358项通过（237.17秒）。双类型、边界、1205中文键、内容和默认构建通过。独立只读复审未发现这两处修复的遗留实质问题。仍未进行新 v10 玩家浏览器或全游戏验收。
