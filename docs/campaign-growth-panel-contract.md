# CampaignGrowthPanel：展示与 Session 接线合同

状态：独立面板与 focused tests 已编写。**本工作者未运行测试、类型检查、构建、安装、Git 或浏览器验收**；由集成人串行验证。没有编辑 App、Session、core、注册表或 locale。路线地图继续使用独立 `CampaignRouteMap`。

## 1. 交付文件与边界

- `src/app/CampaignGrowthPanel.tsx`：只读 DTO、命令边界、一次性复兴确认与 React 面板
- `src/app/campaign-growth-panel.css`：纸卷、玉色与铜色样式；两列卡片在容器窄于 620px 时回流单列；44px 操作目标、焦点样式、减少动画支持
- `tests/ui/campaign-growth-panel.test.tsx`：静态语义呈现与真实回调边界测试
- `tests/ui/campaign-growth-panel.locales.fixture.json`：全部新增界面文本的精确中英与参数映射；不代表已写入正式 locale

DTO 不持有 World、combat/history 审计树、领域领取计划、实体分配器或随机流。只依赖 `CampaignRouteId` 与 `School` 的类型。人数、首通、道具、学派和成本没有 UI 缺省值或自动补齐。选择空白不会偷偷使用第一个弟子/学派。UI 不写入库存、知识、人物或装备，也不提供模拟暂停功能。

## 2. Props 与 WorldCampaignProjection 的适配

公共类型导出于 `CampaignGrowthPanel.tsx`；不要把 `WorldCampaignProjection` 整体传入组件。建议由 Session/轻量应用适配器缓存以下 DTO，只有涉及当前投影的权威数据或语言变更时重建：

- `sessionEpoch`：来自 ApplicationSession。新建、读档、替换会话时变化；Panel 内部以 epoch 为 key，丢弃旧选择、通知与确认；卸载后的旧事件闭包也拒绝发指令
- `basisStamp`：**直接使用 `WorldCampaignProjection.basisStamp` 全局状态戳**。UI 不拼接、不 hash、不以 tick 代替，也不使用 `preview(request).basisStamp`
- `readOnly` / `busy`：真实租约/保存/交互阻塞状态，变化立即阻止回调
- `activeRun`：只绝对禁止 `campaign.relief` 和 `campaign.recover`。活动远征期间其他动作仍由 `managementActionsAvailable` 和所提供的目标资格决定
- `managementActionsAvailable`：直接来自核心投影，控制装备领取、典籍学习、邀请招募与遗产交付
- `equipment`：只从 `equipmentClaims` 取已取得、未领的首通权益。`routeId` 是领取身份，不是装备名称；`eligibleDisciples` 只包含核心确实接受此领取的接收人
- `manuals`：从 `lessons` 建立已解锁典籍。`eligibleStudents` 按学校、存活状态、活动/忙碌、前置与已掌握事实过滤；不能只看 `school`。`learnedBy` 来自 `learnedDiscipleIds`，不表示又可以学习一次。空合法学生列表显示明确空态
- `invitations`：只从 `recruitInvitations` 取尚未使用的邀请。`routeNameKey` 从同目录路线定义取。`schools` 只提供实际可选择的 `recruitProfiles`，投影允许的名字/年龄月数/寿元月数/资质原样显示，不生成 profile 或 discipleId
- `relief`：标准补员可用或有值得说明的不可用条件时提供；不支持该规则时为 `null`。`schools` 只含真实合法学校；`costs` 来自当前规则；`conditions` 显示实际资格/冷却/唯一幸存者条件。不可用时必须设置 `blockedReason`，即使学校列表非空也不能发指令
- `recovery`：只有已实现的标准复兴提供；不支持或不应出现时为 `null`。必须有完整、权威的 `losses`、`retained`、`grants` 三组文本，且每组至少一项才能进入确认。复兴不可用但需要展示原因时必须设置 `blockedReason`
- `estate`：仅宗门实际持有、可以明确追踪来源的装备实例；`itemInstanceId` 保持原实例身份。未释放的远征遗产需排除或提供 `blockedReason`。`provenance` 显示真实亡者/死因/去向事实。资格必须遵循核心所有权转移规则：允许的 away 继承人不要因为不能立即换装而误过滤

