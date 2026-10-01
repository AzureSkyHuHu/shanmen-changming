# 需求目录与追踪

需求ID在本版本内稳定。正文设计源是唯一玩法原始依据；本表是工程验收解释，不增加用户已确认要求。数值均为待测试基线；REQ-015仍是待确认假设。REQ-029/030同时来自本次交付边界；REQ-031是用户随后明确要求的1.0范围。

<a id="req-001"></a>
## REQ-001 · 产品边界

纯单人桌面浏览器、中国修仙宗门；1.0 无账号/联机/PvP/内购/云存档依赖。

依据：[设计源第1节](../source/game-design.md#s01)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-002"></a>
## REQ-002 · 活的宗门

俯视可点选场景，行为可见且能解释岗位、路径、工时和产出的关系。

依据：[设计源第4节](../source/game-design.md#s04)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-003"></a>
## REQ-003 · 人口与规模

开局4人，中期12–16人，常规24人、硬上限36人；切片演示6名弟子。

依据：[设计源第2节](../source/game-design.md#s02)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-004"></a>
## REQ-004 · 三种时钟

权威经营历法、战斗逻辑、表现插值分离；固定步长、安全暂停、远征节点月耗只结算一次。

依据：[设计源第3节](../source/game-design.md#s03)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-005"></a>
## REQ-005 · 确定性核心

纯TypeScript模拟，不依赖DOM/Phaser/React/墙钟；种子随机、稳定ID、有序指令及可复现回放。

依据：[设计源第19节](../source/game-design.md#s19)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-006"></a>
## REQ-006 · 任务与空间

岗位、材料与入口预约；可达路径计运输时间；中断可恢复且不可重复产出。

依据：[设计源第4节](../source/game-design.md#s04)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-007"></a>
## REQ-007 · 经济安全

库存/预留/在途/已消耗分账；无负库存、无配方套利；基础资源与关键材料有恢复路径。

依据：[设计源第7节](../source/game-design.md#s07)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-008"></a>
## REQ-008 · 建筑研究

14类建筑最多3级、16个研究节点；蓝图、施工、维护、迁移与道路校验。

依据：[设计源第8节](../source/game-design.md#s08)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-009"></a>
## REQ-009 · 人物与关系

需求、资质、特质、师承、三轴关系与事件记忆；变化有原因、上限与预告。

依据：[设计源第5节](../source/game-design.md#s05)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-010"></a>
## REQ-010 · 修炼突破

四个修行境界，准备成本、成功率与失败死亡率分离，抽样与事务存档可追溯。

依据：[设计源第6节](../source/game-design.md#s06)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-011"></a>
## REQ-011 · 寿元死亡传承

经营年龄与寿元、战斗倒地/获救/永久死亡区别清楚；一次性遗产、历史、继任与复兴。

依据：[设计源第5节](../source/game-design.md#s05)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-012"></a>
## REQ-012 · 自动与战术

4→6人小队；自动作战、暂停排令、集火/护卫/移动/技能/有限消耗品/有过程撤退。

依据：[设计源第9节](../source/game-design.md#s09)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-013"></a>
## REQ-013 · 技能与配装

24项技能（四门类各4主动+2被动）；普攻+2主动+1被动、3装备槽；终极占主动槽。

依据：[设计源第10节](../source/game-design.md#s10)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-014"></a>
## REQ-014 · 永久树

四棵9节点树、每角色5点、每节点1点；宗门内免费重配，出征锁定，死亡不复制整树。

依据：[设计源第12节](../source/game-design.md#s12)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-015"></a>
## REQ-015 · 远征一局假设

暂定整趟多战斗远征为run；标准6次、深层最多8次、教学2–3次选择；需开工前确认。

依据：[设计源第11节](../source/game-design.md#s11)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-016"></a>
## REQ-016 · 三选一机缘

48张，36个人/12全队；另按12通用/24门类/8跨门/4路线分类；合法抽选、保底、两次刷新、空池退路。

依据：[设计源第13节](../source/game-design.md#s13)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-017"></a>
## REQ-017 · 四套构筑

回潮剑阵、药火共炉、玄甲回响、三曜流转；底盘能自启动，局内改变组合而非救活无用技能。

依据：[设计源第14节](../source/game-design.md#s14)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-018"></a>
## REQ-018 · 统一协议

技能、天赋、装备、状态用白名单协议；定义/实例ID分离；scope与duration分两轴。

依据：[设计源第20节](../source/game-design.md#s20)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-019"></a>
## REQ-019 · 结算管线

预约→提交→命中→数值→防御→盾→生命→濒死→倒地/死亡→事件→后续触发；不可绕过唯一写入口。

依据：[设计源第21节](../source/game-design.md#s21)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-020"></a>
## REQ-020 · 来源与触发

精确来源账本、固定排序、事件触发快照、深度8/派生64初始保险预算与可解释诊断。

依据：[设计源第21节](../source/game-design.md#s21)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-021"></a>
## REQ-021 · 区域与首领

三地区、18普通/6精英/3首领；预告、可处理机制、阶段切换、补给和低运气保底。

依据：[设计源第16节](../source/game-design.md#s16)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-022"></a>
## REQ-022 · 事件与战役

48事件模板、12主线节点、三封印终章、可继续经营；失败后有恢复路径。

依据：[设计源第17节](../source/game-design.md#s17)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-023"></a>
## REQ-023 · 交互可访问

中文管理DOM、Canvas对象替代列表、150%字、键盘、减少动态与非颜色唯一预告。

依据：[设计源第18节](../source/game-design.md#s18)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-024"></a>
## REQ-024 · 框架边界

Phaser表现+React管理+Vite构建；只读投影/命令/事件接口，视图不能修改领域值。

依据：[设计源第19节](../source/game-design.md#s19)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-025"></a>
## REQ-025 · 本地保存

版本化IndexedDB+JSON导出；完整tick快照、写新再切指针、迁移保原档、导入预览与覆盖确认。

依据：[设计源第24节](../source/game-design.md#s24)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-026"></a>
## REQ-026 · 恢复与隐私

3战役槽各3自动版本建议；单可写标签页、隐藏暂停、无离线致死、默认不上传诊断。

依据：[设计源第24节](../source/game-design.md#s24)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-027"></a>
## REQ-027 · 验证与性能

36弟子/128×128/约200对象/6v20基准；确定性、长跑、故障、实玩、性能与可访问验收。

依据：[设计源第25节](../source/game-design.md#s25)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-028"></a>
## REQ-028 · 美术与授权

Q版动漫立绘/插画与Q版像素地图精灵并用，统一国风色板/比例/锚点/动作；原创主资产与逐文件许可账本。

依据：[设计源第18节](../source/game-design.md#s18)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-029"></a>
## REQ-029 · 分层交付

总览→子系统方向→详细设计→执行任务；超过30开发小时量级的完整项目范围，不是游玩时长或工期承诺。

依据：[设计源第26节](../source/game-design.md#s26)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-030"></a>
## REQ-030 · 阶段边界

当前仅设计交付；实现、安装、发布、部署待另行授权，任何计划或指标不伪称完成。

依据：[设计源第1节](../source/game-design.md#s01)；执行覆盖见[任务登记](../03-execution/task-register.md)

<a id="req-031"></a>
## REQ-031 · 中英双语与逐键回退

默认zh-CN，可切换en；所有玩家可见文本走稳定键，缺英文逐键回退中文；切换不改模拟/随机/存档身份。

依据：[设计源第18节](../source/game-design.md#s18)；执行覆盖见[任务登记](../03-execution/task-register.md)
