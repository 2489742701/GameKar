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

/**
 * 加载 vanilla 入口，失败时**重试一次**（2026-11-16 排查出的一次真实故障）。
 *
 * 现象：`npm run dev` 刚起来、第一次访问 `/arena.html` 时，页面全黑、`window.arena`
 * 不存在、控制台零报错 —— 因为 `await import('./vanilla')` 抛了
 * `TypeError: Failed to fetch dynamically imported module`，而这是个**顶层 await**，
 * 异常没人接，整个入口就静默死掉了。
 *
 * 根因是 Vite 开发服务器的**依赖预打包竞态**：第一次请求时它才开始去扫依赖、
 * 把 three 之类的裸模块转成浏览器能用的 URL；这时动态 import 的那一批 chunk
 * 还没落地，fetch 就 404-ish 失败。**第二次访问一定正常**（实测手动 import 必成）。
 *
 * 影响面：生产构建不受影响（chunk 是静态的）；只影响 `npm run dev` 的冷启动第一下。
 * 但"打开是黑屏、控制台还没错"是最难查的一类问题，所以这里补一次重试 +
 * 失败时给一块可读的提示，而不是静默黑屏。
 */
async function loadVanilla(): Promise<void> {
  try {
    await import('./vanilla');
  } catch (err) {
    // 冷启动竞态：等一下让 Vite 把依赖转完，再试一次。加时间戳绕开失败缓存。
    console.warn('[arena] vanilla 首次加载失败，重试一次（Vite 冷启动依赖预打包）：', err);
    await new Promise((r) => setTimeout(r, 600));
    try {
      await import(/* @vite-ignore */ `./vanilla?retry=${Date.now()}`);
    } catch (err2) {
      console.error('[arena] vanilla 加载彻底失败：', err2);
      showBootError(err2);
    }
  }
}

/** 加载失败时画一块提示，别让玩家对着黑屏。不依赖任何游戏 CSS。 */
function showBootError(err: unknown): void {
  const ui = document.getElementById('arena-ui') ?? document.body;
  const box = document.createElement('div');
  box.style.cssText = [
    'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:12px',
    'color:#e8edf7', 'font:500 14px/1.6 system-ui,sans-serif', 'text-align:center',
    'padding:24px', 'pointer-events:auto',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = '游戏没启动起来';
  title.style.cssText = 'font-size:18px';
  const detail = document.createElement('div');
  detail.textContent = err instanceof Error ? err.message : String(err);
  detail.style.cssText = 'opacity:.7;max-width:34em';
  const hint = document.createElement('div');
  hint.textContent = '开发模式下这通常是 Vite 冷启动的竞态：刷新一次页面就好。';
  hint.style.cssText = 'opacity:.55;font-size:12px;max-width:34em';
  const reload = document.createElement('button');
  reload.textContent = '刷新页面';
  reload.style.cssText = [
    'margin-top:8px', 'padding:10px 20px', 'border-radius:8px',
    'border:1px solid #4a5a72', 'background:#16202f', 'color:#e8edf7',
    'font:inherit', 'cursor:pointer',
  ].join(';');
  reload.addEventListener('click', () => location.reload());
  box.append(title, detail, hint, reload);
  ui.append(box);
}

if (modId) {
  // 模组模式：清单缺失、api 不匹配、import 报错都只在 modHost 里画一块提示，
  // 绝不抛到顶层，也绝不把主程序拖下水。
  await mountMod(modId);
} else {
  // 普通模式：先把模组按钮挂到菜单（异步读清单，不阻塞主程序启动），
  // 再按原样加载 vanilla。vanilla 内部仍是原来的顶层脚本，行为一字未变。
  injectModButtons();
  await loadVanilla();
}
