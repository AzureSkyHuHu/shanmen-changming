# v8：五路线战役、真实成长与发布目录接入计划

日期：2026-10-01。状态：**实施计划，未实现、未运行本轮测试**。本文件仅根据当前工作树和既有验证记录编写，不修改冻结设计包，不替代最终集成验收。v7 自动工作仍由当前集成人负责；应先冻结并验证 v7，再执行本计划。文中的新字段/API 是建议合同，须由共享文件负责人确认后落地。

## 1. 本轮结果与边界

优先完成一条真正可从新档玩到结局、失败后能继续经营与重建的五路线战役：

**生产行粮 → 永久配装/修炼 → 选择路线 → 三场真实战斗与两次局内三选一 → 返程统一结算 → 首通成长 → 学艺/换装/招募/传承 → 下一路线 → 长明终章 → 继续经营与重玩。**

五路线是可交付的完整短战役目标，不是原始完整 1.0 的同义词。不能将15次必经战斗称为12个叙事主线节点，也不能把48张战斗机缘称为48个经营事件模板。用户要求完整游戏，完成本轮后仍须继续第12节的原始范围工作，不能以“原型跑通”作为最终交付。

发布门分开记账：

- **G1 五路线闭环**：所有路线、真实奖励、后续成长、补充弟子、实际遗产流转、失败恢复及保存继续可操作
- **G2 扩展机缘可用**：跨成员适配、来源归属、旧档身份迁移、48张逐卡执行与实际合法获取见证全部通过
- **G3 玩家实测**：真实浏览器完成路线/奖励/继承/读档流程，中文和英文、键盘、窄屏检查有证据
- **G4 原始1.0**：另需完成原始经营、事件、建设、研究、人口和长期内容验收；G1–G3通过不能关闭G4

G1可先在开发分支使用冻结旧池，或明确标识的47张可执行新池验证，不必等额外目标失衡阻塞所有战役工作；但任何“48项开放”声明必须等待G2。不能只移除阻塞标签或把未支持效果降级成延迟伤害。

## 2. 经代码确认的接入点与缺口

| 领域 | 当前事实 | v8必须改变的地方 |
|---|---|---|
| World/save | `WorldState`已有builds/expedition/history/automaticProduction；`save.ts`当前为v7，模拟0.7.0，内容仍为`starter-0.1.0` | 添加战役与身份/遗产合同，显式v7→v8迁移；不能回写或冒用v7 |
| campaign | `src/core/campaign`提供五路线、4装备、3典籍、3邀请、标准复兴；49项独立测试曾通过 | 还没有World字段、玩家命令、权威发奖桥、玩家界面或跨域证据校验 |
| expedition | `world-types.ts`出发/预览的routeId是青峰字面量；adapter固定`STARTER_ROUTE`、旧catalog和旧encounter查找 | 改为注册表查询、路线锁与保存的路线身份，不能只扩大TS联合类型 |
| settlement | `runSettled`已经负责普通资源、解锁、build解锁、首次远征里程碑、历史 | 在同一个原子边界登记campaign首通；领取仍是之后的独立原子事务 |
| builds | `equipment.grant`存在；装备查找仅包含6种训练基底；`LearnedSkill.origin`仅starter/study | 注册4件奖励装备；增加可重放的典籍/教学授技、入门登记和遗产转移；不重建旧角色build |
| teaching/death | cultivation有两月教学、寿尽/突破/战斗死亡和relic ID交接；初始无可教知识 | 典籍必须进入真实knowledge；教学完成必须进入learnedSkills；实际build装备目前不会随死亡继承 |
| release | 候选48项，36新增；当前extra-target Stagger不支持；offers仍硬编码12个`AUTHORED_TALENT_IDS` | 选定版本的目录+适配协议；不能仅替换catalog import |
| identity | builds/expedition仅以combat hash绑定内容；release复合候选含新增遭遇，未含3个青峰遭遇 | 完整组合指纹必须含旧/新遭遇、装备/学习规则、奖励/招募、规则与准入协议 |
| presentation | 人物图像按roster下标；敌人依nameKey后缀推archetype；Panel直接读旧combat与遭遇目录 | 持久人物presentationId；显式敌人archetype；所有面板使用所选版本目录 |
| capacity | v7自动预算有1MiB非自动预留；campaign上限2048领取、build上限1024历史/512装备 | 非自动预留不是战役增长证明；新事务、死亡、教学、结束结算必须保持可保存且可恢复 |

这些是工作树观察，不是本轮整树通过。历史验证可查`development-status.md`、`campaign-growth-design.md`和`release-build-catalog.md`。

