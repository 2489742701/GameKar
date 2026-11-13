/**
 * 对战模式的 HUD —— 倒计时、金币、双方大本营血量（蓝/红）、四张手牌、胜负。
 *
 * 规矩沿用老模式：DOM 只是世界状态的镜子，不自己算判据。
 * 这里只读 `world.summary()` 与 `world.hand`，以及 App 的 `selectedSlot`。
 *
 * 时间轴（2026-10-31）：倒计时读 `summary().timeLeft`，加时/告急只是给它换 data 属性，
 * 不在这一层判"还剩几秒算加时"—— 那条在 config.MATCH，改一处两边都跟着动。
 */

import { ECONOMY, HAND, MATCH, REROLL, SUPPLY, type ArenaCard } from './config';
import type { ArenaApp } from './ArenaApp';
import type { BattleLedger, LedgerWreck, SideLedger } from './ArenaWorld';
import { el as make } from '@ui/dom';
import { iconOf } from './cardIcons';
import { BREAD_ICON, COIN_ICON, POP_ICON } from './supplyIcons';
import { QUIT_ICON, SETTINGS_ICON, VIEW_ICON } from './topbarIcons';
import { supplyRowsHtml } from './visuals/supplyRows';
import { needsStaffing } from './visuals/labels';
import { createBannerEditor } from './bannerEditor';
import { saveControls, type ControlPrefs } from './controls';



/**
 * 设置面板的三个「窗口」（2026-11-07 用户："设置栏目应该有多个窗口，
 * 就是调不同的东西，而不是压在一起"）。
 *
 * 每页自带一句说明，写清**这一页的东西什么时候生效** —— 托管/方向是立刻生效
 * 且常驻保存，花色是下一局生效。之前三样堆在一条滚动栏里，这句说明混在一起
 * 反而谁都没说清。
 */
type SettingsTab = 'auto' | 'controls' | 'banner' | 'post';

const SETTINGS_TABS: { key: SettingsTab; label: string; hint: string }[] = [
  {
    key: 'auto',
    label: '托管',
    hint: '托管只能手动点：点了就一直代打，再点一次才交还。',
  },
  {
    key: 'controls',
    label: '方向',
    hint: '改完立刻生效、存在本机，下次进游戏还是你选的方向。',
  },
  {
    key: 'banner',
    label: '旗帜',
    hint: '改完存档；点「再来一局」带上新旗上场（花色下一局生效）。',
  },
  {
    key: 'post',
    label: '后期',
    hint: '改完立刻生效、存在本机。景深默认偏高，拉近镜头会自动再加一点；两根滑杆都拉到 0 就不跑后期。',
  },
];

export interface ArenaHudOptions {
  /** `player` = 玩家槽下标（双人同屏时 0 或 1） */
  onSelectCard: (slot: number, player: number) => void;
  onRestart: () => void;
  /**
   * 结算面板的「回菜单」：清掉 `?mode=…` 回到开始菜单。
   * 没有它，打完一局只能不断重开同一关 —— 换模式得去改 URL（2026-11-07 用户反馈）。
   */
  onMenu?: () => void;
  /**
   * 工具行的「退出」：**退出当前这一局**回主菜单（2026-11-07 用户：
   * "这个进游戏之后退不出来……这个退出游戏就是退出当前游戏，回到主菜单"）。
   * 和 `onMenu` 是同一件事，只是入口不同 —— 一个在战斗中，一个在结算面板。
   */
  onQuit?: () => void;
  /**
   * 视角按钮：点一下切到**下一档**（2026-11-07 傍晚用户："你的视野不要搞得那么复杂，
   * 点一下就切换的"）。上一版是点开一张清单再选，两步、还多一块浮层挡视线。
   */
  onCycleView: () => void;
  /** 工具行「托管」按钮：切手动托管开/关（2026-11-07） */
  onToggleAuto: () => void;
  /**
   * 相机调试面板开关（可空）。传了才在顶栏长一个「调试」按钮 ——
   * 手机没有 F2，而用户要自己调机位、把 ID 发回来，所以得有一个能点的入口。
   */
  onToggleDebug?: () => void;
  /**
   * **开发者模式**（2026-11-08）：状态由入口 `main.ts` 单点持有，HUD 只读写回调。
   * 关着时「调试」按钮隐藏、F2 无效、相机面板叫不出来；默认关。
   */
  devMode?: () => boolean;
  onDevModeChange?: (on: boolean) => void;
  /** 花 5 金重抽这个玩家的全部手牌（保底民居） */
  onReroll: (player: number) => void;
}

/**
 * 一个"座位"的全部 UI 零件：手牌 4 格 + 一条金币条 + 一个刷新按钮。
 *
 * 为什么按座位建而不是写死一份（2026-11-07 双人同屏）：PVE 双人时两个人
 * 各有各的金币和手牌，屏幕底下一套、屏幕顶上一套（旋转 180° 给对面的人看）。
 * 单人局只建 1 个座位，DOM 与老版本完全一致。
 */
interface HudSeat {
  player: number;
  /** 这一家的整块容器（手牌 + 金币条 + 刷新），双人时第二家整体转 180° */
  root: HTMLElement;
  hand: HTMLElement;
  cards: HTMLButtonElement[];
  parts: {
    cost: HTMLElement;
    name: HTMLElement;
    kind: HTMLElement;
    art: HTMLElement;
    need: HTMLElement;
  }[];
  bank: HTMLElement;
  goldText: HTMLElement;
  goldCap: HTMLElement;
  goldFill: HTMLElement;
  reroll: HTMLButtonElement;
  /** 上一帧这一格是什么牌：用来识别"刚打出去"，播一下飞出动画 */
  lastCardId: (string | null)[];
  /** 每格正在播的飞出动画定时器：刷新手牌时要全部取消，否则会把新牌清成空白格 */
  playTimers: (number | null)[];
}

/**
 * 顶栏按钮：**SVG 图标 + 可选文字**。图标永远在，文字只在宽屏露出来。
 * 文字单独一个 span，`setViewStatus` / 两段式退出只改这个 span，
 * 不会像以前 `textContent = …` 那样把 SVG 一起冲掉。
 */
function iconButton(
  icon: string,
  label: string,
  extraClass: string,
): { btn: HTMLButtonElement; text: HTMLSpanElement } {
  const btn = make('button', `ahud__iconbtn ${extraClass}`) as HTMLButtonElement;
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  const text = make('span', 'ahud__iconbtn__txt') as HTMLSpanElement;
  btn.append(text);
  return { btn, text };
}

