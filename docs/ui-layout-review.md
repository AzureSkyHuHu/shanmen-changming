# 页面布局优化记录

## 2026-10-03：以实际页面为基线

用户要求继续游戏开发，并优化 UI 与整体布局。保留现有青玉、暖纸、铜金配色和人物/场景素材，不改变存档版本、指令规则或网站访问范围。

### 已观察的问题

1. **经营入口**：1174 × 750 浏览器视口内，地图约从 y657 才开始；说明、存档摘要、运行栏、九个导航链接和较高的资源卡几乎占满首屏
2. **营造区域**：未营造时，地图旁仍固定显示坐标和旋转表单；滚动后较高的粘性操作栏遮住地图顶部
3. **战役入口**：已选择简体中文仍重复显示中英文候选提示；正文及部分控件较小
4. **缩放与窄屏**：150% 缩放下标题及菜单文字出现不理想的断行；400 × 538 CSS 像素的实际窄窗口中，地图之前仍有大量说明内容

证据来自本轮 dot 云端浏览器的实际页面。窄窗口加浏览器缩放不等于真机触控验收。既有存档均未覆盖。

### 本次实现

- 经营界面采用地图优先布局：简洁标题、可展开候选范围、持续可见的存档/只读信息、紧凑资源数与完整仓储详情
- 营造工具移到地图下方并可收起；有放置预览时保持展开，确认及输入仍挂载，保留原有取消和焦点规则
- 保留所有现有区域锚点与逻辑顺序；关键停止、错误和待决操作不藏入可折叠区域
- 战役界面只在当前活动界面显示一份对应语言的候选提示；统一重复的样式层，调整标题、资源、地图和人物操作层级
- 地图标题和状态不再覆盖场景；保留现有场景交互和人物素材
- 提高常用说明和控件文字至 14 像素，主要交互目标至少 44 像素；窄屏单列与短视口不粘性操作栏分别处理
- v10 采用同一布局方向，但仍保留独立全局核对面板、真实升级/照护数据和独立存档生命周期

### 验证边界

组件/服务端标记检查、类型检查和构建用于发现工程回归；不能证明最终像素布局、浏览器焦点或真实手机交互已通过。发布后需复核：

- 桌面首屏与地图位置，400 CSS 像素窄屏，150% 缩放，中英切换
- 导航与仓储展开、完整资源账目、只读及错误信息
- 放置预览、坐标连续编辑、取消/Escape、确认可达性
- 存档弹窗打开/关闭、焦点返回、原存档显式读取
- 修炼、永久构筑、生产及照护现有流程不受展示改动影响

当前仍不是完整游戏或无障碍合规验收。

### Published checkpoint — 2026-10-03 02:09 UTC

Remote main `e1b805704e68a909de81546cde612aef3000b992` (tree
`91463db6d3b4a6040ad68097be816c7ab02646c7`) completed Actions
[37083998934](https://github.com/AzureSkyHuHu/shanmen-changming/actions/runs/37083998934)
and Pages deployment successfully at 01:46 UTC. The validation job passed
191 files / 3987 tests in 2664.71 seconds and both production builds.

Actual cloud-browser checks of that release:

- Desktop management map now starts near y330, versus approximately y657 in the
  earlier baseline. Map region spans the main content width; placement controls
  no longer occupy a permanent side column
- Inspected narrow approximately 400 CSS-pixel management first fold and English
  desktop 150% zoom: visible controls/text wrap without observed overlap
- Warehouse disclosure opens complete available/reserved/capacity data and
  closes; navigation exposes all nine existing destinations
- Save dialog opens and closes; Escape closes it and returns focus to Saves
- Placement form expands and remains mounted. Its preview is correctly disabled
  while the current session is player-paused; live placement interaction remains
  pending rather than counted as passed
- Campaign entry renders one selected-language preview notice. Inspected desktop
  Chinese and narrow English screenshots; new campaign controls remain available
  by modal scrolling. Further modal/background scrolling review is ongoing

The three existing management slots remain listed unchanged. Re-loading one was
not completed: the safety check blocked replacing current unsaved test progress.
The pending operation was cancelled, the current session retained paused, and
approval requested before retry. No save slot was overwritten.

These are bounded layout/interaction checks, not complete game, real phone,
long-term performance, or full accessibility acceptance.
