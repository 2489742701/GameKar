/**
 * 对战模式入口 —— 只做三件事：装样式与材质、把 ArenaApp 起来、把 HUD 挂上去。
 *
 * 和老模式（`src/main.ts`）互相独立：两边各有各的入口页，共用 engine/ 与素材。
 */

import '../styles/base.css';
import '../styles/components.css';
import '../styles/arena.css';

import { installTheme } from '@ui/theme';
import { ArenaApp } from './ArenaApp';
import { ArenaHud } from './ArenaHud';

const required = <T extends Element>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`arena.html 里找不到 #${id}`);
  return node as unknown as T;
};

function seedFromUrl(fallback: number): number {
  const raw = new URLSearchParams(location.search).get('seed');
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const container = required<HTMLDivElement>('arena-ui');
const canvas = required<HTMLCanvasElement>('arena-stage');

// 木纹/镀金材质与老模式是同一套（玩家在那边的调参在这里也生效）
installTheme();

let hud: ArenaHud | null = null;

const app = await ArenaApp.boot({
  container,
  canvas,
  seed: seedFromUrl(20261027),
  onToast: (text, tone) => hud?.say(text, tone ?? 'ok'),
  onState: () => {
    hud?.refresh();
    hud?.setViewStatus(app.director.status);
  },
});

hud = new ArenaHud(container, app, {
  onSelectCard: (slot) => {
    const result = app.selectCard(slot);
    if (result === 'empty') hud?.say('这一格在补牌，等一下', 'warn');
    else if (result === 'cooldown') hud?.say('这张还在冷却', 'warn');
    else if (result === 'poor') {
      const card = app.world.hand[slot];
      hud?.say(`金币不够（要 ${card?.cost ?? 0}）`, 'warn');
    }
    hud?.setHand();
  },
  onCycleView: () => hud?.setViewStatus(app.nextView()),
  onRestart: () => location.reload(),
});

hud.setViewStatus(app.director.status);

// 键盘：V 换视角（和 HUD 上那颗按钮走同一条路）
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'v' || e.key === 'V') hud?.setViewStatus(app.nextView());
});

declare global {
  interface Window {
    arena: ArenaApp;
    arenaHud: ArenaHud;
  }
}

window.arena = app;
window.arenaHud = hud;
