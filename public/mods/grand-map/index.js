/**
 * 大地图模组入口（2026-11-09，P-087；2026-11-15 分层）—— 卡牌驱动的主模式扩展。
 *
 * 只做三件事：建规则状态、挂视图、按帧驱动。
 * 本文件是**唯一的模组公开面**，目录结构：
 *
 *   index.js          ← 你在这里：入口 / 生命周期 / 探针钩子
 *   view.js           ← 装配层：把状态画出来 + 把点击变成动作
 *   core/             纯逻辑，零 DOM / 零 three，可直接 node 测
 *     rules.js           六方外交 / 商路 / 集市扣押 / 宝箱 / 回合
 *     map.js             大六边形地形 + 六芒星路网 + 三档尺寸
 *     hand.js            四张手牌 / 补牌 / 落牌判据（金币只扣一次）
 *     rally.js           点击地面集结的状态机
 *   view/             纯出件与场景层
 *     sky.js             四时段天光 + 云朵面片
 *   parts/            给参数就出 Object3D 的小件（血条 / 弹丸 / 单位视图）
 *   tests/            node --test 自测（npm run test:mod）
 *
 * ⚠️ 主程序玩法文件零改动，能力全部靠 host 注入（three / engine / assets / modApi）。
 * 仍是原型：**单位战斗与拆家没做**，胜负暂用积分占位。
 * 口径与待拍板项见 `docs/工作笔记/大地图原型设计_20261108.md`。
 */
import { createGame, tick, placeBuilding, spawnChest, collectChest } from './core/rules.js';
import * as M from './core/map.js';
import { createView } from './view.js';

let cleanup = null;

/**
 * 模组在页面上的**独立命名空间**（2026-11-15）。
 *
 * 原来探针钩子直接挂在 `window.__grandMap` / `window.__modActive` 上 —— 每个模组
 * 各自占一个全局键，谁都不知道别人用了什么名字，迟早撞车（`__dbg` 已经归主程序了）。
 *
 * 现在统一收到一个根命名空间下：
 *
 *     window.GamekarMods                 ← 根（由 modHost 保证存在）
 *       .active                          ← 当前挂着的模组 id
 *       .grandMap                        ← 本模组的探针面
 *       .<otherMod>                      ← 别的模组各占一个子键，互不干扰
 *
 * 好处有三：
 *   ① 命名冲突一眼可查 —— 想加钩子先看根下有没有同名；
 *   ② 卸载时删自己那个子键就行，不用记得清了几个全局变量；
 *   ③ 探针 / 调试工具只认 `window.GamekarMods` 一个入口，不用列举模组。
 *
 * ⚠️ 向后兼容：`window.__grandMap` 与 `window.__modActive` 仍然保留为
 * **同名别名**，因为 `tools/grand_map_probe.mjs` 和若干测试钉着它们。
 * 新代码请用 `GamekarMods.grandMap`；别名等探针改造完再撤。
 */
const NS_ROOT = 'GamekarMods';

/** 拿到（或建出）根命名空间。模组不该假设别人先建过它。 */
function namespace() {
  const w = window;
  if (!w[NS_ROOT] || typeof w[NS_ROOT] !== 'object') w[NS_ROOT] = {};
  return w[NS_ROOT];
}

export function mount(host) {
  if (!host || host.api !== 1) {
    throw new Error('host 契约不匹配（需要 api=1）');
  }
  // 开放 API 也带版本，和 host.api 分属两件事（modApi.ts 顶部说清了）：
  //   host.api    —— 宿主契约，决定 mount/exit/makeLoop 这层形状；
  //   modApi.version —— 卡池 / 手牌 / 金币条这层能力。
  // 只查前者的话，开放 API 从 2 升到 3 时模组会**静默**用错形状，到运行期才崩。
  // 这里要求 >= 2 而不是 ===：开放 API 只增不改，向后兼容的版本可以照跑。
  const apiVersion = host.modApi && host.modApi.version;
  if (typeof apiVersion !== 'number' || apiVersion < 2) {
    throw new Error(`开放 API 版本不匹配（需要 >= 2，实际 ${apiVersion}）`);
  }

  const game = { state: createGame(), tradeTarget: 2, tradeKind: 'near' };
  const view = createView(host, game);

  // 用注入的 GameLoop 驱动（不自己 setInterval，卸载时 loop.stop() 一起收干净）。
  const loop = host.makeLoop({ onFrame: (info) => view.frame(info) });

  /** 无头探针 / 调试工具读状态、触发动作的唯一入口 */
  const surface = {
    id: 'grand-map',
    get state() { return game.state; },
    get map() { return M; },
    get hand() { return view.hand; },
    get rally() { return view.rally; },
    get chests() { return view.chests; },
    spawnChest() { return view.spawnChest(); },
    collectChest(id) { return view.collectChest(id); },
    get zoom() { return view.zoom; },
    get size() { return M.SIZE; },
    get sizes() { return M.SIZES; },
    get viewRange() { return M.VIEW; },
    get dudesReady() { return view.dudesReady; },
    get floor() { return view.floor; },
    get periodIndex() { return view.periodIndex; },
    step() { tick(game.state); view.render(); },
    place(r, c) { const res = placeBuilding(game.state, 0, r, c); view.render(); return res; },
    playCard(slot, col, row) { return view.playCard(slot, col, row); },
    rallyAt(col, row) { return view.rallyAt(col, row); },
    setOverview(on) { view.setOverview(on); },
    openMarket() { view.openMarket(); },
    openDiplomacy(id) { view.openDiplomacy(id); },
    setPeriod(i) { view.setPeriod(i); },
  };

  const ns = namespace();
  ns.active = 'grand-map';
  ns.grandMap = surface;
  // 兼容别名（见上方说明，探针改造完再撤）
  window.__modActive = 'grand-map';
  window.__grandMap = surface;

  cleanup = () => {
    loop.stop();
    view.dispose();
    const root = window[NS_ROOT];
    if (root) {
      delete root.grandMap;
      delete root.active;
      // 根上什么都不剩就整个撤掉，别在页面上留一个空对象
      if (Object.keys(root).length === 0) delete window[NS_ROOT];
    }
    delete window.__modActive;
    delete window.__grandMap;
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
