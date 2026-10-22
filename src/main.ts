/**
 * 入口 —— 只做三件事：装载样式、把 GameApp 起来、把 HUD 挂上去。
 *
 * 顺带把 app 暴露成 window.game：开发期在控制台直接敲 `game.pull(10)` 比改代码快得多。
 */

import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { GameApp } from '@game/GameApp';
import type { Difficulty } from '@game/config';
import { Hud } from '@ui/Hud';
import { installTheme } from '@ui/theme';
import { giltOf, loadTuning, woodOf } from '@ui/themePrefs';

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

/** ?difficulty=easy|normal|hard 直接指定这一局的档位；写错了就当没写（不替玩家猜档）。 */
function difficultyFromUrl(): Difficulty | undefined {
  const raw = new URLSearchParams(location.search).get('difficulty');
  return raw === 'easy' || raw === 'normal' || raw === 'hard' ? raw : undefined;
}

const container = required<HTMLDivElement>('app');
const canvas = required<HTMLCanvasElement>('stage');
const uiHost = required<HTMLDivElement>('ui');
const splash = document.getElementById('boot');

// boot 是异步的：小人素材包要先取回来
const app = await GameApp.boot({ container, canvas, seed: seedFromUrl(20261019), difficulty: difficultyFromUrl() });

// 木纹与镀金是启动时现算的两张小图，必须赶在 HUD 建起来之前挂上 CSS 变量。
// 参数从玩家偏好里读：他在这台机器上调过什么，开局就是什么长相（没调过 = 默认那套）。
const tuning = loadTuning(app.prefs);
window.theme = installTheme(undefined, woodOf(tuning), giltOf(tuning), tuning.scale);

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
