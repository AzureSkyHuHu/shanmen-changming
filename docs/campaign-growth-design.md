# 小战役与真实成长：独立领域合同

日期：2026-10-01。状态：独立纯 TypeScript 模块已实现，首轮集成验证由主集成人执行。**尚未接入 World、存档主版本、内容注册表或界面；不代表这五条路线已可在当前游戏中选择，也不代表完整战役或平衡验收完成。**

对应设计：DD-04 修炼/传承、DD-05 远征统一结算、DD-06 永久构筑、DD-12 长期恢复。冻结工程设计包没有改写。当前模块只处理可测试的小战役切片，不把原计划的12节点主线、48事件模板或150年实玩说成已实现。

## 1. 玩家得到的闭环

宗门生产行粮 → 准备合法永久配装 → 三场真实战斗与局内三选一 → 完成返程 → 首通解锁宗门典籍、装备领取权和招募邀请 → 选择领取对象/学艺/新徒 → 下一条有不同对策的路线。

局内天赋不进入成长奖励。典籍归宗门永久收藏，角色学会的是真实已有技能；死者个人天赋、树点和熟练不转写给新徒。装备由唯一 acquisitionId 发放，配装继续由 builds 的 character source 负责。副本首通和奖励领取分开：**真实胜利可以先记载，领取失败仍保持未领，允许安全重试。**

## 2. 五路线图

1. `route.qingfeng-trial` 青峰初试：直接复用现有 `STARTER_ROUTE_ID`、地区、两种普通遭遇和古岩守卫，没有另造平行青峰试炼。首通给行山衣、清心抄本、贯日剑谱和一份招募邀请
2. `route.miasma-seal` 瘴泽之印：青峰后可选。真实清雾毒伤，守印人还会回春；用清心/治疗应对，或快速集火施毒者。首通给治疗法器药泉瓶
3. `route.thunder-seal` 鸣雷之印：青峰后可选，与瘴泽顺序自由。分散远程雷符师、地形绕行和前排护卫；鼓励集火、护卫、打断。首通给攻击法器鸣雷石、援护身法和招募邀请
4. `route.mountain-seal` 镇岳之印：需瘴泽和鸣雷。石卫抱岳吸收伤害，蓄劲储存，真实安装 `talent.fanzhen` 通过普攻释放反击，配震步和后排雷符师。首通给守岳袍
5. `route.everbright-finale` 长明归山：需镇岳。护盾石卫、施毒/治疗者、雷符师的组合，而非仅把一个敌人数值放大。首次胜利记录明确完成，给招募邀请；全部已解锁路线仍可重复游玩，宗门经营继续

每条路线固定三场、每节点一月、返程一月。普通遭遇在路线内仍由远征生成器选择，青峰保留原有两种普通遭遇；新路线各有一种普通遭遇加一场首领。只新增8个遭遇定义，不复制旧青峰敌人。**这些是未平衡基线，尚无等投入队伍胜率或长期难度认证。**

`CAMPAIGN_ENCOUNTERS` 只使用当前执行器已有技能/触发。新增源的反震是敌人自己的战斗来源，不是赠送给玩家的永久机缘。场景渲染需给 `campaign.enemy.stormAdept` 绑定现有适当敌人 archetype，不能从后缀猜成普通山匪。

## 3. 奖励目录与取舍

### 装备

- 行山衣：法衣，+35气血、+600基点控制抗性；不含练功衣的1护甲
- 药泉瓶：法器，+1800基点治疗、+5灵力；较练功法器少15灵力
- 鸣雷石：法器，+4攻击，无额外灵力；与练功法器的20灵力形成输出/续航取舍
- 守岳袍：法衣，+12气血、+3护甲、+1000基点护盾；较练功衣少8气血

均为已有属性桶，不引入可执行内容脚本。不能额外重复安装装备加成：继续由 builds 将属性一次性烘焙到 BattleEntityInput，sourceInstanceId 保留归属与卸装关系。

### 典籍

- 清心抄本 → `skill.qingxin`；丹道，已知清雾，2药草
- 贯日剑谱 → `skill.guanri-jianjue`；剑修，已知留痕剑，2石材（资源稳定ID `stone`）
- 援护身法 → `skill.yuanhu`；体修，已知抱岳，2药草

