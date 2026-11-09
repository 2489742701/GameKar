/**
 * 大地图 3D 视图（2026-11-09，P-087）—— 卡牌驱动的主模式扩展。
 *
 * 地图：大六边形像素地形（map.js），内部六芒星道路 + 相邻近路小道 + 三条对径远路，
 *       中心 9×9 公共区与主干道，边角补成陆地。
 * 场景零件：Renderer / installArenaBackdrop / LightingRig / CameraRig / 后期链 /
 *          ARENA_MODELS 全部来自 host 注入，和 /arena.html 是同一套。
 * HUD：顶栏 + 底部四张手牌（host.modApi.createModHand，复用主程序卡面样式与图标）。
 * 右侧那列"发车/结盟/单步"策略按钮已删除 —— 外交点主城、商路设置点集市。
 */
import * as R from './rules.js';
import * as M from './map.js';
import { createHand, EXTRA_CARDS } from './hand.js';
import { createSky, PERIODS as SKY_PERIODS } from './sky.js';

const colorNum = (hex) => parseInt(hex.slice(1), 16);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const key = (col, row) => `${col},${row}`;

const CSS = `
.gm * { box-sizing: border-box; }
.gm { position:absolute; inset:0; pointer-events:none; color:#e8edf7;
      font:500 13px/1.55 system-ui,sans-serif; }
.gm-tint { position:absolute; inset:0; pointer-events:none; }
.gm-top { position:absolute; left:0; right:0; top:0; min-height:44px; display:flex;
          align-items:center; gap:12px; padding:6px 14px; pointer-events:auto; flex-wrap:wrap;
          background:rgba(10,16,28,.92); border-bottom:1px solid rgba(216,178,92,.35); }
.gm-top h2 { font-size:15px; font-weight:500; margin:0; color:#f3e0b0; white-space:nowrap; }
.gm-top .gold { font-size:19px; color:#fac775; }
.gm-top .muted { color:#9fb2cc; font-size:12px; }
.gm-top button, .gm-panel button { font:inherit; cursor:pointer; border-radius:7px; border:1px solid #3b4d68;
                 background:#1b2740; color:#e8edf7; padding:4px 9px; }
.gm-top button[data-on="1"], .gm-panel button[data-on="1"] { background:#8a6a2e; border-color:#d8b25c; }
.gm-panel { position:absolute; left:50%; top:56px; transform:translateX(-50%);
            width:min(320px,92vw); padding:10px 12px; border-radius:12px; pointer-events:auto;
            background:rgba(12,20,35,.95); border:1px solid rgba(216,178,92,.4); }
.gm-panel h3 { margin:0 0 6px; font-size:14px; font-weight:500; color:#f3e0b0; }
.gm-panel .muted { color:#9fb2cc; font-size:11px; }
.gm-panel button.danger { background:#5a2730; border-color:#a3474f; }
.gm-panel .close { float:right; background:transparent; }
.gm-panel .row { margin:6px 0; }
.gm-log { position:absolute; left:14px; top:64px; width:250px; max-height:132px;
          overflow:hidden; font-size:12px; color:#b8c7dd; pointer-events:none;
          text-shadow:0 1px 5px #000; }
.gm-tip { position:absolute; left:14px; bottom:104px; font-size:12px; color:#c9ae76;
          pointer-events:none; text-shadow:0 1px 5px #000; }
/* HUD 是 DOM，不吃 WebGL 后期：昼夜切换时必须同步卡面主题（只在模组内加规则，
   一行都不改主程序 arena.css）。否则会出现「战场入夜、卡面还亮着」的割裂感。 */
#arena-ui[data-period="dusk"] .ahud__hand[data-mod-hand] .ahud__card {
  background-color:#3a2a25; border-color:#6b4a34; color:#f4ddc4; }
#arena-ui[data-period="night"] .ahud__hand[data-mod-hand] .ahud__card {
  background-color:#1b2537; background-image:none; border-color:#3a4d68; color:#dce8fa;
  box-shadow:inset 0 1px 0 #2a3a55, 0 3px 0 rgba(0,0,0,.6); }
#arena-ui[data-period="night"] .ahud__hand[data-mod-hand] .ahud__card[data-selected="true"] {
  border-color:#c8a45a; }
`;

