/**
 * 对战模式入口 —— 2026-11-08 起只做一件事：**启动前分流**。
 *
 * 用户："这个大世界改成热插拔的行不，最好别污染主程序。咱们主程序毕竟开发差不多了。
 * 作为一个模组来更新"。
 *
 * 原来的整份入口**一字不改**搬到了 `./vanilla.ts`（git 里是一次 rename）。
 * 这里没有、也不许有 ArenaApp / StartMenu / ArenaWorld / config 的引用：
 * 主程序不该知道世界上有哪些模组，模组也不该静态 import 主程序玩法。
 *
 * 为什么是"启动前分流"而不是运行时卸载：`ArenaApp` 没有整体 dispose，
 * 硬做卸载就得改它 —— 那就污染了。项目本来就用 `?mode=pve` + reload 切模式，
 * 直接复用：菜单点模组 → `?mod=<id>` → reload → 这里挂模组；
 * 模组里点退出 → 清掉 `?mod=` → reload → 回到 vanilla。
 *
 * 详见 `docs/工作笔记/大地图模组化架构_20261108.md`。
 */

import '../styles/base.css';
import '../styles/components.css';
import '../styles/arena.css';
import '../styles/start.css';

import { injectModButtons, mountMod } from './modHost';

const modId = new URLSearchParams(location.search).get('mod');

if (modId) {
  // 模组模式：清单缺失、api 不匹配、import 报错都只在 modHost 里画一块提示，
  // 绝不抛到顶层，也绝不把主程序拖下水。
  await mountMod(modId);
} else {
  // 普通模式：先把模组按钮挂到菜单（异步读清单，不阻塞主程序启动），
  // 再按原样加载 vanilla。vanilla 内部仍是原来的顶层脚本，行为一字未变。
  injectModButtons();
  await import('./vanilla');
}
