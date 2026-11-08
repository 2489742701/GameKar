/**
 * 大地图模组入口（2026-11-09）—— 从"占位骨架"升级为**可跑的规则原型**。
 *
 * 只做三件事：建规则状态、挂视图、按秒推进。规则在 rules.js、画面在 view.js，
 * 这里不写任何玩法逻辑。全部文件都在 public/mods/ 内，主程序零改动。
 *
 * 仍是原型：单位战斗 / 拆家 / 3D 战场 / 昼夜都还没做，胜负暂用积分占位。
 * 口径与待拍板项见 `docs/工作笔记/大地图原型设计_20261108.md`。
 */
import { createGame, tick } from './rules.js';
import { createView } from './view.js';

let cleanup = null;

export function mount(host) {
  if (!host || host.api !== 1) {
    throw new Error('host 契约不匹配（需要 api=1）');
  }

  const game = { state: createGame() };
  const view = createView(host, game);
  let acc = 0;

  // 用注入的 GameLoop 驱动（不自己 setInterval，卸载时 loop.stop() 一起收干净）
  const loop = host.makeLoop({
    onFrame: (info) => {
      if (!view.isAuto() || game.state.finished) return;
      acc += info.delta;
      if (acc >= 1) {
        acc = 0;
        tick(game.state);
        view.render();
      }
    },
  });

  // 无头探针靠这两个判断模组是否挂上 / 读得到状态
  window.__modActive = 'grand-map';
  window.__grandMap = {
    get state() { return game.state; },
    step() { tick(game.state); view.render(); },
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