export class ArenaHud {
  readonly el = make('div', 'ahud');
  /** 每个玩家一个座位（1v1 / PVE 单人 = 1 个，PVE 双人 = 2 个） */
  private readonly seats: HudSeat[] = [];
  /**
   * **顶栏人口三分读数**（P-094，2026-11-09 用户："改成闲置人口和占用人口和全部人口"）。
   *
   * 旧版只有一个 `popText` 写 "3/6"，玩家分不清那 3 格是楼占的还是兵借的，
   * 更看不出「闲置会慢慢回、建筑占用卡死」。现在三格并排：
   * 闲（idle）/ 占（used）/ 共（total），全部读 `summary().supply.blue` 同一份数。
   */
  private readonly popIdleText = make('b', 'ahud__supply__num', '');
  private readonly popUsedText = make('b', 'ahud__supply__num', '');
  private readonly popTotalText = make('b', 'ahud__supply__num', '');
  private readonly popTriple = make('span', 'ahud__supply__pop3');
  /** 面包仍是容器（基础 + 磨坊，兵死立刻退还），口径没变 */
  private readonly breadText = make('b', 'ahud__supply__num', '');
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
  /** 设置面板（2026-11-07 改成三页：托管 / 方向 / 旗帜）；默认收起 */
  private readonly settingsPanel: HTMLElement;
  /** 当前打开的标签页；页面内记住，下次叫出设置还是这一页 */
  private settingsTab: SettingsTab = 'auto';
  private readonly settingsTabButtons: HTMLButtonElement[] = [];
  private readonly settingsPanes = new Map<SettingsTab, HTMLElement>();
  private settingsHint!: HTMLElement;
  /** 视角机位菜单（斜视 / 正对 / 我方 / 俯视）；默认收起 */
  /** 已经退出过一次的手指：两段式「退出」的第二下才真走 */
  private quitArmed = false;
  private quitTimer: number | null = null;
  /** 上一次画菜单高亮用的指纹：20Hz 的 refresh 里不重复刷 DOM */
  /** 倒计时：数字（一件只建一次，20Hz 里不重建） */
  private readonly clock = make('div', 'ahud__clock');
  private readonly clockNum = make('b', 'ahud__clock__num', '');
  /** 加时徽标（常规时间打满、双方大本营都在 ⇒ 进入加时，只在这时显示） */
  private readonly clockOt = make('span', 'ahud__clock__ot', '');
  private readonly endSub = make('div', 'ahud__end__sub', '');
  /**
   * **结算账单**（P-094）：左右两栏列「拆了哪些楼 / 自己丢了哪些」，
   * 下面三行把三级积分判据摊开并高亮决定胜负的那一项。
   * 内容只在结算时填一次，靠 `lastLedgerStamp` 防 20Hz 重复重建 DOM。
   */
  private readonly endLedger = make('div', 'ahud__end__ledger');
  private lastLedgerStamp = '';
  private viewBtn!: HTMLButtonElement;
  private quitBtn!: HTMLButtonElement;
  /** 工具行「调试」按钮与设置页「开发者模式」开关（默认都隐藏/关闭） */
  private devBtn: HTMLButtonElement | null = null;
  private devModeBtn!: HTMLButtonElement;
  /** 顶栏按钮的文字标签：宽屏才显示，手机上只剩 SVG（时钟才不会被挤偏） */
  private viewBtnText!: HTMLSpanElement;
  private quitBtnText!: HTMLSpanElement;
  private autoBtn!: HTMLButtonElement;
  /** 设置面板「托管」区的开关（工具行状态变了要一起重画） */
  private autoManualBtn!: HTMLButtonElement;
  private toastTimer: number | null = null;
  /** 设置页「后期」的三件控件：两根滑杆 + 跟随镜头开关（和 F2 面板读同一份状态） */
  private postControls?: {
    tilt: HTMLInputElement;
    tiltNum: HTMLElement;
    dim: HTMLInputElement;
    dimNum: HTMLElement;
    follow: HTMLButtonElement;
    /** P-099：昼夜跟随时间轴的开关 */
    dayClock: HTMLButtonElement;
  };

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
    /** 一格三分读数：小标签「闲 / 占 / 共」+ 整数。窄屏 CSS 只藏标签，数字留着。 */
    const popPart = (tag: string, num: HTMLElement, key: string) => {
      const part = make('span', 'ahud__supply__pop3__part');
      part.dataset['part'] = key;
      part.append(make('i', 'ahud__supply__pop3__tag', tag), num);
      return part;
    };
    this.popTriple.append(
      popPart('闲', this.popIdleText, 'idle'),
      popPart('占', this.popUsedText, 'used'),
      popPart('共', this.popTotalText, 'total'),
    );
    popItem.append(supplyIcon(POP_ICON, '人口：闲置 / 占用 / 全部'), this.popTriple);
    popItem.addEventListener('click', () =>
      this.say(
        `闲置：能立刻盖楼/出兵，每 ${SUPPLY.idleRegenSeconds} 秒回 1 格；` +
          `占用：所有建筑物占的人口，卡死不还（拆楼才释放）；` +
          `全部：上限，民居每座 +${SUPPLY.housePop}`,
        'ok',
      ),
    );
    const breadItem = make('button', 'ahud__supply__item');
    breadItem.type = 'button';
    breadItem.append(supplyIcon(BREAD_ICON, '面包'), this.breadText);
    breadItem.addEventListener('click', () =>
      this.say(`面包：磨坊每座 +${SUPPLY.millBread}；每个兵吃 ${SUPPLY.unitBread}，兵死了立刻退还`, 'ok'),
    );
    /**
     * 房屋读数（用户 2026-11-06）："一个防御建筑对应着一个民居，没有民居就没办法建。"
     * 场上每座塔/兵营要占 1 座民居，所以这里直接显示**有几座民居**；
     * 名额不够时变红，提醒玩家该补民居或去拆对面的。
     */
    const houseItem = make('button', 'ahud__supply__item');
    houseItem.type = 'button';
    houseItem.append(supplyIcon(iconOf('house'), '民居'), this.houseText);
    houseItem.addEventListener('click', () =>
      this.say('民居：塔 / 兵营 / 商行各要 1 座；缺了它不开火、不出兵、不产金', 'ok'),
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

    /**
     * 顶栏三段（2026-11-07 晚用户："设置不应该是在顶栏那边，关和视角、退出也应在顶栏上面显示，
     * 时间放在中间"）：
     *   左 = 人口 / 面包 / 民居；中 = 倒计时；右 = 视角 / 设置 / 退出。
     * 时间居中不是"看起来差不多"，是 CSS grid 的 `1fr auto 1fr` —— 左右两列等宽，
     * 中间那列才真正在屏幕中线上（原来 flex space-between 会被左边三个读数挤偏）。
     */

    /**
     * 座位（2026-11-07 双人同屏）：每个玩家一套手牌 + 一条金币条。
     * 单人局只建 1 个，DOM 与老版本一致；双人时第二个座位整体转到屏幕顶部。
     */
    const bottom = make('div', 'ahud__bottom');
    /** 顶栏那一排：视角 / 设置 / 退出（用户点名的三个） */
    const topTools = make('div', 'ahud__tools ahud__tools--top');
    /** 底部那一排：托管 + 调试（常用但不属于"顶栏三件套"） */
    const tools = make('div', 'ahud__tools');
    /**
     * 视角按钮（2026-11-07 傍晚定稿）：**点一下切一档**，不弹清单、不两段式。
     *
     * 上一版点开是一张浮层清单，用户原话："你的视野不要搞得那么复杂，点一下就切换的"。
     * 档位名仍来自 `app.viewPresets`（导演那份表），按钮只显示当前档。
     * 真要精调机位就走 F2 调试面板 —— 那才是"大量数据可以调"的地方。
     */
    const view = iconButton(VIEW_ICON, '视角：点一下切下一档机位', 'ahud__iconbtn--view');
    this.viewBtn = view.btn;
    this.viewBtnText = view.text;
    view.btn.addEventListener('click', () => this.opts.onCycleView());
    /**
     * 退出（2026-11-07 用户："这个进游戏之后退不出来"）：
     * 两段式 —— 第一下只把按钮改成「再点一次」，2.6 秒不跟就自己复位。
     * 战斗中误触一下就把一局丢了，代价太大；弹模态框又太重，两段式最省事。
     */
    const quit = iconButton(QUIT_ICON, '退出这一局，回主菜单', 'ahud__iconbtn--quit');
    this.quitBtn = quit.btn;
    this.quitBtnText = quit.text;
    quit.btn.addEventListener('click', () => this.confirmQuit());
    /**
     * 托管按钮（2026-11-07 用户："我们直接在那个'托管'上面点一下就可以托管"）。
     * 常驻在工具行，三态分别写「托管 / 托管 · 自动 / 托管 · 手」，
     * 状态和 AI 是否真的在打是同一个来源（autoPilot.state），不另算一遍。
     */
    const auto = make('button', 'ahud__view ahud__auto', '托管');
    this.autoBtn = auto;
    auto.type = 'button';
    auto.addEventListener('click', () => this.opts.onToggleAuto());
    /**
     * 设置按钮（2026-11-07 晚用户："设置不应该是在顶栏那边"）。
     *
     * 中午那版按"游戏栏目不需要设置，右键可以"把按钮从工具行撤了，只留右键 / 长按空地。
     * 用户实际用下来不认：右键是**隐藏入口**，手机长按空地又跟"长按放牌"抢手势。
     * 现在恢复成顶栏的可见按钮，右键与长按照样能用（三条路都通，不是二选一）。
     */
    const settings = iconButton(SETTINGS_ICON, '设置', 'ahud__iconbtn--settings');
    settings.btn.addEventListener('click', () => this.openSettings());
    const debugBtn = this.opts.onToggleDebug ? make('button', 'ahud__view ahud__debugbtn', '调试') : null;
    if (debugBtn && this.opts.onToggleDebug) {
      debugBtn.type = 'button';
      debugBtn.addEventListener('click', () => this.opts.onToggleDebug?.());
      this.devBtn = debugBtn;
    }
    topTools.append(view.btn, settings.btn, quit.btn);
    tools.append(auto);
    if (debugBtn) tools.append(debugBtn);
    top.append(supply, this.clock, topTools);
    /**
     * 设置面板（2026-11-06 用户："这个设置能不能额外准备一个自定义设置里面给他处理"）：
     * 战斗中也能调花色 —— 只攒存档，**下一局生效**（「再来一局」= reload 读新档）。
     *
     * 2026-11-07 用户："那个游戏栏目不需要设置，应该右键可以" ——
     * 工具行里**不再有**设置按钮，改成画布上右键（手机长按空地）叫出来。
     * 战斗中那块屏幕是稀缺资源，常驻按钮只留"这一局用得上"的两个：视角、退出。
     */
    this.settingsPanel = make('div', 'ahud__settings');
    this.settingsPanel.hidden = true;
    const settingsHead = make('div', 'ahud__settings__head');
    const settingsTitle = make('span', 'ahud__settings__title', '设置');
    const settingsClose = make('button', 'ahud__settings__close', '×');
    settingsClose.type = 'button';
    settingsClose.addEventListener('click', () => this.toggleSettings(false));
    settingsHead.append(settingsTitle, settingsClose);

    // 一条标签栏 + 一块内容区：同一时刻只显示一页，不再把三类设置堆成一条长滚动栏
    const tabs = make('div', 'ahud__settings__tabs');
    const body = make('div', 'ahud__settings__body');
    const content: Record<SettingsTab, HTMLElement> = {
      auto: this.buildAutoOptions(),
      controls: this.buildControlOptions(),
      banner: createBannerEditor({ hint: '下一局生效' }),
      post: this.buildPostOptions(),
    };
    for (const def of SETTINGS_TABS) {
      const btn = make('button', 'ahud__settings__tab', def.label);
      btn.type = 'button';
      btn.dataset['tab'] = def.key;
      btn.addEventListener('click', () => this.selectSettingsTab(def.key));
      tabs.append(btn);
      this.settingsTabButtons.push(btn);

      const pane = make('div', 'ahud__settings__pane');
      pane.dataset['pane'] = def.key;
      pane.append(content[def.key]);
      body.append(pane);
      this.settingsPanes.set(def.key, pane);
    }
    this.settingsHint = make('p', 'ahud__settings__note ahud__settings__foot');
    this.settingsPanel.append(settingsHead, tabs, body, this.settingsHint);
    this.selectSettingsTab(this.settingsTab);
    /**
     * 右键**不再**打开设置（2026-11-07 晚用户："为什么右键会打开设置啊？"）。
     *
     * 中午那版把设置按钮从工具行撤了、只留右键/长按，等于把最常用的入口藏进
     * 一个没人会去试的手势里。现在入口回到顶栏「设置」按钮，这两条隐藏路径一起下掉 ——
     * 右键在画布上就只表示"不弹系统菜单"（`PointerInput` 里的 preventDefault 仍保留）。
     */
    /**
     * 座位只给**玩家阵营**建（2026-11-07 实机纠错，用户："我甚至能看到敌方的卡牌和敌方的经济"）。
     *
     * 原来写的是 `Math.max(1, players.length)` —— 1v1 里 `players` 是
     * `[蓝方玩家, 红方 AI]`，长度 2，于是**给红方 AI 也建了一套座位**：
     * 屏幕顶部挂着敌方的手牌和金币条，等于把底牌全亮给玩家。
     * 判断依据只能是"这个槽属于哪个阵营"，不是数组有多长。
     *
     * 单人局（1v1 / PVE 单人）恒 1 个座位，DOM 与老版本一致；
     * 只有 PVE 双人（同阵营两个玩家）才会出现第二个。
     */
    const seats = this.app.world.seatPlayers();
    this.el.dataset['players'] = String(Math.max(1, this.app.world.seatCount));
    // 顶栏那排（视角/设置/退出）已经挂进 top；底部这一排只剩托管与调试
    bottom.append(tools);
    const tops: HTMLElement[] = [];
    seats.forEach((p, order) => {
      // 用槽自己的 id 当索引（`players` 数组下标），不要拿循环序数 ——
      // 两者只在"红方也占槽"时才恰好相等，改一个就错位
      const seat = this.buildSeat(p.id);
      this.seats.push(seat);
      if (order === 0) bottom.append(seat.root);
      else tops.push(seat.root);
    });
    this.notice.dataset['hidden'] = '1';
    this.el.append(top, bottom, this.toast, this.notice, this.end, this.settingsPanel, this.big, ...tops);
    host.append(this.el);
    this.end.hidden = true;
    // 默认关：正常玩家看不到「调试」按钮；开了开发者模式才会由 setDevMode 放出来
    this.setDevMode(this.opts.devMode?.() ?? false);
    /**
     * 结算面板两个出口（2026-11-07 用户："三个模式只变成开始守关"）：
     * 「再来一局」重开当前模式（reload，URL 不动）；
     * 「回菜单」把 `?mode=…` 清掉回开始菜单 —— 那里三个模式都能选。
     * 上一版只有「再来一局」，打完一局就只能不断重开同一关。
     */
    const again = make('button', 'ahud__end__btn', '再来一局');
    again.type = 'button';
    again.addEventListener('click', () => this.opts.onRestart());
    const toMenu = make('button', 'ahud__end__btn ahud__end__btn--ghost', '回菜单');
    toMenu.type = 'button';
    toMenu.addEventListener('click', () => this.opts.onMenu?.());
    const endBtns = make('div', 'ahud__end__btns');
    endBtns.append(again, toMenu);
    this.end.append(make('div', 'ahud__end__title', ''), this.endSub, this.endLedger, endBtns);
    this.setupCardDrag();
    this.refresh();
  }

