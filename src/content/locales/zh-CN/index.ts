import type { TextKey } from '../../../i18n/messages.ts';
import type { MessageTemplate } from '../../../i18n/types.ts';

export const zhCN = {
  'app.title': '山门长明',
  'app.subtitle': '单人修仙宗门 · 浏览器游戏',
  'app.phase': '基础工程 · 第一阶段',
  'app.status': '确定性模拟、存档与界面基础正在搭建。',
  'app.hint': '当前为开发预览，完整玩法尚未开放。',
  'app.scene.label': '山门远景示意',
  'app.scene.caption': '一灯未熄，山门长明',
  'app.next.title': '下一步，点亮山门',
  'app.next.description': '先贯通新建世界、生产指令、时间推进与存档恢复，再逐步展开宗门生活。',
  'app.foundation.label': '工程起步',
  'app.foundation.detail': '玩法接入后将在此显示真实的宗门状态。',
  'settings.language.label': '语言',
  'settings.language.zh-CN': '简体中文',
  'settings.language.en': 'English',
  'settings.language.switch': '切换语言',
  'errors.translation.unavailable': '文本暂不可用',
  'world.disciples.summary': '{count}名弟子正在山门修行。',
  'disciple.welcome': '欢迎{name}加入山门。',
  'cultivation.progress': '当前修炼进度为{progress}。',
  'production.remaining': '生产还需{seconds}秒。',
  'resource.amount': '当前拥有{name}：{amount}。',
} as const satisfies Readonly<Record<TextKey, MessageTemplate>>;
