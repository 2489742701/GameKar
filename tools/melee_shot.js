/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：让六个兵在中间互相砍，抓到"火星刚溅出来"的那一帧。
 *
 * 做法：world 冻结（outcome='draw'）之后粒子还会自己 age 掉，所以抓到命中事件时
 * 顺手把 `fx.step` 换成空函数 —— 画面停在"刚砍中"的瞬间，才看得出粒子放射。
 *
 * 用法：node tools/arena_shot.mjs "<url>" 1 out.png @tools/melee_shot.js
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

  const dude = (id, side, defId, x, z) => ({
    id, side, defId, x, z, hp: 9999, maxHp: 9999, cooldown: 0, stun: 0, order: null, detour: 1,
  });
  // 三对贴身互砍：骑士、兽人（重击）、机器巨人（重击 + 大块头）
  w.units.push(
    dude(7001, 'blue', 'knight', 10, 9),
    dude(7002, 'red', 'knight', 11.1, 9),
    dude(7003, 'blue', 'orc', 10, 12),
    dude(7004, 'red', 'orc', 11.1, 12),
    dude(7005, 'blue', 'mech', 10, 15.4),
    dude(7006, 'red', 'mech', 11.35, 15.4),
  );

  app.rig.setYaw(0);
  app.rig.setPitch(36);
  app.rig.centerOnWorld(11, 12, true);
  app.rig.zoomBy(2.3);
  document.querySelector('.ahud')?.remove();

  // 跑到"有命中事件、火星已经冒出来"的那一帧；再等 0.16 秒让它们飞散开再冻住
  // （立刻冻的话 12 颗全叠在生成点上，截图里就是一块黄斑，看不出"放射"）
  let waited = 0;
  while (waited < 6000) {
    await new Promise((r) => setTimeout(r, 30));
    waited += 30;
    if (w.hits.length > 0 && (app.fx.sparks?.length ?? 0) >= 6) break;
  }
  await new Promise((r) => setTimeout(r, 220));
  const sparks = app.fx.sparks?.length ?? 0;
  app.fx.step = () => {}; // 冻住粒子
  w.outcome = 'draw';
  app.director.update = () => {};
  return { stage, waited, sparks, hits: w.hits.length };
})();
