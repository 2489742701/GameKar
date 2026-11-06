/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：同一时刻把两栋楼打到 45% ——
 * 左边挨的是**箭**，右边挨的是**炮弹**，拍落地之后的样子。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 3 out.png @tools/collapse_shot.js
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

  const arrow = w['place']('blue', 'arrowTower', 6, 11, 520);
  const shell = w['place']('blue', 'cannonTower', 14, 11, 640);
  arrow.build = 1;
  shell.build = 1;

  app.rig.setYaw(0);
  app.rig.setPitch(34);
  app.rig.centerOnWorld(11, 11.5, true);
  app.rig.zoomBy(2.1);
  document.querySelector('.ahud').style.display = 'none';
  document.querySelector('.dbg')?.remove();

  await new Promise((r) => setTimeout(r, 500));

  // 一次掉到 45%（跨 3 档），箭与炮弹各一栋
  w['hurtBuilding'](arrow, arrow.maxHp * 0.55, 'arrow');
  w['hurtBuilding'](shell, shell.maxHp * 0.55, 'cannon');

  // 等碎块落定（GRAVITY 16，从 3-5 格高掉下来约 0.8 秒）
  w.outcome = 'draw';
  await new Promise((r) => setTimeout(r, 1800));
  return { stage, debris: app.damage?.debrisCount ?? null, hp: [Math.round(arrow.hp), Math.round(shell.hp)] };
})();