典籍没有随机掉落阻断。宗门首次取得后永久可查，后代可再次学习。领取计划给同一弟子/同一典籍一份稳定学习 acquisitionId，不能重复付款或重复学会。新徒保留基础学派，不复制死者技能。**桥接必须真的安装 learnedSkills 与培养知识，不能只增加一个“已得典籍”界面数字。**当前学艺计划是付资源直接获得已有技能；既有师徒两月教学可继续服务于已学知识传授，但把教学完成接到 builds 技能的桥接仍需实现。

### 招募

青峰、鸣雷、终章各一份邀请，每份四学派择一；耗4行粮，领一次。属性固定而非用读档反复抽资质。年龄18–21岁、凡人寿元80年、无伤、无修为；各学派侧重点不同。候选ID稳定绑定邀请和学派，实际实体ID由 World 序列器分配。

普通招募和复兴都按 `context.disciples.length` 检查完整档案上限36，**不是只数活人**。已归档身份还须传 `archivedDiscipleIds`，永不复用。一个旧档案仍占完整模拟槽位，先归档后才可接收超过上限的新徒。

## 4. 标准模式复兴

这是玩家明确确认的标准模式机制：全员已经终结死亡、无未完远征、World 提供真实最后死亡ID，才允许 `recovery`。倒地、尚待确认死亡、仍有活人、无死亡记录的新空世界都不满足。

每次复兴：两名**新身份**剑修/丹道学徒，携8谷物和4行粮。宗门建筑、库存、典籍、尚未领取的装备和邀请保持不变。已领取装备不重发，遗物不复制，不复活死者，不复制个人天赋、树点、熟练。新弟子由 builds 的正规初始化获得普通训练装备，这些是新徒基础物品，不能冒充死者遗产。

同一 terminalLossId 只能复兴一次，代数连续且可验证。再次全灭、确认新的真实死亡后可再次复兴；硬核模式始终拒绝。资源包本身也有 acquisitionId，容量不足或下游任一登记失败须整笔回滚。并未借此实现“故意全灭刷装备”奖励：复兴无首通装备、无首通重置，但基础训练装与小额粮食仍可能成为可故意触发的标准模式宽容策略，需实玩平衡而非声称不存在。

## 5. API 与原子提交顺序

导出入口 `src/core/campaign/index.ts`：

- `createCampaignState(mode = 'standard')`：schemaVersion1、rulesVersion1，领域不读时钟/DOM/存储/随机
- `recordCampaignVictory(state, routeId, expedition, combatCatalog)`：仅允许 World 权威结算调用。通过现有 `restoreExpedition` 重放验证整趟历史；检查路线合同精确匹配、全部节点胜利、已完成返程、Ended/committed、真实战斗来源哈希。存第一份首通凭据；重复远征只走原有普通资源掉落
- `campaignProgress(state)`：可选路线、首通、典籍、未领装备/招募、复兴代数、完成状态的只读投影
- `prepareCampaignClaim(state, request, context)`：只读，生成固定成本/效果和 planHash，不预扣、不领走、不标记完成
- `acknowledgeCampaignClaim(state, plan, preTransactionContext, acknowledgement)`：验证原始上下文、版本和所有 acquisitionId 的权威成功收据；成功才写 campaign.claims。精确重试幂等，不再次输出待发放效果
- `serializeCampaign/restoreCampaign/validateCampaignState`：独立版本化规范JSON；读档重建全部首通/领取次序及目录派生内容，而非只信外层校验和

World 桥接事务必须：

1. 从**当前权威 World**构造 context，包括全体完整档案、归档ID、可用资源、学会技能、活动/死亡状态和真实 terminalLossId。不要把这个 context 暴露为玩家自由输入
2. 从真实输入（只允许奖励/学派/弟子选择和复兴确认）准备 plan。招募实体ID要由候选 World 的 ID 序列器分配，拒绝旧ID
3. 在一个尚未提交的 World 副本内，扣固定成本、应用全部下游授权效果及其来源操作。任何失败，包括储物容量、装备注册、学会技能、人口、序列溢出，都丢弃整个副本
4. 下游全部成功后，创建 `campaignEffectsCommitted` 收据，包含这笔事务ID、精确 claimId/planHash 和**全部且不重复**的 acquisitionId。用原始 preTransactionContext 调用 acknowledgement
5. acknowledgement 成功后，一次提交 World 的 campaign/builds/cultivation/inventory/sequences/source ledger/command receipt。不要先保存 campaign 再逐项发奖；也不要先保存资产后将 acknowledgement 延到下一玩家指令

