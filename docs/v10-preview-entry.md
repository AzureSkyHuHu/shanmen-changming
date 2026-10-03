# v10 独立测试入口接线

日期：2026-10-03。此次仅准备明确 opt-in 的入口；没有启用公开 v10 游戏，没有修改普通 v7、v8 战役或 v9 经营入口。构建开关不是访问控制：默认构建可包含未启用的 `management-next.html`，若日后在公开站点构建启用版本，它也会公开可访问，不能据此称作私密页面。

## 构建与隔离

- 新页面为 `management-next.html`，独立 DOM 根为 `management-next-root`，脚本为 `src/management-next.tsx`
- 仅编译环境变量 `VITE_ENABLE_V10_MANAGEMENT` 严格等于字符串 `'1'` 时接入候选模块；没有 URL、localStorage、sessionStorage、旧 v9 开关或运行时对象覆盖
- 未启用分支不动态导入 v10 Session、存档控制器、存档适配器或应用组件，不创建世界，不打开任何存档数据库。非字符串值不被读取或强制转换
- `vite.config.ts` 只新增独立构建输入；未添加默认值，未修改 CI 的现有 v8/v9 开关，也未修改现有三个入口
- 独立测试可以由集成负责人以 `VITE_ENABLE_V10_MANAGEMENT=1` 启动本地开发或构建。此命令仅说明测试方式，不代表本次已经执行、授权发布或通过验收

## 实际服务和存档语义

启用后真实连接 `ApplicationSessionV10`、`ManagementSaveControllerV10`、`createManagementStorageSlotV10` 与 `ManagementAppV10`。入口仅在新世界创建后设置真实 player 暂停，再开放存档控制器与界面；玩家须显式恢复。既有存档的读取/导入仍由控制器原样恢复其自身暂停状态，入口不会再次添加 player/hidden 暂停。

服务构造本身不开数据库。入口开始服务时只由现有控制器打开固定的 `shanmen-changming-v10-management-saves`，不能指定旧数据库名。启动仅列出 v10 位置，不读取任何槽位成为当前游戏，也不写入初始进度。每次回访都是新暂停 Session；已保存位置须明确核对并读取。保存保持 `manual-only`；租约续期不是自动保存，页面关闭不触发最后一刻保存。

本片不连接复制 host、源 v9 Session、迁移协调器或迁移确认流程。存档正文使用稳定中英文键明确说明 v9 → v10 复制转换尚未接入，只支持 v10 操作；适配器原有的来源原文导出仅查询 v10 数据库里已存在的备份，不能执行转换或打开旧数据库。严格 v10 导入的版本拒绝与保护仍由现有控制器负责。

IndexedDB 不可用时保留真实控制器的 unavailable 状态和当前会话导出能力，不伪报已保存。Session/模块/非预期启动错误展示失败页，不声称进度保存成功。

## 生命周期所有权

- 创建和启动服务均在 React 树外完成；StrictMode 的呈现和 effect 重放不拥有 Session 或控制器启动权
- 每个服务的 start 与 dispose 都是一次性、幂等的；dispose 在首个 start 微任务之前发生时，不会打开数据库，已销毁服务不能再次启动
- dispose 先同步使存档控制器失效，等待其在途事务、租约和连接清理完成，再关闭 Session，避免在同步订阅发布栈中关闭；只有明确 BUSY 的 close 才离栈重试一次
- 即使存档停止拒绝也仍尝试关闭 Session，失败保留为 rejected promise，不伪称完成清理
- 根拥有一次 pagehide 清理。导入未完成时离开页面不会创建服务；启动的晚到结果不会重挂页面。重复停止只卸载一次，root.unmount 抛错也会执行服务清理
- React 未捕获渲染错误与同步启动异常同样清理服务并展示失败页。新入口没有退出时自动保存，也没有旧存档迁移副作用

## 检查与验收边界

新增 `tests/application/management-v10-preview.test.tsx` 编写了精确开关与模块未导入验证、运行时覆盖拒绝、稳定文案/中文回退、真实暂停 Session、一次启动、固定 v10 数据库、手动保存及回访显式读取、旧数据库原文不变、存储不可用导出、停启竞争、同步订阅期间清理、停止拒绝/BUSY 重试、初始构造失败、StrictMode 树外所有权、pagehide/晚到启动、卸载和渲染失败。

这些测试使用真实 Session、真实控制器、fake-indexeddb 和 React 根边界替身；根替身不能替代真实浏览器中 StrictMode effect、Canvas、焦点、上传下载及导航行为的验收。实施工作者按分工未运行测试、类型检查、构建、Git 或浏览器。实际串行检查、默认/启用构建及浏览器结果由集成负责人另记。未通过之前不称本片已完成玩家验收、v10 公开发布、移动端或完整游戏验收。
