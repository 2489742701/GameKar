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
  w.outcome = 'draw'; // 停逻辑
  app.director.update = () => {}; // 停自动取景
  w.buildings.clear(); // 清场，只留草地格子当标尺
  w.ruins.length = 0;
  w.units.length = 0;

  const names = {
    knight: '骑士',
    archer: '弓箭手',
    mage: '法师',
    orc: '兽人',
    priest: '牧师',
    golem: '石怪',
    mech: '机器巨人',
    mobileCannon: '移动火炮',
    ballista: '移动弩箭',
  };
  // 两排 × 5 格：单排放 9 个时每格只有 50px，看脸都糊；两排能把每格放到 80px
  // 后排的攻城车更宽（1.55 + 推车人），间距单独放大，免得车和车叠在一起
  const rows = [
    { z: 12.6, gap: 2.4, ids: ['knight', 'archer', 'mage', 'orc', 'priest'] },
    { z: 7.4, gap: 3.1, ids: ['golem', 'mech', 'mobileCannon', 'ballista'] },
  ];
  const startX = 4;
  rows.forEach((row) => {
    row.ids.forEach((id, i) => {
      w.units.push({
        id: 6000 + w.units.length,
        side: 'blue',
        defId: id,
        x: startX + i * row.gap,
        z: row.z,
        hp: 999,
        maxHp: 999,
        cooldown: 0,
        stun: 0,
        order: null,
        detour: 1,
      });
    });
  });

  app.rig.setYaw(0);
  app.rig.setPitch(38);
  app.rig.centerOnWorld(startX + 2 * 2.4, 10, true);
  app.rig.zoomBy(2.25);
  document.querySelector('.ahud').style.display = 'none';
  document.querySelector('.dbg')?.remove();

  await new Promise((r) => setTimeout(r, 900));

  const cam = app.rig.camera;
  const V3 = cam.position.constructor;
  const measured = [];
  for (const [id, e] of app.unitSprites) {
    const u = w.units.find((x) => x.id === id);
    if (!u) continue;
    let lo = Infinity;
    let hi = -Infinity;
    /** 不含推车小人时的顶（小人也是 PlaneGeometry，单独排除）—— 车/炮本体到底多高看这一列 */
    let bodyTop = -Infinity;
    e.obj.updateMatrixWorld(true);
    e.obj.traverse((o) => {
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      // 用 8 个角点过世界矩阵：这样旋转过的炮管不会被当成"竖直件"算高
      let t = -Infinity;
      let b = Infinity;
      for (const x of [bb.min.x, bb.max.x]) {
        for (const y of [bb.min.y, bb.max.y]) {
          for (const z of [bb.min.z, bb.max.z]) {
            const wy = new V3(x, y, z).applyMatrix4(o.matrixWorld).y;
            t = Math.max(t, wy);
            b = Math.min(b, wy);
          }
        }
      }
      lo = Math.min(lo, b);
      hi = Math.max(hi, t);
      if (g.type !== 'PlaneGeometry') bodyTop = Math.max(bodyTop, t);
    });
    measured.push({ defId: u.defId, x: u.x, z: u.z, h: hi - lo, top: hi, bodyTop });
  }

  // 标签跟着相机走：建一次，之后每帧重投影（相机还有阻尼，不跟就会错位）
  const tags = measured.map((m) => {
    const el = document.createElement('div');
    el.textContent = `${names[m.defId] ?? m.defId} · ${m.h.toFixed(2)} 格`;
    el.style.cssText = [
      'position:fixed',
      'left:0px',
      'top:0px',
      'transform:translate(-50%,-100%)',
      'padding:2px 6px',
      'border-radius:4px',
      'background:rgba(12,10,8,0.85)',
      'border:1px solid #c8a24c',
      'color:#f0d08a',
      'font:12px/1.4 sans-serif',
      'white-space:nowrap',
      'z-index:9999',
      'pointer-events:none',
    ].join(';');
    document.body.append(el);
    return { m, el };
  });
  const place = () => {
    for (const { m, el } of tags) {
      const v = new V3(m.x, m.top + 0.22, m.z).project(cam);
      el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    }
    requestAnimationFrame(place);
  };
  requestAnimationFrame(place);

  return {
    stage,
    measured: measured
      .map((m) => ({
        id: m.defId,
        h: +m.h.toFixed(2),
        // 车/炮本体（不含推车人）的顶：手艺器械是不是比人还矮，看这一列
        bodyTop: Number.isFinite(m.bodyTop) ? +m.bodyTop.toFixed(2) : null,
        groundY: 0.5,
      }))
      .sort((a, b) => b.h - a.h),
  };
})();
