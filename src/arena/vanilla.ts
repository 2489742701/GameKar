/**
 * 对战模式入口 —— 只做三件事：装样式与材质、把 ArenaApp 起来、把 HUD 挂上去。
 *
 * 和老模式（`src/main.ts`）互相独立：两边各有各的入口页，共用 engine/ 与素材。
 */

import '../styles/base.css';
import '../styles/components.css';
import '../styles/arena.css';
import '../styles/start.css';

import { installTheme } from '@ui/theme';
import { ArenaApp } from './ArenaApp';
import { ArenaHud } from './ArenaHud';
import { DebugPanel } from './DebugPanel';
import { StartMenu } from './StartMenu';
import { loadSettings, resolveEnemyBanner, settingsFromParam } from './banner';
import { loadDevMode, saveDevMode } from './devMode';
import { setSideBanners } from './theme';

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
const params = new URLSearchParams(location.search);
/**
 * `?play=1`：跳过开始菜单直接开打。
 *
 * 截图与自动化脚本全都走这条路 —— 少了它，`arena_shot.mjs` 拍到的会是菜单而不是战场。
 * `?auto=1` 也跳过：托管局本来就是给测试跑的，没人坐在屏幕前点"开始"。
 */
const skipMenu = params.get('play') === '1' || params.get('auto') === '1' || params.get('auto') === 'blue';
/**
 * `?mode=pve`：守波次模式（2026-11-07）。
 *
 * 场地、出怪、判据全都不一样，但入口还是这一个页面 —— 两套玩法共用一条分发链，
 * APK 与桌面 HTML 都不用多打一份。
 * `?level=outpost` 选关卡，`?players=2` 开双人同屏。
 */
const modeParam = params.get('mode');
/**
 * `?mode=endless`：**1v1 无尽**（2026-11-08 用户："不限时间一直打"）。
 * 和对战同一张图、同一个 AI，只去掉时限与加时；唯一出口是拆掉对面大本营。
 */
const mode: 'arena' | 'pve' | 'endless' =
  modeParam === 'pve' ? 'pve' : modeParam === 'endless' ? 'endless' : 'arena';
const level = params.get('level') ?? undefined;
const players = Math.min(2, Math.max(1, Number(params.get('players') ?? 1) || 1));
/**
 * 花色系统（2026-11-06）：菜单里改过花色 ⇒「开始对战」时重开一局带新花色启动。
 * 存档在 localStorage（banner.ts），这里是"改动后自动重开"的桥：
 * sessionStorage 放一个一次性标记，reload 后跳过菜单直接开打。
 */
const AUTOSTART_KEY = 'arena.autostart';
const autoStart = sessionStorage.getItem(AUTOSTART_KEY) === '1';
if (autoStart) sessionStorage.removeItem(AUTOSTART_KEY);

// 花色必须在 ArenaApp.boot **之前**注入 —— 房顶/旗布/水晶的材质在 boot 里创建
// `?banner=` 参数（测试/分享通道）优先于本地存档，只覆盖本局、不写档
const bannerSettings = settingsFromParam(params.get('banner') ?? '', loadSettings());
setSideBanners({
  blue: bannerSettings.player,
  red: resolveEnemyBanner(bannerSettings, seedFromUrl(20261027)),
});
/** boot 时的花色指纹：菜单里改过 ⇒ 开打时 reload 一次让新花色上场 */
const bannerHashAtBoot = JSON.stringify([bannerSettings.player, bannerSettings.enemy]);

// 木纹/镀金材质与老模式是同一套（玩家在那边的调参在这里也生效）
installTheme();

let hud: ArenaHud | null = null;
let debug: DebugPanel | null = null;

/**
 * **开发者模式**（2026-11-08 用户："把调试默认设为看不见，
 * 在设置里面，将'开发者模式'开关默认设为关闭"）。
 *
 * 状态只在这一处：设置页的开关、`F2`、工具行「调试」按钮、调试面板的可用性
 * 全读同一个 `devMode`。默认关；`?debug=1` 只给开发机 / 无头探针强制开一次，
 * 不写进存档，所以在设置里照样能关掉。
 */
