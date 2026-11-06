/**
 * **花色编辑器**（2026-11-06 用户："这个设置能不能额外准备一个自定义设置里面
 * 给他处理？其实我允许自定义，也允许设计。花色还是太少了……颜色也给用户准备
 * 几个不错的预选。"）
 *
 * 一份组件两个入口：
 * - 开始菜单里的「你的旗帜」；
 * - 游戏内 HUD 的「设置」面板（ArenaHud）—— 战斗中也能调，改完**下一局生效**
 *   （结算面板的「再来一局」= location.reload，会读到新存档）。
 *
 * 只攒 localStorage 存档（banner.ts），不碰任何已启动的世界 —— 生效桥在 main.ts。
 */

import { el } from '@ui/dom';
import {
  bannerClothCanvas,
  drawEmblem,
  EMBLEMS,
  loadSettings,
  saveSettings,
  SCHEMES,
  type Banner,
  type BannerSettings,
} from './banner';

export interface BannerEditorOptions {
  /** 每次改动后的回调（StartMenu 用来刷新大预览；HUD 用来提示"下一局生效"） */
  onChange?: (settings: BannerSettings) => void;
  /** 顶部说明文字（两个入口的语境不同） */
  hint?: string;
}

export function createBannerEditor(opts: BannerEditorOptions = {}): HTMLElement {
  const settings: BannerSettings = loadSettings();

  const box = el('div', 'bned');
  const head = el('div', 'bned__head');
  head.append(el('span', 'bned__title', '你的旗帜'));
  if (opts.hint) head.append(el('span', 'bned__hint', opts.hint));
  box.append(head);

  // 预览旗
  const preview = document.createElement('canvas');
  preview.className = 'bned__preview';
  preview.width = 144;
  preview.height = 96;
  box.append(preview);

  // 三个颜色
  const colors = el('div', 'bned__colors');
  const colorRow = (label: string, key: 'primary' | 'secondary' | 'emblemColor') => {
    const wrap = el('label', 'bned__color');
    const input = document.createElement('input');
    input.type = 'color';
    input.value = settings.player[key];
    input.addEventListener('input', () => {
      settings.player = { ...settings.player, [key]: input.value };
      afterChange();
    });
    wrap.append(input, el('span', '', label));
    return wrap;
  };
  colors.append(colorRow('主色', 'primary'), colorRow('次色', 'secondary'), colorRow('徽记', 'emblemColor'));
  box.append(colors);

  // 预设配色：三色成套一键套用（徽记不动）
  const schemes = el('div', 'bned__schemes');
  schemes.append(el('span', 'bned__label', '配色'));
  for (const s of SCHEMES) {
    const btn = el('button', 'bned__scheme');
    btn.type = 'button';
    btn.title = s.name;
    // 色卡：左主色右次色，中间一道徽记色
    btn.innerHTML =
      `<span style="background:${s.primary}"></span>` +
      `<span style="background:${s.emblemColor}"></span>` +
      `<span style="background:${s.secondary}"></span>`;
    btn.addEventListener('click', () => {
      settings.player = {
        ...settings.player,
        primary: s.primary,
        secondary: s.secondary,
        emblemColor: s.emblemColor,
      };
      afterChange();
    });
    schemes.append(btn);
  }
  box.append(schemes);

  // 徽记：12 款
  const emblems = el('div', 'bned__emblems');
  const mini = new Map<string, HTMLCanvasElement>();
  for (const e of EMBLEMS) {
    const btn = el('button', 'bned__emblem');
    btn.type = 'button';
    btn.title = e.name;
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 40;
    btn.append(c);
    mini.set(e.id, c);
    btn.addEventListener('click', () => {
      settings.player = { ...settings.player, emblem: e.id };
      afterChange();
    });
    emblems.append(btn);
  }
  box.append(emblems);

  // 敌方模式
  const enemyRow = el('div', 'bned__enemy');
  enemyRow.append(el('span', 'bned__label', '敌方'));
  const enemyBtns = new Map<BannerSettings['enemy'], HTMLButtonElement>();
  const modeBtn = (mode: BannerSettings['enemy'], label: string) => {
    const btn = el('button', 'bned__mode', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      settings.enemy = mode;
      afterChange();
    });
    enemyBtns.set(mode, btn);
    return btn;
  };
  enemyRow.append(modeBtn('red', '红旗'), modeBtn('random', '随机花色'));
  box.append(enemyRow);

  function afterChange(): void {
    saveSettings(settings);
    paint();
    opts.onChange?.(settings);
  }

  function paint(): void {
    const b: Banner = settings.player;
    const cloth = bannerClothCanvas(b, 144, 96);
    const ctx = preview.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 144, 96);
      if (cloth) ctx.drawImage(cloth, 0, 0);
    }
    for (const [id, c] of mini) {
      const btn = c.parentElement as HTMLButtonElement;
      btn.dataset['on'] = String(b.emblem === id);
      const c2 = c.getContext('2d');
      if (!c2) continue;
      c2.clearRect(0, 0, 40, 40);
      c2.fillStyle = b.primary;
      c2.fillRect(0, 0, 40, 40);
      c2.save();
      c2.translate(6, 6);
      c2.scale(28, 28);
      c2.fillStyle = b.emblemColor;
      drawEmblem(c2, id as Banner['emblem']);
      c2.restore();
    }
    for (const [mode, btn] of enemyBtns) btn.dataset['on'] = String(settings.enemy === mode);
  }

  paint();
  return box;
}
