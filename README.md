# 山门长明

单人修仙宗门浏览器游戏。默认简体中文，可切换英文，缺少英文的文本逐键回退中文。

## 项目状态

2026-10-02：用户已授权在 dot 云端持续开发，并已将 GitHub 仓库改为公开。GitHub Pages 已发布普通 v7、独立 v8 战役候选与有限 v9 宗门经营候选；原 dot 预览仍为私人访问。完整游戏尚未验收。

- [工程设计入口](docs/engineering-plan/README.md)
- [总体需求](docs/engineering-plan/00-overview/requirements.md)
- [详细设计](docs/engineering-plan/02-detailed-design/README.md)
- [执行任务](docs/engineering-plan/03-execution/task-register.md)
- [实际开发状态](docs/development-status.md)
- [完整游戏验收路线图](docs/full-game-acceptance-roadmap.md)
- [宗门扩建首片候选方案](docs/sect-expansion-first-slice.md)
- [官方技能来源](docs/tooling-manifest.md)

设计包是规划基线，其中的 planned/not_run 表示当时规划状态；实际执行证据记录在开发状态和后续提交中。设计目标不能当成通过测试的功能。

## 核心方向

可见的宗门生活、弟子培养与代际传承、可指挥的自动战斗、多层构筑与秘境三选一。角色采用二次元 Q 版头像插画与统一的场景像素动画。

本地存档优先；不依赖账户或多人后端。发布与公开分享单独确认。

## 开发命令

使用 Node 24 与 npm 11，保留平台可选依赖（TypeScript 7 需要原生编译器二进制）。

- npm ci：按锁文件安装依赖
- npm run dev：启动本地开发服务
- npm run check：依次运行模块边界、文案、测试与类型检查/生产构建
- npm run build：创建生产构建

2026-10-02 17:33 UTC：main `8cf53c10d69138754e1dcb09f835f15b55f3e1cd` 的 GitHub Actions 与 Pages 部署成功。本地冻结源码完整通过150文件3016项测试、1205中文键、双类型/边界/内容及默认和启用版生产构建。普通入口仍为v7；candidate.html为独立存档的v8战役候选；[management.html](https://azureskyhuhu.github.io/shanmen-changming/management.html)为有限v9经营候选，支持实际经营、制药照护、修炼突破与已有永久构筑。三个入口存档隔离；经营候选手动保存、回访显式读取。真实浏览器已走通从零修炼、预留/取消/闭关、待决保存恢复、突破炼气、研习/配装/经脉重配及最终保存刷新续档；原经营存档保留。具体范围与剩余问题见[经营集成记录](docs/v9-management-integration.md)。完整1.0、装备获取、建筑升级、真机移动端及长期性能验收未完成；部分桌面窄屏/150%缩放已实际复验。

大型画像、背景和源图按要求留在 dot，仓库保留轻量运行素材。独立运行和素材恢复请看 [素材说明](docs/large-assets.md)。GitHub Actions 配置为检查通过后自动部署公开 Pages 预览；首次需在仓库 Pages 设置选择 GitHub Actions，实际部署状态以对应运行结果为准。原私人预览单独更新。详见 [Pages 设置](docs/pages-deployment.md)。
