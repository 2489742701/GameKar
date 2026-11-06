/**
 * 对战模式的 HUD —— 倒计时、金币、双方大本营血量（蓝/红）、四张手牌、胜负。
 *
 * 规矩沿用老模式：DOM 只是世界状态的镜子，不自己算判据。
 * 这里只读 `world.summary()` 与 `world.hand`，以及 App 的 `selectedSlot`。
 *
 * 时间轴（2026-10-31）：倒计时读 `summary().timeLeft`，加时/告急只是给它换 data 属性，
 * 不在这一层判"还剩几秒算加时"—— 那条在 config.MATCH，改一处两边都跟着动。
 */

import { ECONOMY, HAND, MATCH, REROLL, type ArenaCard } from './config';
import type { ArenaApp } from './ArenaApp';
import { el as make } from '@ui/dom';
import { iconOf } from './cardIcons';
import { BREAD_ICON, COIN_ICON, POP_ICON } from './supplyIcons';
import { supplyRowsHtml } from './visuals/supplyRows';
import { needsStaffing } from './visuals/labels';
import { createBannerEditor } from './bannerEditor';



export interface ArenaHudOptions {
  onSelectCard: (slot: number) => void;
  onRestart: () => void;
  onCycleView: () => void;
  /** 花 5 金重抽全部手牌（保底民居） */
  onReroll: () => void;
}

export class ArenaHud {
  readonly el = make('div', 'ahud');
  /** 金币数字（住在底部的金币条里，2026-11-06 从顶栏挪下来了） */
  private readonly goldText = make('b', 'ahud__bank__num', '8');
  private readonly goldCap = make('span', 'ahud__bank__cap', `/${ECONOMY.cap}`);
  private readonly goldFill = make('span', 'ahud__bank__fill');
  private readonly bank = make('div', 'ahud__bank');
  private readonly cards: HTMLButtonElement[] = [];
  private readonly cardParts: {
    cost: HTMLElement;
    name: HTMLElement;
    kind: HTMLElement;
    art: HTMLElement;
    need: HTMLElement;
  }[] = [];
  /** 人口 / 面包读数（容器，不是收入） */
  private readonly popText = make('b', 'ahud__supply__num', '');
  private readonly breadText = make('b', 'ahud__supply__num', '');
  /** 上一帧这一格是什么牌：用来识别"刚打出去"，播一下飞出动画 */
  private readonly lastCardId: (string | null)[] = [];
  /** 每格正在播的飞出动画定时器：刷新手牌时要全部取消，否则会把新牌清成空白格 */
  private readonly playTimers: (number | null)[] = [];
  /** 左上角的民居读数 */
  private readonly houseText = make('b', 'ahud__supply__num', '');
  /** 左上角三个胶囊：警告时对应那一个闪红 */
  private readonly supplyItems!: { pop: HTMLElement; bread: HTMLElement; house: HTMLElement };
  /** 通知栏：警告冒出来，过一会儿向左收进去（用户 2026-11-06） */
  private readonly notice = make('div', 'ahud__notice');
  private noticeTimer: number | null = null;
  private readonly lastNoticeAt = new Map<string, number>();
  /** 上一帧缺配的建筑集合：只在「从无到有」那一帧报警，不每帧刷屏 */
  private lastUnstaffed = new Set<string>();
  private readonly toast = make('div', 'ahud__toast');
  private readonly end = make('div', 'ahud__end');
  /** 自定义设置面板（花色编辑器 + 关闭按钮）；默认收起 */
  private readonly settingsPanel: HTMLElement;
  private readonly settingsBtn: HTMLButtonElement;
  /** 倒计时：数字（一件只建一次，20Hz 里不重建） */
  private readonly clock = make('div', 'ahud__clock');
  private readonly clockNum = make('b', 'ahud__clock__num', '');
  /** 加时徽标（常规时间打满、双方大本营都在 ⇒ 进入加时，只在这时显示） */
  private readonly clockOt = make('span', 'ahud__clock__ot', '');
  private readonly endSub = make('div', 'ahud__end__sub', '');
  private viewBtn!: HTMLButtonElement;
  private toastTimer: number | null = null;

