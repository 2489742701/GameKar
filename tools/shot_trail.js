/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：把三发弹丸冻结在半路，正对镜头拍一张，
 * 用来对比"尾巴"加之前 / 之后长什么样。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 2 out.png @tools/shot_trail.js
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
  w.outcome = 'draw'; // 停逻辑：弹丸的 t 就不会再往前走
  app.director.update = () => {};
  w.buildings.clear();
  w.ruins.length = 0;
  w.units.length = 0;

  // 三行弹道 × 三发不同进度：一行三发，看尾巴在"弹幕"里是不是还认得出
  const rows = [
    { z: 6.5, ammo: 'arrow', source: 'arrowTower' },
    { z: 10.5, ammo: 'cannon', source: 'cannonTower' },
    { z: 14.5, ammo: 'magic', source: 'arrowTower' },
  ];
  w.shots.length = 0;
  let id = 9001;
  for (const row of rows) {
    for (const t of [0.2, 0.45, 0.7]) {
      w.shots.push({
        id: id++,
        ammo: row.ammo,
        source: row.source,
        fromX: 6,
        fromZ: row.z,
        toX: 24,
        toZ: row.z,
        t,
        seconds: row.ammo === 'arrow' ? 0.22 : row.ammo === 'cannon' ? 0.45 : 0.4,
      });
    }
  }

  app.rig.setYaw(0);
  app.rig.setPitch(34);
  app.rig.centerOnWorld(14, 10.5, true);
  app.rig.zoomBy(2.3);
  document.querySelector('.ahud').style.display = 'none';
  document.querySelector('.dbg')?.remove();

  await new Promise((r) => setTimeout(r, 800));
  return { stage, shots: w.shots.length };
})();