所有 `CampaignGrowthDisciple.name` 是供当前语言显示的真实名字（支持玩家自定义名与同名区分）；ID 始终保持稳定。语言切换只改变展示文本，不能改变 epoch、basisStamp 或领取身份。

`CampaignGrowthCost` 为 `{ resourceId, nameKey, quantity, available }`：

- `quantity` 取核心实际成本，`available` 是 owned − reserved；不能把预留库存当可用
- 每种资源至多一行、quantity 为正安全整数、available 为非负安全整数；UI 拒绝不足、重复或无效成本行
- `[]` 表示权威规则明确无需资源，不能表示成本查询失败
- 领取和遗产转交目前无资源成本字段，与当前命令一致；未来若有成本需版本化修改合同

`blockedReason`、`conditions`、`provenance`、复兴三组后果使用 `{ key, parameters? }`。这些动态信息必须来自真实选中目录/Session 投影的稳定 locale 键，不把错误 code、内部 ID 或英文运行时异常直接当玩家文案。不要用测试 fixture 的 `test.*` 键做正式展示。

### 复兴内容必须说清楚

真实死亡已先发生。确认必须具体呈现哪些弟子/个人成长已损失，哪些宗门建筑/库存/已获知识/原装备保留，以及新一代真实人物与资源所得。通用框架文本已说明“不复活亡者、不重置首通”；它不能替代这三组具体投影。组件冻结确认时的文本 key/参数与 guard，不会用随后变化的 props 偷换确认内容。状态改变、失租约、busy、重新出发或 recovery 消失都使原确认永久失效；仍保留取消入口，不会把整个页面锁死。

## 3. 精确命令与两层 stamp

`onCommand(request, guard): CampaignGrowthResult` 是同步回调。请求的判别字段已与核心 `CampaignPlayerRequest` 对齐为 `kind`：

```ts
{ kind: 'campaign.equipment.claim', routeId, discipleId }
{ kind: 'campaign.lesson.learn', knowledgeId, discipleId }
{ kind: 'campaign.recruit', routeId, school }
{ kind: 'campaign.relief', school }
{ kind: 'campaign.recover', acknowledgeLoss: true }
{ kind: 'estate.assign', itemInstanceId, discipleId }
```

guard 始终是独立的 `{ sessionEpoch, basisStamp }`，basisStamp 是全局状态戳。UI 不接收或发送 commandId、expectedBasisStamp、costs、profile、sourceId、acquisitionId、terminalLossId 或授予回执。输入边界拒绝额外字段。回调获得分离的 request 与 guard 副本。

Session 回调按以下顺序处理，不能只相信禁用按钮：

1. 比对当前 sessionEpoch、当前 **全局** `projection.basisStamp`、租约、保存/交互阻塞
2. 用同一个 request 调权威 preview/prepare，获取 **请求专属** `preview(request).basisStamp` 与当前 blockers
3. 由 Session 分配唯一 commandId，将请求专属 stamp 放入 `expectedBasisStamp`，提交核心 PlayerCampaignCommand
4. 返回真实同步结果 `{ ok, code?, message? }`，并发布新投影；拒绝/不确定不能返回 `ok:true`

`message` 可使用已注册的参数化错误文本。没有 message 时组件提供本地化通用反馈。核心最终重新验证完整上下文与可保存性；适配器不能绕过成本/资格/首通/模式/上限。

## 4. 重复点击与复兴确认

- 同一个 controller 横跨面板所有卡片，先置 re-entrant latch 再调用应用
- 成功或 callback throw/无有效返回值后，旧 basis 上的任何卡片都不能再次提交；等待全局戳或 epoch 改变
- 明确拒绝不封锁另一种合法选择，但同一个 basis 上完全相同的请求只回调一次；权威 basis 变化才可重试原请求
- `reviewRecovery` 只冻结后果并返回对象，不发命令；通用 `submit` 不接受 recover，即使用类型强转也拒绝
- `confirmRecovery` 只接受该 controller 当前签发的那一个确认对象；复制/伪造、取消后的对象、旧 guard、重复确认均不执行
- Cancel 与 Esc 都撤销确认，不改变 World；默认焦点在取消按钮。关闭后回到复兴入口；若入口已消失/禁用，焦点回到面板
- 确认是页内 `role=group`，不是假冒 modal；不会屏蔽整个页面或抢占战斗 Canvas。Panel 应作为管理屏使用，不盖住战斗中心
- React 只显示待刷新/错误反馈，不做“已领装备”或“已招募”乐观状态授权