  constructor(
    host: HTMLElement,
    private readonly app: ArenaApp,
    private readonly opts: ArenaHudOptions,
  ) {
    /**
     * 顶栏：**一行**，只有三样 —— 人口、面包（含民居）、时间。
     *
     * 用户 2026-11-06："狼方你大本营、敌方红大本营，还有血条，全部关闭。顶栏很干净，
     * 人口、面包、时间、金币一行解决。" 金币当轮（同日）又挪去了卡牌下方 ——
     * 《皇室战争》的圣水条就在手牌边上，攒钱的读数离出牌的手越近越好用。
     *
     * 大本营的血条挪进 3D 世界了（受击时才浮出来，见 `ArenaApp` 的 `syncCoreBars`）——
     * 顶栏那一长条血条常年占着三分之一屏宽，而它 99% 的时间是满的。
     * 后勤读数也一起去掉：缺配的楼自己头顶就挂着「缺 民居」，不需要顶栏再重复一遍。
     */
    const top = make('div', 'ahud__top panel');

    const supply = make('div', 'ahud__supply');
    // 图标代替文字标签：18px 的胶囊里塞"人口"两个字会挤成竖排（2026-11-06 用户要求画 SVG）
    const supplyIcon = (svg: string, label: string): HTMLElement => {
      const icon = make('span', 'ahud__supply__icon');
      icon.innerHTML = svg;
      icon.setAttribute('aria-label', label);
      icon.title = label;
      return icon;
    };
    const popItem = make('button', 'ahud__supply__item');
    popItem.type = 'button';
    popItem.append(supplyIcon(POP_ICON, '人口'), this.popText);
    popItem.addEventListener('click', () =>
      this.say('人口：民居每座 +2；建筑占 2（最多占上限−2，给军队留格）、兵占 1', 'ok'),
    );
    const breadItem = make('button', 'ahud__supply__item');
    breadItem.type = 'button';
    breadItem.append(supplyIcon(BREAD_ICON, '面包'), this.breadText);
    breadItem.addEventListener('click', () => this.say('面包：磨坊每座 +2；每个兵吃 1', 'ok'));
    /**
     * 房屋读数（用户 2026-11-06）："一个防御建筑对应着一个民居，没有民居就没办法建。"
     * 场上每座塔/兵营要占 1 座民居，所以这里直接显示**有几座民居**；
     * 名额不够时变红，提醒玩家该补民居或去拆对面的。
     */
    const houseItem = make('button', 'ahud__supply__item');
    houseItem.type = 'button';
    houseItem.append(supplyIcon(iconOf('house'), '民居'), this.houseText);
    houseItem.addEventListener('click', () =>
      this.say('民居：每座塔 / 兵营要 1 座；缺了它不开火、不出兵', 'ok'),
    );
    supply.append(popItem, breadItem, houseItem);
    this.supplyItems = { pop: popItem, bread: breadItem, house: houseItem };

    this.clock.append(this.clockNum);
    /**
     * 加时徽标（2026-11-06 用户："没拆掉大本营有一个加时赛"）：
     * 常规 3 分钟打满、两边大本营都还立着 ⇒ 不判胜负，续加时。
     * 时钟切成红色加时态，数字右边挂「加时」两个字 —— 不挂这两个字，
     * 玩家会以为倒计时出 bug 了：0 又变回 60。
     */
    this.clockOt.append('加时');
    this.clock.append(this.clockOt);

    top.append(supply, this.clock);

    const hand = make('div', 'ahud__hand');
    for (let i = 0; i < HAND.size; i++) {
      const card = make('button', 'ahud__card');
      // 三块子节点**只建一次**：以前在 20Hz 的刷新里 replaceChildren，
      // 手指按下去的那一帧正好被换掉，点击就丢了 —— 这就是"有时候点不到"。
      const cost = make('span', 'ahud__card__cost', '');
      const name = make('span', 'ahud__card__name', '');
      const kind = make('span', 'ahud__card__kind', '');
      const art = make('span', 'ahud__card__art');
      const need = make('span', 'ahud__card__need', '');
      card.append(cost, art, name, need);
      card.addEventListener('pointerdown', (e) => {
        // 拖放手势的起点（2026-11-06）：不在这里抢 click，位移超过阈值才进拖放模式
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        this.dragFrom = { slot: i, x: e.clientX, y: e.clientY, pointerType: e.pointerType };
        // 触屏长按（180ms 没动）=「按住屏幕就有影子」，松手按影子落点放下；
        // <180ms 的点击仍是普通点击选牌，不误伤
        if (e.pointerType === 'touch') {
          this.clearHoldTimer();
          this.holdTimer = window.setTimeout(() => {
            if (!this.dragFrom || this.dragging) return;
            this.dragging = true;
            this.app.beginCardDrag(this.dragFrom.slot);
            this.app.moveCardDrag(this.dragFrom.x, this.dragFrom.y, 'touch');
          }, 180);
        }
      });
      card.addEventListener('click', () => {
        // 拖回卡牌/拖出去落牌后浏览器还会补一个 click —— 吃掉，别误选
        if (this.suppressCardClick) return;
        this.opts.onSelectCard(i);
      });
      this.cards.push(card);
      this.cardParts.push({ cost, name, kind, art, need });
      hand.append(card);
    }

    // 手牌成组贴底（之前三块直接摊在 flex 列里，space-between 把手牌顶到了屏幕正中）
    const bottom = make('div', 'ahud__bottom');
    const view = make('button', 'ahud__view', '视角 · 全景');
    this.viewBtn = view;
    view.addEventListener('click', () => this.opts.onCycleView());
    const reroll = make('button', 'ahud__reroll', `刷新 · ${REROLL.cost} 金`);
    reroll.type = 'button';
    reroll.title = '重抽全部 4 张手牌，保底一张民居';
    reroll.addEventListener('click', () => this.opts.onReroll());
    const tools = make('div', 'ahud__tools');
    /**
     * 设置面板（2026-11-06 用户："这个设置能不能额外准备一个自定义设置里面给他处理"）：
     * 战斗中也能调花色 —— 只攒存档，**下一局生效**（「再来一局」= reload 读新档）。
     * 面板默认收起；和开始菜单里的编辑器是同一份组件（bannerEditor.ts）。
     */
    const settingsBtn = make('button', 'ahud__view', '设置');
    settingsBtn.type = 'button';
    settingsBtn.addEventListener('click', () => this.toggleSettings());
    this.settingsBtn = settingsBtn;
    tools.append(view, reroll, settingsBtn);
    this.settingsPanel = make('div', 'ahud__settings');
    this.settingsPanel.hidden = true;
    const settingsHead = make('div', 'ahud__settings__head');
    const settingsTitle = make('span', 'ahud__settings__title', '自定义 · 你的旗帜');
    const settingsClose = make('button', 'ahud__settings__close', '×');
    settingsClose.type = 'button';
    settingsClose.addEventListener('click', () => this.toggleSettings(false));
    settingsHead.append(settingsTitle, settingsClose);
    const settingsNote = make('p', 'ahud__settings__note', '改完存档，点「再来一局」就能带上新旗上场');
    this.settingsPanel.append(settingsHead, settingsNote, createBannerEditor());
    /**
     * 金币条（2026-11-06 用户）："能把那个金 20/20 移到卡牌下方，有点像《皇室战争》那样。
     * 就是下面有一个栏目，一点点加的那个能不能搞一下？"
     *
     * 三层叠在一起：填充条在最底下（width = 金/cap），刻度线盖在填充上面
     * （每 1 金一道），数字在最上层 —— 攒一格亮一格，攒满整条泛金光。
     */
    const bankIcon = make('span', 'ahud__bank__icon');
    bankIcon.innerHTML = COIN_ICON;
    const bankLabel = make('span', 'ahud__bank__label');
    bankLabel.append(bankIcon, this.goldText, this.goldCap);
    this.bank.append(this.goldFill, bankLabel);
    bottom.append(tools, hand, this.bank);
    this.notice.dataset['hidden'] = '1';
    this.el.append(top, bottom, this.toast, this.notice, this.end, this.settingsPanel, this.big);
    host.append(this.el);
    this.end.hidden = true;
    this.end.append(
      make('div', 'ahud__end__title', ''),
      this.endSub,
      make('button', 'ahud__end__btn', '再来一局'),
    );
    (this.end.lastChild as HTMLElement).addEventListener('click', () => this.opts.onRestart());
    for (let i = 0; i < HAND.size; i++) this.playTimers.push(null);
    this.setupCardDrag();
    this.refresh();
  }