若界面先展示计划，确认时必须重算和复核。发奖中断时保存边界只有“全部旧状态”或“全部新状态”，没有可跨读档半发的中间状态。若需要跨异步存储记录事务，由 World 持久化层既有原子保存负责，不用此模块再加外部状态机。

## 6. 必需的具体 authority 桥接扩展

这些尚未写入现有模块，不能经玩家通用命令入口自由调用：

1. **builds `equipment.grant`（已有）**：注册4件 `CAMPAIGN_EQUIPMENT` 后，传 plan 的 definitionId、discipleId、acquisitionId；源由已有 builds 正规创建。campaign 装备不自动装备，用户仍做配装选择
2. **builds `skill.grantKnowledge`（需新增）**：字段 `commandId, expectedRevision, acquisitionId, discipleId, knowledgeId, skillId`；校验已授权典籍、学派、前置、能力支持与 acquisitionId 去重。记录 `LearnedSkill.origin = 'archive'`、creditCost0。资源成本由同一 World 事务扣，不能再扣现有 learning credits，也不能偷改既有 milestone 奖励凑学费
3. **cultivation `knowledge.grant`（需新增且仅权威）**：字段 `commandId, expectedRevision, acquisitionId, discipleId, knowledgeId`；来源绑定真实 campaign claim。建立可传授知识，初次档案录入用 teacherId/teachingId 为null，不伪造师父。若通过师徒教学完成，必须另有已验证教学完成事实驱动 builds 对应 skill grant
4. **builds `disciple.enroll`（需新增）**：字段 `commandId, expectedRevision, acquisitionId, discipleId, school`；按现有 createBuildFrame 的合法基础技能/训练装备规则分配新来源与实例，不重建所有旧 build，也不向旧 origin偷偷追加人。原始创建信息和后续登记均进入可重放历史
5. **cultivation `disciple.enroll`（需新增且仅权威）**：字段 `commandId, expectedRevision, acquisitionId, discipleId, profile`；只接收重算后的招募目录档案。可复用 createCultivator 检查寿元、凡人修为上限、资质等；出生历法由 `calendarMonth - ageMonths` 和固定月份tick规则创建，不能把“招募日期”当出生日期
6. **World 新人物登记**：实体、导航位置、姓名稳定键、学派、职务、空生产计划、build/cultivation映射一起写；占地与36完整模拟限制重新检查。加入训练武器/法衣/法器时也检查装备历史上限。**外貌必须有持久化的 appearance/presentation ID，与当前 roster 数组下标分离**：归档死者、重排队伍后，幸存者不能突然换脸。新 cohort 由桥接选择美术清单真正支持且符合年龄的外观/肖像变体并保存；迁移时把现有索引外貌固化到角色身份。不能用死者 profile ID 冒充新徒，也不能为外观复用而复制其天赋。当前 campaign 招募目录不擅造尚不存在的素材ID，实际ID由下一版 World/展示合同明确
7. **World 死者归档（需设计）**：保存精简生平/死亡ID/已授传承；清理活人可执行任务和来源引用；武器/法衣/法器归继承人或宗门遗产的规则必须明确。当前 builds 的装备所有者无“宗门库”类型，需 `equipment.transfer`/`estate.transfer` 权威事件及相应可重放校验，不能只改 ownerDiscipleId。campaign 自身既不复制也不转移遗产
8. **inventory 资源效果**：复兴赠品和学习/招募成本，与领取同一事务；reserve/commit 或现有等价资源账本。不能把库存余量快照当永久授权

玩家新命令只应表达“查看/领取奖励、从档案学艺、选学派招募、确认标准复兴”。上列 authority 身份、成本、资料、receipt 不能由 UI 原样传入。

## 7. 存档、目录指纹与迁移

本模块没有修改任何现有 World 保存结构。并入主流程预计需要下一次明确的主存档/simulation版本（由集成人选择，例如v7），不偷偷给v5/v6已保存数据补一个值后称为迁移。