  /**
   * 建一个座位：4 张手牌 + 金币条 + 刷新按钮。
   *
   * 手势在这里只记「从哪一张按下」，真正的拖放状态机在 `setupCardDrag`
   * （window 上收，因为指针会离开卡牌跨到画布）。两个座位共用一个状态机，
   * 靠 `pointerId` 分出是谁的手指 —— 两人同时拖也不会互相踩。
   */
  private buildSeat(player: number): HudSeat {
    const root = make('div', player === 0 ? 'ahud__seat' : 'ahud__seat ahud__seat--p1');
    const hand = make('div', 'ahud__hand');
    const cards: HTMLButtonElement[] = [];
    const parts: HudSeat['parts'] = [];
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
        this.dragFrom.set(e.pointerId, {
          player,
          slot: i,
          x: e.clientX,
          y: e.clientY,
          pointerType: e.pointerType,
        });
        // 触屏长按（180ms 没动）=「按住屏幕就有影子」，松手按影子落点放下；
        // <180ms 的点击仍是普通点击选牌，不误伤
        if (e.pointerType === 'touch') {
          this.clearHoldTimer(e.pointerId);
          const pid = e.pointerId;
          this.holdTimers.set(
            pid,
            window.setTimeout(() => {
              const from = this.dragFrom.get(pid);
              if (!from || this.dragging.has(pid)) return;
              this.dragging.add(pid);
              this.app.beginCardDrag(from.slot, from.player);
              this.app.moveCardDrag(from.x, from.y, 'touch', from.player);
            }, 180),
          );
        }
      });
      card.addEventListener('click', () => {
        // 拖回卡牌/拖出去落牌后浏览器还会补一个 click —— 吃掉，别误选
        if (this.suppressCardClick) return;
        this.opts.onSelectCard(i, player);
      });
      cards.push(card);
      parts.push({ cost, name, kind, art, need });
      hand.append(card);
    }

    /**
     * 金币条（2026-11-06 用户）："能把那个金 20/20 移到卡牌下方，有点像《皇室战争》那样。
     * 就是下面有一个栏目，一点点加的那个能不能搞一下？"
     *
     * 三层叠在一起：填充条在最底下（width = 金/cap），刻度线盖在填充上面
     * （每 1 金一道），数字在最上层 —— 攒一格亮一格，攒满整条泛金光。
     */
    const bank = make('div', 'ahud__bank');
    // 刻度间距按上限算，别在 CSS 里写死 5%（cap 20 那版就是这么漏的）
    bank.style.setProperty('--gold-tick', `${100 / ECONOMY.cap}%`);
    const goldText = make('b', 'ahud__bank__num', '8');
    const goldCap = make('span', 'ahud__bank__cap', `/${ECONOMY.cap}`);
    const goldFill = make('span', 'ahud__bank__fill');
    const bankIcon = make('span', 'ahud__bank__icon');
    bankIcon.innerHTML = COIN_ICON;
    const bankLabel = make('span', 'ahud__bank__label');
    bankLabel.append(bankIcon, goldText, goldCap);
    bank.append(goldFill, bankLabel);
    /**
     * 刷新按钮从上面的工具行挪到金币条右边（2026-11-07）：
     * 它是"花 5 金换一手牌"，跟金币和手牌绑在一起才顺手；
     * 更重要的是双人时**每家要各有一个**，放在工具行会打起来。
     */
    const reroll = make('button', 'ahud__reroll', `刷新 · ${REROLL.cost} 金`);
    reroll.type = 'button';
    reroll.title = '重抽全部 4 张手牌，保底一张民居';
    reroll.addEventListener('click', () => this.opts.onReroll(player));
    const bankRow = make('div', 'ahud__bankrow');
    bankRow.append(bank, reroll);
    root.append(hand, bankRow);
    // 每格一个"飞出去"动画定时器槽，与手牌格数对齐（null = 没在播）
    const playTimers: (number | null)[] = new Array<number | null>(HAND.size).fill(null);
    return {
      player,
      root,
      hand,
      cards,
      parts,
      bank,
      goldText,
      goldCap,
      goldFill,
      reroll,
      lastCardId: new Array<string | null>(HAND.size).fill(null),
      playTimers,
    };
  }

  // ---------------------------------------------------------------- 卡牌拖放

  /**
   * 正在按下的手指 / 鼠标，key = `pointerId`。
   *
   * 原来是一个 `dragFrom: {...} | null`（单指）。双人同屏时两个人会**同时**按住
   * 各自的牌，单槽会被后者覆盖 —— 表现为"我拖着拖着影子突然跑到他那边去了"。
   * 改成按 pointerId 分槽后，几条手势各走各的，互不干扰。
   */
  private readonly dragFrom = new Map<
    number,
    { player: number; slot: number; x: number; y: number; pointerType: string }
  >();
  /** 已经进了拖放模式（位移超过阈值）的那些 pointerId */
  private readonly dragging = new Set<number>();
  /** 触屏长按的定时器，同样按 pointerId 分 */
  private readonly holdTimers = new Map<number, number>();
  private suppressCardClick = false;

  private clearHoldTimer(pid?: number): void {
    if (pid === undefined) {
      for (const t of this.holdTimers.values()) window.clearTimeout(t);
      this.holdTimers.clear();
      return;
    }
    const t = this.holdTimers.get(pid);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.holdTimers.delete(pid);
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
      const from = this.dragFrom.get(e.pointerId);
      if (!from) return;
      if (!this.dragging.has(e.pointerId)) {
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < 8) return;
        this.dragging.add(e.pointerId);
        this.app.beginCardDrag(from.slot, from.player);
      }
      this.clearHoldTimer(e.pointerId);
      this.app.moveCardDrag(e.clientX, e.clientY, e.pointerType || 'mouse', from.player);
    });
    window.addEventListener('pointerup', (e) => {
      const from = this.dragFrom.get(e.pointerId);
      if (!from) return;
      if (this.dragging.has(e.pointerId)) {
        const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        if (hit?.closest('.ahud__hand')) this.app.cancelCardDrag(from.player);
        else this.app.dropCardDrag(e.clientX, e.clientY, e.pointerType || 'mouse', from.player);
        this.suppressCardClick = true;
        window.setTimeout(() => { this.suppressCardClick = false; }, 0);
      }
      this.clearHoldTimer(e.pointerId);
      this.dragFrom.delete(e.pointerId);
      this.dragging.delete(e.pointerId);
    });
    // 指针被系统取消（来电/切窗）：只拆这一根，别把另一个人的影子也清了
    window.addEventListener('pointercancel', (e) => {
      const from = this.dragFrom.get(e.pointerId);
      if (from && this.dragging.has(e.pointerId)) this.app.cancelCardDrag(from.player);
      this.clearHoldTimer(e.pointerId);
      this.dragFrom.delete(e.pointerId);
      this.dragging.delete(e.pointerId);
    });
  }

  /** 设置面板「托管」区的说明（状态变了跟着换文案） */
  private autoManualDesc!: HTMLElement;

  /**
   * 「托管」设置区。
   *
   * 2026-11-07 傍晚用户改了口径："托管就是点一下就托管，不要等 5 秒，
   * 必须玩家自己手动点才会托管" —— 所以这里只剩「现在就托管」一个开关，
   * 原来那行「闲置 5 秒自动托管」连同 `controls.idleAuto` 那个存档位一起删掉了。
   */
  private buildAutoOptions(): HTMLElement {
    const box = make('div', 'ahud__opts');
    box.append(make('div', 'ahud__opts__title', '托管'));
    const row = (name: string, onClick: () => void): [HTMLButtonElement, HTMLElement] => {
      const line = make('div', 'ahud__opt');
      const txt = make('div', 'ahud__opt__txt');
      const desc = make('span', 'ahud__opt__desc');
      const btn = make('button', 'ahud__opt__btn');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        onClick();
        this.paintAuto();
      });
      txt.append(make('span', 'ahud__opt__name', name), desc);
      line.append(txt, btn);
      box.append(line);
      return [btn, desc];
    };
    const [manualBtn, manualDesc] = row('现在就托管', () => this.opts.onToggleAuto());
    this.autoManualBtn = manualBtn;
    this.autoManualDesc = manualDesc;
    /**
     * 开发者模式（2026-11-08 用户："在设置里面，将开发者模式开关默认设为关闭"）。
     * 点一下通知入口改状态 + 存档，入口再回调 `setDevMode` 把三处 UI 一起重画 ——
     * HUD 不自己存这个布尔值。
     */
    const [devBtn, devDesc] = row('开发者模式', () =>
      this.opts.onDevModeChange?.(!(this.opts.devMode?.() ?? false)),
    );
    this.devModeBtn = devBtn;
    devDesc.textContent = '关着时「调试」按钮和 F2 都看不见；开了才显示相机调试面板。';
    // 每页只留一句说明（在面板底部 __foot），这里不再重复写一段
    this.paintAuto();
    return box;
  }

  /**
   * 开发者模式的**唯一渲染入口**：入口状态变了就调这里，
   * 一次把工具行按钮和设置页开关都对齐，不各画各的。
   */
  setDevMode(on: boolean): void {
    if (this.devBtn) this.devBtn.hidden = !on;
    if (this.devModeBtn) {
      this.devModeBtn.dataset['on'] = String(on);
      this.devModeBtn.textContent = on ? '开发者 · 开' : '开发者 · 关';
    }
  }

  /**
   * 设置面板「后期」页（2026-11-08 用户："后期也加一个后期的设置栏…
   * 景深可以高一点或者低一点，也可以让用户自己调"）。
   *
   * 三件控件都**直连 App 的公开接口**，不在 HUD 里另存一份数值；
   * `refresh()` 每 10Hz 调 `paintPostOptions()`，所以 F2 面板改了这里也跟着动，
   * 不会出现两个入口各报一个数的假读数。
   */
  private buildPostOptions(): HTMLElement {
    const box = make('div', 'ahud__opts');
    box.append(make('div', 'ahud__opts__title', '后期效果'));

    const slider = (
      name: string,
      desc: string,
      value: number,
      onInput: (v: number) => void,
    ): { input: HTMLInputElement; num: HTMLElement } => {
      const line = make('div', 'ahud__opt ahud__opt--range');
      const txt = make('div', 'ahud__opt__txt');
      txt.append(make('span', 'ahud__opt__name', name), make('span', 'ahud__opt__desc', desc));
      const input = make('input', 'ahud__opt__range') as HTMLInputElement;
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.05';
      input.value = String(value);
      const num = make('span', 'ahud__opt__num num', value.toFixed(2));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        num.textContent = v.toFixed(2);
        onInput(v);
      });
      line.append(txt, input, num);
      box.append(line);
      return { input, num };
    };

    const tilt = slider('微缩景深', '越高越糊。默认偏高，镜头拉近时还会自动再加一点。', this.app.tiltKnob, (v) => this.app.setTilt(v));
    const dim = slider('氛围压暗', '0 = 白天。拖这根会切到手动；想从早打到晚就把下面的自动开关打开。', this.app.dim, (v) => this.app.setDim(v));

    const row = make('div', 'ahud__opt');
    const txt = make('div', 'ahud__opt__txt');
    txt.append(
      make('span', 'ahud__opt__name', '跟随镜头'),
      make('span', 'ahud__opt__desc', '拉近视距 ⇒ 景深更高；拉远 ⇒ 更低。关掉就只看上面那根滑杆。'),
    );
    const follow = make('button', 'ahud__opt__btn') as HTMLButtonElement;
    follow.type = 'button';
    follow.addEventListener('click', () => {
      this.app.setTiltAuto(!this.app.tiltFollowsCamera);
      this.paintPostOptions();
    });
    row.append(txt, follow);
    box.append(row);

    /** P-099：昼夜时间轴开关。默认开 —— 一局从白天打到夕阳再入夜。 */
    const dayRow = make('div', 'ahud__opt');
    const dayTxt = make('div', 'ahud__opt__txt');
    dayTxt.append(
      make('span', 'ahud__opt__name', '昼夜 · 自动'),
      make('span', 'ahud__opt__desc', '跟着对局时间从早打到晚；关掉就只看上面那根压暗滑杆。'),
    );
    const dayClock = make('button', 'ahud__opt__btn') as HTMLButtonElement;
    dayClock.type = 'button';
    dayClock.addEventListener('click', () => {
      this.app.setDayClock(!this.app.dayClock);
      this.paintPostOptions();
    });
    dayRow.append(dayTxt, dayClock);
    box.append(dayRow);

    this.postControls = {
      tilt: tilt.input, tiltNum: tilt.num, dim: dim.input, dimNum: dim.num, follow, dayClock,
    };
    this.paintPostOptions();
    return box;
  }

  /** F2 面板和设置页共用一份状态，10Hz 同步一次。 */
  private paintPostOptions(): void {
    const c = this.postControls;
    if (!c) return;
    const t = String(this.app.tiltKnob);
    if (c.tilt.value !== t) c.tilt.value = t;
    c.tiltNum.textContent = this.app.tiltKnob.toFixed(2);
    const d = String(this.app.dim);
    if (c.dim.value !== d) c.dim.value = d;
    c.dimNum.textContent = this.app.dim.toFixed(2);
    c.follow.dataset['on'] = String(this.app.tiltFollowsCamera);
    c.follow.textContent = this.app.tiltFollowsCamera ? '跟随 · 开' : '跟随 · 关';
    // P-099：自动模式下 dim 每帧在动，10Hz 刷新会让滑杆跟着时间轴走
    c.dayClock.dataset['on'] = String(this.app.dayClock);
    c.dayClock.textContent = this.app.dayClock ? '自动 · 开' : '自动 · 关';
  }

  /** 工具行按钮 + 设置面板开关，读同一个 `autoPilot.state`。 */
  private paintAuto(): void {
    if (!this.autoBtn || !this.autoManualBtn) return;
    const s = this.app.autoPilot.state;
    const label = s.manual ? '托管 · 开' : '托管';
    if (this.autoBtn.textContent !== label) this.autoBtn.textContent = label;
    this.autoBtn.dataset['on'] = String(s.active);
    this.autoManualBtn.dataset['on'] = String(s.manual);
    this.autoManualBtn.textContent = s.manual ? '托管 · 开' : '托管 · 关';
    this.autoManualDesc.textContent = s.manual
      ? '一直代打，直到再点一次（和工具行「托管」是同一个开关）'
      : '自己打；点一下交给 AI 常驻代打';
  }

  /**
   * 「操作 · 方向」四个开关（2026-11-07 用户："把操作反转之类的都设置好，
   * 可以常态化保存"）。
   *
   * 不做事件总线、不重载页面：`ArenaApp.controls` 是**同一个可变对象**，
   * 四个手势回调每次事件都直接读它，所以改完下一个手势就是新方向；
   * `saveControls()` 写 localStorage，下次启动 `loadControls()` 读回来。
   *
   * 每行都写清"当前这个方向到底会怎样"，而不是只给一个含糊的「开 / 关」——
   * 反转类设置最怕的就是用户开着面板还得猜自己拨到了哪一边。
   */
  private buildControlOptions(): HTMLElement {
    const box = make('div', 'ahud__opts');
    box.append(make('div', 'ahud__opts__title', '操作 · 方向'));
    const rows: {
      key: keyof ControlPrefs;
      name: string;
      normal: string;
      inverted: string;
    }[] = [
      {
        key: 'tiltInvert',
        name: '双指上下推 · 俯仰',
        normal: '往下滑 = 更俯视，往上滑 = 更平',
        inverted: '往下滑 = 更平，往上滑 = 更俯视',
      },
      {
        key: 'panInvert',
        name: '单指拖 · 平移',
        normal: '手指往哪拖，地图就往哪走',
        inverted: '反向拖拽（镜头跟着手指走）',
      },
      {
        key: 'rotateInvert',
        name: '双指拧 · 转视角',
        normal: '顺时针拧 = 镜头右转',
        inverted: '顺时针拧 = 镜头左转',
      },
      {
        key: 'zoomInvert',
        name: '捏合 / 滚轮 · 缩放',
        normal: '张开 = 拉近，捏合 = 拉远',
        inverted: '张开 = 拉远，捏合 = 拉近',
      },
    ];
    // 平时留空（生效时机由面板底部 __foot 统一说明），只在点开关后给一句"已保存"反馈
    const status = make('p', 'ahud__settings__note ahud__settings__status');
    for (const row of rows) {
      const line = make('div', 'ahud__opt');
      const txt = make('div', 'ahud__opt__txt');
      const desc = make('span', 'ahud__opt__desc');
      const btn = make('button', 'ahud__opt__btn');
      btn.type = 'button';
      const paint = (): void => {
        const on = this.app.controls[row.key];
        btn.dataset['on'] = String(on);
        btn.textContent = on ? '反转 · 开' : '反转 · 关';
        btn.setAttribute('aria-pressed', String(on));
        desc.textContent = on ? row.inverted : row.normal;
      };
      btn.addEventListener('click', () => {
        this.app.controls[row.key] = !this.app.controls[row.key];
        saveControls(this.app.controls);
        paint();
        status.textContent = `已保存「${row.name}」· 立刻生效`;
      });
      txt.append(make('span', 'ahud__opt__name', row.name), desc);
      line.append(txt, btn);
      box.append(line);
      paint();
    }
    box.append(status);
    return box;
  }

  /**
   * 切标签页：只显示一页，其余 `hidden`；当前按钮点亮，底部说明跟着换。
   * `settingsTab` 记住上次那一页，下次叫出设置不用重新找。
   */
  private selectSettingsTab(key: SettingsTab): void {
    this.settingsTab = key;
    for (const btn of this.settingsTabButtons) {
      const on = btn.dataset['tab'] === key;
      btn.dataset['on'] = String(on);
      btn.setAttribute('aria-selected', String(on));
    }
    for (const [k, pane] of this.settingsPanes) pane.hidden = k !== key;
    this.settingsHint.textContent =
      SETTINGS_TABS.find((t) => t.key === key)?.hint ?? '';
  }

  /** 设置面板开关。开着的时候战斗照跑（面板浮在上面，不挡逻辑）。 */
  toggleSettings(on?: boolean): void {
    const next = on ?? this.settingsPanel.hidden;
    this.settingsPanel.hidden = !next;
    if (next) this.selectSettingsTab(this.settingsTab);
  }

  /** 叫出设置面板（右键 / 长按空地）。 */
  private openSettings(): void {
    this.toggleSettings(true);
  }

  /**
   * 两段式退出：第一下改成「再点一次」，2.6 秒内没跟就复位。
   * 真走之后页面跳转，所以不需要复位（`onQuit` 里清 sessionStorage 再跳）。
   */
  private confirmQuit(): void {
    if (this.quitArmed) {
      this.opts.onQuit?.();
      return;
    }
    this.quitArmed = true;
    this.quitBtn.dataset['armed'] = '1';
    this.quitBtnText.textContent = '再点一次';
    this.quitBtn.title = '再点一次「退出」回主菜单';
    this.say('再点一次「退出」回主菜单，这一局不保存', 'warn');
    if (this.quitTimer !== null) window.clearTimeout(this.quitTimer);
    this.quitTimer = window.setTimeout(() => this.resetQuit(), 2600);
  }

  private resetQuit(): void {
    if (this.quitTimer !== null) {
      window.clearTimeout(this.quitTimer);
      this.quitTimer = null;
    }
    this.quitArmed = false;
    this.quitBtn.dataset['armed'] = '0';
    this.quitBtnText.textContent = '';
    this.quitBtn.title = '退出这一局，回主菜单';
  }

  // ---------------------------------------------------------------- 中央大字

  private readonly big = make('div', 'ahud__big');
  private overtimeSplashShown = false;
  /** PVE：已经放过几波（用来抓"新一波来了"这个瞬间放中央大字） */
  private lastWaveSeen = 0;

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
            : b.kind === 'guild'
              ? '您的商行缺少民居'
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
    this.paintAuto();
    this.paintPostOptions();
    const s = this.app.world.summary();
    // 每个座位各画各的：手牌、金币条、科技前置提示都是按玩家的
    for (const seat of this.seats) this.paintSeat(seat);

    /**
     * 倒计时 vs 波次条（2026-11-07）：
     * PVE 里"3 分钟倒计时"毫无意义 —— 那一格改成显示**第几波 / 下一波还有几秒**，
     * 全部放完之后切成"残余 N 只"（玩家最想知道的就是还剩多少没清）。
     * 判据全部来自 `summary().pve`，UI 不自己算。
     */
    if (s.endless) {
      /**
       * 1v1 无尽（2026-11-08）：没有倒计时，时钟改成**向上计时**。
       * 不读 `timeLeft`（那是 Infinity），也不打告急 / 加时 —— 时间到了不会结束。
       */
      const mm = Math.floor(s.elapsed / 60);
      const ss = s.elapsed % 60;
      this.clockNum.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
      this.clockOt.textContent = '无尽';
      this.clock.dataset['warn'] = 'false';
      this.clock.dataset['ot'] = 'false';
      this.clock.dataset['endless'] = '1';
      this.clock.dataset['pve'] = '0';
    } else if (s.pve) {
      const { wave, total, nextIn, alive, left, lastWaveOut } = s.pve;
      this.clock.dataset['pve'] = '1';
      this.clock.dataset['endless'] = '0';
      if (lastWaveOut) {
        this.clockNum.textContent = `${total}/${total} 波`;
        this.clockOt.textContent = `残余 ${alive}`;
      } else {
        this.clockNum.textContent = `${Math.min(wave + 1, total)}/${total} 波`;
        this.clockOt.textContent = `下一波 ${Math.ceil(nextIn)}s`;
      }
      // 守满时限前 30 秒告警（和 1v1 的"最后 30 秒变红"同一条视觉语言）
      this.clock.dataset['warn'] = String(left <= MATCH.warnSeconds);
      this.clock.dataset['ot'] = 'false';
    } else {
      const mm = Math.floor(s.timeLeft / 60);
      const ss = s.timeLeft % 60;
      this.clockNum.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
      this.clock.dataset['warn'] = String(s.timeLeft <= MATCH.warnSeconds);
      this.clock.dataset['ot'] = String(s.overtime);
      this.clock.dataset['pve'] = '0';
      this.clock.dataset['endless'] = '0';
    }

    // 进加时赛的**一次性**排面：屏幕中央「加时赛」大字闪 2.6 秒 + 两侧彩带
    // （2026-11-06 用户："屏幕中间会闪过加时赛两三秒……屏幕两边可以飞出彩带"）。
    // 结果页（outcome != playing）不再触发，重开一局由 reload 自然复位。
    if (s.overtime && s.outcome === 'playing' && !this.overtimeSplashShown) {
      this.overtimeSplashShown = true;
      this.showBig('加时赛');
      this.app.confetti.burst();
    }

    /**
     * 波次来袭的**一次性**排面（2026-11-07）：中央闪「第 N 波」。
     *
     * 只在 `wave` 这个读数**变了**的那一帧放，不看时间 ——
     * 掉帧、快进、暂停再开都不会漏放或重放。
     */
    if (s.pve && s.outcome === 'playing' && s.pve.wave !== this.lastWaveSeen) {
      this.lastWaveSeen = s.pve.wave;
      if (s.pve.wave > 0) {
        const elite = this.app.world.pve?.level.waves[s.pve.wave - 1]?.elite;
        this.showBig(elite ? `第 ${s.pve.wave} 波 · 精英` : `第 ${s.pve.wave} 波`);
        if (elite) this.app.confetti.burst();
      }
    }
    // 守住全部波次：撒一次彩带（和加时赛的排面同一套，不新做特效）
    if (s.pve && s.outcome === 'win' && !this.overtimeSplashShown) {
      this.overtimeSplashShown = true;
      this.app.confetti.burst();
    }

    // 人口三分 / 面包：闲置见底时整个人口胶囊闪红（原来按 pop>=popMax 判断，
    // 现在 occupied 卡死后 pop 可能长期贴着上限，改用 idle 才是真警报）
    const sup = s.supply.blue;
    this.popIdleText.textContent = String(sup.idle);
    this.popUsedText.textContent = String(sup.used);
    this.popTotalText.textContent = String(sup.total);
    this.supplyItems.pop.setAttribute('data-full', String(sup.idle <= 0));
    this.breadText.textContent = `${sup.bread}/${sup.breadMax}`;
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

    if (s.outcome !== 'playing') {
      this.end.hidden = false;
      /**
       * 结算面板一出现就收掉中央大字（P-094）：「加时赛 / 第 N 波」那行
       * `showBig` 会挂 2.7 秒，正好压在账单两栏中间，把明细遮得严严实实。
       * 结算页是最终读数，任何 transient 排面都得让位。
       */
      this.big.dataset['show'] = '0';
      const title = this.end.firstElementChild as HTMLElement;
      title.dataset['outcome'] = s.outcome;
      /**
       * 标题必须和「怎么结束的」对得上（P-094）。
       * 旧版只要 `outcome === 'win'` 就写「红方大本营被拆了」，可加时打满
       * 按积分赢的时候对面大本营好好立着 —— 玩家看一眼标题就以为自己拆了家，
       * 再看账单里 1200 血又对不上，等于结算页自己打自己脸。
       * 所以按 `reason` 分：拆家归拆家、积分归积分、平局归平局。
       */
      title.textContent = s.pve
        ? s.outcome === 'win' ? '守住了 —— 这关过了' : '大本营被拆了 —— 失守'
        : s.reason === 'core'
          ? s.outcome === 'win'
            ? '红方大本营被拆了 —— 你赢了'
            : s.outcome === 'lose'
              ? '蓝方大本营被拆了 —— 这局输了'
              : '两边的大本营同时被拆了 —— 平局'
          : s.outcome === 'win'
            ? '加时积分胜出 —— 你赢了'
            : s.outcome === 'lose'
              ? '加时积分落后 —— 这局输了'
              : '加时打满 —— 平局';
      // 第二行必须写清"怎么结束的"：时间到判的胜负和拆掉大本营判的胜负是两回事，
      // 不写玩家会以为自己的大本营也被拆了。
      this.endSub.textContent = this.reasonText(s);
      // 左右账单：把「销毁了哪些建筑 / 为什么积分更多」摊开给人看
      this.paintLedger(s);
    }
  }

  /**
   * **结算账单 DOM**（P-094）。
   *
   * 数据全来自 `summary().ledger`（规则层算好），这里只负责摆版：
   * 左蓝 / 右红两栏各列「拆掉对方什么、自己丢了什么」，下面三行
   * 把三级判据摊开并给决定胜负那一行挂 `data-decided="1"`。
   *
   * 只在结算时跑，且用 `lastLedgerStamp` 去重 —— `refresh()` 是 20Hz，
   * 每帧 innerHTML 会把结算页重排到卡。数字和中文名都是受控数据，
   * 仍统一过一遍 `esc()`，免得以后有人往建筑名里塞尖括号。
   */
  private paintLedger(s: ReturnType<ArenaApp['world']['summary']>): void {
    const L: BattleLedger | null = s.ledger;
    this.endLedger.hidden = !L;
    if (!L) return;
    const stamp = [
      s.outcome, s.reason, L.decidedBy,
      L.blue.wreckedTotal, L.red.wreckedTotal,
      L.blue.alive, L.red.alive, L.blue.coreHp, L.red.coreHp,
    ].join(':');
    if (stamp === this.lastLedgerStamp) return;
    this.lastLedgerStamp = stamp;

    const esc = (v: string): string =>
      v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const wreckList = (list: LedgerWreck[]): string =>
      list.length
        ? list.map((w) => `<li><span>${esc(w.name)}</span><b>×${w.count}</b></li>`).join('')
        : '<li class="ahud__ledger__empty">一栋没拆到</li>';
    const col = (side: SideLedger, name: string): string => `
      <div class="ahud__ledger__col" data-side="${side.side}">
        <div class="ahud__ledger__name">${name}</div>
        <div class="ahud__ledger__sect">
          <h4>拆掉对方 <b>${side.wreckedTotal}</b> 栋</h4>
          <ul>${wreckList(side.wrecked)}</ul>
        </div>
        <div class="ahud__ledger__sect">
          <h4>自己丢了 <b>${side.lostTotal}</b> 栋</h4>
          <ul>${wreckList(side.lost)}</ul>
        </div>
      </div>`;
    const criteria = L.criteria.map((c, i) => `
      <div class="ahud__ledger__row" data-decided="${c.decided ? '1' : '0'}">
        <span class="ahud__ledger__key">${'①②③'[i] ?? ''} ${esc(c.name)}<i>${esc(c.hint)}</i></span>
        <b class="ahud__ledger__score">${c.blue} : ${c.red}</b>
        ${c.decided ? '<em class="ahud__ledger__why">← 这一项分出胜负</em>' : ''}
      </div>`).join('');

    this.endLedger.innerHTML = `
      <div class="ahud__ledger__head">${esc(L.headline)}</div>
      <div class="ahud__ledger__cols">
        ${col(L.blue, '蓝方 · 你')}
        <div class="ahud__ledger__vs">VS</div>
        ${col(L.red, '红方 · 对手')}
      </div>
      <div class="ahud__ledger__criteria">${criteria}</div>`;
  }

  /** 结算面板第二行。数字一律从 summary 里取，不在这里重算。 */
  private reasonText(s: ReturnType<ArenaApp['world']['summary']>): string {
    // 1v1 无尽：没有"时间到"这条出口，第二行写战绩（时长 + 双方拆楼数）
    if (s.endless) {
      const mm = Math.floor(s.elapsed / 60);
      const ss = String(s.elapsed % 60).padStart(2, '0');
      return `无尽 · 打了 ${mm}:${ss} · 拆掉对面 ${s.destroyed.red} 栋 / 自己丢了 ${s.destroyed.blue} 栋`;
    }
    // PVE：写"守住几波 / 清掉多少 / 大本营剩多少"，不写 1v1 的积分
    if (s.pve) {
      const p = s.pve;
      return s.reason === 'waves'
        ? `${p.level} · ${p.total} 波全部守住 · 清掉 ${p.slain} 只 · 大本营剩 ${s.blueCore}`
        : `${p.level} · 倒在第 ${Math.min(p.wave + 1, p.total)} 波 · 已清掉 ${p.slain} 只`;
    }
    const minutes = MATCH.seconds / 60;
    // 2026-11-06 加时赛：常规时间打满不判，加时打满按**积分**判（存活楼数 → 剩血 → 拆楼）。
    // P-094 起这三级判据在下方左右账单里逐行摊开，第二行只说「怎么结束的 + 去哪看」，
    // 不再把四组数字挤成一行糊脸。reason = 'overtime'（新）/ 'time'（旧存档兼容）。
    if (s.reason === 'overtime' || s.reason === 'time') {
      const head = s.reason === 'overtime' ? `${minutes + 2} 分钟（含加时）到` : `${minutes} 分钟到`;
      return `${head} · 详细账单见下：拆了哪些楼、哪一项分出胜负`;
    }
    if (s.reason === 'draw') {
      return `${minutes + 1} 分钟（含加时）到 · 三级判据全部持平，账单里逐项可查`;
    }
    if (s.reason === 'core' && s.outcome === 'draw') {
      return '最后一下把两边的大本营一起拆掉了';
    }
    return s.outcome === 'win' ? '红方大本营被拆掉了' : s.outcome === 'lose' ? '蓝方大本营被拆掉了' : '';
  }

  /**
   * 一个座位的全部读数：手牌提示、金币条、四张卡面。
   * 判据一律取玩家槽（`world.players[i]`），UI 不自己算钱、也不算能不能造。
   */
  private paintSeat(seat: HudSeat): void {
    const p = this.app.world.players[seat.player] ?? this.app.world.players[0]!;
    // 科技前置 / 发牌裁量提示：判据与 draw()/reroll()/落牌校验同源（world.techHint）
    seat.hand.setAttribute('data-no-room', String(!this.app.world.buildingRoom(p.side)));
    seat.hand.setAttribute('data-hint', this.app.world.techHint(p.side) ?? '');
    // 金币条：数字 + 填充宽度一起走。data-full 给整条泛金光 —— 满了提醒"该花出去了"。
    seat.goldText.textContent = String(p.gold);
    seat.goldCap.textContent = `/${ECONOMY.cap}`;
    seat.goldFill.style.width = `${Math.min(100, (p.gold / ECONOMY.cap) * 100)}%`;
    seat.bank.dataset['full'] = String(p.gold >= ECONOMY.cap);
    for (let i = 0; i < seat.cards.length; i++) this.paintCard(seat, i);
  }

  /**
   * 只改文字与 data 属性 —— 不重建节点、也不 disabled。
   * disabled 会让点击彻底没反应，玩家只会觉得"点不到"；
   * 这里让点击永远有回应（打不了就说明原因）。
   */
  private paintCard(seat: HudSeat, slot: number): void {
    const el = seat.cards[slot]!;
    const parts = seat.parts[slot]!;
    // 正在播"飞出去"的这 260ms：别改它，让动画把旧牌面带走
    if (el.dataset['played'] === '1') return;

    const p = this.app.world.players[seat.player] ?? this.app.world.players[0]!;
    const card = p.hand[slot];
    const id = card ? card.id : null;
    const last = seat.lastCardId[slot] ?? null;

    // 刚打出去：牌面再留 260ms 做飞出动画，然后变成**空白格**（不再显示"补牌中"）
    if (!card && last !== null) {
      seat.lastCardId[slot] = null;
      el.dataset['played'] = '1';
      el.dataset['selected'] = 'false';
      const old = seat.playTimers[slot];
      if (old !== null && old !== undefined) window.clearTimeout(old);
      seat.playTimers[slot] = window.setTimeout(() => {
        el.dataset['played'] = '0';
        el.dataset['empty'] = '1';
        el.dataset['affordable'] = 'true';
        parts.cost.textContent = '';
        parts.name.textContent = '';
        parts.kind.textContent = '';
        parts.art.innerHTML = '';
        parts.need.textContent = '';
        /**
         * P-095：清空图标的同时**必须把图标缓存一起清掉**。
         * 以前只清 innerHTML，却留着 `data-icon = 刚打出去那张卡的 id`；
         * 等 2.2 秒后随机补牌补回**同一个 id**（概率 ≈ 1/卡池数），
         * 下面那句缓存判断会以为"图标还在"而跳过重建 ⇒ 卡面图标永久空白。
         * 这就是用户看到的「SVG 有概率不显示」—— 不是随机渲染故障，是缓存没失效。
         */
        delete el.dataset['icon'];
        seat.playTimers[slot] = null;
      }, 260);
      return;
    }
    seat.lastCardId[slot] = id;

    el.dataset['selected'] = String(
      this.app.selectedSlot === slot && this.app.selectedPlayer === p.id,
    );
    if (!card) {
      // 空白格：没有数字、没有名字、没有倒计时 —— 就是"这张牌已经打出去了"
      el.dataset['empty'] = '1';
      el.dataset['affordable'] = 'true';
      parts.cost.textContent = '';
      parts.name.textContent = '';
      parts.kind.textContent = '';
      parts.art.innerHTML = '';
      parts.need.textContent = '';
      delete el.dataset['icon']; // 空白格也一样：别给下一张卡留一个假的"已渲染"标记
      return;
    }
    el.dataset['empty'] = '0';
    el.dataset['kind'] = card.kind === 'building' ? 'build' : 'army';
    el.dataset['affordable'] = String(p.gold >= card.cost);
    parts.cost.textContent = String(card.cost);
    parts.name.textContent = card.name;
    // 移动火炮是**军队**（'siege' 只是模型差异），不再单独标'工程'
    parts.kind.textContent = card.kind === 'building' ? '建筑' : '军队';
    // 图标只在换牌时重建：这是 20Hz 的刷新，每次 innerHTML 会白白重解析 SVG。
    // 两个条件都要判：① id 变了；② DOM 里的 SVG 真的还在（动画清空过 / 外部改过 DOM）。
    // 只判 ① 就是 P-095 那个「有概率不显示」的病根。
    // `card.icon` 给大地图扩展卡用：它们自带 SVG，主模式 CARD_ICON 表里没有。
    if (el.dataset['icon'] !== card.id || parts.art.childElementCount === 0) {
      parts.art.innerHTML = card.icon ?? iconOf(card.id);
      el.dataset['icon'] = card.id;
    }
    // 「几人几包」改成 SVG 图标（用户 2026-11-06），**差哪样标哪样红**：
    // 判据读 `supplyBlocked` 的理由文本（和出牌被拒同一条路，不另算一套账），
    // 玩家看着牌面就知道"为什么造不出来"，不用点出去被拒了才明白。
    parts.need.innerHTML = supplyRowsHtml(card);
    const why = this.app.world.supplyBlocked(p.side, card);
    el.dataset['short'] = why ? (why.includes('面包') ? 'bread' : 'pop') : '';
  }

  /**
   * 刷新手牌之后强制重画：清掉所有"飞出去"动画和定时器，
   * 不然 260ms 后旧定时器会把刚发下来的新牌清成空白格。
   */
  rerollHand(): void {
    for (const seat of this.seats) {
      for (let i = 0; i < seat.cards.length; i++) {
        const timer = seat.playTimers[i];
        if (timer !== null && timer !== undefined) window.clearTimeout(timer);
        seat.playTimers[i] = null;
        seat.lastCardId[i] = null;
        seat.cards[i]!.dataset['played'] = '0';
        seat.cards[i]!.dataset['selected'] = 'false';
      }
    }
    this.refresh();
  }

  /** 卡池变了（配卡组以后）再重建卡面；现在只需重画。 */
  setHand(): void {
    this.refresh();
  }

  /** 视角按钮上的那行短字（当前机位名）；宽屏才显示，手机只留 SVG。 */
  setViewStatus(status: string): void {
    const label = `视角 · ${status}（点一下切下一档）`;
    if (this.viewBtn.title !== label) this.viewBtn.title = label;
    this.viewBtn.setAttribute('aria-label', label);
    if (this.viewBtnText.textContent !== status) this.viewBtnText.textContent = status;
  }

  /** 给外部（比如实机探针）读一眼当前卡面文案（第 0 号座位）。 */
  get cardLabels(): string[] {
    return (this.seats[0]?.cards ?? []).map((c) => c.textContent ?? '');
  }

  /** 用一张卡的说明做长按提示（以后接气泡）。 */
  static describe(card: ArenaCard): string {
    return `${card.name}（${card.cost} 金）· ${card.blurb}`;
  }
}

/** 两行增减需求已抽到 `visuals/supplyRows.ts`（纯函数、单测覆盖）。 */

