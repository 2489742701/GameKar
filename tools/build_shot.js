/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：把两栋楼按在施工中途，拍一张 ——
 * 看脚手架、半截墙、楼体从地里冒出来的样子。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 2 out.png @tools/build_shot.js
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
  w.outcome = 'draw';
  app.director.update = () => {};
  w.buildings.clear();
  w.ruins.length = 0;
  w.units.length = 0;

  // 左：施工中（0.35，脚手架加矮墙）；右：已经完工（1，脚手架应该收掉了）
  const a = w['place']('blue', 'barracks', 6, 6, 420);
  const b = w['place']('blue', 'arrowTower', 13, 14, 520);
  a.build = 0.35;
  b.build = 1;

  app.rig.setYaw(0);
  app.rig.setPitch(32);
  app.rig.centerOnWorld(11, 10.5, true);
  app.rig.zoomBy(1.9);
  document.querySelector('.ahud').style.display = 'none';
  document.querySelector('.dbg')?.remove();

  await new Promise((r) => setTimeout(r, 900));
  return { stage, builds: [a.build, b.build] };
})();
