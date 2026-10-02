# v10 升级所有者的有限记录余量

日期：2026-10-02。状态：新增本地计量实现与测试源码，等待集成负责人执行验证；不是完整 v10 准入或发布验收。

## 接口与边界

`deriveSectUpgradeObligationsV10(source)` 接受实际 World 的结构化只读字段：地图尺寸、弟子的 `id/position/traveling`，以及 `sectExpansion.schemaVersion/upgrade/reservations`。无需复制持久化 frame，也不提供可由调用方回传的可信证书。返回的 `admitted` 恒为 `false`。

每个 active owner 实现冻结的 `SectUpgradeObligationV10`。补充类型只增加诊断：具体 typed record witness、重复数组的 sample/count、各分支 record delta、剩余工作/访问/区间/检查点容量。未改冻结合同类型。`supported` 只表示本地计量可推导；`headroom.fits` 单独表示列出的本地行数/取消修订余量足够。二者都不证明真实来源、合法状态、生命周期或整档可导入。

## 计量公式

- 所有 bytes、canonical UTF-16 characters、value nodes 使用现有 `measureProgressionRecord` 语义。characters 不是未转义文本长度；JSON 的 NUL 与孤立 surrogate 都按实际六字符转义计算
- job、同一 paired claim、实际工人的 position/traveling 只收 `max(0, 最大完整记录 − 当前完整记录)`；receipt 插入另外收一个可能的逗号，不虚构 World event、第二回执、building 或 local ID
- 每个分支先合计所有记录 delta，再对整个分支的三项指标分别取最大值。complete 与 cancel 不相加；三种 live 付款形态、取消前/后半程与 requested/death 也分别计量
- 已完成/取消历史继续留在整档 current measurement。只对当前 live job 与其唯一 claim 做替换扣除；绝不把已完成工作、终态 history 或整本 ledger 当作可回收空间
- 当前 upgrade revision 到 MAX_SAFE_INTEGER 的数字宽度增长放在 `shared`，只收一次；`totals` 已包含 shared，集成者不要重复加

Typed witness 是字段宽度上界，不是可提交的游戏数据。举例：400 spans、401 visits、两个 checkpoints、最大时钟与最大 live route 可同时用于 sizing，但不声称它们能出现在一个合法 live job 中。取消 witness 可保守含完整400区间宽度，但不把 activeTicks400 当作可取消保存边界。测试中合成的 extreme evidence 也明确是 sizing fixture，没有通过领域合法性断言。

## 独立推导的数组和路径上界

样本使用真实类型：visit 有6个 value nodes；span 有6个；checkpoint 有8个；cell 有3个。实际节点数由 typed 样本计量取得，不借用旧 descriptor 常量。

已有空数组 skeleton 计入其括号和一个 array node。替换为 n 行时只加 `n × measure(sample) + max(0,n−1)` 字节/字符，以及 `n × sampleNodes` 节点，不再次加数组节点或括号。

固定上限来自 `SECT_UPGRADE_LIMITS_V10`：401 visits、400 spans、2 checkpoints、400工作刻。保存历史采用完整总上界再减当前大小；不是只量“剩余行”却误减整个当前历史。额外报告的 appendable spans 为 `min(400−activeTicks,400−currentSpanCount)`，以及剩余 visit/checkpoint 槽位。

导航由已有 `navigationPathByteBudget` 校验地图为1..256。允许最多 `width×height` 个保存 cell，坐标分别以 width−1、height−1 的最大数字宽度计量；不分配65536个假 cell。其解析式与旧路径字节公式一致，节点增量独立为 `3×width×height`。navigation 的 target、routeVersion、movementTicks（4−1）、retryAtTick 都使用实际类型的最大宽度；终态正确清空导航。工人实际 World position/traveling 的增长另计，不假设终态传送。

## ID、付款与终态

已存在的不可变 IDs/引用保持原字符串，当前与未来重复使用均按实际转义长度计量，包含128 code units的引用。升级 local IDs 依保存序号确定，最多 job `sect-upgrade:255`、reservation `sect-upgrade-reservation:256`，不是假造 MAX 整数 local ID。所有新增时间/修订字段按 MAX_SAFE_INTEGER 宽度；取消 expectedRevision 用 MAX−1，post-revision 用 MAX。

资源价格读取冻结丹房L2目录。paired claim 的 base 与空 sect 都保留 construction.half/remainder checkpoints；完成包含 `complete:<jobId>`、committed、空 outputs/remaining；取消包含 `cancel:<jobId>`、released、真实阶段 consumed 与空 remaining。terminal 的 released 在半程前为6/6，半程后为3/3。

player cancel command 是最多128 ASCII字符。death cancel command 按整个 `system/v10/death/<deathId>/<jobId>` 的128 code-unit约束计算剩余 deathId长度；不错误地给两个128字段直接拼接。该 deathId 以最长 JSON 转义单位作为保守上界，并同时计入 terminal 和 receipt。当前实际生命周期的 instance death ID 更短；该额外宽度不声明新 identity 合法，也不开放仍关闭的死亡取消执行路径。

## 本地终止余量

每 live owner 预留一条 upgrade cancel receipt 与一次 upgrade revision；不再分配 jobs、paired claims、buildings、nextId 或 navVersion。检查 `receipts.length+live<=256`、`revision<=MAX−live`、jobs<=128、active<=36、共享 paired claims<=384。共享384仍是旧协议上限，未扩容。

最后一个有效 receipt/revision 保留给取消或未来认证的死亡取消。完成/取消后 owner消失，但其真实 job/claim/receipt 留在 current bytes 中。本文件不提供“owner消失就可释放”的 discharge判断；集成root仍必须认证 exact terminal、ledger、receipt与生命周期关联。

一次取消修订不是整个任意等待过程的修订预算。未定长阻塞、导航重试、维护等待不能由有限工作刻推出有限elapsed ticks。每次实际 tick/command 必须重新测量所有 owner，保留其他任务的终止槽位，在不能发布合法完整候选时停在原可导出边界。没有用本地 envelope 承诺任意等待后必然完成。

## 集成仍须完成

此层不包含已有五所有者、培养/教学/寿尽、归档、balance/clock增长、L2消费者、World/envelope新身份及reader整体上限。root必须合成完整八字段真实canonical UTF-8、decoded characters/nodes、所有领域行数/整数余量及4MiB门限；existing-owner共享字段不能重复收费。全源验证/安全descriptor capture必须先于此结构化查询。本地测量拒绝普通getter/非JSON/cycle，但不声称能沙箱化恶意Proxy反射，也不是新的bounded reader。

新增测试覆盖0/199/200/399、requested/death/complete、保存证据最大行、1/9/10/99/100/256地图边界、128单位ASCII/NUL/孤立surrogate/Unicode引用、最大local ID、whole-branch maxima、最后回执/修订槽位、历史保留、输出诊断隔离与非法source。测试源码尚未运行；应由唯一集成执行者记录实际结果。这里没有声称升级root、codec或真实死亡终止已经可用。