  // ---------------------------------------------------------------- 卡牌拖放

  private dragFrom: { slot: number; x: number; y: number; pointerType: string } | null = null;
  private dragging = false;
  private suppressCardClick = false;
  private holdTimer: number | null = null;

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /**
   * 拖放（2026-11-06 用户）："拖住它拖到地图上，会显示一个影子看看放在哪里，
   * 然后可以拖回卡牌。" 手势在 window 上收（指针会离开卡牌、跨到画布）：
   * - 位移 > 8px 才进入拖放（不误伤普通点击选牌）；
   * - 松手落在手牌区 = 拖回取消；落在地图上 = app.dropCardDrag 落牌；
   * - 拖过之后吃掉落下来的 click，防止"拖回"反而把卡选中。
   */
  private setupCardDrag(): void {
    window.addEventListener('pointermove', (e) => {
      if (!this.dragFrom) return;
      if (!this.dragging) {
        if (Math.hypot(e.clientX - this.dragFrom.x, e.clientY - this.dragFrom.y) < 8) return;
        this.dragging = true;
        this.app.beginCardDrag(this.dragFrom.slot);
      }
      this.clearHoldTimer();
      this.app.moveCardDrag(e.clientX, e.clientY, e.pointerType || 'mouse');
    });
    window.addEventListener('pointerup', (e) => {
      if (!this.dragFrom) return;
      if (this.dragging) {
        const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        if (hit?.closest('.ahud__hand')) this.app.cancelCardDrag();
        else this.app.dropCardDrag(e.clientX, e.clientY, e.pointerType || 'mouse');
        this.suppressCardClick = true;
        window.setTimeout(() => { this.suppressCardClick = false; }, 0);
      }
      this.clearHoldTimer();
      this.dragFrom = null;
      this.dragging = false;
    });
    // 指针被系统取消（来电/切窗）：别把影子留在场上
    window.addEventListener('pointercancel', () => {
      if (this.dragging) this.app.cancelCardDrag();
      this.clearHoldTimer();
      this.dragFrom = null;
      this.dragging = false;
    });
  }

