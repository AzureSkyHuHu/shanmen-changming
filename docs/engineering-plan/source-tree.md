# 建议源代码树与模块责任

这里只是未来实现位置，包内没有这些游戏代码。原始完整树见[源§23](source/game-design.md#s23)。文件责任以[任务JSON](03-execution/tasks.json)为可查询登记，跨目录接口由对应领域负责人评审。

```text
shanmen-changming/
  docs/                       # 本文档包可整体放到docs/engineering-plan/
  src/
    core/
      kernel/ simulation/     # 时钟、随机、ID、命令、事件 TASK-004~006
      world/                  # 地图、实体、关系 TASK-007/012/018
      agents/                 # 任务、导航、需求、日程 TASK-011~013
      economy/                # 库存、建造、研究 TASK-008/014
      cultivation/ legacy/    # 境界、突破、年龄、死亡、传承 TASK-016~018
      combat/
        definitions/ pipeline/ targeting/ effects/
        modifiers/ triggers/ statuses/ diagnostics/ ai/ tactics/
      builds/
        permanent-tree/ run-talents/ loadout/
      expeditions/ progression/ queries/
    content/
      schemas/ definitions/ encounters/ events/ maps/
      locales/zh-CN/           # 完整基础文本
      locales/en/              # 英文映射，逐键中文fallback
    application/
      session.ts command-dispatcher.ts save-coordinator.ts
      projections/ runtime/
    phaser/scenes/ views/
    ui/hud/ panels/ dialogs/ components/ settings/ i18n/
    input/
    platform/persistence/ files/ browser/ settings/
    workers/                  # 只有性能证据触发后才建立实际worker
    assets/
  public/assets/
  tests/unit/ property/ integration/ replay/ e2e/ performance/
  tests/combat/ builds/ fixtures/saves/ fixtures/scenarios/
  tools/                      # 内容/经济/构筑/回放/图集/性能工具
  licenses/                   # 逐资产来源与第三方许可
  package.json lockfile tsconfig.json vite.config.ts
  vitest.config.ts playwright.config.ts
  README.md CHANGELOG.md
```

## 依赖与仓库规则
core不能导入React/Phaser/DOM/数据库/Date.now；content不能执行任意脚本；UI只能改本地界面状态并提交命令；平台实现端口。设置与战役档分开。源资产和生成图集分开，生成物可重建，锁文件/工具链/三种版本进入发行记录。

正式仓库README应说明启动/构建/测试/内容验证/存档迁移/素材许可/已知限制；本包尚未提供可执行启动命令，避免让设计文件冒充代码仓库。
