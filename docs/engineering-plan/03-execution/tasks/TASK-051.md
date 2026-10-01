# TASK-051 · 实现中英映射切换与回退

状态：planned · 负责人：国际化工程（unassigned） · 里程碑：[M3](../milestones.md#m3)

授权：pending_development_approval；本任务未开始，实现/安装/部署不因本计划自动获准。

## 追踪与前置
需求：[REQ-031](../../00-overview/requirements.md#req-031)、[REQ-023](../../00-overview/requirements.md#req-023)、[REQ-025](../../00-overview/requirements.md#req-025)

设计段落：[02-detailed-design/14-internationalization.md#keys](../../02-detailed-design/14-internationalization.md#keys)、[02-detailed-design/14-internationalization.md#resolve](../../02-detailed-design/14-internationalization.md#resolve)、[02-detailed-design/14-internationalization.md#switch](../../02-detailed-design/14-internationalization.md#switch)

依赖任务：[TASK-003](TASK-003.md)、[TASK-034](TASK-034.md)

## 文件/模块责任
- `src/content/locales/zh-CN/`（未来目标路径，当前没有创建此实现）
- `src/content/locales/en/`（未来目标路径，当前没有创建此实现）
- `src/ui/i18n/`（未来目标路径，当前没有创建此实现）
- `src/platform/settings/`（未来目标路径，当前没有创建此实现）
- `tests/unit/i18n/`（未来目标路径，当前没有创建此实现）
- `tests/e2e/locales/`（未来目标路径，当前没有创建此实现）

## 输入
- 最新中英需求与文本键表
- 只读投影/设置端口
- 所有前置任务已批准的输出与当前设计版本

## 输出
- 完整中文键覆盖
- en逐键回退与语言开关
- 参数格式/复数工具及审校清单

## 执行步骤
1. 登记全部玩家可见文本含错误日志tooltip
2. 实现整句命名参数/格式化/参数一致检查
3. 将locale设置独立保存并仅刷新显示缓存
4. 补英文翻译制作与校对流程，不伪报已有全译

## 验收测试
- AT-051-01：英文缺键/空值逐键中文回退且缺zh构建失败；状态not_run
- AT-051-02：切换不变领域hash/RNG/offer/指令；状态not_run
- AT-051-03：英文长文本及150%不溢出；状态not_run
- AT-051-04：参数类型/复数规则一致且自定义姓名原样；状态not_run

## 完成证据与交接
提交/内容版本、实际变更文件、测试命令和结果、代表场景或截图、已知失败与未测项必须登记。计划条目不能替代执行证据；完成需所有前置和本任务验收通过，或经明确评审记录允许的非阻断例外。触及其他任务所有模块时先更新接口契约和责任分工。

## 失败处理
可重现缺陷保留seed/指令/版本与最小夹具；禁止为通过测试删掉失败路径。若前置规则未定、能力缺失或授权不足，设blocked并写清所需决策；不伪造完成状态。
