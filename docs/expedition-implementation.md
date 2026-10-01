# 远征与三选一领域模块

2026-10-01。实现范围为 `src/core/expeditions/**`、`tests/expeditions/**`。这是独立纯 TypeScript 领域模块，尚未接入 World、UI 或 World 存档；不能据此称游戏已可玩。

## 决策与边界

- **临时实现决策：整趟远征为一局 run，单次战斗为 encounter。** ADR-001 仍为 proposed；本实现不把用户尚未确认的边界改写成已批准设计
- 路线由调用者提供的遭遇定义 ID 池生成，使用独立 generation 随机流；模块不生成敌人数值、不编写战斗 AI、不声称这些遭遇已经有内容
- 每条路线 2–9 次遭遇，最后一次固定为首领，不再发会立刻失效的机缘。标准 7 战对应 6 次奖励，深层 9 战对应 8 次，教学 3 战对应 2 次
- 每节点与返程独立标记 0–12 个月。路线当前为有界线性抽样，普通遭遇可重复；分岔选路、营地事件和区域完整内容尚未实现
- 队伍上限 36 名，受整体实体上限约束。出发基本配装完整：普攻、两主动、一被动、武器／法衣／法器。永久树来源按已有前置与排斥关系校验，最多 5 点
- 当前内容全部需要显式 `contentMode: 'experimental'`。默认不能把 definition-only 内容冒充已验证内容；verified 模式会拒绝这些配装

## 公共 API

从 `src/core/expeditions/index.ts` 导入：

| API | 用途 |
| --- | --- |
| `createExpedition(options, catalog)` | 生成 Preparing 状态及完整路线，不扣 World 资源 |
| `expeditionDeparturePreview(state)` | 返回队伍、携带补给与总旅行／返程月数 |
| `applyExpeditionCommand(state, command, catalog)` | 纯转换，返回不可变 state、receipt 与 adapter effects；失败保留原状态 |
| `getNextTimeCheckpoint(state)` | 获取唯一下一月检查点；不推进时间 |
| `legalTalentCandidates(state, catalog)` | 查询真实合法卡及持有人 |
| `previewNextOffer(state, catalog)` | 复制状态后预览，不消费正式 RNG、ID、次数或存档 |
| `serializeExpedition` / `restoreExpedition` | 独立版本化 payload；不修改 World 存档形状 |

所有命令包含 `commandId` 与 `expectedRevision`。相同 ID、完全相同内容重试会返回原 receipt、`replayed: true`、空 effects；相同 ID 不同内容拒绝。过时 revision 拒绝。新 commandId 再次请求已完成结算也不会重复发 effects。

主要命令：`depart`、`time.admit`、`time.commit`、`encounter.begin`、`encounter.resolve`、`offer.reroll`、`offer.choose`、`offer.supplies`、`members.died`、`talent.rebind`、`run.end`、`run.settle`。

## World 原子适配合同

领域模块只能检查输入一致性，不能证明调用者已经推进 World 月份、确实赢得战斗或已获得装备。调用者必须由受信任的 World／战斗适配层构造命令，不能直接把 UI／网络对象当作 validated outcome。

每个 effect 都有稳定 `effectId`。receipt 保存本次 effect IDs。**World 必须将领域状态、资源账本、弟子变化、外部 effect receipt 和保存位置放入同一原子提交。** effect 返回成功不代表外部操作已经执行。若需要异步落库，持久化待提交 outbox，而不能先保存新 run state 再丢弃 effects。

### 1. 出发

1. 调用 `createExpedition` 与 departure preview
2. World 再检查队员存活、空闲、配装真实归属、已有锁及库存。`available` 是快照信息，不能替代实际出发时的原子验证
3. 对 `depart` 返回的 departure effect，用 effect ID 去重；扣除 `debitSupplies`，安装各弟子唯一 `lockId`，停止其生产／修炼资格，与 run 一起提交
4. 远征中禁止修改被锁配装；这不是通过改 UI 按钮即可保证，其他 World 命令也必须检查锁
5. `runId` 必须由 World 保证唯一，不可因新建本模块状态而重复使用

### 2. 每月旅行与返程

`getNextTimeCheckpoint` 返回：checkpoint ID、time settlement ID、节点 visit ID、当前预期月／下一月、离岗弟子、当月携带补给支出。

正确顺序是：