## 5. 集成验证请求

由父任务在全部文件冻结后串行执行：

```sh
npx vitest run tests/ui/campaign-growth-panel.test.tsx
npm run typecheck
npm run check:boundaries
npm run check-content
```

Focused tests 覆盖旧/变化 epoch 与 basis、只读/busy、细粒度 active-run 限制、空资格、注入字段、库存不足、重复/跨卡/re-entrant click、异常 callback、取消后确认、确认前无副作用、后果双语、标签、类型安全按钮、epoch remount。当前测试使用 Node 静态 React HTML 与可执行控制器，不声称真实浏览器 DOM 交互或视觉验收通过。

接入后的真实浏览器必测：1280×720、1920×1080、窄屏及150%文本；中英切换；选择学生后成本变化；领取双击；同框跨卡点击；复兴审阅后取消/Esc、存档替换/失租约/新远征；亡者遗产接收与away合法所有权转移。检查真实回执/库存/知识/唯一实例而非仅查看按钮反馈。

## 6. 精确新增 locale 与参数

以下与 `tests/ui/campaign-growth-panel.locales.fixture.json` 完全一致：每个 `entries[key]` 的第0项写入中文 catalog，第1项写入英文 catalog；`parameters[key]` 写入 message specification，无记录的 key 使用空参数对象。正式注册由父任务完成。参数名与类型不应修改，否则需同步面板与 focused fixture。

