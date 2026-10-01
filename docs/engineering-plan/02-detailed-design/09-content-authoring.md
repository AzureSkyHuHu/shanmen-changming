# DD-09 内容数据、目录与制作管线

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-013](../00-overview/requirements.md#req-013)、[REQ-014](../00-overview/requirements.md#req-014)、[REQ-016](../00-overview/requirements.md#req-016)、[REQ-018](../00-overview/requirements.md#req-018)、[REQ-028](../00-overview/requirements.md#req-028)

<a id="schema"></a>
## 内容包合同

ContentManifest含contentVersion、requiredSimulationVersion、catalogs、assetManifest、locales和hash。定义必须有稳定ID、schemaVersion、nameKey、descriptionKey、tags、mechanics、presentationKey、source/designRef和testScenarioIds。

使用可辨识联合类型+运行时schema，数值单位显式；仅白名单条件(all/any/not+字段比较)、目标、效果。禁eval/任意JS/脚本URL/内容自行注册执行器。未知操作为构建错误，不能无声忽略。

<a id="catalog"></a>
## 目录所有权与数量

24技能与36树节点完整命名/方向见源§10/12；48机缘当前为作用域/分类基线和核心示例，尚非48张逐卡完整配置。不得将设计目录当成已可加载数据。

内容登记应一行一个稳定ID，列：名称、类型、作用域、主分类、前置/互斥、启动来源、白名单能力、数值状态、文案/图标/音效、测试、切片/1.0标签、制作状态。48机缘双轴分别统计总数；技能门类/主动被动也分别计数。纸傀仅每施法者1个、不培养继承，Summon未通过测试则条目blocked。

<a id="pipeline"></a>
## 导入与发布验证

作者编辑源定义→结构校验→ID重复/悬空引用→图循环/不可达/互斥冲突→操作能力矩阵→空池/启动可达→本地化缺键→资产存在/许可→内容测试→生成只读manifest。

数值与卡面说明从同一字段生成；特殊解释文案必须引用真实条件，避免中文承诺与执行不同。新增普通技能不改主循环；新机制走扩展ADR并提升所需模拟版本。所有生成产物标注来源和可重建命令，原始素材与发布图集分开。

<a id="tests"></a>
## 内容完成标准

每条有正向触发、前置无效、清理/读档三类夹具；首领有可见预告、处理方式、阶段与失败解释；事件有无效条件与后续回声。计数达到目标不等于内容完成。静态校验报告、可加载包及手动试玩证据同时满足才进入内容完成状态。
