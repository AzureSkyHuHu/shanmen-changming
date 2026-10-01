# 参考与证据边界

主设计源及原始核验日期见[来源记录](source/PROVENANCE.md)。本包没有独立实现或性能实验。以下官方资料用于工程选型；开发时须复核精确版本，不把文档链接当作已安装软件。

## 技术官方资料
- [Phaser官方React TypeScript模板](https://github.com/phaserjs/template-react-ts)：框架衔接起点；注意源方案要求检查构建统计和nolog路径
- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)：稳定外部快照订阅
- [Vite指南](https://vite.dev/guide/)：开发和构建工具链
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)：本地结构化存储
- [MDN存储配额与回收](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)：本地档非永久保障
- [Vitest指南](https://vitest.dev/guide/)与[Playwright指南](https://playwright.dev/docs/intro)：单元/集成与真实页面测试
- [i18next fallback](https://www.i18next.com/principles/fallback)、[interpolation](https://www.i18next.com/translation-function/interpolation)、[react-i18next useTranslation](https://react.i18next.com/latest/usetranslation-hook)：语言适配器建议；显式中文默认及fallback，空英文回退

## 设计/制作依据
- [Hades官方更新说明](https://www.supergiantgames.com/blog/hades-the-nighty-night-update-patch-notes/)：仅参考刷新避免空转的思路，不复用名称或数值
- [OpenAI官方game-studio插件目录](https://github.com/openai/plugins/tree/main/plugins/game-studio)：主方案已研究来源提交5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f；资料准备不等于游戏实现或插件永久激活

## 素材候选（未因本包下载或采纳）
- [Kenney UI Adventure](https://kenney.nl/assets/ui-pack-adventure)、[Particle Pack](https://kenney.nl/assets/particle-pack)、[Interface Sounds](https://kenney.nl/assets/interface-sounds)
- [Asianoriental2](https://opengameart.org/content/asianoriental2)、[亭模型](https://vvaytoyek.itch.io/chinese-four-corner-pavilion-free)、[剑模型](https://vvaytoyek.itch.io/chinese-fantasy-sword-pack1-free)
- [Noto CJK许可](https://github.com/notofonts/noto-cjk/blob/main/Serif/LICENSE)、[CC0条款](https://creativecommons.org/publicdomain/zero/1.0/)

许可须逐具体文件再核；候选免费标签不构成权利保证。没有联网/遥测/账号接入授权隐含在这些链接中。
