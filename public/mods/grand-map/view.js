/**
 * 大地图 3D 视图层（2026-11-09）—— 换掉之前的 SVG 棋盘，改用主游戏那套 3D 表现。
 *
 * 楼是 host.assets 注入的 `ARENA_MODELS` + `buildModel` 生成的，
 * 和 /arena.html 1v1 里的建筑**同一套模型**；正交俯视机位、深色战场、
 * 金色读数也对齐主游戏。规则仍在 rules.js，这层只把状态画成 3D。
 * 天空 / 云 / 四时段在 sky.js，作为同一场景的天光层并入，不是独立页面。
 */
import * as R from './rules.js';
import { createSky, PERIODS as SKY_PERIODS } from './sky.js';

const RAD = 22;               // 六芒星半径（格）
const CELL = 1.55;            // 中心格边长
const G0 = -((R.SPEC.centerSize * CELL) / 2);
const colorNum = (hex) => parseInt(hex.slice(1), 16);

const vertex = (i) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return [Math.cos(a) * RAD, Math.sin(a) * RAD];
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
.gm * { box-sizing: border-box; }
.gm { position:absolute; inset:0; pointer-events:none; color:#e8edf7;
      font:500 13px/1.55 system-ui,sans-serif; }
.gm-tint { position:absolute; inset:0; pointer-events:none; }
.gm-top { position:absolute; left:0; right:0; top:0; height:44px; display:flex;
          align-items:center; gap:18px; padding:0 16px; pointer-events:auto;
          background:rgba(10,16,28,.92); border-bottom:1px solid rgba(216,178,92,.35); }
