# 山门长明

单人修仙宗门浏览器游戏。默认简体中文，可切换英文，缺少英文的文本逐键回退中文。

## 项目状态

2026-10-01：用户已授权在 dot 云端直接开发，并使用私人 GitHub 仓库进行版本管理。项目已具备可玩的 v7 经营与远征循环，正在接入五路线战役；完整游戏尚未验收。

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

2026-10-01 最新完整验证：1655项测试、1041中文键、双类型检查、边界/内容和生产构建通过。候选v8已接真实退出预算、战役成长界面与受控撤退；下一扩建阶段已验证独立藏经阁建造/取消领域闭环，仍待World、保存与界面接入。普通新游戏仍v7，新版独立入口默认锁定且未部署；真实浏览器与完整1.0仍待验收。最近确认aa2413f的GitHub Actions成功，后续提交看各自状态。

大型画像、背景和源图按要求留在 dot，仓库保留轻量运行素材。独立运行和素材恢复请看 [素材说明](docs/large-assets.md)。GitHub Actions 当前负责检查和构建，不会自动更新游戏预览。
