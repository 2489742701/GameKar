/**
 * 大地图模组入口（2026-11-09，P-087）—— 卡牌驱动的主模式扩展。
 *
 * 只做三件事：建规则状态、挂视图、按帧驱动。规则在 rules.js、地图在 map.js、
 * 手牌判据在 hand.js、画面在 view.js，这里不写任何玩法逻辑。
 * 全部文件都在 public/mods/ 内，主程序玩法文件零改动，能力靠 host.modApi 注入。
 *
 * 表现层用的是主游戏那套 3D 零件（Renderer / 光照 / 相机 / OutputPass /
 * ARENA_MODELS）；地图形态是大六边形像素地形 + 内部六芒星道路网。
 * 四时段天光与云朵面片在 sky.js。仍是原型：单位战斗 / 拆家没做，胜负暂用积分占位。
 * 口径与待拍板项见 `docs/工作笔记/大地图原型设计_20261108.md`。
 */
import { createGame, tick, placeBuilding, spawnChest, collectChest } from './rules.js';
import * as M from './map.js';
import { createView } from './view.js';

let cleanup = null;

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

  // 无头探针靠这几个读得到状态 / 触发操作
  window.__modActive = 'grand-map';
  window.__grandMap = {
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

  cleanup = () => {
    loop.stop();
    view.dispose();
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
