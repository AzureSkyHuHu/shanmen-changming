# 架构总览与约束

## 单向数据流
用户操作 → CommandDispatcher（序号/去重）→ 纯核心（校验/预约/固定tick）→ DomainEvent → 只读查询投影 → React/Phaser。
完整tick边界 → SaveCoordinator → 存储适配器。表现动画可以请求命令，但不能直接结算资源或伤害。

## 分层与所有权
| 层 | 拥有 | 可以依赖 | 不可依赖 |
|---|---|---|---|
| core | 世界、角色、经济、战斗、随机与ID | 类型与纯内容定义 | 浏览器、UI、引擎、数据库、Date.now |
| content | schema校验后的不可变定义 | 无副作用协议 | 世界可变实例、任意脚本 |
| application | 会话、指令顺序、投影与保存调度 | core、端口 | 场景私有对象 |
| phaser | 场景、相机、精灵、视觉反馈 | 投影与命令端口 | 直接写核心字段 |
| ui | 面板、焦点、筛选、管理DOM | 投影与命令端口 | 第二份权威世界 |
| platform | IndexedDB、文件、可见性、音频 | 端口类型 | 自行改写领域结果 |

## 不可破坏的不变量
- 一个会话只有一个权威世界；一个存档只有一个可写标签页
- 同seed+相同版本+同初态+同指令日志得到相同领域哈希
- 可用库存=现有库存−有效预留；不得负数；每事务只提交一次
- 经营年月与战斗tick互不偷偷换算；远征节点战略月耗有独立提交标记
- 死亡提交、奖励提交、run退出、保存切指针均有幂等ID
- 读取与投影不推进随机流、不抽新奖励、不改状态
- 来源移除只撤销该来源；run结束不能移除合法character天赋
- 存档先校验/迁移/验证，再成为当前版本；失败保留原档

## 演进阈值
初版纯模块化单仓；20Hz逻辑步长为试验值，低频系统按tick错峰。只有固定基准的profiling证明主线程瓶颈，才在[性能设计](../02-detailed-design/13-assets-performance.md#worker)提出Worker迁移。传输协议从一开始可序列化，但不为未来可能需求复制一套运行时。

## 详细接口入口
[内核合同](../02-detailed-design/01-kernel-contracts.md)、[场景/UI边界](../02-detailed-design/11-ui-rendering.md)、[保存恢复](../02-detailed-design/10-save-and-recovery.md)、[建议源代码树](../source-tree.md)