## 3. 最早需集成人拍板的共享合同

在分派实现前一次确认以下事项，避免三个模块分别发明身份和迁移规则：

1. **版本与唯一目录入口**：建议World saveVersion8 / simulationVersion0.8.0；发布内容ID另命名为稳定的五路线版本。建立一个纯数据/规则注册入口，支持冻结v7身份及v8身份。领域规则版本独立于World版本；不要把“主档v8”当所有内部协议仍可原地改动的许可
2. **旧局续玩策略**：建议已有整趟远征固定旧combat、旧offer生成器与旧路线规则直到Ended；新出发才用新池。旧pending offer、RNG、已获机缘和锁定配装均保留。不要用新池重放旧commandLog，否则历史offer会改变。若选择整局即时迁移，须额外实现并证明每一种阶段、历史offer、锁hash和战斗source的等价迁移，成本明显更高
3. **build迁移与来源合同**：建议build v2采用带明确版本边界的历史重放：冻结v1原点与旧命令前缀，边界执行确定性结构升级，之后仅重放v2后缀。保留既有装备/来源/命令/里程碑ID和receipt语义，不靠替换contentHash通过校验。旧前缀和新后缀的catalog/rules选择要成为保存合同
4. **新徒、遗产与归档**：建议稳定`presentationId`、权威`disciple.enroll`、显式装备owner联合类型，以及独立的死者摘要登记。装备归指定合格活继承人，否则宗门遗产库；新徒初始装是新acquisition，不继承死者点数/天赋/熟练。存活配装必须完整，死者装备转移后的build状态需明确允许“已退役/归档”，不能留下悬空loadout。远征锁内死亡先登记死亡绑定的待办遗产，结束解锁后再转移；不能中途改配装导致既有lockHash失效
5. **模式与缺员恢复**：新档默认标准模式；若提供硬核须开局明确选择且不可中途暗改。既有存档此前没有模式字段，不能从死亡/胜率推断硬核。候选目录只有3份一次性邀请，正常最多从4人增至7人；全灭复兴不能解决“仅剩一人且邀请已用完”的实际困局。先做实玩可恢复性夹具；若失败，集成人需选择一个明确、可计费/防重复的标准补员规则并升campaign规则版本，不能偷偷重置邀请
6. **旧首通认可范围**：只从仍保有完整、已验证Ended青峰run的旧档导入首通；只有`region.qingfeng.cleared`或摘要的旧档不造证据，提示需再完成青峰取得本轮成长。如果希望全面追认历史，需要另设来源限定的迁移合同

这些决策由集成人记录；本计划本身未批准任何玩法改动或新奖励。

## 4. 状态所有权与建议玩家合同

### 4.1 唯一所有者

- **World**：全局序列、人物实体/位置/presentationId、库存、跨域事务、权威死亡/授业/结算关联；所有成功状态一次提交
- **campaign**：模式、5条首通证据、典籍可用性、未领权益、领取/复兴幂等账本。典籍可用性由首通推导，不维护第二个可漂移的“已收藏计数”
- **builds**：个人学校、已学技能、树点与来源、唯一装备实例及owner、配装与远征锁；不自行宣判World已通关或老师已授业
- **cultivation**：真实年龄/寿元/境界/伤势、可传授知识、教学进度、死亡与继承人。装备实例不是relic字符串的替身
- **expedition**：保存的路线身份、所属目录/准入规则、局内状态、补给与offer RNG、当前战斗和结束结算；局内机缘只活于此边界
- **history/estate**：长期死亡身份、曾用ID、遗产转交事实和必要的原始证据。归档不是删掉幂等凭据或降低死亡后人口上限检测
- **Session/UI**：展示投影、语言、选中对象和带epoch的确认提案；不持有可提交的cost/profile/acknowledgement，不分配人物ID

避免`core/campaign/catalog`与`expeditions/encounter-catalog`形成运行时循环。可让共同注册入口组合纯目录；campaign领域接收明确版本的规则/目录参数，World选择版本，内容模块不导入World。

### 4.2 最小玩家输入

建议增加`campaign.command`外层命令，严格closed union，仅接收：

- `campaign.equipment.claim { routeId, discipleId }`
- `campaign.lesson.learn { knowledgeId, discipleId }`
- `campaign.recruit { routeId, school }`
- `campaign.recover { acknowledgeLoss: true }`
- 若引入遗产库，另有经过权威校验的`estate.assign { itemInstanceId, discipleId }`

