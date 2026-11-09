/**
 * GAMEKAR 模组开放 API（2026-11-09，P-087）。
 *
 * 用户口径：「主程序 0 改动，然后开放 API 接口，相当于用模组的方式来做」。
 * 所以这个文件是**新增的能力出口**，不修改任何现有玩法文件：
 *   · `ArenaApp.ts` / `ArenaWorld.ts` / `ArenaHud.ts` / `config.ts` 一行不动；
 *   · 只把卡池、卡面图标、手牌 DOM 工厂做成稳定接口，由 `modDeps.ts` 注入给模组。
 *
 * `createModHand()` 复用主程序 `arena.css` 的 `.ahud__hand` / `.ahud__card` 类名
 * 和 `cardIcons.ts` 的图标，所以模组的手牌长得和 /arena.html 一模一样 ——
 * 大地图是**卡牌驱动的主模式扩展**，不是另做一个战争模式。
 *
 * 版本号注意：`MOD_API_VERSION` 是**开放 API** 的版本；`host.api === 1` 是
 * **宿主契约**的版本（见 modHost.ts）。两者互不相干，别合并。
 */
import { CARDS, ECONOMY, HAND, type ArenaCard } from './config';
import { iconOf } from './cardIcons';
import { COIN_ICON } from './supplyIcons';

export const MOD_API_VERSION = 2;

export { CARDS, ECONOMY, HAND, iconOf };
export type { ArenaCard };

/** 模组可以自带扩展卡的图标（不往主程序 CARD_ICON 里塞）。 */
export interface ModCard extends ArenaCard {
  icon?: string;
}

export interface ModHandCallbacks {
  /** 点一下选中（再点一次取消由调用方决定） */
  onSelect(slot: number): void;
  /** 长按拖出后松手落在地图上：屏幕坐标由调用方换算成格子 */
  onDrop(slot: number, clientX: number, clientY: number): void;
  /** 拖动过程：给调用方画落牌影子 */
  onDragMove?(slot: number, clientX: number, clientY: number): void;
  /** 拖回手牌区 / 取消 */
  onCancel?(slot: number): void;
}

export interface ModHand {
  readonly el: HTMLElement;
  /** 手牌状态由模组自己的规则层给，API 不碰玩法判据 */
  render(cards: (ModCard | null)[], gold: number, selected: number): void;
  /** 出牌飞出动画（和主模式 .ahud__card[data-played] 同一条） */
  play(slot: number): void;
  dispose(): void;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * 主模式那条**金币条**（`.ahud__bank`），不是把金币数字塞在顶栏左上角。
 *
 * 用户 2026-11-09：「那个金币为什么给你收到左上角了？不是这个UI，可以用我们旧的UI啊」。
 * 旧 UI 就是皇室战争那版的金币条：手牌下方一条胶囊，填充条按 金/上限 长，
 * 每 1 金一道刻度，攒满泛金光。这里只做 DOM，读数和上限仍由模组规则层喂。
 */
export interface ModBank {
  readonly el: HTMLElement;
  set(gold: number, cap: number): void;
  dispose(): void;
}

export function createModBank(): ModBank {
  const row = document.createElement('div');
  row.className = 'ahud__bankrow';
  row.dataset['modBank'] = '1';
  row.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:8px', 'transform:translateX(-50%)',
    'width:min(560px,92vw)', 'pointer-events:auto', 'z-index:22',
  ].join(';');

  const bank = document.createElement('div');
  bank.className = 'ahud__bank';
  const fill = document.createElement('span');
  fill.className = 'ahud__bank__fill';
  const label = document.createElement('span');
  label.className = 'ahud__bank__label';
  const icon = document.createElement('span');
  icon.className = 'ahud__bank__icon';
  icon.innerHTML = COIN_ICON;
  const num = document.createElement('b');
  num.className = 'ahud__bank__num';
  const cap = document.createElement('span');
  cap.className = 'ahud__bank__cap';
  label.append(icon, num, cap);
  bank.append(fill, label);
  row.append(bank);

  return {
    el: row,
    set(gold, max) {
      // 刻度间距按上限算，别在 CSS 里写死（主模式 HUD 就是这么漏过一次）
      bank.style.setProperty('--gold-tick', `${100 / Math.max(1, max)}%`);
      num.textContent = String(gold);
      cap.textContent = `/${max}`;
      fill.style.width = `${Math.min(100, (gold / Math.max(1, max)) * 100)}%`;
      bank.dataset['full'] = String(gold >= max);
    },
    dispose() { row.remove(); },
  };
}

/**
 * 生成和主模式同款的四张手牌。拖放阈值 8px：短按是"选中"，拖出去才是"落牌"。
 * 只负责 DOM 与手势，判据 / 扣钱 / 补牌都由调用方（模组规则层）自己算。
 */
export function createModHand(cb: ModHandCallbacks): ModHand {
  const hand = document.createElement('div');
  hand.className = 'ahud__hand';
  hand.dataset['modHand'] = '1';
  hand.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:34px', 'transform:translateX(-50%)',
    'width:min(560px,92vw)', 'pointer-events:auto', 'z-index:22',
  ].join(';');

  const buttons: HTMLButtonElement[] = [];
  let drag: { slot: number; x: number; y: number; active: boolean } | null = null;
  // pointerup 先于 click：拖出去松手时别让 click 又把它选中（P-087 实测坑）
  let lastDragAt = -1e9;

  for (let i = 0; i < HAND.size; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ahud__card';
    btn.dataset['empty'] = '1';
    btn.dataset['slot'] = String(i);
    btn.addEventListener('pointerdown', (e) => {
      drag = { slot: i, x: e.clientX, y: e.clientY, active: false };
    });
    btn.addEventListener('click', () => {
      if (performance.now() - lastDragAt < 300) return;
      cb.onSelect(i);
    });
    buttons.push(btn);
    hand.append(btn);
  }

  const onMove = (e: PointerEvent): void => {
    if (!drag) return;
    if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.active = true;
    if (drag.active) cb.onDragMove?.(drag.slot, e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent): void => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    lastDragAt = performance.now();
    const overHand = (e.target as Element | null)?.closest?.('.ahud__hand');
    if (overHand) cb.onCancel?.(d.slot);
    else cb.onDrop(d.slot, e.clientX, e.clientY);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  return {
    el: hand,
    render(cards, gold, selected) {
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i]!;
        const card = cards[i] ?? null;
        btn.dataset['empty'] = card ? '0' : '1';
        btn.dataset['affordable'] = String(!card || gold >= card.cost);
        btn.dataset['selected'] = String(i === selected);
        btn.dataset['kind'] = card && card.kind !== 'building' ? 'army' : 'building';
        btn.innerHTML = card
          ? `<span class="ahud__card__cost">${card.cost}</span>` +
            `<span class="ahud__card__art">${card.icon ?? iconOf(card.id)}</span>` +
            `<span class="ahud__card__name">${esc(card.name)}</span>` +
            `<span class="ahud__card__kind">${card.kind === 'building' ? '建筑' : '军队'}</span>`
          : '';
      }
    },
    play(slot) {
      const btn = buttons[slot];
      if (!btn) return;
      btn.dataset['played'] = '1';
      window.setTimeout(() => { delete btn.dataset['played']; }, 280);
    },
    dispose() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      hand.remove();
    },
  };
}
