/**
 * 开始菜单 —— 打开 `/arena.html` 看到的第一屏。
 *
 * 为什么需要它：上一版是"打开即进游戏"，倒计时当场开始。
 * 玩家还没看清这是个什么游戏，对面 AI 已经出了两张牌了。
 *
 * 只做三件事：**喊出这是什么**、**让人自己决定什么时候开始**、**把规则摊开一次**。
 * 真正的逻辑暂停在 `ArenaApp.pause()`（`GameLoop` 停 `onSimStep`、渲染不停），
 * 所以菜单背后那幅战场一直在：浮尘在飘、磨坊在转 —— 比一张静态背景图更像"游戏在等你"。
 */

import { el } from '@ui/dom';
import type { Sfx } from '@audio/sfx';
import { createBannerEditor } from './bannerEditor';

/** 菜单上的三个模式。`pve1` = 单人守城，`pve2` = 双人同屏守城。 */
export type MenuMode = 'arena' | 'pve1' | 'pve2';

export interface StartMenuOptions {
  seed: number;
  /**
   * 当前所处的模式。**只影响"主按钮按哪个开始"和文案**，
   * 不影响其它模式入口是否显示 —— 三个模式永远都能互相切（见下面的坑）。
   */
  mode?: MenuMode;
  /** 点主按钮：调用方负责 resume + 移除菜单（= 继续当前模式） */
  onStart: () => void;
  /**
   * 切到**另一个**模式（要重开一局，所以是跳转而不是原地切换）。
   *
   * 2026-11-07 实机踩的坑：上一版只有 `onPve(players)`，而且 PVE 模式下
   * **整行 PVE 入口都不渲染**（"已经在里面了，别让人反复跳"）。结果玩家从
   * 对战点进 PVE 之后，URL 一直停在 `?mode=pve`，「再来一局」又是 reload，
   * **再也回不到普通对战** —— 用户看到的现象是"三个模式只剩一个开始守关"。
   * 改成三个模式永远互相可切。
   */
  onSwitch?: (mode: MenuMode) => void;
  /** 音效开关（本地记住）。没传就不显示那个按钮 */
  sfx?: Sfx;
}

/** 说明面板的四段 —— 都是"不写出来就一定会有人踩"的规则。 */
const RULES: { title: string; body: string }[] = [
  {
    title: '目标',
    body: '三分钟里拆掉对方**更多**的楼。大本营被拆就直接结束 —— 但别只盯着它，对面的民居没了，他的塔会全部哑火。',
  },
  {
    title: '手牌',
    body: '四张，点一张再点地面放下去。只能盖在自己半场，中间那道**黄区**谁都不能建。',
  },
  {
    title: '后勤',
    body: '要干活的楼都占人手：兵营 = 1 磨坊 + 1 民居，箭塔/炮塔 = 1 民居。缺了会停摆，头顶挂「缺 民居」—— 那时候它不开火也不出兵。',
  },
  {
    title: '施工',
    body: '新楼不是瞬间出现的：民居 2.2 秒、兵营 4.2 秒。垒墙的那几秒它不干活，外面围着脚手架。',
  },
  {
    title: '兵种',
    body: '近战扛线、远程输出、攻城拆楼。移动火炮射程 7.2 格，比箭塔还远 —— 它能站在塔外面把塔拆掉。',
  },
];

export class StartMenu {
  readonly el: HTMLDivElement;
  private readonly rules: HTMLDivElement;
  private readonly main: HTMLDivElement;
  /** 自定义旗帜独立栏目（2026-11-06：从主界面收进按钮里，不再堆在一起） */
  private readonly bannerPanel: HTMLDivElement;