`commandId`仍由Session/内核协议管理。招募/复兴内部需要的discipleId由候选World序列器分配，**不要把领域层CampaignClaimRequest原样公开给UI**。不接收玩家自填库存、成本、属性、acquisitionId、sourceId、事务收据或terminalLossId。

UI预览按现有departure proposal模式新增`sessionEpoch + basisStamp`。basis必须覆盖campaign revision、build/cultivation相关版本、库存可用量、roster/归档/身份序列、活动/死亡及所选content identity。同tick也可能发生相关改变，不能只凭simulationTick判断未过期。核心最终仍用当下完整`CampaignContext`重算；`contextHash`是最终依据，数值revision只能是明确的World派生令牌，不引用不持久的Session revision。

创建新人物时使用固定招募profile；出生tick满足当前日历与给定年龄，正常公式为`calendarTick - ageMonths * CALENDAR_TICKS_PER_MONTH`，并明确月份内生日约定。出生tick可以是负数，招募时刻不是生日。出现位置选择真实可走格，不随机消耗未声明的RNG。

## 5. 内容身份与旧档迁移

### 5.1 发货指纹

新增版本化manifest，至少明确包含：

- combat definitions与runtime/extra-target协议；源scope、effect和能力准入语义
- 永久build规则、6训练装备+4战役装备、24技能学习规则及authority语义
- 5条路线spec/前置/首通奖励、**3旧+8新=11个遭遇定义**，包括敌人配置、场地、掉落
- 3典籍、4招募模板、邀请成本、复兴资源与模式规则；若新增补员/遗产规则同样纳入
- offer合法性/生成算法版本、run规则版本、campaign规则版本、build规则版本

现有`releaseCatalogIdentity.compositeFingerprint`可做起点，不能直接当最终值。最终新卡失衡补丁会改变候选combat fingerprint，须重新生成manifest。中文/英文文案与渲染资源可另有内容校验/asset manifest，但切换语言不能改变模拟身份或RNG。

保存稳定manifest ID及指纹；程序只解析受支持的注册ID，不把导入存档中的任意目录当可执行内容。版本字符串、hash和规则都须匹配，未知未来版本只读/拒绝并保留源文本。hash用于完整性，不宣称防作弊签名。

### 5.2 推荐迁移序列

1. 固化实际v7已发布/已验证的validator、combat/catalog、offer生成与build规则。不要让legacy validator引用新`EXPEDITION_COMBAT_CATALOG`
2. `parseSave`先校验源envelope/checksum/源contentVersion，再按v1→…→v7的现有明确链条到达v7；新增`validateLegacyWorldStateV7`及`migrateWorldV7ToV8`
3. 将`parseSave`当前“所有版本contentVersion必须等于现值”的逻辑改为源版本允许身份表；否则一改CONTENT_VERSION就会错误拒绝所有旧档
4. 迁移只做确定性结构转换：固化旧人物外貌，初始化战役/遗产索引，建立build历史规则边界，标记旧run内容身份。保持时钟、所有RNG、资源、普通来源/装备/死亡ID、v7自动live job/cursor/watermark与历史页逻辑内容不变
5. 有完整Ended青峰run时，在旧目录下验证并导入一次首通；否则campaign初态不凭库存或unlock猜测。旧未完成run结算时，再通过其旧目录证据登记首通
6. 旧run的controller、boundary、configHash、contentHash、offer与commandLog使用旧解析器/运行规则；新run才绑定发布manifest。旧Ended证据不得在下一次出发覆盖时丢掉唯一首通证明
7. 验证迁移后的所有跨域关联和实际保存字节。默认先暂停提示迁移，读取本身不覆盖原始存储；只有显式保存才创建新一代，保持现有回滚、租约、未来版本保护

新World与迁移World必须进入同一种v8不变量，不能在每个panel处为旧档临时补字段。内部build/cultivation/expedition/campaign schema需按真实形状/规则变化分别升级，不机械地全部叫8。

### 5.3 首通证据的保留

目前`CampaignClear`只保存evidenceHash，`WorldRunHistory`没有routeId且只保存摘要，下一次出发会替换完整run。故v8必须选择明确的证据策略：

- 建议首次胜利保留有界的完整领域结算证据（最多5份），含源目录身份、run origin/route/results/settlement和可用于重放的必要历史，或一个可重建上述事实的既有无损历史引用
- 首通导入必须在权威World的真实战斗结果边界产生；不相信UI伪造的`validatedCombatOutcome`/hash字符串
- World读档验证首通runId/settlementId、route、首次解锁顺序及保存证据一致；修复后重算hash也不能掩盖“没有来源证据”的清关
- 不必永久保存每一场战斗的全部tick日志来声称防作弊；但要明确这是本地语义一致性、真实入口权限和证据关联，不是密码学真实性证明
- 先量出五份真实证据最坏体积，不能存完整副本后再遇到4MiB上限才处理

