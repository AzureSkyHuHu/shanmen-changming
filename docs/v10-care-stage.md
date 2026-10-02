# v10 双配方照护局部阶段

日期：2026-10-02。状态：内部组件实现。集成负责人在包含逐终态复制修复的冻结副本上完成两套类型检查，以及 care / transition / bounds 三套 51 项检查（其中护理 11 项），7.75 秒通过；整树检查仍单独记录。这不代表浏览器或完整游戏验收。

## 固定边界

- 新增 `care-runtime-v10.ts` 与 `care-validation-v10.ts`，使用真实 `WorldStateV10` / `SectUpgradeFrameV10`；旧 v9 selector、validator 与协议未改
- 只在根已认证 construction / research / upgrade / maintenance / production 记录后调用 `deliveredPowderJobsV10`；只允许 `craft.wound-powder.v9` 和 `craft.wound-powder-alt.v9`，真实 completed / deliveryVisit / 一份 wound-powder 输出，按终态刻与事务 ID 稳定排序
- 最早尚未占用剂量先用；取消后沿 `previousCancelledCareId` 重用，完成剂量不可复用。不由库存或相似 outputs 推断制药来源
- 真实患者到仓、抵达刻不计工、40 个有效刻、paired reservation 消耗与固定 `care.wound-powder.reduce-injury.v9.1` 效果原子结算；仍为减 20 且最低 0
- 患者资格另外排除活动 upgrade owner；worker/entrance claims 使用全部六域 union 一次，避免护理双计数。六所有者 closure 同时核对每份预留一个 owner、每个 owner 唯一一份预留和引用一致
- 休养取消读取固定 v10 cultivation clock wrappers；历史归档引用要求已认证 lifecycle identity source。原有护理系统回执继续使用 `system/v9/healed/...` 与 `system/v9/death/...`，不改成 v10 升级专属命名空间

运行中每个护理终态独立复制固定成本行，避免两个完成记录或取消→重用记录共享同一数组。首轮局部检查确实发现该别名，被严格 descriptor tree 拒绝；修复输出所有权后重跑通过，没有放宽输入检查。

## 端口与责任

`applyValidatedCareCommandV10`、`tickValidatedCareV10` 仅生成内部候选。它们不提供存档、root identity、描述符捕获、完整 World 生命周期或容量准入，也不接收可替换 validator 或可信 caller flag。系统取消参数只可由根真实生命周期准备；完整候选必须再次认证。root 负责失败时保留原完整边界，不发布半结算。

`validateCareRecordsV10` 保留原有访问、工作区间、消耗、修订、效果、休养 talent 来源与死亡 mirror 强度；`validateCareOwnerClosureV10` 是明确六域的局部闭合，World 回执去重、全系统基础预留、库存来源和未来义务仍由根核对。

## 新测试的证据范围

`care-v10.test.ts` 使用明确补足基础库存的既有组件夹具，实际执行基础制药、两种研究、L1 建造、400 有效刻升级、200 有效刻替代制药与实际送仓，再执行 40 刻照护和两剂量 25→5→0。v10 局部步骤不冒充完整 World 月结/容量运行。

覆盖 exact recipe 白名单、无送达/未来输出/数量错误、伪工时被前置生产检查拒绝、库存不能授权、活动升级患者互斥、真实取消重用、JSON 续行和幂等重试、六域正反向预留、效果/工时/来源篡改、暂停/共享路径预算/仓库中断及本地余量。

休养、死亡与归档分支先由实际 v9 生命周期产生历史，再由 v10 固定记录包装认证其保留语义；明确不是新 v10 root 生命周期转换验收。完整新版本公开准入、codec、迁移、UI、真实浏览器、长期性能和完整游戏仍需独立验收。
