# 原生模态框页面滚动修正

2026-10-03 UTC。仅修改共享样式与静态合同检查；不修改 React 状态、模态生命周期、焦点逻辑、模拟或存档。

## 现有证据

- 本轮已发布页面截图 `12-campaign-phone-en-after.jpg` 同时显示战役入口内部滚动条和页面滚动条。内部滚动用于窄屏下访问新战役、种子和页尾，必须保留
- 同轮浏览器几何检查：视口 402×540 CSS px；文档 clientWidth/scrollWidth 均为 390，scrollHeight 为 2452，根节点 overflow 为 visible；原生模态框约 381.6×520，clientHeight 为 518，scrollHeight 为 980，overflow 为 auto
- 这证明模态框打开时仍有独立页面滚动区，不单凭双滚动条断言背景手势已经泄漏。背景实际滚动与焦点行为须在修正后复核

## 最小修改

共享 `src/app/app.css` 在 `@supports selector(html:has(dialog:modal))` 内，仅为匹配 `html:has(dialog:modal)` 的根节点设置 `overflow: hidden`。无模态框时规则不匹配；不支持该选择器时保持此前行为。使用原生 `:modal`，避免把仅含 `open` 属性的非模态 dialog 当作模态框。

保留入口/普通存档框的高度约束与内部滚动，以及经营存档框的固定标题、反馈和可滚动内容。没有固定 body、强制全局 scrollbar-gutter 或新增 JavaScript 计数/清理路径。模态框切换时以浏览器当前原生模态状态为准。

## 验证状态与清单

新增 `tests/ui/native-modal-scroll-contract.test.ts` 共四项源码合同检查，覆盖选择器守卫、条件根锁、默认页面布局和现有内部滚动。尚未运行；测试、构建和真实浏览器验证由集成负责人统一执行。源码合同不等同于浏览器验收。

建议定向检查：

`npm test -- tests/ui/native-modal-scroll-contract.test.ts tests/entry-flow/entry-flow.test.tsx tests/application/management-v9-save-presentation.test.ts`

真实页面待验证：

1. 手机窄窗、桌面和 150% 缩放下打开入口/存档，根滚动条不再可操作，无横向溢出或新内容遮挡
2. 内部滚动仍能到达种子、新建按钮和页尾；经营存档标题与反馈仍可见
3. 在模态内容及边缘尝试滚动，背景位置保持；入口与存档来回切换不恢复背景滚动
4. 关闭最后一个模态后，页面可正常滚动，先前位置与焦点按既有逻辑恢复；重复开关无残留锁
5. 不为复核读取覆盖当前未保存世界、写入或删除已有槽位。涉及替换现有进度的行为另按授权执行

本改动不代表移动真机、屏幕阅读器或所有浏览器兼容性已经验收。

集成记录（02:28 UTC）：三份指定测试文件共 39 项通过，耗时 3.83 秒；生产构建通过。发布后仍需执行上述真实浏览器滚动检查。