## 6. 实施顺序与文件责任

每个步骤可分别写单元夹具；共享文件只由集成人合并，仓库全量验证串行运行。不要让v7负责人和v8负责人同时重写save/validation/commands/types/session。

### V8-0 冻结基线与合同

- 保存v7精确内容树/提交与check结果；复制真实v7各阶段save为不可变迁移夹具
- 确认第3节；建立内容注册/冻结规则入口以及v8类型骨架
- 指定共享整合负责人：`world/types.ts`、`kernel/{contracts,commands,save,validation,simulation}.ts`、`application/session.ts`和全局locale registry
- 出口：所有后续模块引用相同ID/type，不需要各自用字符串/断言绕过未定合同

### V8-1 版本目录、Stagger与offer准入

主要文件：`content/release/*`、`core/combat/{definitions,runtime}/*`、`content/schemas/*`、`core/expeditions/{offers,shared,snapshot,types}.ts`、`tools/validate-content/index.ts`。

- 先注册冻结旧池与新池，保留旧算法；新池候选来自版本目录，不再永久受12ID白名单限制
- 按`release-build-catalog.md`的11组精确谓词构造有界能力图：活着的已装备技能/有效来源、真实目标范围与队伍、资源生产/消费、选定recipient、可达触发。条件环不能自己证明启动能力；消费poison不等于生产poison，雷伤不等于Shock，另一人的自盾不等于可给持有人护盾
- 重跑每张卡的rank/互斥/前置；死亡或合法rebind后重算候选。保留已经授予的card来源，不偷偷改持有人或凭空给技能。短池明确补给退路，不伪造第三张
- 若推进48/48，在**新目录**把走脉成符改成显式`additionalTargets:1 / linkRangeUnits:600 / extraTargetStatus(stagger,16 ticks,1 stack)`。冻结旧定义保持原样。执行同一次已提交施法中的确定性额外recipient列表、伤害/附加状态成对顺序；不新开付费cast/root，不引入延迟队列，不把附加失衡发到原目标
- CLI与UI文本验证覆盖所选发布目录，不能`npm run check`仍只检旧12张。
- 出口：47项先具备真实合法获取见证；48项只有显式协议全通过才解锁。此工作可与V8-2并行，最终迁移/组合指纹串行收口

### V8-2 永久成长authority与遗产基础

主要文件：`core/builds/{types,rules,builds,snapshot}.ts`、`core/cultivation/{types,cultivation,validation}.ts`、新`core/world/campaign-bridge.ts`与遗产/身份模块。

- 注册4装备定义；`equipment.grant`只取得所有权，不自动装备。属性依旧只在`buildCombatLoadout`烘焙一次
- 新增authority-only `skill.grantKnowledge`与`knowledge.grant`，相同acquisition关联build/cultivation两端。典籍付库存成本，build creditCost0，不再扣study credits；严格验证学校、前置、已有技能和支持能力
- `LearnedSkill`区分archive/teaching来源及事实ID。教学完成的`cultivation.taught`对应真实knowledge/teacher/teachingId，并在同一World月边界授予build技能。授业入口先检查学生学派、前置和重复知识，不能先教成不合法知识再让build拒绝整个下一月
- `disciple.enroll`分别登记build/cultivation；新角色3件训练装与初始技能按既有正式初始化规则创建。历史可重放，不修改`origin.disciples`伪装其原本就存在
- 死亡时登记唯一死亡绑定的遗产事实；无活动锁者可立即转移，有远征锁者先保存不可领取的待转遗产，`runSettled`按旧lockHash正式解锁后再兑现。真实装备转移先撤旧owner的安装来源，保留itemInstanceId/acquisitionId，再转合法继承人/宗门库。继承人仍在远征时也只取得库存所有权，不改其锁定配装；手动装备才安装新source。不能重发已领取战役装备，待转遗产需要预留结算空间
- 死者归档前确认无未完远征/教学/突破/生产所有权；保存死亡、名字/外貌、生平摘要、遗产与权威引用，从完整模拟列表退出，并让历史引用解析到归档身份。build及cultivation重放要支持退役/归档，不直接splice当前数组绕过validator
- 出口：两个代际的知识与物品都能在下一场战斗产生真实效果，死者个人树点/天赋/技能熟练不复制

### V8-3 World原子领取、模式与恢复