const forcedDebug = params.get('debug') === '1';
let devMode = forcedDebug || loadDevMode();

function setDevMode(on: boolean): void {
  devMode = on;
  saveDevMode(on);
  hud?.setDevMode(on);
  debug?.setEnabled(on);
  hud?.say(on ? '开发者模式已开：F2 /「调试」可用' : '开发者模式已关');
}

const app = await ArenaApp.boot({
  container,
  canvas,
  seed: seedFromUrl(20261027),
  mode,
  level,
  players,
  /**
   * 警告走左上角通知栏（会向左收起），普通提示走原来的 toast。
   * 出牌被拒时顺手让「对应那个胶囊闪红」—— 判据就是 `playCard` 的 reason 文本。
   */
  onToast: (text, tone) => {
    if (tone === 'warn') {
      hud?.notify(text);
      hud?.flashSupply(text);
    } else {
      hud?.say(text, 'ok');
    }
  },
  onState: () => {
    hud?.refresh();
    hud?.setViewStatus(app.director.status);
    debug?.refresh();
  },
  /**
   * 闲置自动托管接管时给一句提示：玩家最怕的是"怎么突然自己动起来了"。
   * 手动点开的那条路不提示（按钮自己会变成「托管 · 手」）。
   */
  onAutoPilot: (s) => {
    if (s.active && !s.manual) hud?.say('闲置 5 秒 · 已自动托管；点一下屏幕就能拿回来');
  },
});

/**
 * 回开始菜单 —— 清 `?mode=…` 是必须的。
 *
 * 只 `location.reload()` 的话 `?mode=pve` 会一直粘着，玩家永远回不到普通对战 ——
 * 这正是上一版"三个模式只剩一个开始守关"的成因。
 * 战斗中的「退出」和结算面板的「回菜单」都走这一个函数，语义上就是同一件事。
 */
const toMenu = (): void => {
  sessionStorage.removeItem(AUTOSTART_KEY);
  location.href = location.pathname;
};

hud = new ArenaHud(container, app, {
  onSelectCard: (slot, player = 0) => {
    const result = app.selectCard(slot, player);
    if (result === 'empty') hud?.say('这张牌已经打出去了，等新牌', 'warn');
    else if (result === 'cooldown') hud?.say('这张还在冷却', 'warn');
    else if (result === 'poor') {
      const card = app.playerAt(player).hand[slot];
      hud?.say(`金币不够（要 ${card?.cost ?? 0}）`, 'warn');
    }
    hud?.setHand();
  },
  /** 视角按钮：点一下切下一档（导演平滑挪过去，按钮上的字跟着换） */
  onCycleView: () => {
    app.nextView();
    hud?.setViewStatus(app.director.status);
  },
  /** 工具行 / 设置面板共用这一条：切手动托管，按钮与开关由 refresh() 统一重画 */
  onToggleAuto: () => {
    const manual = app.autoPilot.toggleManual();
    hud?.say(manual ? '已托管，再点一次「托管」交还给自己' : '控制权已交还给你');
    hud?.refresh();
  },
  /**
   * 顶栏「调试」按钮：开关相机面板。手机没有 F2，这是**唯一**能点到的入口
   * （2026-11-07 用户："我的 debug 模式你也没给我准备好，我没办法调整摄像机"）。
   * 面板本身是临时件，定稿机位后跟它一起删。
   */
  onToggleDebug: () => debug?.toggle(),
  /** 设置页「开发者模式」开关：读同一份状态、改同一份状态 */
  devMode: () => devMode,
  onDevModeChange: (on) => setDevMode(on),
  onReroll: (player = 0) => {
    const res = app.rerollHand(player);
    if (res.ok) {
      hud?.rerollHand();
      hud?.say('重抽四张（保底一张民居）');
    } else {
      hud?.say(res.reason ?? '刷新不了', 'warn');
    }
  },
  /** 重开当前模式（URL 不动）。想换模式走下面的「退出 / 回菜单」 */
  onRestart: () => location.reload(),
  onMenu: toMenu,
  onQuit: toMenu,
});

hud.setViewStatus(app.director.status);