1. 从已提交状态取得 checkpoint
2. 先用 `time.admit` 冻结本月存活名单与成本并预付携带口粮；同检查点重复 admission 不再扣款
3. 对 World 副本运行现有的一月寿元、资源与风险流程，且避免把这批离岗弟子的口粮再从城镇仓库重复扣一次
4. 如需风险选择，保持原 checkpoint 待处理，不把未来月份标记已提交；解决风险后重新验证
5. 只有 World 确实完成这一月，才用 `time.commit` 将两边新状态和 monthCheckpoint receipt 原子写入；commit 不二次扣口粮

`time.commit` 必须匹配预期 checkpoint、起始月和结果月，不能跳月。暂停／关页不消耗月份；战斗期间无合法时间 checkpoint，不按现实战斗秒数加年龄。返程只扣标注的返程月数，不再补扣整趟远征。

临时补给规则为 admission 时每名存活弟子每月 1 份 meal，可由创建参数 `monthlyMealPerMember` 显式设置 0–100。缺粮拒绝 admission，不产生半月状态。月份中途死亡不退还预付成本；全员死亡终止途中时把冻结成本／名单记入 abandonedCheckpoints，不能伪造完整月。需要由 World/UI 提供补给不足处理流程；此模块没有凭空增加粮食的“恢复”按钮。

### 3. 战斗边界

`encounter.begin` 返回锁定的存活队伍、遭遇定义 ID、稳定战斗 seed、当前战略月和应安装的机缘来源；状态变为 InEncounter。

- 用受支持的战斗内容构造真实 `BattleState`／`CombatControllerState`，不以本模块的测试 outcome 代替战斗
- 进入时保存明确的 `battleEntityId → discipleId` 参与者映射，仅锁定队伍成员允许映射到 World 弟子。战斗引擎的局部 entity ID 可能与 World 建筑或其他实体同名，**禁止凭 ID 文本相同认定是同一个弟子**
- `createCombatController` 的 arena/configHash、参与者映射、完整 controller/battle snapshot 和 run state 应一起持久化；恢复时核对 expected configHash
- 敌人、召唤物和装饰实体不能产生 World 弟子死亡、传承或岗位清理
- `EncounterMemberResult` 的 `permanentDeathId` 对活着／倒地后恢复者为 null，真正永久死亡才传稳定死亡 ID。Downed 不等于 Dead；战斗 defeat 可以带回受伤幸存者，不能为满足结算而伪造全员永久死亡
- 胜利／撤离必须至少有一名幸存者。紧急撤离必须由战斗过程确认 `retreatConfirmed: true`；单击撤退按钮不构成成功证明。controller 的 draw 或尚未实现的撤退过程不能静默当成胜利，需明确适配规则
- 结果需包含所有实际参与成员，完整生命／灵力／伤势／耐久，消耗补给、封存／未封存战利品及解锁。模块校验 ID、范围、无重复、补给余额和死亡一致性，不重演战斗真伪
- 收到 encounterResult effect 后，提交 World 伤势与永久死亡，按 `resultId`、死亡 ID 去重；清理旧 encounter 和待执行队列。机缘身份跨场保存，护盾／中毒／冷却／临时触发状态不从旧场直接复制

`talentSources` 中的局内 instance ID 是领域身份；适配层应维护它到战斗 sourceInstanceId 的映射。每个 team talent 只有一份全队共享 budget；现有执行器允许给多名成员安装 contender 来源，再按最高有效值选择唯一激活源，以便一人倒地后继续生效。不能把这些 contender 当成按人数叠加的独立光环。当前 12 张定义的触发计数均为 encounter scope。未来若新增 run-scope 次数预算，必须先增加跨场预算转接，不能每场重新初始化后宣称满足 run 上限。

模块会用 `combatDefinitionSupport` 检查技能／永久树和抽卡，排除 move、zone、summon、非零 chain stagger 等当前不支持的执行能力。

### 4. 死亡与三选一

局外月风险永久死亡由 World 权威死亡事务调用 `members.died`，并传递一一对应死亡 ID。个人机缘立即移除，全队机缘保留；绑定指定符修的全队机缘在该持有人死亡后暂不安装，可在合法场合显式 `talent.rebind` 给存活符修。不得自动赠给另一人。

已展示 offer 保存 offerId、reward ordinal、revision、候选 ID、每卡持有人、全部展示历史、RNG 前后状态、刷新余额、保底计数与选择 commitId。选择确认重新计算合法性。

当权威死亡改变候选或来源，原奖励机会原地重建并增加 offer revision，旧 revision 选择被拒；不额外发奖励、不扣刷新。卡牌来自真实技能／效果来源，不仅看文本标签。例如：丹修施毒、符修消耗毒时，消毒触发的个人机缘给符修；丹修阵亡导致毒源消失后，即使符修仍存活，也不继续提供无法发动的卡。