主要文件：`core/world/campaign-bridge.ts`、`kernel/{contracts,commands}.ts`、`world/types.ts`及campaign权威关联校验。

每次领取执行顺序固定：

1. 先处理既有World command receipt的精确重试/冲突，不重新分配实体ID
2. 读取当前World，构造preTransactionContext；在候选序列上分配新身份，生成领域request与`prepareCampaignClaim`计划
3. 在一个候选World内扣available资源、发装备/授知识/创建人物/增加复兴资源，应用全部source操作与所属域收据
4. 验证所有receipt的acquisitionId集合与计划完全一致，调用`acknowledgeCampaignClaim`，传**原始preTransactionContext**
5. 验证跨域不变量、命令收据、历史容量及完整保存候选；全部成功才发布。任何失败丢弃整个候选：库存、ID、人口、build、cultivation、campaign、日志保持原边界

失败后领取权仍存在，可换接收人/腾库存后重试。相同命令重放无重复效果；新命令重复领同一权益明确拒绝。标准复兴仅在全体已最终死亡、无未结束run、有真实terminalLossId时出现，必须玩家确认；Downed/pendingDeath不能触发。保留宗门建筑库存典籍，创建新身份，不复活、不重置首通、不重领战役装备。

### V8-4 五路线接入与统一结算

主要文件：`core/expeditions/{encounter-catalog,world-types,world-adapter}.ts`及新registry、`world/validate-progression.ts`。

- Departure/preview接受`CampaignRouteId`；从campaignProgress读取路线可用性，返回明确UNKNOWN_ROUTE/ROUTE_LOCKED原因，不从UI按钮是否禁用推定合法
- 所有时间、补给、route spec及encounter lookup按所选目录解析；保存routeId和catalog/admission identity，configHash覆盖实际敌人/场地/技能来源
- 敌人archetype写入定义，不再通过`endsWith`猜测。雷符师有真实的现有可用素材映射或新已审核素材，不能误显示山匪
- 在`runSettled`所有普通结算成功的候选World内，确认run已Ended/committed、三场真实胜利且返程完成，再调用`recordCampaignVictory`并记录首通证据。库存满时整笔停留可恢复边界，首通不先偷记
- 下一趟出发前保留首通证据。普通重玩只重复既有普通掉落；首通权益、邀请和个人首次远征点数均不重复
- 旧run仍按旧目录跑完并可授真实青峰首通；v8新run才用新目录和全部五路线
- 不把战斗胜利面板当完成返程；不在终点发马上清除的run天赋。终章显示首次完成事实与继续游玩入口

### V8-5 保存/预算与长期有界性

主要文件：`kernel/{save,validation,migrate-v7}.ts`、`core/save-budget/*`、`world/validate-*.ts`、`history/*`和迁移测试。

- 按第5节建立冻结源校验和迁移；unknown字段、假acquisition、重复身份、假死亡、假首通和重算checksum后的伪造仍拒绝
- 新增campaign领取、教学完成、死亡遗产、招募及首通证据的候选空间检查。未知pending obligations继续阻止自动新开工，不能把新增campaign命令标成“零字节”以放行
- 对异步后续义务预留空间：已接受的教学、已开始run、死亡清理不能到完成时永远因收据/历史上限卡死。离散领取可以拒绝并保留权益，已承诺结算必须能完成或给可恢复的容量处理
- 4MiB是整个UTF-8 envelope上限，2,000,000 campaign字符/4,000,000 build字符不是各自可全占预算。精确测量最终manifest/字段，保持自动job未来取消/返还预算
- 36限制是完整模拟档案，不是只数活人；归档ID永久不复用。超过上限前先安全归档死者，不能允许37完整实体。所有旧history引用须仍可解析
- 1024 build命令、512装备、2048 campaign claims必须有明确停止/归档策略与显示原因。第一次通过五路线不等于无限代际；若未做跨代账本压缩，记录实际可支持的操作/代际窗口而不宣称150年认证
- 出口：保存迁移、重复导入、租约失去、容量拒绝均不会制造半发奖/消失装备/重复新徒；v7自动工作不回归

### V8-6 玩家界面与小战役可读性

主要文件：新CampaignPanel/相应CSS、`ExpeditionPanel`、`BuildPanel`、`CultivationPanel`、`App`、`session`、`status-messages`、locale及Phaser presentation。