.gm-top h2 { font-size:15px; font-weight:500; margin:0; color:#f3e0b0; }
.gm-top .gold { font-size:19px; color:#fac775; }
.gm-top .muted { color:#9fb2cc; font-size:12px; }
.gm-side { position:absolute; right:0; top:44px; bottom:0; width:344px; overflow-y:auto;
           pointer-events:auto; padding:12px 14px 22px; background:rgba(12,20,35,.93);
           border-left:1px solid rgba(216,178,92,.28); }
.gm h3 { font-size:13px; font-weight:500; margin:14px 0 6px; color:#c9ae76;
         border-bottom:1px solid #2b3a54; padding-bottom:4px; }
.gm button { font:inherit; cursor:pointer; border-radius:7px; border:1px solid #3b4d68;
             background:#1b2740; color:#e8edf7; padding:5px 10px; margin:2px 3px 2px 0; }
.gm button[data-on="1"] { background:#8a6a2e; border-color:#d8b25c; }
.gm button.danger { background:#5a2730; border-color:#a3474f; }
.gm button.ghost { background:transparent; }
.gm .row { display:flex; align-items:center; gap:6px; margin:4px 0; flex-wrap:wrap; }
.gm .muted { color:#8fa2bd; font-size:12px; }
.gm .hint { font-size:12px; color:#8fa2bd; margin:4px 0 8px; }
.gm select { background:#1b2740; color:#e8edf7; border:1px solid #3b4d68;
             border-radius:7px; padding:5px 8px; font:inherit; }
.gm .card { border:1px solid #2b3a54; border-radius:8px; padding:7px 9px; margin:5px 0; }
.gm .log { max-height:150px; overflow-y:auto; font-size:12px; color:#b8c7dd; }
.gm .log div { padding:2px 0; border-bottom:1px solid #1c2a40; }
.gm-tip { position:absolute; left:16px; bottom:14px; font-size:12px; color:#c9ae76;
          pointer-events:none; text-shadow:0 1px 5px #000; }
@media (max-width:760px) {
  .gm-side { width:100%; top:auto; height:46vh; border-left:0; border-top:1px solid #2b3a54; }
}
`;

export function createView(host, game) {
  const T = host.three;
  const A = host.assets;
  const ui = host.uiRoot;

  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'gm';
  root.innerHTML = `
    <div class="gm-tint"></div>
    <div class="gm-top"><h2>大地图 · 多方混战</h2><span class="gold" data-gold>50</span>
      <span class="muted" data-info></span></div>
    <div class="gm-side"></div>
    <div class="gm-tip">点中心亮格放楼 · 点主城选外交 · 拖动可转视角</div>`;
  ui.append(style, root);
  const tintEl = root.querySelector('.gm-tint');
  const side = root.querySelector('.gm-side');
  const goldEl = root.querySelector('[data-gold]');
  const infoEl = root.querySelector('[data-info]');

  const renderer = new T.WebGLRenderer({ canvas: host.canvas, antialias: true });
  renderer.setClearColor(0x0b1220, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-32, 32, 20, -20, 0.1, 1000);
  let yaw = 0;
  const applyCamera = () => {
    camera.position.set(Math.sin(yaw) * 34, 46, Math.cos(yaw) * 34);
    camera.lookAt(0, 0, 0);
  };
  applyCamera();
  const sky = createSky(T, scene);

  // 圆形战场：六芒星顶点半径 22 都在圆内，四角露出天空球渐变（天空盒才真的可见）
  const ground = new T.Mesh(
    new T.CircleGeometry(27, 48),
    new T.MeshBasicMaterial({ color: 0x14231c }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  scene.add(ground);

  // 中心区格子（可点）
  const cellMeshes = [];
  for (let r = 0; r < R.SPEC.centerSize; r++) {
    for (let c = 0; c < R.SPEC.centerSize; c++) {
      const m = new T.Mesh(
        new T.PlaneGeometry(CELL - 0.08, CELL - 0.08),
        new T.MeshBasicMaterial({ color: 0x111d30, side: T.DoubleSide }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(G0 + c * CELL + CELL / 2, 0.02, G0 + r * CELL + CELL / 2);
      m.userData.r = r;
      m.userData.c = c;
      scene.add(m);
      cellMeshes.push(m);
    }
  }

  // 六个主城：势力色底座 + 主游戏同款大本营模型
  for (const f of R.FACTIONS) {
    const [x, z] = vertex(f.id);
    const base = new T.Mesh(
      new T.CircleGeometry(2.6, 24),
      new T.MeshBasicMaterial({ color: colorNum(f.color), side: T.DoubleSide }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(x, 0.04, z);
    scene.add(base);
    try {
      const model = A.buildModel(A.ARENA_MODELS.core(colorNum(f.color)).static);
      model.scale.setScalar(0.75);
      model.position.set(x, 0.1, z);
      scene.add(model);
    } catch (err) {
      console.warn('[grand-map] 主城模型装配失败，用底座兜底：', err);
    }
  }

  // 固定商路：6 条相邻边 + 3 条对径弦
  const roadPts = [];
  for (const road of R.ROADS) {
    const [x1, z1] = vertex(road.a);
    const [x2, z2] = vertex(road.b);
    roadPts.push(new T.Vector3(x1, 0.06, z1), new T.Vector3(x2, 0.06, z2));
  }
  scene.add(new T.LineSegments(
    new T.BufferGeometry().setFromPoints(roadPts),
    new T.LineBasicMaterial({ color: 0xba7517 }),
  ));

  const buildingMeshes = new Map();
  const caravanMeshes = new Map();
  const raycaster = new T.Raycaster();
  const ndc = new T.Vector2();
  let selected = 1, target = 2, kind = 'near', escorted = false;
  let auto = false, autoSky = false, skyAcc = 0, acc = 0;
  let dragging = false, lastX = 0;

  const onCanvasClick = (e) => {
    if (dragging) return;
    const rect = host.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(cellMeshes)[0];
    if (!hit) return;
    const { r, c } = hit.object.userData;
    const res = R.placeBuilding(game.state, 0, r, c);
    if (!res.ok) R.note(game.state, `放楼失败：${res.reason}`);
    render();
  };
  const onDown = (e) => { dragging = false; lastX = e.clientX; };
  const onMove = (e) => {
    if (e.buttons !== 1) return;
    if (Math.abs(e.clientX - lastX) > 3) dragging = true;
    yaw -= (e.clientX - lastX) * 0.004;
    lastX = e.clientX;
    applyCamera();
  };
  host.canvas.addEventListener('click', onCanvasClick);
  host.canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);

  const onClick = (e) => {
    const node = e.target.closest('[data-action]');
    if (!node) return;
    const s = game.state;
    const a = node.dataset['action'];
    const id = Number(node.dataset['id'] ?? 0);
    if (a === 'select') { selected = id; render(); return; }
    if (a === 'rel') { R.setRelation(s, 0, selected, node.dataset['rel']); render(); return; }
    if (a === 'backstab') { R.backstab(s, 0, selected); render(); return; }
    if (a === 'send') { R.sendCaravan(s, 0, target, kind, escorted); render(); return; }
    if (a === 'resolve') { R.resolveIncoming(s, id, node.dataset['choice']); render(); return; }
    if (a === 'step') { R.tick(s); render(); return; }
    if (a === 'auto') { auto = !auto; render(); return; }
    if (a === 'period') { sky.setPeriod(Number(node.dataset['i'])); autoSky = false; render(); return; }
    if (a === 'autosky') { autoSky = !autoSky; skyAcc = 0; render(); return; }
    if (a === 'reset') { game.state = R.createGame(Date.now() & 0xffff); auto = false; render(); return; }
    if (a === 'exit') { host.exit(); return; }
  };
  root.addEventListener('click', onClick);
  const onChange = (e) => {
    const n = e.target;
    if (n.id === 'gm-target') target = Number(n.value);
    if (n.id === 'gm-escort') escorted = n.checked;
    if (n.name === 'gm-kind') kind = n.value;
    if (n.matches('[data-city]')) selected = Number(n.value);
    render();
  };
  side.addEventListener('change', onChange);

  function syncMeshes() {
    const s = game.state;
    for (let r = 0; r < R.SPEC.centerSize; r++) {
      for (let c = 0; c < R.SPEC.centerSize; c++) {
        const key = `${r},${c}`;
        const has = s.cells[r][c].building;
        if (has && !buildingMeshes.has(key)) {
          const owner = s.cells[r][c].owner ?? 0;
          try {
            const m = A.buildModel(A.ARENA_MODELS.house(colorNum(R.FACTIONS[owner].color)).static);
            m.scale.setScalar(0.42);
            m.position.set(G0 + c * CELL + CELL / 2, 0.05, G0 + r * CELL + CELL / 2);
            scene.add(m);
            buildingMeshes.set(key, m);
          } catch { /* 装配失败就只靠格子颜色表达 */ }
        }
        if (!has && buildingMeshes.has(key)) {
          scene.remove(buildingMeshes.get(key));
          buildingMeshes.delete(key);
        }
      }
    }
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
    }
  }

  function updateCaravans(time) {
    for (const car of game.state.caravans) {
      const m = caravanMeshes.get(car.id);
      if (!m) continue;
      const [x1, z1] = vertex(car.from);
      const [x2, z2] = vertex(car.to);
      const total = car.kind === 'far' ? R.SPEC.trade.travel.far : R.SPEC.trade.travel.near;
      const t = 0.12 + 0.76 * Math.max(0, Math.min(1, 1 - car.ticksLeft / total));
      m.position.set(x1 + (x2 - x1) * t, 0.5 + Math.sin(time * 4 + car.id) * 0.06, z1 + (z2 - z1) * t);
      m.rotation.y = Math.atan2(x2 - x1, z2 - z1);
    }
  }

  function render() {
    const s = game.state;
    const blocked = new Set(R.blockedSegments(s, 0));
    const unlocked = new Set(R.unlockedCells(s, 0).map(([r, c]) => `${r},${c}`));
    for (const m of cellMeshes) {
      const { r, c } = m.userData;
      const cell = s.cells[r][c];
      let col = 0x111d30;
      if (r === R.SPEC.roadRow) col = blocked.has(c) ? 0x8a3540 : 0x6b5527;
      else if (cell.building) col = colorNum(R.FACTIONS[cell.owner ?? 0].color);
      else if (cell.owner === 0) col = 0x1b3350;
      else if (cell.owner !== null) col = 0x241c2c;
      else if (unlocked.has(`${r},${c}`)) col = 0x2b4f78;
      m.material.color.setHex(col);
    }
    syncMeshes();

    const f = R.FACTIONS[selected];
    const rel = f.isPlayer ? '自己' : R.REL_LABEL[R.relationOf(s, 0, selected)];
    const targets = R.FACTIONS.filter((x) => x.id !== 0 && R.canTrade(s, 0, x.id).ok);
    if (!targets.some((x) => x.id === target)) target = targets[0]?.id ?? 0;
    const cells = s.cells.flat().filter((c) => c.owner === 0).length;
    const canStab = !f.isPlayer && R.relationOf(s, 0, selected) === R.REL.ALLIED;
    const incoming = s.pending.length
      ? s.pending.map((p) => `<div class="card">${esc(R.FACTIONS[p.owner].name)} 的车 · ${p.cargo} 金<br>
          <button data-action="resolve" data-id="${p.id}" data-choice="trade">正常贸易</button>
          <button class="danger" data-action="resolve" data-id="${p.id}" data-choice="seize">扣押（+${p.cargo * R.SPEC.seizeMultiplier} · 死仇）</button></div>`).join('')
      : '<div class="hint">暂无来车。</div>';
    const log = s.log.slice(0, 8).map((l) => `<div>[${l.tick}] ${esc(l.text)}</div>`).join('');
    const periodBtns = SKY_PERIODS.map((p, i) =>
      `<button data-action="period" data-i="${i}" data-on="${sky.periodIndex === i ? 1 : 0}">${p.label}</button>`).join('');
    const relBtns = ['allied:结盟', 'neutral:中立', 'hostile:宣战'].map((x) => {
      const [r, label] = x.split(':');
      return `<button data-action="rel" data-rel="${r}">${label}</button>`;
    }).join('');

    goldEl.textContent = s.factions[0].gold;
    tintEl.style.background = SKY_PERIODS[sky.periodIndex].tint;
    infoEl.textContent = `/ ${R.SPEC.gold.cap} 金 · 回合 ${s.tick}/${R.SPEC.endTick} · 中心格 ${cells} · 封死路段 ${blocked.size}`;
    side.innerHTML = `
      <h3>天光 · 四时段</h3>
      <div class="row">${periodBtns}</div>
      <div class="row"><button data-action="autosky" data-on="${autoSky ? 1 : 0}">昼夜巡游</button></div>
      <div class="hint">云朵是水平面片小模型，飘过战场上空；四时段改天光与云色。</div>
      <h3>外交 · ${esc(f.name)}（${esc(rel)}）</h3>
      <div class="hint">点场上主城模型切换目标；联盟上限 ${R.SPEC.allyLimit}，背刺/扣押 = 死仇。</div>
      <div class="row"><select data-city>
        ${R.FACTIONS.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></div>
      <div class="row">${f.isPlayer ? '<span class="muted">自己</span>' : relBtns}</div>
      ${canStab ? '<div class="row"><button class="danger" data-action="backstab">背刺（⇒ 死仇）</button></div>' : ''}
      <h3>集市 · 发车</h3>
      <div class="row"><span class="muted">目的地</span>
        <select id="gm-target">${targets.map((x) => `<option value="${x.id}" ${x.id === target ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="row">
        <label><input type="radio" name="gm-kind" value="near" ${kind === 'near' ? 'checked' : ''}> 近 ${R.SPEC.trade.near} 金</label>
        <label><input type="radio" name="gm-kind" value="far" ${kind === 'far' ? 'checked' : ''}> 远 ${R.SPEC.trade.far} 金</label></div>
      <div class="row"><label><input type="checkbox" id="gm-escort" ${escorted ? 'checked' : ''}> 派兵护航（+${R.SPEC.cost.escort}）</label></div>
      <div class="row"><button data-action="send" ${targets.length ? '' : 'disabled'}>发车</button></div>
      <h3>待处理来车</h3>${incoming}
      <h3>控制</h3>
      <div class="row"><button data-action="step">单步</button>
        <button data-action="auto" data-on="${auto ? 1 : 0}">${auto ? '暂停' : '自动推进'}</button>
        <button class="ghost" data-action="reset">重置</button>
        <button class="ghost" data-action="exit">退出</button></div>
      <div class="hint">钱是存量：满金时收益被上限吃掉，先放楼/发车腾空间。</div>
      <h3>事件</h3><div class="log">${log}</div>`;
  }

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    // 水平中心右移 6 格：右侧有 344px 面板，把战场整体往左推，六个主城才都在可视区
    camera.left = -26;
    camera.right = 38;
    camera.top = 32 * (h / Math.max(1, w));
    camera.bottom = -32 * (h / Math.max(1, w));
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  render();

  return {
    render,
    isAuto: () => auto,
    frame(info) {
      if (auto && !game.state.finished) {
        acc += info.delta;
        if (acc >= 1) { acc = 0; R.tick(game.state); render(); }
      }
      if (autoSky) {
        skyAcc += info.delta;
        if (skyAcc >= 6) { skyAcc = 0; sky.setPeriod(sky.periodIndex + 1); render(); }
      }
      sky.update(info.time);
      updateCaravans(info.time);
      renderer.render(scene, camera);
    },
    dispose() {
      root.removeEventListener('click', onClick);
      side.removeEventListener('change', onChange);
      host.canvas.removeEventListener('click', onCanvasClick);
      host.canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', resize);
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      renderer.dispose();
      root.remove();
      style.remove();
    },
  };
}