每 run 仅两次刷新。刷新至少有一个全局此前未展示的合法 ID；不存在则禁用且不扣次数、不消费 RNG。抽样无放回，偏好权重有界，最多选两个偏好标签。

第一份合法奖励优先给能工作的 core，满足“前两次内出现”的窗口；选 core 后最多两份后续奖励内优先提供对应 support。无法满足时记录显式诊断，不用非法卡冒充保底。当前没有已编写通用卡，因此不能保证每组三张都有通用类别。

少于三张时只列真实合法选择，始终可放弃当次卡换 2 份 meal；完全空池也是明确补给选择。补给选择消耗同一个奖励机会，不能以后回来领卡。此数量为临时未平衡配置。

**只收录现有 12 个具名机缘，目标 48 张中剩余 36 张未实现。** 其中 `talent.zoumai-chengfu` 的非零 chain stagger 当前战斗执行器不支持，故不会出现。其他卡也可能因技能、人数、前置、相斥、满级或活着的来源不足被筛除。没有用虚构占位卡填满三选一。

### 5. 一个 EndRun 结算入口

- 首领胜利、已确认紧急撤离、战斗 defeat 自动进入 Ending；安全节点／待领奖节点可请求 safeRetreat
- 胜利与安全撤回保留全部已得战利品；紧急撤离保留全部封存物及逐资源向下取整的 50% 未封存物；defeat 清空未封存物。50% 是冻结设计里的首轮临时值，未声称平衡完成
- 结算 ID 固定，损失规则／战利品／解锁条款在进入 Ending 时锁定。返程进度与实际未用补给随月 checkpoint 更新；中途风险不让 Ending 提前变成 Ended
- 有幸存者就结算标注返程月数；全员永久死亡无返程月耗。返程开始后额外死亡不重写已封存的奖励条款，由 World 处理死亡后果
- `run.settle` 仅在返程完成后产生一次 runSettled effect：战利品、未用携带补给、解锁、幸存者解锁、永久死亡 ID 关联清理、全部 run talent 来源与 encounter 清理
- 未用补给目前独立于战利品折损，结算归还；这是一条显式临时实现规则，后续若将撤退／全灭补给纳入折损，应修改规则版本与测试，不得 UI 提示一套、账本另一套
- 重复结束／结算不重复发奖励。新的首领快速重试必须使用新 runId，并在旧 runSettled 已经原子提交后创建

## 保存与信任边界

独立 payload 当前为 schemaVersion 2 / expedition-2，加入预付月份 admission；尚未发布到旧 World 存档，不静默接受先前试验 payload。保存内容 fingerprint、完整起始输入、路线／offer／机缘／结算状态和最多 512 条已接受命令。恢复先做 plain-JSON、大小、版本和 checksum 检查，再从起点重放命令，逐字比较标准化最终状态。因此篡改候选而只重新计算 checksum 仍会失败。

这是损坏和不一致检测，不是防作弊认证：能够同时改写合法初始输入与整段历史的人仍可构造另一个合法世界。World 总存档版本、跨模块恢复、IndexedDB 原子事务与迁移由整合层处理。不能从任意 parse 出来的对象直接调用转换器；先走 restore。关闭页面保留当前远征，不自动撤退或刷新。

## 验证记录

- 父集成人执行的首次 expedition 检查：28 项测试通过，包含 10,000 个 offer seed，耗时约 6.12 秒；无 expedition 类型错误
- 此后补强真实触发来源与 Downed／永久死亡区分，并增加对应回归测试；父集成人最终重跑 30 项全部通过，含 10,000 seed，耗时约 6.59 秒；当前全项目类型检查通过
- 为 World 整合增加冻结月份 admission、月中死亡与中断记录后，父集成人重跑 32 项全部通过；具体 World 整合与后续证据见 expedition-world-integration.md
- 10,000 seed 是隔离 offers 随机流的合法性、持有人、core 窗口和预览纯性 sweep；并非 10,000 次完整远征／战斗或数值平衡测试
- 用例覆盖三战旅行／返程对账、checkpoint 暂停／恢复、缺粮不部分结算、战斗身份／结果拒绝、四种结束、受伤幸存者 defeat、个人持有人死亡、团队来源保留、原地 offer 重建、空池／不足池、无新卡禁刷新、双刷新总预算、重复选择／结算、保存 RewardPending／InEncounter／Ending 后确定性恢复，以及伪造 offer 拒绝
- 尚未执行 World／战斗／UI 的端到端整合、真实浏览器恢复与可玩性验收；本任务没有改 World、UI、全局存档 schema、依赖或执行提交