- 入口显示标准/硬核规则（仅在真实实现硬核选择后开放）；种子/继续/替换确认沿用现有功能
- 五路线进度图显示前置、预计4个月、实际行粮、机制与对策；青峰后瘴泽/鸣雷双分支自由选择，镇岳要求两印，终章要求镇岳
- 返程后给出可行动的成长摘要：领取装备、学对应典籍、选学派招募、去配装、下一条已解锁路线。显示资源成本/接收对象/满员或不兼容原因，不能只显示“奖励已解锁”
- 典籍学习与配装分离，换装展示真实机会成本；树点显示个人里程碑来源，不每通一条路线白送额外点
- Recruit预览展示真实学校/年龄/寿元/资质和4行粮；同名新徒可用代数/入门次序作显示区分，稳定ID不依名字
- 遗产界面显示死亡原因、真实转交给谁、可分配装备和宗门典籍；复兴明确损失及保留内容，无自动确认
- 在界面销毁/读档/开新局/失租约后旧确认失效；双击领取只产生一笔。新面板不复制full combat/history审计树到每tick DTO
- 全部标题、错误、奖励/新敌人、死亡/传承和说明使用稳定中文键与英文参数一致映射；缺英文逐键中文回退，英文切换不重建World
- 结束声明为“五路线战役完成，可继续经营”，不暗示原始内容总量全部交付

## 7. 五路线实际成长链与可玩最低要求

| 阶段 | 实际取得 | 玩家下一步与必须观察的影响 |
|---|---|---|
| 新档 | 四人合法starter build、既有训练装、可持续谷物/做饭 | 留守生产与出征分工；不靠修改初始资源/作弊属性通过 |
| 青峰返程 | 行山衣权益；清心、贯日典籍；一邀请；符合条件的个人首次胜利里程碑 | 丹道付2草学习清心并选择替换主动；剑修付2石学习贯日；选人领衣但自行换装；招新徒补留守/战斗角色 |
| 瘴泽 | 药泉瓶权益 | 治疗系比较+治疗/+5灵力与训练法器+20灵力，实际改变下一战治疗与续航 |
| 鸣雷 | 鸣雷石权益；援护典籍；一邀请 | 体修付2草学援护，真实友方盾支持符修；法器+4攻换续航；补缺学校 |
| 镇岳 | 守岳袍权益 | 对护盾/反震/控制做准备，比较护甲与气血、盾效；不是仅装备后静态战力数字变大 |
| 长明终章 | 完成事实；一邀请 | 显示三印/终章结果，可重玩所有已开路线；保留永久资产，清理run/encounter来源 |
| 传承/复兴 | 已取得典籍、真实教学所得技能、同一装备实例、标准新身份与小额粮包 | 新生/继承者再次出征；不复制死者天赋/点数，不重置首通；受伤/缺员有已证明的恢复路径 |

四套构筑的合法见证必须使用实际两主动一被动、已有树点和能获得的知识，不把推荐技能列表当单人同时可装备的技能。青峰前应能在没有指定稀有机缘的情况下完成基础挑战；三印和终章允许准备、疗伤及调整构筑，不要求抽到特定卡。

路线数值目前未平衡。必须用正常新档与正常成本进度证明两个分支顺序都可通；高强度测试队只证明接线，不能成为难度认证。新路线普通池各只有一个定义，连续两场相同普通战是当前范围事实，后续需要增加变化。

## 8. 必须新增的验收夹具

建议下列命名便于分工；测试文件只在相关实现任务中创建。本任务未创建或运行测试。

