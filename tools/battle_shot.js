/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：在真实战场环境里跑到"有几发弹丸在飞"的那一帧，
 * 然后冻结，拍一张 —— 验尾巴在建筑/阴影/地砖背景上是不是还看得见。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 2 out.png @tools/battle_shot.js
 */
(async () => {
  const waitFor = (fn) =>
    new Promise((res) => {
      const t = setInterval(() => {
        if (fn()) {
          clearInterval(t);
          res('ok');
        }
      }, 100);
    });
  const stage = await waitFor(() => window.arena);
  const app = window.arena;
  const w = app.world;

  // 关掉两边 AI，摆一座蓝箭塔 + 一座蓝炮塔，正对着红方兵营与一队红兵
  w.auto.blue = false;
  w.auto.red = false;
  w.buildings.clear();
  w.ruins.length = 0;
  w.units.length = 0;
  w.shots.length = 0;
  // 全部直接置为完工：这个脚本是给"看弹丸/命中特效"用的，不是看施工（施工另有 build_shot.js）
  const built = (side, kind, col, row, hp) => {
    const b = w['place'](side, kind, col, row, hp);
    b.build = 1;
    return b;
  };
  built('blue', 'house', 4, 7, 220);
  built('blue', 'arrowTower', 8, 7, 520);
  built('blue', 'cannonTower', 8, 13, 640);
  built('red', 'barracks', 18, 7, 420);
  built('red', 'house', 18, 13, 220);
  for (let i = 0; i < 3; i++) {
    w.units.push({
      id: 7100 + i,
      side: 'red',
      defId: 'knight',
      x: 16.5,
      z: 8 + i * 1.6,
      hp: 600,
      maxHp: 600,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1,
    });
  }

  app.rig.setYaw(0);
  app.rig.setPitch(34);
  app.rig.centerOnWorld(12, 10.5, true);
  app.rig.zoomBy(2.0);
  document.querySelector('.ahud').style.display = 'none';
  document.querySelector('.dbg')?.remove();

  // 跑到"至少 3 发弹丸在空中"的那一帧，立刻冻结（world.update 直接 return，t 不再往前走）
  let waited = 0;
  while (w.shots.length < 3 && waited < 4000) {
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }
  app.director.update = () => {};
  w.outcome = 'draw';

  await new Promise((r) => setTimeout(r, 300));
  return { stage, shots: w.shots.length, waited };
})();