  /** 设置面板开关。开着的时候战斗照跑（面板浮在上面，不挡逻辑）。 */
  toggleSettings(on?: boolean): void {
    const next = on ?? this.settingsPanel.hidden;
    this.settingsPanel.hidden = !next;
    this.settingsBtn.dataset['on'] = String(next);
  }

  // ---------------------------------------------------------------- 中央大字

  private readonly big = make('div', 'ahud__big');
  private overtimeSplashShown = false;

  /** 屏幕中央大字（进加时赛用）：闪 2.6 秒自动收。pointer-events 全关，纯排面。 */
  private showBig(text: string): void {
    this.big.textContent = text;
    this.big.dataset['show'] = '0';
    void this.big.offsetWidth; // 强制 reflow：让动画每次都从头放
    this.big.dataset['show'] = '1';
    window.setTimeout(() => { this.big.dataset['show'] = '0'; }, 2700);
  }

  /**
   * 通知栏：显示一条警告，**4.2 秒后向左收进去**（CSS transform 过渡）。
   * 同一条文案 6 秒内只弹一次 —— 否则三座塔同时缺民居会连刷三遍。
   */
  notify(text: string): void {
    if (!text) return;
    const now = performance.now();
    if (now - (this.lastNoticeAt.get(text) ?? -1e9) < 6000) return;
    this.lastNoticeAt.set(text, now);
    this.notice.textContent = text;
    this.notice.dataset['hidden'] = '0';
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice.dataset['hidden'] = '1';
    }, 4200);
  }

  /**
   * 出牌被拒时，左上角**对应的那个胶囊闪红**（用户 2026-11-06）。
   * 判据从失败原因的文本里读，不另算一套账：`playCard` 的 reason 是唯一来源。
   */
  flashSupply(reason: string): void {
    const hit: (keyof typeof this.supplyItems)[] = [];
    if (reason.includes('人口')) hit.push('pop');
    if (reason.includes('面包')) hit.push('bread');
    if (reason.includes('民居')) hit.push('house');
    for (const key of hit) {
      const el = this.supplyItems[key];
      el.dataset['flash'] = '0';
      void el.offsetWidth; // 强制重排，动画才能连续重播
      el.dataset['flash'] = '1';
      window.setTimeout(() => { el.dataset['flash'] = '0'; }, 950);
    }
  }

  /**
   * 「您的箭塔防御建筑缺少民居」这类警告：
   * 只在**缺配状态从无到有**时通知，施工中不报，配齐了也不报。
   * 楼顶那块 SVG 牌子负责"哪一栋"，通知栏负责"整体发生了什么"。
   */
  private checkStaffing(): void {
    const now = new Set<string>();
    const fresh: string[] = [];
    for (const b of this.app.world.buildings.values()) {
      if (b.side !== 'blue' || b.build < 1) continue;
      if (!needsStaffing(b.kind) || this.app.world.isStaffed(b.id)) continue;
      const key = `${b.id}:${b.kind}`;
      now.add(key);
      if (!this.lastUnstaffed.has(key)) {
        fresh.push(
          b.kind === 'barracks'
            ? '您的兵营缺少磨坊与民居'
            : b.kind === 'cannonTower'
              ? '您的炮塔防御建筑缺少民居'
              : '您的箭塔防御建筑缺少民居',
        );
      }
    }
    this.lastUnstaffed = now;
    for (const text of fresh) this.notify(text);
  }

  say(text: string, tone: 'ok' | 'warn' = 'ok'): void {
    this.toast.textContent = text;
    this.toast.dataset['tone'] = tone;
    this.toast.dataset['on'] = '1';
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.dataset['on'] = '0';
    }, 1800);
  }

  /** 10Hz 由 App 的 onState 调；内容便宜，全量重画。 */
  refresh(): void {
    const s = this.app.world.summary();
    // 发牌裁量提示：读的判据与 draw()/reroll()/落牌校验是同一个 buildingRoom
    const hand = this.el.querySelector('.ahud__hand');
    if (hand) hand.setAttribute('data-no-room', String(!this.app.world.buildingRoom('blue')));
    // 金币条：数字 + 填充宽度一起走（判据只读 summary().gold，条不自己算账）。
    // data-full 给整条泛金光 —— 满了就提醒玩家"该花出去了"。
    this.goldText.textContent = String(s.gold);
    this.goldCap.textContent = `/${ECONOMY.cap}`;
    this.goldFill.style.width = `${Math.min(100, (s.gold / ECONOMY.cap) * 100)}%`;
    this.bank.dataset['full'] = String(s.gold >= ECONOMY.cap);

    // 倒计时：最后 30 秒变红（data-warn）；进加时切红色加时态（data-ot，2026-11-06）
    const mm = Math.floor(s.timeLeft / 60);
    const ss = s.timeLeft % 60;
    this.clockNum.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
    this.clock.dataset['warn'] = String(s.timeLeft <= MATCH.warnSeconds);
    this.clock.dataset['ot'] = String(s.overtime);

    // 进加时赛的**一次性**排面：屏幕中央「加时赛」大字闪 2.6 秒 + 两侧彩带
    // （2026-11-06 用户："屏幕中间会闪过加时赛两三秒……屏幕两边可以飞出彩带"）。
    // 结果页（outcome != playing）不再触发，重开一局由 reload 自然复位。
    if (s.overtime && s.outcome === 'playing' && !this.overtimeSplashShown) {
      this.overtimeSplashShown = true;
      this.showBig('加时赛');
      this.app.confetti.burst();
    }

    // 人口 / 面包：满了变红（data-full），点一下有说明
    const sup = s.supply.blue;
    this.popText.textContent = `${sup.pop}/${sup.popMax}`;
    this.breadText.textContent = `${sup.bread}/${sup.breadMax}`;
    this.popText.parentElement?.setAttribute('data-full', String(sup.pop >= sup.popMax));
    this.breadText.parentElement?.setAttribute('data-full', String(sup.bread >= sup.breadMax));
    // 民居：数量 + 名额够不够（不够变红，和人口/面包同一套告警色）
    let houses = 0;
    for (const b of this.app.world.buildings.values()) {
      if (b.side === 'blue' && b.kind === 'house') houses++;
    }
    this.houseText.textContent = String(houses);
    this.houseText.parentElement?.setAttribute(
      'data-full',
      String(s.staffed.blue < s.staffingNeeded.blue),
    );

    this.checkStaffing();

    for (let i = 0; i < this.cards.length; i++) this.paintCard(i);

    if (s.outcome !== 'playing') {
      this.end.hidden = false;
      const title = this.end.firstElementChild as HTMLElement;
      title.dataset['outcome'] = s.outcome;
      title.textContent =
        s.outcome === 'win'
          ? '红方大本营被拆了 —— 你赢了'
          : s.outcome === 'lose'
            ? '蓝方大本营被拆了 —— 这局输了'
            : s.reason === 'core'
              ? '两边的大本营同时被拆了 —— 平局'
              : '加时打满 —— 平局';
      // 第二行必须写清"怎么结束的"：时间到判的胜负和拆掉大本营判的胜负是两回事，
      // 不写玩家会以为自己的大本营也被拆了。
      this.endSub.textContent = this.reasonText(s);
    }
  }

  /** 结算面板第二行。数字一律从 summary 里取，不在这里重算。 */
  private reasonText(s: ReturnType<ArenaApp['world']['summary']>): string {
    const minutes = MATCH.seconds / 60;
    // 2026-11-06 加时赛：常规时间打满不判，加时打满按**积分**判（存活楼数 → 剩血 → 拆楼）
    // ⇒ 文案写清"含加时"并把积分摆第一行。reason = 'overtime'（新）/ 'time'（旧存档兼容）。
    if (s.reason === 'overtime' || s.reason === 'time') {
      // destroyed 的键是"谁被拆"：destroyed.red = 红方被拆掉几栋 = 你拆了几栋
      const head = s.reason === 'overtime' ? `${minutes + 2} 分钟（含加时）到` : `${minutes} 分钟到`;
      return `${head} · 积分（存活楼） 你 ${s.buildings.blue} / 敌 ${s.buildings.red} · 大本营剩血 蓝 ${s.blueCore} / 红 ${s.redCore} · 拆楼 你 ${s.destroyed.red} / 敌 ${s.destroyed.blue}`;
    }
    if (s.reason === 'draw') {
      return `${minutes + 1} 分钟（含加时）到 · 大本营剩血、拆掉的楼数都一样`;
    }
    if (s.reason === 'core' && s.outcome === 'draw') {
      return '最后一下把两边的大本营一起拆掉了';
    }
    return s.outcome === 'win' ? '红方大本营被拆掉了' : s.outcome === 'lose' ? '蓝方大本营被拆掉了' : '';
  }

  /**
   * 只改文字与 data 属性 —— 不重建节点、也不 disabled。
   * disabled 会让点击彻底没反应，玩家只会觉得"点不到"；
   * 这里让点击永远有回应（打不了就说明原因）。
   */
  private paintCard(slot: number): void {
    const el = this.cards[slot]!;
    const parts = this.cardParts[slot]!;
    // 正在播"飞出去"的这 260ms：别改它，让动画把旧牌面带走
    if (el.dataset['played'] === '1') return;

    const card = this.app.world.hand[slot];
    const id = card ? card.id : null;
    const last = this.lastCardId[slot] ?? null;

    // 刚打出去：牌面再留 260ms 做飞出动画，然后变成**空白格**（不再显示"补牌中"）
    if (!card && last !== null) {
      this.lastCardId[slot] = null;
      el.dataset['played'] = '1';
      el.dataset['selected'] = 'false';
      if (this.playTimers[slot] !== null) window.clearTimeout(this.playTimers[slot]!);
      this.playTimers[slot] = window.setTimeout(() => {
        el.dataset['played'] = '0';
        el.dataset['empty'] = '1';
        el.dataset['affordable'] = 'true';
        parts.cost.textContent = '';
        parts.name.textContent = '';
        parts.kind.textContent = '';
        parts.art.innerHTML = '';
        parts.need.textContent = '';
        this.playTimers[slot] = null;
      }, 260);
      return;
    }
    this.lastCardId[slot] = id;

    el.dataset['selected'] = String(this.app.selectedSlot === slot);
    if (!card) {
      // 空白格：没有数字、没有名字、没有倒计时 —— 就是"这张牌已经打出去了"
      el.dataset['empty'] = '1';
      el.dataset['affordable'] = 'true';
      parts.cost.textContent = '';
      parts.name.textContent = '';
      parts.kind.textContent = '';
      parts.art.innerHTML = '';
      parts.need.textContent = '';
      return;
    }
    el.dataset['empty'] = '0';
    el.dataset['kind'] = card.kind === 'building' ? 'build' : 'army';
    el.dataset['affordable'] = String(this.app.world.gold.blue >= card.cost);
    parts.cost.textContent = String(card.cost);
    parts.name.textContent = card.name;
    // 移动火炮是**军队**（'siege' 只是模型差异），不再单独标'工程'
    parts.kind.textContent = card.kind === 'building' ? '建筑' : '军队';
    // 图标只在换牌时重建：这是 20Hz 的刷新，每次 innerHTML 会白白重解析 SVG
    if (el.dataset['icon'] !== card.id) {
      parts.art.innerHTML = iconOf(card.id);
      el.dataset['icon'] = card.id;
    }
    // 「几人几包」改成 SVG 图标（用户 2026-11-06），**差哪样标哪样红**：
    // 判据读 `supplyBlocked` 的理由文本（和出牌被拒同一条路，不另算一套账），
    // 玩家看着牌面就知道"为什么造不出来"，不用点出去被拒了才明白。
    parts.need.innerHTML = supplyRowsHtml(card);
    const why = this.app.world.supplyBlocked('blue', card);
    el.dataset['short'] = why ? (why.includes('面包') ? 'bread' : 'pop') : '';
  }

  /**
   * 刷新手牌之后强制重画：清掉所有"飞出去"动画和定时器，
   * 不然 260ms 后旧定时器会把刚发下来的新牌清成空白格。
   */
  rerollHand(): void {
    for (let i = 0; i < this.cards.length; i++) {
      const timer = this.playTimers[i];
      if (timer !== null) window.clearTimeout(timer);
      this.playTimers[i] = null;
      this.lastCardId[i] = null;
      this.cards[i]!.dataset['played'] = '0';
      this.cards[i]!.dataset['selected'] = 'false';
    }
    this.refresh();
  }

  /** 卡池变了（配卡组以后）再重建卡面；现在只需重画。 */
  setHand(): void {
    this.refresh();
  }

  /** 视角按钮上的那行字（自动/手动 + 机位名）。 */
  setViewStatus(status: string): void {
    const text = `视角 · ${status}`;
    if (this.viewBtn && this.viewBtn.textContent !== text) this.viewBtn.textContent = text;
  }

  /** 给外部（比如实机探针）读一眼当前卡面文案。 */
  get cardLabels(): string[] {
    return this.cards.map((c) => c.textContent ?? '');
  }

  /** 用一张卡的说明做长按提示（以后接气泡）。 */
  static describe(card: ArenaCard): string {
    return `${card.name}（${card.cost} 金）· ${card.blurb}`;
  }
}

/** 两行增减需求已抽到 `visuals/supplyRows.ts`（纯函数、单测覆盖）。 */

