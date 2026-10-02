# v10 丹房升级：真实寿尽的固定取消批次

2026-10-02。此片是内部领域/生命周期组件接线，尚不代表 v10 完整运行时、存档准入、迁移、Session、界面或发布验收。

## 固定接口

- `cancelValidatedSectUpgradesForLifecycleV10(frame, context, evidence): SectUpgradeResultV10`
- `validateWorldSectUpgradeRecordsV10(world, frame, lifecycleEvidence): readonly ConstructionValidationIssue[]`

第一项只接受 `prepareValidatedV10CultivationClock/Command` 的真实 reducer 调用产生的短命 `V10CultivationTransitionEvidence`。先对原始 frame/context 调用一次 `readV10PreWorkDeaths`，核对对象身份、源/候选/实际 reducer 结果及镜像事件快照，然后才开始构造取消候选。没有调用者自报的 deathId、工人/任务列表、trusted boolean、重绑工厂或回调策略。

批次从真实新增不可劳动事实选择活跃 upgrade jobs，按 `(startedTick, jobId)` 排序，自行生成 `system/v10/death/<deathId>/<jobId>`。每个取消沿用一个命令修订与现有 paired release，全部成功才返回隔离的候选；任何后段失败返回原 frame。系统 ID 长度、回执槽位、修订安全整数、重复命令、实际安全位置和成对预留释放均保留检查。

第二项只验证完成的生命周期记录。它要求 lifecycle evidence 绑定确切且未改变的 World、frame 等于该 World 的真实投影，然后在内部取得历史身份及具体死亡事实。私有记录校验核对 worker/death/job/system receipt 和终态的两时钟，必须精确等于最初 expiryPending 或 died 的不可劳动边界；该工人的升级开工、工作和访问不得发生在此边界或之后；该工人自身不可劳动同刻的取消必须是认证的死亡系统取消，不能同时把 reason/receipt 改成普通玩家取消来洗掉来源。早于自身寿尽的普通取消、其他工人死亡暂停同刻的普通取消仍合法。归档身份的一般历史时间上界不能代替这项授权。

## 次序和未扩大范围

根运行时必须先执行真实培养/寿元准备，再把其原始 frame/context/evidence 交给固定取消批次；任何旧生产/宗门工作清理、遗产结算和归档都在其后。新增生命周期暂停仍允许执行这一必需释放，之后不运行升级工作。完成记录 proof 不能执行退役前取消，最终 death.finalize 的旧 pendingDeath 也不能授权延迟释放。

玩家 `isSectUpgradeCommandV10`、普通/validated 玩家命令入口继续拒绝 `system/`。独立 `validateSectUpgradeRecordsV10` 仍拒绝死亡取消，即使调用者持有合法归档身份；必须经过固定 World 记录接口。普通 requested 取消、start、四向行走、检查点、旧 v9 命名空间和校验没有开放策略参数。

取消沿用真实最后位置、清空该任务导航、解除升级 claims，World compose 清除任务 traveling。0–199 工时释放石/木板各 6；200–399 只释放各 3，已经消耗的半价不返还。不会产生 activeTicks400 的可退款边界，不改 L1 建造来源、维护到期、地图 navVersion、World 序列或随机流。

整个返回值仍是领域候选。完整 World 源/候选记录、六域所有者闭合、旧经济余额、数值/字节/读取器/未来义务和最终一次发布属于根集成；此接口不代替它们。

## 测试内容与夹具边界

新增 `tests/sect-expansion/upgrade-death-v10.test.ts`：

- 真实旧 v9 建造、研究、付款及 v10 升级访问/工作，分别在 0/199/200/399 工时经真实寿尽 reducer 取消；核对已消耗/释放配对账本、系统回执、位置、导航、claims、原输入不变和确切重复结果
- 399 工时的已付维护活人对照确实下一刻完成；相同升级历史的寿尽分支保留一项中点检查点，不扣 remainder
- 多个同刻真实死亡按 job 顺序取消；第二个位置不安全时，第一笔已准备释放也不发布
- 伪造、复制、JSON、完成记录 proof、异源 proof、替换 frame/context，以及准备后的源/候选/frame/context 修改全部拒绝
- 零工时真实死亡取消历史只把 start 移至自身寿尽同刻、保留回执/预留/完整退款/位置的一致伪造也拒绝；自身不可劳动边界不等于普通同刻 start/cancel
- 同时把真实寿尽取消的 reason 和 receipt 改为普通玩家取消、保留全部真实付款/工作/刻的双字段洗白被拒绝；正例保留早于自身寿尽及其他人物死亡暂停同刻的普通取消
- 已认证历史端口拒绝错误 deathId、worker、系统回执、终态刻/日历刻、requested reason 搭配系统 ID、异源和变更 World；单独归档身份无法放行
- 真正 death.finalize、责任登记、固定 build/cultivation 遗产结算与归档后，原升级历史在移除真实 actor 后继续可验证并支持 JSON 往返；这是组件组合，不声称根运行时已经发布

基础物资明确采用既有 `fundedRuntimeFixture` 的初始资金配置，新宗门材料、研究、建造和升级工时由实际 reducer 获得。近寿尽调整是明确的初始边界夹具；只在当前月内跳过无任务进度的空闲时钟，保留所有实际访问、工时、月结、付款与事件来源，不冒称模拟了完整寿命。多死亡不安全位置反例故意构造未准入空间源，只证明领域批次不会部分发布。

检查由唯一根集成人员串行执行；本工作者未运行测试、类型检查、构建或 Git。实际结果应以根集成报告为准。完整游戏、150 年/36 人、3 倍速、移动真机和长期性能仍未验收。

集成复验（2026-10-02 20:15 UTC）：暂停/死亡修复后的记录根、死亡与共享时钟叶合计49项通过；候选与旧建造、研究、护理、时钟、codec兼容合计7文件358项通过（237.17秒）。双类型、边界、1205中文键、内容和默认构建通过。独立只读复审未发现这两处修复的遗留实质问题。仍未进行新 v10 玩家浏览器或全游戏验收。
