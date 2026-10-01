# DD-11 React、Phaser与交互合同

状态：设计基线 / 待评审；未实现、未执行游戏测试

需求追踪：[REQ-023](../00-overview/requirements.md#req-023)、[REQ-024](../00-overview/requirements.md#req-024)、[REQ-012](../00-overview/requirements.md#req-012)

<a id="projection"></a>
## 会话与投影

ApplicationSession拥有WorldSession唯一实例、模式、命令端口与订阅生命周期。Projection携带revision、entityDiffs、resourceSummary、alerts、selectedDetails等只读DTO；React稳定查询订阅相应revision，Phaser只同步差量实体。框架对象不能进入core或SaveEnvelope。

退出场景/面板释放订阅、输入监听、音频句柄；进入新模式从当前快照构造，不重启世界。UI筛选排序是本地状态，不触发模拟。

<a id="screens"></a>
## 界面信息合同

宗门总览：年月/速度/资源/告警+可点选人物建筑；弟子页：适配、需求原因、任务阻塞、师承与履历；突破页：预览因素、材料、时间与死亡风险；出征页：配装/补给/路线风险；三选一：卡→合法持有人→结果；结算页：伤/撤/死/失物原因。

全屏页返回保留相机、选中、暂停原因；告警可跳到实体或相关账本。命令反馈分已接收/已提交/拒绝原因，不能按钮闪一下就声称成功。

<a id="input"></a>
## 输入与可访问

ActionMap负责重绑键位、模式与焦点；文本框内不能触发战斗快捷键。空格暂停、Esc返回需遵守模态堆栈；打开确认框捕获焦点，关闭回到原控件。Canvas提供可聚焦对象列表与等价命令入口。

1280×720与1920×1080，125%/150%中文文字重排；重要状态不得只靠红绿/音效/hover。缩放下卡片可滚动而确认按钮可达。减少动态、震动开关、独立音量、闪烁限制从第一版组件开始预留。

<a id="tests"></a>
## 真实页面验收

通过Playwright/人工在真实页面完成选人→生产→保存→出征→暂停命令→三选一→归来；不能仅调用核心函数代替。反复进出战斗50次检测监听器/对象释放；低帧率UI仍及时显示命令接收，不重复发出；双击、Esc、Back、模态关闭、隐藏恢复均覆盖。