export function createView(host, game) {
  const T = host.three;
  const A = host.assets;
  const API = host.modApi;
  const ui = host.uiRoot;
  const modelOf = new Map([...API.CARDS, ...EXTRA_CARDS].map((c) => [c.id, c.building ?? null]));

  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'gm';
  root.innerHTML = `
    <div class="gm-tint"></div>
    <div class="gm-top"><h2>大地图 · 多方混战</h2><span class="gold" data-gold>50</span>
      <span class="muted" data-info></span><span style="flex:1"></span>
      <span class="gm-periods"></span><button data-action="exit">退出</button></div>
    <div class="gm-panel gm-dipl" hidden></div>
    <div class="gm-panel gm-market" hidden></div>
    <div class="gm-log"></div>
    <div class="gm-tip">点卡牌选中 → 点地图落牌 · 长按拖出去也行 · 点主城开外交 / 点集市设商路</div>`;
  ui.append(style, root);
  const tintEl = root.querySelector('.gm-tint');
  const goldEl = root.querySelector('[data-gold]');
  const infoEl = root.querySelector('[data-info]');
  const periodsEl = root.querySelector('.gm-periods');
  const diplEl = root.querySelector('.gm-dipl');
  const marketEl = root.querySelector('.gm-market');
  const logEl = root.querySelector('.gm-log');

  // ===== 主程序同款场景零件 =====
  const scene = new T.Scene();
  const renderer = new A.Renderer(host.canvas);
  A.installArenaBackdrop(scene, renderer.instance);
  const lighting = new A.LightingRig(scene, { shadowMapSize: 1024 });
  const rig = new A.CameraRig({
    pitchDeg: A.ARENA_CAMERA.pitchDeg,
    yawDeg: A.ARENA_CAMERA.yawDeg,
    tilesAcross: 62, minTilesAcross: 12, maxTilesAcross: 96,
  });
  // 先给相机真实视口，再算场内边界：否则 clampDesired 用的是 1×1 默认尺寸
  rig.resize(window.innerWidth, window.innerHeight);
  rig.setBounds({ field: { cols: M.MAP.cols, rows: M.MAP.rows } });
  const mid = A.cellToWorld(A.pos(M.MAP.cx, M.MAP.cy));
  rig.centerOnWorld(mid.x, mid.z, true);

  const composer = new A.EffectComposer(renderer.instance);
  composer.addPass(new A.RenderPass(scene, rig.camera));
  composer.addPass(new A.OutputPass());
  const tiltPass = new A.ShaderPass(A.TILT_SHIFT_SHADER);
  tiltPass.uniforms['amount'].value = 0.35;
  composer.addPass(tiltPass);

  const sky = createSky(T, scene, mid);

  // ===== 大六边形像素地形：一个 InstancedMesh 承载全部方块格 =====
  const terrain = M.terrainCells();
  const indexOf = new Map();
  terrain.forEach((c, i) => indexOf.set(key(c.col, c.row), i));
  const tileGeo = new T.BoxGeometry(0.94, 0.28, 0.94);
  const tileMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const tiles = new T.InstancedMesh(tileGeo, tileMat, terrain.length);
  const dummy = new T.Object3D();
  terrain.forEach((c, i) => {
    const w = A.cellToWorld(A.pos(c.col, c.row));
    dummy.position.set(w.x, 0.14, w.z);
    dummy.updateMatrix();
    tiles.setMatrixAt(i, dummy.matrix);
  });
  tiles.instanceMatrix.needsUpdate = true;
  scene.add(tiles);

  const GRASS = new T.Color(0x4a7a3a);
  const GRASS_LIT = new T.Color(0x6c9c4e);
  const CENTER = new T.Color(0x8a7440);
  const MAIN = new T.Color(0x5b4a32);
  const STAR = new T.Color(0xba7517);
  const SHORT = new T.Color(0xd8b45c);
  const FAR = new T.Color(0x9a5f2e);
  const BLOCKED = new T.Color(0x8a3540);
  const FACTION_COLORS = R.FACTIONS.map((f) => new T.Color(colorNum(f.color)));

  // ===== 六座主城：主游戏同款大本营模型，落在六芒星尖角 =====
  M.POINTS.forEach((p, i) => {
    const w = A.cellToWorld(A.pos(p.col, p.row));
    const base = new T.Mesh(
      new T.CircleGeometry(2.2, 24),
      new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[i].color), side: T.DoubleSide }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(w.x, 0.32, w.z);
    scene.add(base);
    try {
      const model = A.buildModel(A.ARENA_MODELS.core(colorNum(R.FACTIONS[i].color)).static);
      // 主程序的模型本体只有 1 格大，视图层一律按 BUILDING_SCALE 放大 —— 别再自作主张写 0.8
      model.scale.setScalar(A.BUILDING_SCALE);
      model.position.set(w.x, 0.34, w.z);
      scene.add(model);
    } catch (err) {
      console.warn('[grand-map] 主城模型装配失败：', err);
    }
  });

  const hand = createHand(API, game);
  const buildingMeshes = new Map();
  const caravanMeshes = new Map();
  let autoSky = false, skyAcc = 0, auto = false, acc = 0;
  let dragging = false, lastX = 0;
  let ghost = null;
  let diplId = 2;

  const groundCell = (clientX, clientY) => {
    const rect = host.canvas.getBoundingClientRect();
    const g = rig.screenToGround(clientX - rect.left, clientY - rect.top);
    if (!g) return null;
    return { col: Math.floor(g.x), row: Math.floor(g.z) };
  };

  const showGhost = (clientX, clientY) => {
    const cell = groundCell(clientX, clientY);
    if (!cell || !M.inHex(cell.col, cell.row)) { if (ghost) ghost.visible = false; return; }
    if (!ghost) {
      ghost = new T.Mesh(
        new T.PlaneGeometry(0.9, 0.9),
        new T.MeshBasicMaterial({ color: 0x8ee6a0, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false }),
      );
      ghost.rotation.x = -Math.PI / 2;
      scene.add(ghost);
    }
    const w = A.cellToWorld(A.pos(cell.col, cell.row));
    ghost.position.set(w.x, 0.34, w.z);
    ghost.visible = true;
  };
  const hideGhost = () => { if (ghost) ghost.visible = false; };

  const message = (text) => { R.note(game.state, text); render(); };

  // 卡牌 HUD：主程序同款手牌（开放 API 提供）
  const modHand = API.createModHand({
    onSelect: (slot) => { hand.select(slot); render(); },
    onDragMove: (_slot, x, y) => showGhost(x, y),
    onCancel: () => hideGhost(),
    onDrop: (slot, x, y) => playAt(slot, x, y),
  });
  ui.append(modHand.el);

  function playAt(slot, clientX, clientY) {
    hideGhost();
    const cell = groundCell(clientX, clientY);
    if (!cell) return;
    const res = hand.play(slot, cell.col, cell.row);
    if (!res.ok) message(res.reason);
    else { modHand.play(slot); render(); }
  }

  const onCanvasClick = (e) => {
    if (dragging) return;
    const cell = groundCell(e.clientX, e.clientY);
    if (!cell) return;
    const k = key(cell.col, cell.row);
    // 点自己的集市 = 开商路设置
    if (hand.claims.get(k)?.owner === 0 && hand.claims.get(k)?.card === 'market') { openMarket(); return; }
    // 点主城附近 = 开外交
    const near = M.POINTS.findIndex((p, i) => i > 0 && Math.abs(p.col - cell.col) <= 3 && Math.abs(p.row - cell.row) <= 3);
    if (near > 0) { openDiplomacy(near); return; }
    if (hand.selected < 0) return;
    const res = hand.play(hand.selected, cell.col, cell.row);
    if (!res.ok) message(res.reason);
    else { modHand.play(hand.selected); render(); }
  };
  const onDown = (e) => { dragging = false; lastX = e.clientX; };
  const onMove = (e) => {
    if (e.buttons !== 1) return;
    if (Math.abs(e.clientX - lastX) > 3) dragging = true;
    rig.rotateBy(-(e.clientX - lastX) * 0.12);
    lastX = e.clientX;
  };
  host.canvas.addEventListener('click', onCanvasClick);
  host.canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);

  function openDiplomacy(id) {
    diplId = id;
    marketEl.hidden = true;
    diplEl.hidden = false;
    const s = game.state;
    const rel = R.relationOf(s, 0, id);
    diplEl.innerHTML = `
      <button class="close" data-action="close">×</button>
      <h3>${esc(R.FACTIONS[id].name)} · ${esc(R.REL_LABEL[rel])}</h3>
      <div class="muted">联盟最多 2 人 · 背刺 / 扣押 = 死仇，永不复盟</div>
      <div class="row"><button data-action="rel" data-rel="allied">结盟</button>
        <button data-action="rel" data-rel="neutral">中立</button>
        <button data-action="rel" data-rel="hostile">宣战</button>
        ${rel === R.REL.ALLIED ? '<button class="danger" data-action="backstab">背刺</button>' : ''}</div>
      <div class="muted">商路设置与来车处理在点开的集市里做</div>`;
  }

  function openMarket() {
    marketEl.hidden = false;
    diplEl.hidden = true;
    renderMarket();
  }

  function renderMarket() {
    if (marketEl.hidden) return;
    const s = game.state;
    const target = game.tradeTarget ?? 2;
    const kind = game.tradeKind ?? 'near';
    const targets = R.FACTIONS.slice(1).map((f) => {
      const rel = R.relationOf(s, 0, f.id);
      return `<button data-action="target" data-id="${f.id}" data-on="${target === f.id ? 1 : 0}">${esc(f.name)}·${esc(R.REL_LABEL[rel])}</button>`;
    }).join('');
    const pending = s.pending.length
      ? s.pending.map((p) => `<div class="row muted">${esc(R.FACTIONS[p.owner].name)} 来车 ${p.cargo} 金
          <button data-action="incoming" data-id="${p.id}" data-choice="trade">正常贸易</button>
          <button class="danger" data-action="incoming" data-id="${p.id}" data-choice="seize">扣押</button></div>`).join('')
      : '<div class="muted">当前没有待处理的来车</div>';
    marketEl.innerHTML = `
      <button class="close" data-action="close">×</button>
      <h3>集市 · 商路设置</h3>
      <div class="row muted">目的地</div><div class="row">${targets}</div>
      <div class="row muted">路线（近安全钱少 / 远钱多，要护航）</div>
      <div class="row"><button data-action="kind" data-kind="near" data-on="${kind === 'near' ? 1 : 0}">近路</button>
        <button data-action="kind" data-kind="far" data-on="${kind === 'far' ? 1 : 0}">远路</button></div>
      <div class="row muted">设置好后，把「商队 / 护航」卡落在商路上发车</div>
      <div class="row muted">来车处理（扣押 ⇒ 立即死仇）</div>${pending}`;
  }

  const onClick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset['action'];
    if (a === 'exit') { host.exit(); return; }
    if (a === 'close') { diplEl.hidden = true; marketEl.hidden = true; return; }
    if (a === 'period') { sky.setPeriod(Number(b.dataset['i'])); autoSky = false; render(); return; }
    if (a === 'autosky') { autoSky = !autoSky; skyAcc = 0; render(); return; }
    if (a === 'auto') { auto = !auto; render(); return; }
    if (a === 'reset') {
      game.state = R.createGame(Date.now() & 0xffff);
      hand.reset(); diplId = 2;
      diplEl.hidden = true; marketEl.hidden = true;
      render(); return;
    }
    if (a === 'target') { hand.setTrade(Number(b.dataset['id']), game.tradeKind); render(); return; }
    if (a === 'kind') { hand.setTrade(game.tradeTarget ?? 2, b.dataset['kind']); render(); return; }
    if (a === 'incoming') {
      const res = R.resolveIncoming(game.state, Number(b.dataset['id']), b.dataset['choice']);
      if (!res.ok) message(`处理失败（${res.reason}）`);
      else render();
      return;
    }
    const s = game.state;
    if (a === 'rel') {
      const res = R.setRelation(s, 0, diplId, b.dataset['rel']);
      if (!res.ok) message(res.reason === 'ally-limit' ? '联盟最多 2 人' : '死仇永不复盟');
      openDiplomacy(diplId); render(); return;
    }
    if (a === 'backstab') {
      const res = R.backstab(s, 0, diplId);
      if (!res.ok) message('当前不是结盟关系');
      openDiplomacy(diplId); render(); return;
    }
  };
  root.addEventListener('click', onClick);

  function syncBuildings() {
    const want = new Set();
    for (const [k, v] of hand.claims) {
      if (!v.card) continue;
      want.add(k);
      if (buildingMeshes.has(k)) continue;
      const [col, row] = k.split(',').map(Number);
      const w = A.cellToWorld(A.pos(col, row));
      try {
        const name = modelOf.get(v.card);
        if (name && A.ARENA_MODELS[name]) {
          const m = A.buildModel(A.ARENA_MODELS[name](colorNum(R.FACTIONS[0].color)).static);
          // 一格占领点比主程序 3×3 占地小，按主程序缩放打个折，避免盖住邻格
          m.scale.setScalar(A.BUILDING_SCALE * 0.62);
          m.position.set(w.x, 0.3, w.z);
          scene.add(m);
          buildingMeshes.set(k, m);
        } else {
          // 军队卡：占位小方块（DudeSprite / DudeGallery 小人素材仍待接入）
          const m = new T.Mesh(
            new T.BoxGeometry(0.55, 0.55, 0.55),
            new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[0].color) }),
          );
          m.position.set(w.x, 0.58, w.z);
          scene.add(m);
          buildingMeshes.set(k, m);
        }
      } catch { /* 模型装配失败就只靠地块颜色表达 */ }
    }
    for (const [k, m] of buildingMeshes) {
      if (!want.has(k)) { scene.remove(m); buildingMeshes.delete(k); }
    }
  }

  function syncCaravans(time) {
    const s = game.state;
    const alive = new Set(s.caravans.map((c) => c.id));
    for (const [id, m] of caravanMeshes) {
      if (!alive.has(id)) { scene.remove(m); caravanMeshes.delete(id); }
    }
    for (const car of s.caravans) {
      if (!caravanMeshes.has(car.id)) {
        const m = new T.Mesh(
          new T.BoxGeometry(1.1, 0.7, 0.8),
          new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[car.owner].color) }),
        );
        scene.add(m);
        caravanMeshes.set(car.id, m);
      }
      const m = caravanMeshes.get(car.id);
      const a = M.POINTS[car.from], b = M.POINTS[car.to];
      const wa = A.cellToWorld(A.pos(a.col, a.row)), wb = A.cellToWorld(A.pos(b.col, b.row));
      const total = car.kind === 'far' ? R.SPEC.trade.travel.far : R.SPEC.trade.travel.near;
      const t = 0.12 + 0.76 * Math.max(0, Math.min(1, 1 - car.ticksLeft / total));
      m.position.set(wa.x + (wb.x - wa.x) * t, 0.6 + Math.sin(time * 4 + car.id) * 0.05, wa.z + (wb.z - wa.z) * t);
    }
  }

  function paintTiles() {
    const s = game.state;
    const unlocked = hand.unlocked();
    const blocked = new Set(R.blockedSegments(s, 0));
    terrain.forEach((c, i) => {
      const k = key(c.col, c.row);
      const kind = M.roadKindAt(c.col, c.row);
      let col = GRASS;
      if (kind === 'center') col = CENTER;
      else if (kind === 'main') col = MAIN;
      else if (kind === 'star') col = STAR;
      else if (kind === 'short') col = SHORT;
      else if (kind === 'far') col = FAR;
      const claim = hand.claims.get(k);
      if (claim) col = FACTION_COLORS[claim.owner];
      else if (unlocked.has(k)) col = GRASS_LIT;
      if (kind === 'main' && blocked.has(c.col - M.CENTER.col0)) col = BLOCKED;
      tiles.setColorAt(i, col);
    });
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
  }

  function render() {
    const s = game.state;
    goldEl.textContent = s.factions[0].gold;
    infoEl.textContent = `/ ${R.SPEC.gold.cap} 金 · 回合 ${s.tick}/${R.SPEC.endTick} · 来车 ${s.pending.length}`;
    const period = SKY_PERIODS[sky.periodIndex];
    tintEl.style.background = period.tint;
    ui.dataset['period'] = period.key;
    periodsEl.innerHTML = SKY_PERIODS.map((p, i) =>
      `<button data-action="period" data-i="${i}" data-on="${sky.periodIndex === i ? 1 : 0}">${p.label}</button>`).join('') +
      `<button data-action="autosky" data-on="${autoSky ? 1 : 0}">巡游</button>` +
      `<button data-action="auto" data-on="${auto ? 1 : 0}">${auto ? '暂停' : '推进'}</button>` +
      `<button data-action="reset">重置</button>`;
    modHand.render(hand.cards, s.factions[0].gold, hand.selected);
    logEl.innerHTML = s.log.slice(0, 6).map((l) => `<div>[${l.tick}] ${esc(l.text)}</div>`).join('');
    paintTiles();
    syncBuildings();
    renderMarket();
  }

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(w, h, dpr);
    rig.resize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
  };
  resize();
  window.addEventListener('resize', resize);
  render();

  return {
    render,
    openMarket,
    openDiplomacy,
    setPeriod: (i) => { sky.setPeriod(i); render(); },
    get periodIndex() { return sky.periodIndex; },
    get hand() { return hand; },
    /** 无头探针走格子坐标，和拖放共用同一条 hand.play 判据 */
    playCard(slot, col, row) {
      const res = hand.play(slot, col, row);
      if (!res.ok) message(res.reason);
      else { modHand.play(slot); render(); }
      return res;
    },
    frame(info) {
      hand.tick(info.delta);
      if (auto && !game.state.finished) {
        acc += info.delta;
        if (acc >= 1) { acc = 0; R.tick(game.state); render(); }
      }
      if (autoSky) {
        skyAcc += info.delta;
        if (skyAcc >= 6) { skyAcc = 0; sky.setPeriod(sky.periodIndex + 1); render(); }
      }
      rig.update(info.delta);
      lighting.update(info.time);
      sky.update(info.time);
      syncCaravans(info.time);
      composer.render(info.delta);
    },
    dispose() {
      root.removeEventListener('click', onClick);
      host.canvas.removeEventListener('click', onCanvasClick);
      host.canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', resize);
      modHand.dispose();
      delete ui.dataset['period'];
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      lighting.dispose(scene);
      renderer.dispose();
      root.remove();
      style.remove();
    },
  };
}
