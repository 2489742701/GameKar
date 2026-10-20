/**
 * 入口 —— 只做三件事：装载样式、把 GameApp 起来、把 HUD 挂上去。
 *
 * 顺带把 app 暴露成 window.game：开发期在控制台直接敲 `game.pull(10)` 比改代码快得多。
 */

import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { GameApp } from '@game/GameApp';
import { Hud } from '@ui/Hud';
import { installTheme } from '@ui/theme';

function required<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html 里找不到 #${id}`);
  return node as unknown as T;
}

/** ?seed=123 换一张地图，方便并排比较两种地形生成结果。 */
function seedFromUrl(fallback: number): number {
  const raw = new URLSearchParams(location.search).get('seed');
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const container = required<HTMLDivElement>('app');
const canvas = required<HTMLCanvasElement>('stage');
const uiHost = required<HTMLDivElement>('ui');
const splash = document.getElementById('boot');

// 木纹与镀金是启动时现算的两张小图，必须赶在 HUD 建起来之前挂上 CSS 变量
window.theme = installTheme();

// boot 是异步的：小人素材包要先取回来
const app = await GameApp.boot({ container, canvas, seed: seedFromUrl(20261019) });
const hud = new Hud(uiHost, app);
hud.start();

splash?.setAttribute('data-done', '');
window.setTimeout(() => splash?.remove(), 600);

declare global {
  interface Window {
    game: GameApp;
    hud: Hud;
    /** 纹理生成读数（字节数与耗时），开发期直接敲 window.theme 看 */
    theme: ReturnType<typeof installTheme>;
  }
}

window.game = app;
window.hud = hud;
