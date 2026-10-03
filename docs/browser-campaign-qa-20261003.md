# v8 首路线真实浏览器复核

2026-10-03 03:35–04:11 UTC，公开candidate.html，已部署提交
`1d88c78c5208e5c90b5d8fec00f14e034020d222`。本记录是有限玩法/页面回归，不是完整游戏验收。

## 独立检查进度

从入口新建种子 `qa-layout-20261003`，保持旧战役1不变。新起点保存到原空战役2（版本1）；首节点后另存原空战役3，后续只更新该测试战役3。没有读回或覆盖旧经营存档。

## 实际走通

- 林青与沈砚预览出征：最低8饭食、4个月往返。确认后仓库8→0，队伍预付第一月后携带6
- 通过真实时钟和节点操作走完两场林间巡守、古岩守卫及返程；暂停/隐藏不补算离线时间
- 第一场后给林青选择个人机缘“破釜守元”；第二场选择全队“并肩守御”，分别经过持有人及确认流程
- 首领战先暂停，实际下达集火、抱岳和护卫。暂停时前摇保持0.5秒；护卫按机缘给双方7护盾。恢复后自动战斗继续并胜利
- 返程之前只显示结算预览；实际返程后木材24→44、石料12→24、灵草6→15，未用饭食为0，双方归来、无永久陨落，出征锁解除
- 行历山川显示已破1/5境，瘴泽之印与鸣雷之印开放；其余路线未冒充已验收
- 行山衣只能领取一次，指定林青后权益从待领列表消失；配装仍需独立草案与确认，确认后显示实际新法衣
- 沈砚使用2灵草研习清心：15→13，显示已掌握且不能重复研习。之后将主动一由青雾换为清心，保留主动二回春，并显式确认
- 以沈砚设置并启用烹制饭食目标24、园圃种谷目标20、无料觅谷恢复目标1的有序计划。真实运行后库存达到24饭食/20谷物，无预留，工人回到待命；随后暂停并保存

战役3依次保存为版本1（首节点后）、2（首通返程）、3（装备与典籍）、4（净化配装和补给计划，04:11:29 UTC）。存档面板均确认成功。未执行新档读回验证，不将保存成功等同于故障恢复验收。

## 真实发现并处理的页面问题

1. 刚保存后点击同槽读取也固定声称“当前未保存进度”。源代码没有脏状态判断，这是恒定提示。修为条件式风险说明，确认/取消及槽位保护完全不变
2. 战斗纸面人物名被外层远征h3颜色覆盖；实测色值rgb(228,218,183)几乎融入背景。局部修正纸面标题为深色墨色，保留暗色区域
3. 路线封面仍引用发布时明确排除的可选大原图PNG。实际图片complete=true但naturalWidth=0。改用既有渐变的紧凑装饰，不上传原图，不制造缺失图片框

以上新修复需各自通过检查与部署后再看最终像素，不能把本记录当作其已上线证据。

## 页面与工具边界

已发布原生模态滚动修正实际通过：窄屏内层可滚到种子/页尾，背景scrollY保持0；入口与存档互换仍锁背景；关闭最后模态恢复页面滚动并返回焦点。

两次页面操作工具报告42–45秒，随后相同状态交互恢复约0.4秒；日志另有浏览器扩展元数据错误。尚未建立持续的应用卡顿复现，不能将工具耗时直接归因为游戏代码。当前Node性能专项与真实浏览器响应是不同证据。

## Resume and two further routes — 2026-10-03 05:12 UTC

The paused campaign tab later entered the read-only lease fence while left in the
background. Revision 5 remained present. The implementation renews every five
seconds with a fifteen-second TTL and correctly rejects a late renewal; the
precise reason the heartbeat was delayed was not observed. v8 and v9 use separate
IndexedDB namespaces. With explicit permission to replace this test scene, an
ordinary campaign-3 read (no forced takeover) restored revision 5, write access
and a paused session at tick17837/year2 month3. The original campaign1 and the
separate baseline campaign2 remained unchanged.

The same three-person party (Lin Qing, Shen Yan and the recruited sword disciple)
then completed all three encounters and actual return settlement for 瘴泽之印 and
鸣雷之印. Each route prepaid twelve meals for four travel/return months; nine
herbs and fourteen stone actually entered storage after return. All three party
members returned, none permanently died, and departure locks were released.

- 瘴泽: selected team 三曜净阵 and sword disciple's 借痕续命. Queued 回春 while
  paused, resumed it, then observed Shen Yan's HP rise from93 to115 in the boss
  fight. A specific cleanse proc was not directly verified. The manual sword
  cast first correctly reported out-of-range; a later attempt arrived after the
  encounter had ended and did not establish a successful manual cast.
- 鸣雷: an actual initial snapshot showed the sword disciple casting 贯日剑诀.
  One candidate refresh changed the legal offer list and remaining count2→1.
  Selected team 异法护灯 and 余盈护灯, whose legal-holder list contained only
  Shen Yan. Issued boss focus and ally guard before resuming the boss fight.
- After the second route: campaign3 revision6 saved05:02:58 UTC. After the third:
  revision7 saved05:10:18 UTC. Both saves reported success. The map showed3/5
  routes completed, 镇岳 newly available and the finale still locked.
- At the third return: wood44, stone50, herbs31, grain20, meals26, planks0.
  Shen Yan's automatic food plan resumed after returning. No resource injection
  or hidden-state mutation was used.

A fourth-route attempt has now departed with the same party and is paused at
镇岳's first encounter, with nine carried meals. It has not been completed or
saved over revision7 yet. This remains a bounded campaign playthrough, not full
content, balance, failure/recovery, long-run or actual-mobile-device acceptance.