| ID / 建议文件 | 输入与操作 | 必须断言 |
|---|---|---|
| C01 `integration/campaign-world.test.ts` | 正常新档生产→青峰三战→两次合法offer→返程 | 真实库存变化、唯一首通/证据、锁解除、权益出现、旧run来源清空 |
| C02 同上 | 青峰→瘴泽→鸣雷及青峰→鸣雷→瘴泽 | 两种顺序均能开镇岳；提前选镇岳/终章从核心拒绝 |
| C03 同上 | 完成五路线、重玩青峰/终章、保存恢复再领取 | 完成事实唯一；普通掉落可重复，first-clear装备/邀请/里程碑不重发 |
| C04 `integration/campaign-claims.test.ts` | 每一grant阶段注入失败、满库存、sequence溢出、build/cultivation登记拒绝、末尾容量拒绝 | 整个World与输入不变；无资源/ID消耗；权益未领；成功重试一次到账 |
| C05 同上 | 旧预览后用料/死亡/出发/读档/另一个领取；双击/重复命令/同ID不同请求 | 旧确认拒绝，精确重试幂等，变更请求冲突，UI不能伪造成本/ack |
| C06 `integration/campaign-growth.test.ts` | 学3典籍、实际换装/换技能、派出新徒 | builds learnedSkills与cultivation knowledge一致；装备属性一次；新徒源独有；真实战斗显示清心/援护等效果 |
| C07 同上 | 教学完成、老师死亡前后、学生出征/忙碌、异学派/重复知识 | 两月真实时间；死亡中断未完成教学；已学知识保留；授技一次；不产生非法跨学派技能 |
| C08 `integration/campaign-inheritance.test.ts` | 持战役装备角色指定继承人死亡；无继承人死亡；继承人也死亡；双方仍有远征锁 | 同一装备实例/获取ID仅一owner；旧sources撤销；库/继承转交可查；远征lockHash先完整解锁再转移；未复制天赋/点数 |
| C09 同上 | Downed、pendingDeath、全员死亡、同terminalLoss两次复兴、下一代再次全灭；硬核 | 只有已最终死亡标准档可确认复兴；新ID/固定profile；不重发旧首通；新死亡可开启下一代 |
| C10 同上 | 35/36完整档案、归档旧人、旧ID重用、重排roster | 上限真实执行；归档引用可解析；新ID唯一；幸存者sprite/portrait不换脸 |
| C11 `integration/campaign-recovery.test.ts` | 无粮、有伤、主力全伤、单一幸存者、邀请用尽 | 可生产/休养/补员或已明确的安全恢复路径；不要求人为全灭才能修复人口困境 |
| S01 `integration/campaign-v8-migration.test.ts` | 真实v7无run、Travelling、AtNode、InEncounter、RewardPending、Ending/满仓、Ended、有live auto job | 源目录先通过；旧RNG/offer/source/config/锁/库存/时间及auto cursor保留；续玩和不中断旧规则结果相同 |
| S02 同上 | v1–v6链式迁移、源字节读档后、未知未来/坏checksum/坏content | 明确迁移；旧文本不变；只保存新generation；未知/损坏不覆盖 |
| S03 同上 | 只有青峰unlock摘要 vs 完整已结算青峰run | 前者不伪造首通；后者只导入一次；下一run替换后首通证据仍在 |
| S04 `campaign/world-provenance.test.ts` | 重算外层hash后篡改首通route/claim/技能/成本/owner/死亡/候选/transactionId | 独立campaign校验和World跨域校验都不能只信hash通过 |
| S05 `save-budget/campaign-obligations.test.ts` | 近4MiB/历史边界，已开run/教学/自动job与领取同时存在 | 不超上限；领取拒绝可重试；既有结算/取消/死亡清理不因新领取挤占空间被永久卡死 |
| R01 `expeditions/release-admission.test.ts` | 四套合法starter/可学变体；少人、亡者、缺producer、错误盾目标、资源环 | 新候选可用性真实，不把tags当足够证据；缺前置拒绝；每张已开放卡至少一条合法见证 |
| R02 同上 | 至少10000种子、保存/恢复、死亡/rebind、短池/空池、重复刷新 | offer唯一/合法；条件允许才保底；不消耗无效刷新；rng与续玩一致；不硬凑第三张 |
| R03 `combat-advanced/extra-target-stagger.test.ts` | 多跳、满抗性、致死命中、反击杀施法者、source撤除与读档 | 仅extra target一次失衡；顺序/tenacity/source准确；仅一paid cast/root；旧定义及旧快照不变 |
| U01 `application/campaign-session.test.ts` | 确认时读档/换档/失lease/overlay暂停、重复点击、语言切换 | epoch保护；只读无改写；无半发奖；locale不改变save identity |
| U02 `campaign-presentation/presentation.test.tsx` | 中英/缺英文/长名字/禁用路线/满员/无合法接收人 | 明确原因、成本和后续动作；键盘可达；无假奖励和未实现撤退按钮 |

## 9. 实际游玩与浏览器验收

自动化夹具之外，保留一个**正常新档贯穿记录**和一个**失败/传承记录**：记录精确build/manifest、种子、队伍、学艺/点数/装备、花费、选择、伤亡和结局，不能用临时加攻击的测试队代替。

- 两个分支顺序、至少两个实用队伍组合；无指定稀有卡通关见证
- 清心、援护、换装和三选一对下一战的实际贡献；适用卡少时的退路
- 单人/弱队/重伤/没粮恢复，普通死亡及已获装备继承，至少两次代际更替的工程夹具
- 真实Canvas截屏：新徒入门、两印/终章不同敌人、效果区/召唤/额外目标失衡、遗产前后同一身份；静态合成图不算
- 浏览器操作：准备→战斗指挥→奖励→返程→学习/换装/招募→下一路线；中途关闭/刷新恢复；撤回与满仓释放；终章后继续
- 中文/英文、1280×720与1920×1080及窄屏检查、键盘焦点/Esc/返回、125%/150%文本不截断；真实设备/版本与性能记录

