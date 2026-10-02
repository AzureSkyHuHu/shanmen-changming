# v10 固定完整候选的预留义务释放证明

日期：2026-10-02。状态：内部实现与定向测试已编写，等待唯一集成负责人执行检查。不是 v10 运行时发布、存档准入、codec、迁移、Session、UI 或玩家入口。

## 唯一固定接口

`world/reserved-discharges-v10.ts` 提供 `inspectReservedDischargesV10(before, after)`，返回 `{ supported, discharged, unknowns }`。`world/sect-release-v10.ts` 仅重导出同一个函数和类型，方便其他内部模块沿用已有 import 组织；没有第二套算法。

两个参数必须是真实完整 v10 World。入口先通过既有有界数据描述符捕获和 `inspectUnregisteredWorldV10Records`，读取的是自己持有的快照。然后从相同实际 World 重新派生六类宗门义务和阶段感知培养义务，固定使用 v10 构筑来源与原有永久构筑身份。

没有调用者计量值、assessment、回调、policy、可信标志、可复用证书或 death flag。没有把 World 改名为 v9、删去 upgrade 域、筛选账本、调用旧 v9 整根 wrapper 或改变旧版本接受范围。所用 progression 数量与终态检查仅为版本无关结构叶；名称中的历史 v9 不意味着借用旧 World 身份。

`discharged` 是已经存在且实际终结的 owner 标识，不是可回收字节或历史删除授权。所有完成/取消 job、receipt、paired reservation 和来源仍保留在 after 的实际计量中。本查询不比较容量，不能替代当前硬上限、完整余量、缺口不增加、授课续行或原子发布 gate。

## 完整候选必须真实可重放

先核验整体因果，再给任何 owner 释放：

- 完全相同的边界允许返回 supported，但没有释放
- 两个管理时钟都恰好前进一刻时，只尝试固定真实 normal 与 no-optional-growth 准备器；从 unchanged before 分别重放，完整 canonical World 必须与 after 一致
- 时钟相同时，从 after 新增的真实 World 当前/归档回执，或 construction/production/research/care/upgrade 回执，重建唯一玩家命令并执行固定 `prepareUnregisteredCommandCandidateV10`
- `system/` 回执只能由触发它的真实刻或真实 World 命令带出，不当作玩家命令执行。不能把升级死亡来源换成普通取消
- 没有新的唯一外层命令、两个以上玩家命令组合、多刻跨度、时钟错位、失败重放或任何额外完整 World 差异都拒绝

因此完整记录上分别合法的两端也不能随意拼接。正常取消后另改一个可被 root 接受的诊断字符串、库存或历史，同样没有释放证明。自动终结 journal 本身也不构成工时/付款证据。

这仍是固定算法的重放证明，不是密码学真实性、无限历史重演或浏览器性能承诺。

## 逐类终态与不可变来源

六类宗门 owner 为 planned-blueprint、construction、production、research、care、upgrade。

- planned-blueprint → started construction 是义务转移，不是释放；只有真实取消并保留图纸不可变字段、终止时间和新回执才计入
- 工作 owner 必须保留原 job 身份、reservation、工人/病人、起始两时钟、原始位置、配方/研究/建筑关联与所有不可变 proof
- `productiveSite` 整体比较，保留 L2 的 upgradeJobId、原 construction sourceJobId、位置、level、firstMaintenanceCalendarTick；不得像旧释放代码一样遗漏整个字段，或把 L2 重建为 L1
- 取消通过真实原 paired book 的 `releaseSectReservation` 再计算整个 reservation；必须精确等于 after 的保留 claim，消费/释放数量必须等于原来已耗/未耗部分
- 取消不增加 activeTicks、visits、workSpans 或 paid checkpoints；保留原 phase 作 previousPhase，并且存在相应新 cancellation receipt
- 完成保留原 claim 两侧完整投入，具有 `complete:<owner>` 的两侧 committed settlement、真实消费和零释放；施工同时保留实际 completed blueprint 和预分配结果建筑
- 升级同时核对 resultLevel：取消为1、完成为2。原 construction building 始终为1并完全不改写；没有新建筑或伪等级赋值
- 旧手动生产终态可在 archive 中，但必须保留 reservation、事件、来源、状态与工作所有权释放；自动玩家取消必须保留真实 pin，系统终结保留真实 journal，并已通过整个候选的真实重放

