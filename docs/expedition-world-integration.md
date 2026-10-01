# World 远征、真实战斗与返程整合

2026-10-01。此文记录 `world-adapter.ts`、`world-types.ts`、`encounter-catalog.ts` 与整合测试的实际合同。完整 World v4 字段／迁移／修炼活动锁由 World 负责人实现；App／Session／Canvas 为其他任务。领域测试通过不代表浏览器验收通过。

## 已实现的闭环

1. 从永久配装模块的实际持有装备、两主动、一被动和树节点创建出发队伍
2. 同一事务取消冲突生产、扣除携带补给、锁定永久配装与修炼活动、创建整趟远征
3. 逐 tick 推进现有经营世界，经过原有生日、寿元、风险暂停与生产顺序
4. 进入实际战斗 controller，运行自动选技、移动与受限玩家指令，冻结战略历法
5. 通过保存的参与者映射结算真实胜负、伤势、死亡与掉落，产生持久化三选一
6. 第二次奖励后挑战首领；返程月耗完成后一次性入库、解除全部成员锁并授予首次胜利永久进度

当前起始试炼是三场遭遇（含首领）、两次三选一、旅行三个月加返程一个月。两名弟子的最低补给为 8 份 meal，初始库存可承担；四人要 16 份，预览会给出真实缺口。默认 UI 应先选两名合法弟子，不用不明原因阻止初次试炼。

森林巡逻为双近战敌人，毒谷使用现有清雾毒效果，石卫首领使用抱岳护盾与震步范围控制。普通节点从已声明池确定性抽样，可能重复；首领固定。敌人数值、掉落和伤势阈值属于首轮未平衡调参，不是最终难度承诺。

## 共享合同与职责

`WorldState` 持有 `builds` 和 `expedition`。修炼 profile 的 `activityOwner` 为 `{kind:'expedition',runId,lockId}|null`，使用实际 RunMember.lockId。永久 BuildDisciple 同时持有自己的配装锁；验证器检查双向一致性。

`WorldExpeditionState` 保存：

- run：唯一远征领域状态，包含唯一携带补给账本
- travel：当前月的 checkpointId、startCalendarTick、targetCalendarTick，不保存第二份可消费库存
- battle：controller、configHash、参与者／敌人映射、来源映射和世界 tick 对齐游标
- effectReceipts：已原子应用的领域 effect IDs；没有“保存了新 run 但丢了 effects”的中间状态
- deathMappings：当前 run 内战斗局部死亡身份到 World 全局死亡身份的映射
- history：结束结算摘要；保留 runId／settlementId，与长期 World 命令回执一致，未擅自按 64 局截断
- forcedWithdrawal、blockedReason：超时强制撤回及可恢复结算阻塞的显示状态

`EXPEDITION_COMBAT_CATALOG` 是从现有 authored combatCatalog 生成的一份受控深冻结副本。构筑、远征、战斗和恢复校验使用相同定义／fingerprint。遭遇声明独立于技能目录，没有用临时技能字符串或任意脚本充当能力。

## 稳定 API

所有函数从 `src/core/expeditions/world-adapter.ts` 导入：

- `initializeWorldExpedition()`：供新 World／v4 迁移附加空状态
- `previewWorldExpedition(world, request)`：真实队伍合法性、4 个月成本、库存缺口、寿元不足与伤势警告
- `isWorldExpeditionCommand(value)`：严格的玩家请求边界
- `dispatchWorldExpedition(world, command)`：同步纯 World 转换，返回 `{ok,world,result,eventIds}` 或 `{ok:false,code}`
- `beforeWorldExpeditionTick(world)`：处理已到达但因风险暂停未提交的完整边界，随后协调专属暂停；不推进时间
- `afterWorldExpeditionTick(world)`：消费已经推进的一次世界 tick，推进 controller 或提交到达的月份
- `reconcileWorldExpeditionDeaths(world)`：把已确认自然死亡及其既有 deathId 同步给锁定 run
- `projectWorldExpedition(world)`：边界明确的只读投影；不暴露命令日志／完整结算账本
- `validateWorldExpedition(world)`：恢复 run/controller、锁、时钟、映射与应用回执的一致性