- 旧 World 首先使用其冻结版本的 combat/build/expedition 内容和规则校验。若改了实际 combat catalog，旧 `contentHash`/`catalogHash` 不能与新目录混用；升级活动战斗、已锁配装及局内来源须采用现有显式迁移思路
- **当前 builds.contentHash 只散列 combat catalog，未包含 equipment 和学习规则**。新增装备即使不改变这个哈希，也不能因此宣称完整内容已绑定：新 build rulesVersion/复合目录指纹应覆盖装备、学习规则和登记authority语义；保留旧规则重放迁移
- 新路线/奖励目录均使用稳定ID；此模块自己用 rulesVersion1，变更奖励或招募数值时必须显式升级，不让旧领取计划对着新奖励目录重算
- 新 campaign 初态不得凭现存普通库存推测首通。当前持有完整已结算青峰 run 的档案可在旧数据校验通过后由 `recordCampaignVictory` 建立首通；仅有旧 `region.qingfeng.cleared` 字符串或缺少完整战斗证据的历史不能冒充本模块已验证首通，须明确采用独立历史迁移合同或让玩家再打一趟
- 领取存档结构检查 claimId、acquisitionId、候选属性、固定成本、技能ID、每项收据、代数、事务唯一性和先后解锁关系。哈希仅检测损坏，不是签名/反作弊
- World 的跨域验证还须把 campaign clear 的 runId/settlementId、claim与build/cultivation acquisitionId、招募身份、最终死亡记录真正关联。单独 campaign 快照无法证明外部战斗和人口真相
- 首通只有5条；常规重玩不增加 campaign 历史。领取最多2048笔，快照最多2,000,000字符，触顶明确拒绝新领取但不破坏旧状态。**这是防御界限，不是150年代际无界存档方案**；更长期领取归档/摘要需后续保留跨域幂等证据

## 8. 验证范围和仍缺的验收

测试文件：

- `tests/campaign/progression.test.ts`：真实领域结算证据、锁线与两种分支顺序、继续游玩、首通/领取幂等、上下文变更、领取失败重试、学派/前置/成本、候选固定属性、36完整档案和显式复兴
- `tests/campaign/snapshot.test.ts`：顺序/身份/目录重建；外层校验和甚至内层计划哈希重算后，篡改装备/技能/成本/招募/资源仍拒绝；未知版本/恶意JSON拒绝
- `tests/campaign/catalog-combat.test.ts`：新增遭遇实际创建并推进已有控制器；知识技能能力检查；中英键；高强度测试队完成三场真实青峰战斗→真实远征结算→首通成长。高强度队只验证线路，不能用作平衡证据

主集成人负责运行：`npm test -- tests/campaign/progression.test.ts tests/campaign/snapshot.test.ts tests/campaign/catalog-combat.test.ts`、`npm run typecheck`、`npm run check:boundaries`；然后最终整树检查。本文将在收到实际结果后追加，不预填通过。

仍须：World原子桥接及故障注入测试、新authority命令与重放迁移、实际装备/学艺/新徒界面、战役危机提示、首通展示、中英回退接入、键盘/窄屏、精确版本浏览器实玩、弱队/单专精/主力全伤恢复、同投入三印终章难度测试，以及长期人口/遗产/命令历史归档。没有新增网络、部署、发布或凭据操作。

### 实际验证记录

2026-10-01 10:08 UTC：主集成人报告首轮48项 campaign 测试通过。严格类型检查发现的只读测试克隆问题已修复，领域验证器未放宽。随后增加一项“后续代际复兴/空世界拒绝”回归；最终候选已冻结，主集成人在基于 `ef34f80` 的独立 `validation-domain-extras` 目录运行最终 campaign/history 测试、类型检查和模块边界检查，**最终结果尚待确认**。该记录不覆盖 World桥接、浏览器实玩、平衡或原设计全部内容。

集成者最终独立验证（2026-10-01 10:09 UTC）：在ef34f80基线加本模块及独立历史编码器的隔离目录，战役49项与历史26项测试共75项全部通过；两套TypeScript检查及模块边界通过。这仍不代表World/UI接入、整局平衡或完整原始战役范围完成。