任何一个相关 owner 缺证据都会让整个结果 supported:false，且清空 discharged，不能从部分成功中偷取恢复信用。

## 待决寿尽与完整生命周期

真实下一刻寿尽可以先取消正在运行的 upgrade，甚至在其第399有效刻之后阻止原本的最后工作刻。它可以释放 `sect.upgrade:<job>`，但不释放 `disciple-lifecycle:<disciple>`。

待决死亡继续保留同一生命周期 owner。本入口另加显式断言，避免将来结构派生错误地丢弃 pending owner 而被当作释放。

生命周期只有完整终态才释放：实际 death、人物移除、全部 estate 责任结算、item transfers、build retirement、cultivation archived disciple、World archived identity 和没有仍属于死者的装备。真实 `death.finalize` 候选必须整体重放一致；删除其中任意一项均不通过。

已完成的升级死亡取消历史在后续 death.finalize 中原样保留，不重新制造升级取消、不回滚已经消费的半期材料、不抹除 L2 来源。

## 输入与资源边界

调用者对象不会被修改或冻结。普通 getter、共享别名、稀疏/非 JSON 数据等由既有捕获器拒绝；异常处理不读取调用者抛出对象的 message。每次返回独立诊断对象，修改上一次返回不能授权下一次查询。

Proxy 反射可能执行其 trap；本实现不声称识别全部 Proxy、限制 trap 自身执行成本，或跨任意 hostile trap 实现原子捕获。完整 root/候选重复检查也有成本，本片没有做性能快路或性能验收。

## 定向测试与执行责任

`tests/sect-expansion/v10-reserved-discharges.test.ts` 编写14项检查：

1. 图纸转施工不算释放，图纸与施工取消有真实证据
2. 新研究取消和真实最后工作刻完成，拒绝跨多刻拼接
3. 升级开工未耗/半期已耗取消，保留已消费材料
4. normal/no-optional 最后升级工作刻完成，L1 construction 不变
5. root-valid 无关字段拼接拒绝
6. 缺 job/receipt/claim settlement、伪退款或来源改写拒绝
7. 两种真实 L2 伤药生产取消保留完整 productiveSite，来源篡改拒绝
8. 真实药剂照护取消与完成的 dose/effect 证据
9. 不修改/冻结调用者、冻结源支持、独立返回值和固定 re-export
10. v9混入、getter、共享别名、hostile thrown message拒绝
11. 第399刻升级寿尽取消但保留生命周期，完整归档后才释放，逐一删除终态证据拒绝
12. 手动归档与自动 pin 取消
13. 自动真实工时与付款完成
14. root-valid 自动退休 journal 伪造拒绝

昂贵准备使用真实旧 v9 历史作为明确标注的 record-only 测试 lift，并仅预置 BASE 测试资金；宗门资源、研究、建造、药剂均为实际付款工作。新增研究、升级与所有本片要证明的 transition 使用固定 v10 候选。临近寿尽是明确初始条件，不冒称推进了完整寿命。

本文件所有者未运行类型检查、测试、构建、Git、部署或浏览器；上述是已编写用例范围，不是通过结果。实际执行结果由唯一集成负责人另行记录。仍不代表完整游戏、公开 v10、完整恢复准入或授课续行验收。

## 首轮集成反馈

集成负责人于2026-10-02 20:38 UTC确认：首轮本片14项中13项通过，唯一失败为“真实自动完成付款”用例耗时5422毫秒，超过默认5000毫秒；没有报告本片 source defect。该用例确实推进完整160有效工作刻、路径与每刻完整 root 检查，已仅为这个新增用例设置30000毫秒上限，保留所有真实 tick/付款/终态断言，未更改全局或旧测试超时。修正后仍等待负责人复验，不把超时修正视为测试已通过。

集成复验（2026-10-02 20:48 UTC）：修正后解除义务14/14、教学57/57全部通过；真实完整教学续行仍逐刻执行。它们与待修正的容量gate合跑393.56秒，gate另有4个新测试默认5秒超时和1个交付阶段夹具错误，不能把合跑称全通过。本提交不含gate。双类型、边界及默认构建通过；独立只读审阅未发现本片实质问题。完整游戏与新v10玩家入口未验收。