兼容迁移中的旧 World 尚未附加 expedition 时，tick／死亡协调钩子直接返回旧 World。模块不调用 `advanceTicks`；全项目只有 kernel 的一次主循环推进 tick，不发生递归推进。

玩家只可使用 `expedition.depart`、`continue`、`choose`、`reroll`、`supplies`、安全节点 `retreat` 和 `tactic`。World kernel 以 `expedition.command/{command}` 封装，并复用全局命令去重；trusted `time.admit/commit`、`encounter.resolve`、死亡与最终结算不得直接暴露给 UI。App 可另加 sessionEpoch／配装修炼 revision／资源 stamp 防止过时预览确认，但同步派发仍会重新检查实际 World。

当前适配层不新增 World journal 事件种类，`eventIds=[]`。远征状态、结算 history 与 effect receipts 自己承担状态记录；UI 不得把内部 kind 当作未翻译的用户日志。

## 原子出发与锁

出发拒绝死亡／待确认死亡、已有活动锁、已有配装锁、突破中、授课或听课中的成员。已在生产的成员通过现有生产取消事务释放材料与工位。保留原 trainingMode 作为回城意图，活动锁阻止离岗生产、训练、休养与授课；生日和寿元仍照常处理。

`traveling` 继续专指宗门岗位寻路动画，绝不借用它表示远征。出发的资源预留和扣款在同一副本内完成，不向生产专属 World.reservations 留下孤立预留。若任意资源或锁步骤失败，原始 World 完全保留。

年龄本身当前不是试炼禁入规则；寿元可能撑不到返程是明确预览警告。玩家可作这个选择，但不能在后台略过风险确认或把待确认死亡偷偷判定完成。

## 月份预付、暂停与恢复

为了只有一份携带库存，未发布的 run payload 升为 **schemaVersion 2 / expedition-2**：

- `time.admit` 把本月存活名单、补给成本及 checkpoint 身份冻结，立即从 run.supplies 扣一次
- 同 checkpoint 重复 admission 不再次扣除，不依赖调用者只发一次按钮事件
- `time.commit` 只提交这个已存在的检查点，不二次扣款
- 中途减员不退还预付整月成本；全员永久死亡取消未完成旅行时保存 abandonedCheckpoint，包括原冻结名单与成本，不伪造完整月份
- 剩余未开始月份不继续收费；自然死亡发生在返程途中时同样记录中断，不重写已经封存的战利品条款

World cursor 的 targetCalendarTick = startCalendarTick + 1200。主循环每次先执行 before hook，再做暂停判断，随后原有 clock → 修炼生日／月末／风险 → 生产 → after hook。走到月历边界不等于已经完成这整个月的路程，必须到准确 target tick 才提交。

若准确 target 上触发待确认死亡，完整 checkpoint 保留未提交；玩家确认死亡后，下一次 before hook 先提交它再尝试推进新 tick。不会为了恢复而多走一 tick，也不会重复整月成本。测试同时覆盖目标 tick 和月中第 17 tick 的死亡暂停。

AtNode、RewardPending、未开始的旅行／返程和入库阻塞由独立 `expedition` pause owner 控制。player、hidden、cultivation、error 等其他暂停永不被清掉。战斗切至 combat mode，真实战斗 tick 与 World encounterTick 一起推进，calendarTick 不变。

## 战斗身份、来源与死亡

`participants` 在入场时明确记录 battleEntityId → discipleId。战斗局部 entity:3 可以与某个未参战 World 弟子或建筑同名，两者没有身份关系。结果只遍历参与者映射，不遍历“所有死亡实体”去更改 World。

敌人另有持久化 `enemies` 映射：battleEntityId、nameKey、archetypeId。展示使用 ridge-raider／venom-adept／ruin-guardian 的显式身份，不从对象顺序猜敌人或弟子。

角色永久来源记录 World sourceInstanceId → battle sourceInstanceId；装备的固定加成已由 buildCombatLoadout 算入一次，映射明确标记 bakedEquipment，没有再次安装装备机制。技能与树节点仍由战斗执行器各安装一次。

