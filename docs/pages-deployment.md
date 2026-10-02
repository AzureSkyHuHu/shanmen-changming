# GitHub Pages 自动预览

此工作流为已授权的公开游戏预览提供自动构建和部署。配置文件存在不代表仓库已启用 Pages，也不代表线上部署或完整游戏验收已经通过。

## 一次性仓库设置

仓库管理员或维护者打开 [仓库 Pages 设置](https://github.com/AzureSkyHuHu/shanmen-changming/settings/pages)，在 **Build and deployment → Source** 选择 **GitHub Actions**。仓库已有 `.github/workflows/ci.yml`，无需再创建 GitHub 建议的模板工作流。[官方设置步骤](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)

同时检查 `github-pages` 环境的部署分支规则仅允许 `main`；如已设置人工审批，工作流会正常等待审批，不会绕过。现有 Actions 策略也必须允许本工作流使用的官方 `actions/*` 操作。[官方 Pages 环境建议](https://github.com/actions/deploy-pages/blob/v5.0.1/README.md#security-considerations)

工作流只使用任务运行期间的 `GITHUB_TOKEN` 和 OIDC，不需要创建、保存或提供 PAT、部署密钥或云账号凭据。`configure-pages` 显式关闭 `enablement`，只读取现有 Pages 配置，不会申请管理权限或替用户开启服务。如果此步骤提示 Pages 未配置，先完成上述设置，再重新运行当前 `main` 的完整工作流。[官方 configure-pages 输入](https://github.com/actions/configure-pages/blob/v6.0.0/action.yml)

## 构建与部署约束

- `push` 到 `main` 和 PR 都保留原有 `npm run check`：模块边界、内容/文案、全部测试、双类型检查及默认生产构建。
- 只有 `main` 的 `push` 在检查成功后额外生成预览构建，使用 `VITE_BASE_PATH=/shanmen-changming/` 和 `VITE_ENABLE_V8_CANDIDATE=1`。不重复运行整套测试。
- 上传目录仅为 `dist`，保留一天。`deploy` 通过 `needs: validate` 消费同一工作流运行的已验证产物；不使用 `workflow_run`、PR 产物、PR 写权限或另一次构建。
- 源码检出固定为触发该次运行的 SHA。部署前再读取 `main`，若 SHA 已变则拒绝旧运行覆盖站点。要回滚，请在 `main` 提交经过验证的回退，而不是重新部署过期运行。
- PR 可以取消旧检查；`main` 运行和 Pages 部署不会被新推送中断。同一分支只运行一组检查，Pages 部署另有独立串行锁；较新的待运行版本可替代尚未开始的旧版本。[GitHub 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- 校验任务仅有 `contents: read`。只有部署任务具有 `pages: write`、`id-token: write`，并以 `contents: read` 读取最新 `main`；该任务不检出或执行项目源码。Pages 与 OIDC 权限仅用于本次部署。[官方权限说明](https://github.com/actions/deploy-pages/blob/v5.0.1/README.md#oidc)

Pages 操作固定到 2026-10-02 从官方发布页核验的完整提交：

- `configure-pages` [v6.0.0](https://github.com/actions/configure-pages/releases/tag/v6.0.0)：[`45bfe0192ca1faeb007ade9deae92b16b8254a0d`](https://github.com/actions/configure-pages/commit/45bfe0192ca1faeb007ade9deae92b16b8254a0d)
- `upload-pages-artifact` [v5.0.0](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0)：[`fc324d3547104276b827a68afc52ff2a11cc49c9`](https://github.com/actions/upload-pages-artifact/commit/fc324d3547104276b827a68afc52ff2a11cc49c9)
- `deploy-pages` [v5.0.1](https://github.com/actions/deploy-pages/releases/tag/v5.0.1)：[`368f82528645a54fb793d4d04e342629a3f51346`](https://github.com/actions/deploy-pages/commit/368f82528645a54fb793d4d04e342629a3f51346)

## 入口、存档与素材

首次成功部署后，在未配置自定义域名时，预期地址为：

- 普通入口：`https://azureskyhuhu.github.io/shanmen-changming/`
- 战役候选：`https://azureskyhuhu.github.io/shanmen-changming/candidate.html`
- 提交证据：`https://azureskyhuhu.github.io/shanmen-changming/build-info.json`

普通入口的新游戏仍采用 v7；候选页显式开启 v8，并保持独立数据库 `shanmen-changming-v8-candidate-saves`。这不将普通入口升级为 v8，也不读取、复制或迁移普通入口存档。GitHub Pages 与原私人预览属于不同站点来源，浏览器本地存档不会自动跨站同步。

两张大型原图仍按 [大素材说明](large-assets.md) 留在本地，不进入 Git 或 Pages 产物。CI 明确检查产物中不存在这两张原图。仓库已包含角色 96 像素头像、场景与战斗序列帧；人物信息使用 CSS 叠层回退。路线大图为 `aria-hidden` 的装饰，缺失时保留 CSS 渐变底图，路线文字与操作独立存在。静态源码检查未发现玩法依赖这些原图；首次线上浏览器验收仍须检查缺图回退、两条入口、资源子路径和独立存档，不能用构建通过代替。

## 如何确认生效

1. 在 [Validate game](https://github.com/AzureSkyHuHu/shanmen-changming/actions/workflows/ci.yml) 找到目标 `main` 提交，确认 `validate` 与 `deploy` 均成功。
2. 使用该次部署输出的 `page_url` 打开页面；读取 `build-info.json`，确认 `commit` 等于目标 SHA。
3. 分别检查普通入口和 `candidate.html` 能加载并创建对应新游戏，刷新后各自存档仍独立。检查生产资源从 `/shanmen-changming/` 加载，以及缺失原图时的界面。
4. 如 Pages 设置尚未完成、环境等待审批、测试失败、部署失败或浏览器验收尚未执行，应分别记录对应状态，不标记为“已上线”或“游戏已验收”。
