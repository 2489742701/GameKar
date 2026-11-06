/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：把两栋楼彻底拆掉，拍废墟 ——
 * 左边是被箭/刀拆的，右边是被炮弹拆的（碎块应该是四散而不是原地一堆）。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 3 out.png @tools/ruin_shot.js
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
  w.auto.blue = false;
  w.auto.red = false;
  w.buildings.clear();
  w.ruins.length = 0;
  w.units.length = 0;

  const a = w['place']('blue', 'arrowTower', 6, 11, 520);
  const b = w['place']('blue', 'cannonTower', 15, 11, 640);
  a.build = 1;
  b.build = 1;

  app.rig.setYaw(0);
  app.rig.setPitch(34);
  app.rig.centerOnWorld(11.5, 11.5, true);
  app.rig.zoomBy(2.0);
  document.querySelector('.ahud')?.remove();
  document.querySelector('.dbg')?.remove();

  await new Promise((r) => setTimeout(r, 500));
  w['hurtBuilding'](a, 99999, 'arrow');
  w['hurtBuilding'](b, 99999, 'cannon');
  w.outcome = 'draw';

  await new Promise((r) => setTimeout(r, 1600));
  return { stage, ruins: w.ruins.length, debris: app.damage?.debrisCount ?? null };
})();