入场通过 `BattleEntityInput.healthRatioBps` 传递已保存的生命比例，并把全部角色／局内来源（包括 boundHolderId）放入同一次 `createBattle`。执行器先安装来源，再按最终派生 maxHealth 初始化生命；不会把基础 120 生命误当成拥有厚土增益后的满血，也不创建第二个战斗副本重装效果。生命比例不触发治疗事件，不改写基础属性。

全队机缘遵循现有执行器合同：各合法成员持有 contender source，但相同定义共享一个 team budget／ICD，只有最高有效来源触发。某一来源 Downed 后其他来源可以接续，不把效果乘以人数。它们不是多份独立光环。指定符修机缘使用同一个显式 boundHolderId；绑定者失效时具体 runtime 的预算消费细节仍由战斗模块负责验证，不能仅凭领域保留卡牌就宣称全部效果正确。

真正永久死亡需 controller entity.life=Dead 且有本地 deathId。适配层为该精确参与者分配一次 World 全局 instance deathId，并把 encounterId、battleEntityId、本地 deathId、discipleId、World deathId 作为映射一起提交；不得把局部 instance:1 直接送入 World 死亡账本。再次恢复／结算复用该身份，不重复分配或继承。自然寿元死亡直接使用现有修炼死亡 ID。

玩家队伍默认 deathRule=downed。Downed／无 deathId 的 Recovered 不是永久死亡。原型恢复明确为倒地幸存者 25% 生命、+25 伤势；非胜利幸存者再 +10 伤势，上限 100。其他存活者保留实际剩余生命比例和灵力。装备耐久目前没有独立永久损耗系统，结果不伪造持久维修。

真实 controller 已终结的结果才可生成 outcome，使用完整实体／统计而非截断显示日志。victory 才发遭遇声明奖励；defeat 保留受伤幸存者但损失未封存战利品。timeout／mutual-elimination 的 draw 按本轮明确政策作为失败的强制撤回，UI 需说明 forcedWithdrawal，不给胜利奖励、不伪造死人。当前没有紧急撤退倒计时／打断过程，所以战斗中不能用安全撤回按钮冒充逃脱成功。

## 一次返程结算

返程最后 checkpoint 完成后预检全部战利品和未用补给容量，才能提交 run.settle。入库、解锁、build 解锁、profile activityOwner 清除、源清理、首次胜利里程碑与唯一 effect receipt 在同一个 World 事务中完成。任何失败都保留原 Ending 状态，尤其不可先写 Ended 再丢失奖励。

仓满保持 INVENTORY_FULL 与原奖励等待，禁止默默截断或丢弃。当前 UI 仍需为这种阻塞提供可解释操作；测试以显式释放库存空间验证重试只入库一次。

结束 run 的成员状态是历史回城快照。之后弟子自然死亡、修炼或换装不会倒改旧 run，也不能因此使旧存档失效。只有仍锁定的 run 要与当前 life/build 完全一致。

## 限制与验证

- 父集成人已执行首轮 11 项实际 World 整合测试，全部通过，约 7.08 秒；这包括真实三场战斗完成与恢复，不是伪造 outcome 的演示
- 随后的历史生命状态回归与额外来源／暂停校验等待统一重跑；最终证据由集成负责人记录
- 后续补充了实际厚土来源的满血／受伤比例入场、一次来源安装与恢复，以及极值 revision 溢出时整笔出发回滚；整合用例已扩展至 14 项，等待统一重跑
- 独立远征领域补强后 32 项测试通过，含 10,000 个抽卡 seed；不是 10,000 次完整游戏平衡测试
- 仅有现有 12 张 authored talents，目标 48 张仍缺 36 张；不支持的执行能力继续过滤，缺卡不编造第三张
- 初始只有 20 grain，已有烹饪会消耗它。普通节点可能不给 grain，因此食物循环尚不自我维持。下一步需要真正的农业／采集生产整合，不能用偷偷抬高遭遇掉落掩盖缺失农耕系统
- 本模块没有完成浏览器 Canvas／输入、视觉、多语言、性能或长周期数值验收；没有因领域测试通过宣称完整游戏已验收

### 2026-10-01 09:19 verified checkpoint

Parent verified all14 World expedition cases and32 domain cases within the frozen511-test suite, then repeated the full boundaries/locales/typechecks/build workflow in an isolated snapshot successfully. This establishes engineering integration, not browser or final-game acceptance.