```json
{
  "entries": {
    "campaign.growth.eyebrow": [
      "归山 · 薪火",
      "Homecoming · Legacy"
    ],
    "campaign.growth.title": [
      "山门承续",
      "The Sect Endures"
    ],
    "campaign.growth.intro": [
      "归来所得，付诸修行。宗门的积累，交到合适的人手中。",
      "Put each homecoming to work. Entrust the sect’s hard-won gains to the right disciples."
    ],
    "campaign.growth.sections": [
      "成长与传承章节",
      "Growth and legacy sections"
    ],
    "campaign.growth.count": [
      "{count} 项",
      "{count} entries"
    ],
    "campaign.growth.readOnly": [
      "当前为只读状态，可以查看，不能领取或变更传承。",
      "This session is read-only. You can inspect these records, but cannot claim or assign anything."
    ],
    "campaign.growth.busy": [
      "正在处理存档，请稍候再操作。",
      "A save operation is in progress. Please wait before making changes."
    ],
    "campaign.growth.activeRun": [
      "远征进行中，暂不能补员或复兴。其他安排仅对当前符合条件的人选开放。",
      "An expedition is active, so relief and recovery are unavailable. Other actions remain available for eligible recipients."
    ],
    "campaign.growth.pending": [
      "指令已处理，正在等待最新宗门记录。请勿重复提交。",
      "The command was processed. Waiting for updated sect records; please do not submit again."
    ],
    "campaign.growth.uncertain": [
      "尚未收到完整操作结果，请先等待宗门记录刷新，避免重复消耗。",
      "The full result has not arrived. Wait for updated sect records to avoid spending twice."
    ],
    "campaign.growth.applied": [
      "宗门已确认本次安排；以更新后的记录为准。",
      "The sect has confirmed this action. The updated records show its result."
    ],
    "campaign.growth.rejected": [
      "本次安排未获确认。请检查最新条件，再选择接收人或重新审阅。",
      "This action was not confirmed. Check the latest requirements, then choose a recipient or review again."
    ],
    "campaign.growth.separator": [
      "、",
      ", "
    ],
    "campaign.growth.costs": [
      "所需物资",
      "Resource cost"
    ],
    "campaign.growth.costLine": [
      "{name} × {quantity} · 可用 {available}",
      "{name} × {quantity} · {available} available"
    ],
    "campaign.growth.noCost": [
      "无需物资",
      "No resource cost"
    ],
    "campaign.growth.insufficientResources": [
      "当前可用物资不足，不能执行；预留物资不计入可用量。",
      "There are not enough available resources. Reserved stock cannot be spent."
    ],
    "campaign.growth.chooseDisciple": [
      "请选择弟子",
      "Choose a disciple"
    ],
    "campaign.growth.chooseSchool": [
      "请选择学派",
      "Choose a school"
    ],
    "campaign.growth.noDisciples": [
      "暂无符合条件的接收弟子。",
      "No eligible recipient is available."
    ],
    "campaign.growth.noStudents": [
      "暂无可学习此典籍的弟子。",
      "No eligible student is available for this manual."
    ],
    "campaign.growth.noSchools": [
      "当前没有可选的招募学派。",
      "No recruitment school is currently available."
    ],
    "campaign.growth.actionFor": [
      "{action}：{name}",
      "{action}: {name}"
    ],
    "campaign.growth.equipment.title": [
      "首通馈赠",
      "Earned Equipment"
    ],
    "campaign.growth.equipment.help": [
      "只列出已取得且尚未领取的装备权益。领取后仍需前往配装。",
      "Only earned, unclaimed equipment is listed. Equip it in the build panel after claiming."
    ],
    "campaign.growth.equipment.empty": [
      "暂没有待领取的装备。",
      "There is no equipment waiting to be claimed."
    ],
    "campaign.growth.equipment.select": [
      "装备接收人",
      "Equipment recipient"
    ],
    "campaign.growth.equipment.action": [
      "领取装备",
      "Claim equipment"
    ],
    "campaign.growth.manuals.title": [
      "宗门藏经",
      "Sect Manuals"
    ],
    "campaign.growth.manuals.help": [
      "典籍留在宗门，每位弟子按真实条件与物资成本学习；学习后自行调整招式。",
      "Manuals remain with the sect. Each disciple must meet the requirements and pay the resource cost, then adjust their equipped skills."
    ],
    "campaign.growth.manuals.empty": [
      "宗门尚无可供学习的战役典籍。",
      "The sect has no campaign manuals available to study yet."
    ],
    "campaign.growth.manuals.select": [
      "研习弟子",
      "Student"
    ],
    "campaign.growth.manuals.action": [
      "研习典籍",
      "Study manual"
    ],
    "campaign.growth.manuals.learnedBy": [
      "已掌握：{names}",
      "Learned by: {names}"
    ],
    "campaign.growth.manuals.unlearned": [
      "尚无弟子掌握此典籍。",
      "No disciple has learned this manual yet."
    ],
    "campaign.growth.recruits.title": [
      "山门招贤",
      "Welcome New Disciples"
    ],
    "campaign.growth.recruits.help": [
      "每份邀请只使用一次。选定学派后，可查看新徒的真实资质与寿元。",
      "Each invitation can be used once. Choose a school to inspect the recruit’s actual aptitude and lifespan."
    ],
    "campaign.growth.recruits.empty": [
      "当前没有未使用的招募邀请。",
      "There are no unused recruitment invitations."
    ],
    "campaign.growth.recruits.invitation": [
      "{route} · 招募邀请",
      "{route} · Recruitment invitation"
    ],
    "campaign.growth.recruits.school": [
      "新徒学派",
      "Recruit’s school"
    ],
    "campaign.growth.recruits.profile": [
      "{name} · 年龄 {ageYears} 岁 {ageMonths} 月 · 寿元 {lifespanYears} 年 {lifespanMonths} 月 · 资质 {aptitude}",
      "{name} · Age {ageYears} years {ageMonths} months · Lifespan {lifespanYears} years {lifespanMonths} months · Aptitude {aptitude}"
    ],
    "campaign.growth.recruits.action": [
      "邀请入门",
      "Use invitation"
    ],
    "campaign.growth.renewal.title": [
      "续火重整",
      "Tend the Flame"
    ],
    "campaign.growth.relief.title": [
      "标准补员",
      "Standard-mode Relief"
    ],
    "campaign.growth.relief.action": [
      "请求补员",
      "Request relief"
    ],
    "campaign.growth.recovery.title": [
      "山门复兴",
      "Rebuild the Sect"
    ],
    "campaign.growth.recovery.help": [
      "仅在真实终局损失后的标准模式开放。先审阅损失、保留内容与新一代的所得。",
      "Available only in standard mode after a finalized terminal loss. Review what was lost, what remains, and what the next generation receives."
    ],
    "campaign.growth.recovery.review": [
      "审阅复兴后果",
      "Review recovery consequences"
    ],
    "campaign.growth.recovery.confirmTitle": [
      "确认承受损失，重续薪火",
      "Acknowledge the Loss and Rebuild"
    ],
    "campaign.growth.recovery.confirmHelp": [
      "本次操作不会复活亡者，也不会重置首通。请逐项确认以下真实后果，再开始新一代。",
      "This action does not revive the fallen or reset first clears. Review each consequence before beginning a new generation."
    ],
    "campaign.growth.recovery.losses": [
      "已失去的",
      "What was lost"
    ],
    "campaign.growth.recovery.retained": [
      "宗门保留的",
      "What the sect retains"
    ],
    "campaign.growth.recovery.grants": [
      "新一代取得的",
      "What the new generation receives"
    ],
    "campaign.growth.recovery.stale": [
      "宗门状态已改变，这次确认已失效。请返回后重新审阅。",
      "The sect has changed. This confirmation has expired; go back and review the current consequences."
    ],
    "campaign.growth.recovery.confirm": [
      "我已了解损失，确认复兴",
      "I understand the loss. Rebuild the sect"
    ],
    "campaign.growth.recovery.cancel": [
      "暂不复兴",
      "Cancel recovery"
    ],
    "campaign.growth.estate.title": [
      "宗门遗产库",
      "Sect Estate"
    ],
    "campaign.growth.estate.help": [
      "分配宗门保管的真实装备实例。装备不会复制；接收后仍需自行配装。",
      "Assign actual equipment held by the sect. Items are transferred, never duplicated, and still need to be equipped."
    ],
    "campaign.growth.estate.empty": [
      "遗产库暂无可分配的装备。",
      "The estate has no equipment available to assign."
    ],
    "campaign.growth.estate.select": [
      "传承接收人",
      "Legacy recipient"
    ],
    "campaign.growth.estate.action": [
      "交付装备",
      "Assign equipment"
    ],
    "campaign.growth.managementUnavailable": [
      "当前宗门边界暂不允许领取、学艺、招募或遗产交付。请先处理待决事项。",
      "Claims, learning, recruitment, and estate assignments are currently blocked. Resolve the pending decision first."
    ]
  },
  "parameters": {
    "campaign.growth.count": {
      "count": {
        "type": "number",
        "format": "integer"
      }
    },
    "campaign.growth.costLine": {
      "name": {
        "type": "string",
        "format": "text"
      },
      "quantity": {
        "type": "number",
        "format": "integer"
      },
      "available": {
        "type": "number",
        "format": "integer"
      }
    },
    "campaign.growth.actionFor": {
      "action": {
        "type": "string",
        "format": "text"
      },
      "name": {
        "type": "string",
        "format": "text"
      }
    },
    "campaign.growth.manuals.learnedBy": {
      "names": {
        "type": "string",
        "format": "text"
      }
    },
    "campaign.growth.recruits.invitation": {
      "route": {
        "type": "string",
        "format": "text"
      }
    },
    "campaign.growth.recruits.profile": {
      "name": {
        "type": "string",
        "format": "text"
      },
      "ageYears": {
        "type": "number",
        "format": "integer"
      },
      "ageMonths": {
        "type": "number",
        "format": "integer"
      },
      "lifespanYears": {
        "type": "number",
        "format": "integer"
      },
      "lifespanMonths": {
        "type": "number",
        "format": "integer"
      },
      "aptitude": {
        "type": "number",
        "format": "integer"
      }
    }
  }
}
```