/**
 * 开始菜单：**默认打开**。
 *
 * 上一版是"打开即开打"——玩家还没看清这是什么游戏，倒计时已经在走了。
 * 菜单期间 `app.pause()` 停的是逻辑（`GameLoop.onSimStep`），画面照常渲染，
 * 所以背后那幅战场是活的：磨坊在转、浮尘在飘。
 */
if (!skipMenu && !autoStart) {
  app.pause();
  hud.el.style.visibility = 'hidden';
  const menu = new StartMenu(container, {
    seed: seedFromUrl(20261027),
    // 当前模式只决定"主按钮开始的是哪一局"，另外两个模式的入口永远都在
    mode: mode === 'pve' ? (players >= 2 ? 'pve2' : 'pve1') : mode,
    sfx: app.sfx,
    /**
     * 切模式 = 重开一局，所以走**跳转**而不是原地切。
     *
     * 回普通对战时 `location.search = ''` 是必须的：`?mode=pve` 不主动清掉就会一直粘着，
     * `location.reload()`（「再来一局」）永远回到 PVE —— 上一版就是这么把普通模式弄丢的。
     */
    onSwitch: (m) => {
      sessionStorage.setItem(AUTOSTART_KEY, '1');
      if (m === 'arena') {
        location.search = '';
      } else if (m === 'endless') {
        location.search = '?mode=endless';
      } else {
        location.search = m === 'pve2' ? '?mode=pve&players=2' : '?mode=pve';
      }
    },
    onStart: () => {
      // 浏览器只在**用户手势**里允许建 AudioContext，这一下是全场唯一的天然时机
      app.sfx.unlock();
      // 菜单里改过花色 ⇒ 重开一局带新花色启动（sessionStorage 一次性自动开打标记）
      const now = loadSettings();
      if (JSON.stringify([now.player, now.enemy]) !== bannerHashAtBoot) {
        sessionStorage.setItem(AUTOSTART_KEY, '1');
        location.reload();
        return;
      }
      menu.dispose();
      hud.el.style.visibility = '';
      app.resume();
      hud.say('开打 —— 点一张牌，再点地面');
    },
  });
}

/**
 * `?auto=1` / `?auto=blue`：开局就把**我方**交给 AI 代打。
 *
 * 这是给自动化测试用的通道：蓝方挂机时 60 秒必输（实测大本营 1200 血被推平），
 * 那样跑出来的不是"这一局怎么打"，而是"没人操作会怎样"。
 * 开了托管，两边都是 AI，一局能自己打完，平衡性才有得测。
 * 蓝方出的是**手牌**（和玩家同一套限制），所以这条链路顺带也被测到。
 */
const autoParam = params.get('auto');
if (autoParam === '1' || autoParam === 'blue') {
  // 走 AutoPilot 的手动档，而不是直接改 world：否则状态机下一帧按"玩家没操作"
  // 把它算成 false，测试通道会莫名其妙地失效。
  app.autoPilot.forceManual(true);
  hud?.say('我方托管已开（自动化测试用）');
}

// 调试面板：F2 开关。用户在这里调机位、把喜欢的机位码与"要删的东西"记下来发我。
debug = new DebugPanel(app);
debug.setEnabled(devMode);
container.append(debug.el);
hud?.setDevMode(devMode);
/**
 * 挂到 window 上只为一件事：**无头探针要能开面板**（`tools/_probe_*.js` 走 CDP eval）。
 * 面板本来就是临时调试件，跟着它一起删；不是给产品逻辑用的入口。
 */
(window as unknown as { __dbg: DebugPanel }).__dbg = debug;

// 键盘：V 换视角（和 HUD 上那颗按钮走同一条路）
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'v' || e.key === 'V') hud?.setViewStatus(app.nextView());
  if (e.key === 'F2') {
    e.preventDefault();
    // 开发者模式关着时 F2 完全没反应（不是"按了没面板但也不拦默认行为"）
    if (devMode) debug?.toggle();
  }
});

declare global {
  interface Window {
    arena: ArenaApp;
    arenaHud: ArenaHud;
  }
}

window.arena = app;
window.arenaHud = hud;