观察战斗耗时、资源净收支、伤势恢复月数和重试成本再调数值。记录“测试过的种子与正常队伍”，不凭少量样本声称所有随机种子平衡。

## 10. 集成执行与完成标准

由集成人在冻结树上串行执行相关focused tests、`npm run typecheck`、`npm run check:boundaries`、`npm run check-content`，最后完整`npm run check`，并确认新目录确实被CLI校验。保存真实pass/fail/not-run及精确树版本；后续任何共享schema/content更改使之前相关结果失效。

工程完工清单：

- 五条路线真正可选/可锁/可结算；4件装备、3典籍和3邀请的真实取得/使用都验证
- 新人物可工作/修炼/配装/出征，外貌跟身份；真实装备和知识流向下一代
- 标准复兴、缺员恢复、真实死亡与安全退路有说明；紧急战斗撤退若未实现仍不可声称已支持
- 新目录适配覆盖全部已开放机缘；若47/48必须直说，不能以文件计数通过G2
- v1–v7迁移、旧run pinned semantics、源字节保留及v7自动经营回归通过
- 最终UI/Canvas有实际点击和截图证据；仅DOM或核心测试通过不得关闭G3
- 更新实际状态/验收缺口，保持冻结设计包不变；发布/远端/素材同步由父任务依现有授权执行，本计划不发起Git、构建、上传或部署

## 11. 可并行分工与合并顺序

1. **集成人**先定第3节并冻结v7/版本类型；拥有所有共享内核/World/save/session文件
2. **release worker**仅操作候选目录、combat protocol、offer策略及相应单测；提供冻结旧规则和新registry接口
3. **growth worker**操作build/cultivation authority与重放合同；提供enroll/knowledge/estate原语及故障夹具
4. **campaign bridge worker**待类型明确后接首通/领取/路线和跨域校验；不与集成人同时编辑内核dispatcher
5. **UI worker**基于固定只读DTO实现战役/奖励/招募/遗产面板与本地文本；不自行设计权威状态
6. **QA worker**准备迁移、正常进度及浏览器验收脚本；独立测试运行/安装/构建仍交单一集成人

合并顺序：manifest/类型 → authority与版本重放 → World/首通/迁移/预算 → Session → UI/表现 → 新目录开放 → 冻结整树和浏览器验收。若release协议落后，可先验证完整五路线闭环，但不得在同一个已发布identity下后补改变机缘规则。

## 12. 仍未覆盖的原始完整范围

下列不因v8计划存在而完成，须继续追踪原始requirements/qa matrix：

- **经营建设**：可扩建山门、14类建筑最多3级、建设/搬迁/拆改及维护、16研究节点、季节生态与名望；当前8个固定建筑和6个基础/持续配方不是这套系统
- **完整内容数量**：36配方、18普通敌人/6精英/3区域首领、18装备基底/12类受限词缀、12–18长期角色特质；训练6基底+战役4基底不能冒充18基底
- **叙事与事件**：48个经营事件模板、12个主线节点、关系记忆/外宗态度/后续回声；五路线战斗图没有这些选择和后果
- **人口与传承深度**：中期12–16、常规24/上限36人口循环，生平/师友/纪念与掌门继任，长期补员、遗产库及历史归档；一次性3邀请最多7人，也未证明150年长期体验
- **远征变化与风险**：三个原设计探索区、营地/岔路/精英/环境机制、真实紧急撤退出口/过程及损失、快捷首领重试、耐久和耗寿的完整使用；五路线各三战不能替代全部
- **构筑成熟度**：24技能与36树节点的数据存在不等于全部真实进度可达/已平衡；12–18永久特质、配方制作的装备与完整资源门槛仍需实玩；48候选机缘还须G2
- **终章与长期**：原终章要求生产、阵法、传承与战术共同准备；当前combined-arms首领只验证战斗组合，不能宣称已实现护山灾劫全部经营考核
- **品质与交付**：实际浏览器性能、可访问性与输入设置、长时存储压力/故障恢复、全量英文可读性、素材完整同步与精确发布/交付报告

结论：以五路线的真实闭环解除当前“只有单条案例”的核心缺口；同时把旧档、来源、人物与遗产协议一次做正确。先交付可玩结果，再逐项扩大内容，始终区分“计划、领域通过、World接入、浏览器实测、完整1.0”。