  constructor(host: HTMLElement, private readonly opts: StartMenuOptions) {
    this.el = el('div', 'start');
    this.main = el('div', 'start__main');
    this.rules = el('div', 'start__rules');
    this.bannerPanel = el('div', 'start__rules start__banner-panel');

    // ---- 标题
    const mode: MenuMode = this.opts.mode ?? 'arena';
    const inPve = mode !== 'arena';
    const title = el('div', 'start__title');
    title.append(
      el('h1', 'start__name', 'GAMEKAR'),
      el(
        'p',
        'start__sub',
        inPve ? '守城模式 · 五波守住大本营' : '建筑战场 · 三分钟一局',
      ),
    );

    // ---- 按钮
    const actions = el('div', 'start__actions');
    const play = el('button', 'start__btn start__btn--primary', inPve ? '开始守关' : '开始对战');
    play.type = 'button';
    play.addEventListener('click', () => this.opts.onStart());

    /**
     * 另外两个模式的入口（2026-11-07 修正）。
     *
     * 上一版是"PVE 模式下不显示 PVE 入口"，本意是别让人反复跳，
     * 结果 PVE 的 URL 一旦进去就再也出不来 —— 菜单上只剩「开始守关」。
     *
     * 现在的规矩：**当前模式的按钮不重复出现，另外两个永远在**。
     * 三个状态各对应一行，用户任何时候都能看见"还有哪两个模式可以玩"。
     */
    const allModes: { key: MenuMode; label: string }[] = [
      { key: 'arena', label: '普通对战' },
      { key: 'pve1', label: '守城 PVE' },
      { key: 'pve2', label: '双人同屏' },
    ];
    const others = allModes.filter((m) => m.key !== mode);

    const modeRow = el('div', 'start__row');
    for (const m of others) {
      const btn = el('button', 'start__btn start__btn--pve', m.label);
      btn.type = 'button';
      btn.dataset['mode'] = m.key;
      btn.addEventListener('click', () => this.opts.onSwitch?.(m.key));
      modeRow.append(btn);
    }

    const help = el('button', 'start__btn', '玩法说明');
    help.type = 'button';
    help.addEventListener('click', () => this.showRules(true));

    const bannerBtn = el('button', 'start__btn', '自定义旗帜');
    bannerBtn.type = 'button';
    bannerBtn.addEventListener('click', () => this.showBanner(true));

    actions.append(play, modeRow);
    actions.append(help, bannerBtn);

    const foot = el('div', 'start__foot', `seed ${this.opts.seed} · 建筑协调经济 · v0.4`);
    this.main.append(title, actions, foot);

    /**
     * 音效开关。它的另一个作用是**顺便解锁音频**：
     * 点它的时候已经有用户手势了，先放一声"木牌拍桌"，玩家立刻知道开没开。
     */
    if (this.opts.sfx) {
      const sfx = this.opts.sfx;
      const toggle = el('button', 'start__link', `音效：${sfx.on ? '开' : '关'}`);
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        const next = !sfx.on;
        sfx.setEnabled(next);
        toggle.textContent = `音效：${next ? '开' : '关'}`;
        if (next) {
          sfx.unlock();
          sfx.play('place');
        }
      });
      this.main.append(toggle);
    }

    // ---- 说明面板（默认隐藏）
    const ruleTitle = el('h2', 'start__rules__title', '怎么玩');
    const list = el('div', 'start__rules__list');
    for (const r of RULES) {
      const item = el('section', 'start__rule');
      const h = el('h3', 'start__rule__title', r.title);
      // `**加粗**` 只在文案里出现几次，写个 10 行的解析比引一个 markdown 库划算
      const p = el('p', 'start__rule__body');
      for (const [i, part] of r.body.split('**').entries()) {
        if (i % 2 === 1) p.append(el('b', '', part));
        else p.append(document.createTextNode(part));
      }
      item.append(h, p);
      list.append(item);
    }
    const back = el('button', 'start__btn start__btn--primary', '知道了');
    back.type = 'button';
    back.addEventListener('click', () => this.showRules(false));
    this.rules.append(ruleTitle, list, back);
    this.rules.hidden = true;

    // ---- 自定义旗帜栏目（默认隐藏）：点主界面的按钮进来，编辑器不再堆在标题下面
    const bannerTitle = el('h2', 'start__rules__title', '自定义 · 你的旗帜');
    const bannerBody = el('div', 'start__banner__body');
    bannerBody.append(createBannerEditor({ hint: '改完点「开始对战」自动生效' }));
    const bannerBack = el('button', 'start__btn start__btn--primary', '返回');
    bannerBack.type = 'button';
    bannerBack.addEventListener('click', () => this.showBanner(false));
    this.bannerPanel.append(bannerTitle, bannerBody, bannerBack);
    this.bannerPanel.hidden = true;

    this.el.append(this.main, this.rules, this.bannerPanel);
    host.append(this.el);
  }

  /** 主界面 / 玩法说明 / 自定义旗帜三个栏目互斥，别叠在一起。 */
  private openPanel(which: 'main' | 'rules' | 'banner'): void {
    this.main.hidden = which !== 'main';
    this.rules.hidden = which !== 'rules';
    this.bannerPanel.hidden = which !== 'banner';
  }

  private showRules(on: boolean): void {
    this.openPanel(on ? 'rules' : 'main');
  }

  private showBanner(on: boolean): void {
    this.openPanel(on ? 'banner' : 'main');
  }

  dispose(): void {
    this.el.remove();
  }
}
