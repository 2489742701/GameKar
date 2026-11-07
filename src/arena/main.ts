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
const mode = params.get('mode') === 'pve' ? 'pve' : 'arena';
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
});

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
  onCycleView: () => hud?.setViewStatus(app.nextView()),
  onReroll: (player = 0) => {
    const res = app.rerollHand(player);
    if (res.ok) {
      hud?.rerollHand();
      hud?.say('重抽四张（保底一张民居）');
    } else {
      hud?.say(res.reason ?? '刷新不了', 'warn');
    }
  },
  onRestart: () => location.reload(),
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
    mode,
    sfx: app.sfx,
    /**
     * 「守城 PVE」/「双人同屏」：跳过去直接开打。
     *
     * 写一次性 autostart 标记再导航 —— reload 之后 `?mode=pve` 生效，
     * 菜单不再弹（和"改完旗帜自动开打"走同一条通道）。
     */
    onPve: (n) => {
      sessionStorage.setItem(AUTOSTART_KEY, '1');
      location.search = n >= 2 ? '?mode=pve&players=2' : '?mode=pve';
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
  app.world.setAuto('blue', true);
  hud?.say('我方托管已开（自动化测试用）');
}

// 调试面板：F2 开关。用户在这里调机位、把喜欢的机位码与"要删的东西"记下来发我。
debug = new DebugPanel(app);
container.append(debug.el);

// 键盘：V 换视角（和 HUD 上那颗按钮走同一条路）
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'v' || e.key === 'V') hud?.setViewStatus(app.nextView());
  if (e.key === 'F2') {
    e.preventDefault();
    debug?.toggle();
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
