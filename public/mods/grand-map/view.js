/**
 * 大地图 3D 视图（2026-11-09，P-087 续）—— 卡牌驱动的主模式扩展。
 *
 * 地图：大六边形像素地形（map.js，半径 38 格 ≈ 3750 格 = 竞技场的 4.3 倍），
 *       内部六芒星道路 + 相邻近路小道 + 三条对径远路，中心 17×17 公共区。
 *       中心区非道路格一律**正常草地**，只有真道路格才染道路色。
 * 镜头：默认拉近看局部（tilesAcross 34），滚轮缩放 / 拖动平移 / Shift+拖动旋转，
 *       顶栏「全图」一键拉远看整张六边形 —— 大地图要能"逛"，不是缩成一张小沙盘。
 * 场景零件：Renderer / installArenaBackdrop / LightingRig / CameraRig / 后期链 /
 *          ARENA_MODELS 全部来自 host 注入，和 /arena.html 是同一套。
 * 集结：点地面插旗 ⇒ 主程序同款像素小人（loadPack + DudeGallery + DudeSprite）朝旗行进。
 * HUD：顶栏 + 底部四张手牌（host.modApi.createModHand，复用主程序卡面样式与图标）。
 */
import * as R from './rules.js';
import * as M from './map.js';
import { createHand, EXTRA_CARDS } from './hand.js';
import { createRally } from './rally.js';
import { createSky, PERIODS as SKY_PERIODS } from './sky.js';

const colorNum = (hex) => parseInt(hex.slice(1), 16);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const key = (col, row) => `${col},${row}`;

/** 沿屏幕短边可见格数：局部固定、全图随档位放大 */
const LOCAL_VIEW = M.VIEW.local;
const OVERVIEW = M.VIEW[M.SIZE];
/** 宝箱按真实秒刷新，走独立时钟，不受「推进 / 暂停」这个调试开关影响 */
const CHEST_EVERY = R.SPEC.chest.everySeconds;

/**
 * **P-098（2026-11-13）已改回默认收起。**
 * 用户 2026-11-09：「调试的话，我现在可以用，但是后面也要改回来呀」——
 * 开发期为了一开页面就能点时段/巡游/推进，这里曾经是 true；现在收口成 false，
 * 想调试点顶栏那颗「调试」按钮即可，控件本身一个没删。
 * 主程序自己的开发者模式仍是默认关、设置页开关，本模组没有动它。
 *
 * ⚠️ 别再改回 true：`tests/mod_api_20261109.test.ts` 与 `tools/grand_map_probe.mjs`
 * 都钉着「默认收起」。要彻底去掉调试能力就整块删掉 + 移除顶栏按钮。
 */
const DEBUG_DEFAULT_OPEN = false;

const CSS = `
.gm * { box-sizing: border-box; }
.gm { position:absolute; inset:0; pointer-events:none; color:#e8edf7;
      font:500 13px/1.55 system-ui,sans-serif; }
.gm-tint { position:absolute; inset:0; pointer-events:none; }
/* 顶栏直接用主模式那套 .ahud__top / .ahud__clock / .ahud__tools--top，
   金币也回到手牌下方的 .ahud__bank —— 不再自己画一条黑条把金币塞左上角 */
.gm-top { pointer-events:auto; background:rgba(10,16,28,.92);
          border-bottom:1px solid rgba(216,178,92,.35); }
.gm-title { font-size:13px; font-weight:500; color:#f3e0b0; white-space:nowrap; }
.gm-devtag { margin-left:6px; padding:1px 5px; border-radius:4px;
             border:1px dashed #d8b25c; font-size:10px; font-weight:500;
             letter-spacing:.08em; color:#f6dc9c; }
.gm-top .ahud__clock__num { font-size:13px; }
.gm-sizes { display:inline-flex; gap:3px; margin-right:6px; }
.gm-sizes button, .gm-debug button { font:inherit; cursor:pointer; border-radius:7px;
          border:1px solid #3b4d68; background:#1b2740; color:#e8edf7; padding:3px 8px; }
.gm-sizes button[data-on="1"], .gm-debug button[data-on="1"] {
          background:#8a6a2e; border-color:#d8b25c; }
/* 调试控件集中在这里；P-098 起默认收起，点顶栏「调试」按钮展开 */
.gm-debug { position:absolute; right:10px; top:52px; width:min(300px,92vw);
            padding:8px 10px; border-radius:10px; pointer-events:auto;
            background:rgba(12,20,35,.94); border:1px solid rgba(216,178,92,.35); }
.gm-debug__row { display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin:4px 0; }
.gm-debug .muted { color:#9fb2cc; font-size:11px; }
.gm-debug__info { font-size:11px; color:#b8c7dd; line-height:1.5; }
.gm-panel { position:absolute; left:50%; top:56px; transform:translateX(-50%);
            width:min(320px,92vw); padding:10px 12px; border-radius:12px; pointer-events:auto;
            background:rgba(12,20,35,.95); border:1px solid rgba(216,178,92,.4); }
.gm-panel h3 { margin:0 0 6px; font-size:14px; font-weight:500; color:#f3e0b0; }
.gm-panel .muted { color:#9fb2cc; font-size:11px; }
.gm-panel button { font:inherit; cursor:pointer; border-radius:7px; border:1px solid #3b4d68;
                  background:#1b2740; color:#e8edf7; padding:4px 9px; }
.gm-panel button[data-on="1"] { background:#8a6a2e; border-color:#d8b25c; }
.gm-panel button.danger { background:#5a2730; border-color:#a3474f; }
.gm-panel .close { float:right; background:transparent; }
.gm-panel .row { margin:6px 0; }
/* 用户 2026-11-09：「左下角不需要那么多提示呀」——
   去掉深色底框、提示压成一行、日志只留最近 3 条，把左下角还给战场 */
.gm-log { position:absolute; left:12px; bottom:14px; width:280px; max-height:52px;
          overflow:hidden; font-size:11px; line-height:1.5; pointer-events:none;
          color:rgba(200,215,236,.85); text-shadow:0 1px 4px #000; }
.gm-tip { position:absolute; left:12px; bottom:70px; font-size:11px; white-space:nowrap;
          pointer-events:none; color:rgba(240,213,154,.72); text-shadow:0 1px 4px #000; }
/* HUD 是 DOM，不吃 WebGL 后期：昼夜切换时必须同步卡面主题（只在模组内加规则，
   一行都不改主程序 arena.css）。否则会出现「战场入夜、卡面还亮着」的割裂感。 */
#arena-ui[data-period="dusk"] .ahud__hand[data-mod-hand] .ahud__card {
  background-color:#3a2a25; border-color:#6b4a34; color:#f4ddc4; }
#arena-ui[data-period="night"] .ahud__hand[data-mod-hand] .ahud__card {
  background-color:#1b2537; background-image:none; border-color:#3a4d68; color:#dce8fa;
  box-shadow:inset 0 1px 0 #2a3a55, 0 3px 0 rgba(0,0,0,.6); }
#arena-ui[data-period="night"] .ahud__hand[data-mod-hand] .ahud__card[data-selected="true"] {
  border-color:#c8a45a; }
/* 宝箱金币可以顶破 50 上限：数字照实显示，条子泛一层金光表示「超额」 */
#arena-ui .ahud__bank[data-over="true"] { border-color:#fff0b8;
  box-shadow:0 0 12px rgba(255,224,140,.65), inset 0 1px 0 rgba(255,255,255,.12); }
#arena-ui .ahud__bank[data-over="true"] .ahud__bank__cap { color:#ffe9a8; }
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
    <div class="ahud__top panel gm-top">
      <span class="gm-title">大地图 · 多方混战 <b class="gm-devtag">DEV</b></span>
      <div class="ahud__clock gm-clock"><b class="ahud__clock__num" data-clock>0 / 120</b></div>
      <div class="ahud__tools ahud__tools--top">
        <span class="gm-sizes"></span>
        <button class="ahud__iconbtn" data-action="rally" data-on="1">集结</button>
        <button class="ahud__iconbtn" data-action="overview">全图</button>
        <button class="ahud__iconbtn" data-action="debug">调试</button>
        <button class="ahud__iconbtn" data-action="exit">退出</button>
      </div>
    </div>
    <div class="gm-debug" data-debug>
      <div class="gm-debug__row"><span class="muted">时段</span><span class="gm-periods"></span></div>
      <div class="gm-debug__row"><button data-action="autosky" data-flag="autosky">巡游</button>
        <button data-action="auto" data-flag="auto">推进</button>
        <button data-action="reset">重置</button></div>
      <div class="gm-debug__info" data-info></div>
    </div>
    <div class="gm-panel gm-dipl" hidden></div>
    <div class="gm-panel gm-market" hidden></div>
    <div class="gm-log"></div>
    <div class="gm-tip">点地面集结 · 拖卡牌落牌 · 滚轮缩放 / 拖动平移</div>`;
  ui.append(style, root);
  const tintEl = root.querySelector('.gm-tint');
  const clockEl = root.querySelector('[data-clock]');
  const infoEl = root.querySelector('[data-info]');
  const periodsEl = root.querySelector('.gm-periods');
  const sizesEl = root.querySelector('.gm-sizes');
  const debugEl = root.querySelector('[data-debug]');
  const diplEl = root.querySelector('.gm-dipl');
  const marketEl = root.querySelector('.gm-market');
  const logEl = root.querySelector('.gm-log');
  const rallyBtn = root.querySelector('[data-action="rally"]');
  const overviewBtn = root.querySelector('[data-action="overview"]');
  const debugBtn = root.querySelector('[data-action="debug"]');
  debugEl.hidden = !DEBUG_DEFAULT_OPEN;
  debugBtn.dataset['on'] = DEBUG_DEFAULT_OPEN ? '1' : '0';

  // 金币回到手牌下方那条旧 UI 的填充条（开放 API 提供，不是顶栏左上角一个数字）
  const modBank = API.createModBank();
  ui.append(modBank.el);

  // ===== 主程序同款场景零件 =====
  const scene = new T.Scene();
  const renderer = new A.Renderer(host.canvas);
  A.installArenaBackdrop(scene, renderer.instance);
  const lighting = new A.LightingRig(scene, { shadowMapSize: 1024 });
  const rig = new A.CameraRig({
    pitchDeg: A.ARENA_CAMERA.pitchDeg,
    yawDeg: A.ARENA_CAMERA.yawDeg,
    // 上限要盖得住最大档的全图视角，否则 rig.zoom 会被 clamp 到 100（实测大档只能拉到 100）
    tilesAcross: LOCAL_VIEW, minTilesAcross: 12, maxTilesAcross: M.VIEW.lg + 8,
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

  // 云往外围多推一点，局部视图里别盖在可建造地块上当"白色障碍物"
  const sky = createSky(T, scene, mid, (M.MAP.hexR / 30) * 1.35);

  // ===== 地板：用主程序同一套 TileMap + GroundView =====
  // 用户 2026-11-09：「你这个地板好像是 2D 的，不是 3D 的」。
  // GroundView 每格是 thickness + 1.2 厚的立体块，顶面按地形起伏（grass 0.5 /
  // sand 0.46 / rock 0.78），材质 roughness 0.95 + flatShading、颜色带 fbm 抖色、
  // receiveShadow = true；P-087 改大六边形时我换成了 0.28 高的薄方块 + 纯色，
  // 俯视就成了一张 2D 网格贴图。现在把真实零件接回来，形状仍由 terrain 数组裁成六边形。
  const terrain = M.terrainCells();
  const codeOf = (name) => A.TERRAIN_ORDER.indexOf(name);
  const codes = new Uint8Array(M.MAP.cols * M.MAP.rows).fill(codeOf('water'));
  terrain.forEach((c) => {
    // 六边形内以草原为主，掺少量沙地 / 岩脊制造顶面高差（读的是主程序 TERRAIN 表）
    const t = (c.col * 7 + c.row * 13) % 29 === 0 ? 'rock'
      : (c.col * 3 + c.row * 5) % 13 === 0 ? 'sand' : 'grass';
    codes[c.row * M.MAP.cols + c.col] = codeOf(t);
  });
  const tileMap = new A.TileMap({ cols: M.MAP.cols, rows: M.MAP.rows }, codes);
  const ground = new A.GroundView(tileMap);
  scene.add(ground.group);
  // GroundView 把 water 格放进 sea 层：六边形外整层藏掉，轮廓才真是大六边形
  ground.group.children[1].count = 0;
  const groundY = (col, row) => tileMap.surfaceY(A.pos(Math.floor(col), Math.floor(row)));

  // 染色一律走 GroundView.tintCells（和 1v1 给黄沙禁建带染色是同一个函数）
  const GRASS = A.TERRAIN.grass.color;
  const GRASS_LIT = 0x8ab35f;
  const MAIN = 0x6b5636;
  const STAR = 0xba7517;
  const SHORT = 0xd8b45c;
  const FAR = 0x9a5f2e;
  const BLOCKED = 0x8a3540;
  const CHEST = 0xffd75e;
  const FACTION_HEX = R.FACTIONS.map((f) => colorNum(f.color));

  // ===== 六座主城：主游戏同款大本营模型，落在六芒星尖角 =====
  M.POINTS.forEach((p, i) => {
    const w = A.cellToWorld(A.pos(p.col, p.row));
    const base = new T.Mesh(
      new T.CircleGeometry(2.2, 24),
      new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[i].color), side: T.DoubleSide }),
    );
    base.rotation.x = -Math.PI / 2;
    const gy = groundY(p.col, p.row);
    base.position.set(w.x, gy + 0.02, w.z);
    scene.add(base);
    try {
      const model = A.buildModel(A.ARENA_MODELS.core(colorNum(R.FACTIONS[i].color)).static);
      // 主程序的模型本体只有 1 格大，视图层一律按 BUILDING_SCALE 放大
      model.scale.setScalar(A.BUILDING_SCALE);
      model.position.set(w.x, gy + 0.04, w.z);
      scene.add(model);
    } catch (err) {
      console.warn('[grand-map] 主城模型装配失败：', err);
    }
  });

  // ===== 集结旗：一根杆 + 一面布 + 地上一圈光圈 =====
  const flagGroup = new T.Group();
  const pole = new T.Mesh(
    new T.BoxGeometry(0.16, 2.2, 0.16),
    new T.MeshBasicMaterial({ color: 0xffe4a0 }),
  );
  pole.position.y = 1.1;
  const cloth = new T.Mesh(
    new T.PlaneGeometry(1.1, 0.7),
    new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[0].color), side: T.DoubleSide }),
  );
  cloth.position.set(0.55, 1.85, 0);
  const ring = new T.Mesh(
    new T.CircleGeometry(1.1, 28),
    new T.MeshBasicMaterial({ color: 0xfac775, transparent: true, opacity: 0.22, side: T.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  flagGroup.add(ring, pole, cloth);
  flagGroup.visible = false;
  scene.add(flagGroup);

  const hand = createHand(API, game);
  const rally = createRally();
  const buildingMeshes = new Map();
  const caravanMeshes = new Map();
  const unitViews = new Map();
  const chestMeshes = new Map();
  let chestAcc = 0;
  let autoSky = false, skyAcc = 0, auto = false, acc = 0;
  let overview = false;
  let canvasDrag = false, dragging = false, lastX = 0, lastY = 0;
  let ghost = null;
  let diplId = 2;

  // ===== 像素小人：主程序同款素材包，异步加载；没读到就退回阵营色小方块 =====
  let dudePack = null, gallery = null, dudeRng = null;
  const styles = new Map();
  void A.loadPack().then((pack) => {
    dudePack = pack;
    gallery = new A.DudeGallery(pack);
    dudeRng = new host.engine.Random(20261109);
  }).catch((err) => {
    console.info('[grand-map] 像素小人素材没读到，退回占位方块：', err);
  });
  const styleFor = (cardId) => {
    if (!styles.has(cardId)) styles.set(cardId, A.randomStyle(dudeRng, dudePack));
    return styles.get(cardId);
  };

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
    ghost.position.set(w.x, groundY(cell.col, cell.row) + 0.04, w.z);
    ghost.visible = true;
  };
  const hideGhost = () => { if (ghost) ghost.visible = false; };

  const message = (text) => { R.note(game.state, text); render(); };

  function syncFlag() {
    const f = rally.flag;
    flagGroup.visible = !!f;
    if (!f) return;
    const w = A.cellToWorld(A.pos(f.col, f.row));
    flagGroup.position.set(w.x, groundY(f.col, f.row) + 0.02, w.z);
  }

  /** 点击地面 ⇒ 插旗集结。军队可以站道路上（道路只是不能盖楼）。 */
  function rallyAt(col, row) {
    const res = rally.dropFlag(col, row);
    if (!res.ok) { message(res.reason); return res; }
    syncFlag();
    message(`集结点 (${col},${row}) · 再点别处可随时改集结位置`);
    return res;
  }

  /** 打出军队/攻城卡 ⇒ 从落牌点拉出一队像素小人，向当前集结点行进。 */
  function afterPlay(slot, res, col, row) {
    if (!res.ok) { message(res.reason); return res; }
    modHand.play(slot);
    const card = res.card;
    if (card && card.kind !== 'building') {
      const count = Math.min(8, Math.max(3, card.squad?.reduce((n, s) => n + s.count, 0) ?? 3));
      rally.spawn(col, row, count, card.id);
    }
    render();
    return res;
  }

  // 卡牌 HUD：主程序同款手牌（开放 API 提供）
  const modHand = API.createModHand({
    onSelect: (slot) => { hand.select(slot); render(); },
    onDragMove: (_slot, x, y) => showGhost(x, y),
    onCancel: () => hideGhost(),
    onDrop: (slot, x, y) => {
      hideGhost();
      const cell = groundCell(x, y);
      if (!cell) return;
      afterPlay(slot, hand.play(slot, cell.col, cell.row), cell.col, cell.row);
    },
  });
  ui.append(modHand.el);

  const onCanvasClick = (e) => {
    if (dragging) return;
    const cell = groundCell(e.clientX, e.clientY);
    if (!cell) return;
    const k = key(cell.col, cell.row);
    // 点自己的集市 = 开商路设置
    if (hand.claims.get(k)?.owner === 0 && hand.claims.get(k)?.card === 'market') { openMarket(); return; }
    // 点主城附近 = 开外交
    const near = M.POINTS.findIndex((p, i) => i > 0 && Math.abs(p.col - cell.col) <= 4 && Math.abs(p.row - cell.row) <= 4);
    if (near > 0) { openDiplomacy(near); return; }
    if (hand.selected >= 0) {
      const slot = hand.selected;
      afterPlay(slot, hand.play(slot, cell.col, cell.row), cell.col, cell.row);
      return;
    }
    // 没选牌 = 点地面插旗集结军队
    rallyAt(cell.col, cell.row);
  };
  const onDown = (e) => { canvasDrag = true; dragging = false; lastX = e.clientX; lastY = e.clientY; };
  const onUp = () => { canvasDrag = false; };
  const onMove = (e) => {
    if (!canvasDrag || e.buttons !== 1) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging = true;
    if (e.shiftKey) rig.rotateBy(-dx * 0.12);
    else rig.panByPixels(dx, dy);
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = host.canvas.getBoundingClientRect();
    rig.zoomBy(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX - rect.left, e.clientY - rect.top);
    overview = false;
    overviewBtn.dataset['on'] = '0';
    overviewBtn.textContent = '全图';
  };
  host.canvas.addEventListener('click', onCanvasClick);
  host.canvas.addEventListener('pointerdown', onDown);
  host.canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerup', onUp);
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
    // 三档地图：启动前分流，和切模式/进出模组一样走「改 URL + reload」，
    // 不做运行时重建世界（形状/路网/规则层都按档位在加载时算好）
    if (a === 'size') {
      const p = new URLSearchParams(location.search);
      p.set('size', b.dataset['size']);
      location.search = p.toString();
      return;
    }
    if (a === 'debug') {
      debugEl.hidden = !debugEl.hidden;
      debugBtn.dataset['on'] = debugEl.hidden ? '0' : '1';
      return;
    }
    if (a === 'rally') {
      const on = rally.setEnabled(!rally.enabled);
      rallyBtn.dataset['on'] = on ? '1' : '0';
      message(on ? '集结已启用：点地面插旗，军队会往旗子走' : '集结已关闭');
      return;
    }
    if (a === 'overview') {
      overview = !overview;
      rig.zoom = overview ? OVERVIEW : LOCAL_VIEW;
      if (!overview) rig.centerOnWorld(mid.x, mid.z);
      overviewBtn.dataset['on'] = overview ? '1' : '0';
      overviewBtn.textContent = overview ? '回局部' : '全图';
      return;
    }
    if (a === 'period') { sky.setPeriod(Number(b.dataset['i'])); autoSky = false; render(); return; }
    if (a === 'autosky') { autoSky = !autoSky; skyAcc = 0; render(); return; }
    if (a === 'auto') { auto = !auto; render(); return; }
    if (a === 'reset') {
      game.state = R.createGame(Date.now() & 0xffff);
      hand.reset(); rally.reset(); diplId = 2;
      for (const v of unitViews.values()) removeUnitView(v);
      unitViews.clear();
      syncFlag();
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
      const name = modelOf.get(v.card);
      // 军队卡由集结层的小人表达，不再画一个假建筑
      if (!name || !A.ARENA_MODELS[name]) continue;
      want.add(k);
      if (buildingMeshes.has(k)) continue;
      const [col, row] = k.split(',').map(Number);
      const w = A.cellToWorld(A.pos(col, row));
      try {
        const m = A.buildModel(A.ARENA_MODELS[name](colorNum(R.FACTIONS[0].color)).static);
        // 一格占领点比主程序 3×3 占地小，按主程序缩放打个折，避免盖住邻格
        m.scale.setScalar(A.BUILDING_SCALE * 0.62);
        m.position.set(w.x, groundY(col, row) + 0.02, w.z);
        scene.add(m);
        buildingMeshes.set(k, m);
      } catch { /* 模型装配失败就只靠地块颜色表达 */ }
    }
    for (const [k, m] of buildingMeshes) {
      if (!want.has(k)) { scene.remove(m); buildingMeshes.delete(k); }
    }
  }

  function removeUnitView(v) {
    if (v.sprite) { scene.remove(v.sprite.mesh); v.sprite.dispose(); }
    if (v.box) {
      scene.remove(v.box);
      v.box.geometry.dispose();
      v.box.material.dispose();
    }
  }

  /** 集结的兵：素材包加载完自动从占位方块升级成主程序同款像素小人。 */
  function syncUnits(time) {
    const alive = new Set();
    for (const u of rally.units) {
      alive.add(u.id);
      let v = unitViews.get(u.id);
      if (gallery && (!v || !v.sprite)) {
        if (v) removeUnitView(v);
        const { atlas, texture } = gallery.acquire(styleFor(u.card));
        const sprite = new A.DudeSprite(dudePack, atlas, texture, {
          ...A.DEFAULT_APPEARANCE, height: 1.15,
        });
        scene.add(sprite.mesh);
        v = { sprite, box: null };
        unitViews.set(u.id, v);
      } else if (!gallery && !v) {
        const box = new T.Mesh(
          new T.BoxGeometry(0.5, 0.9, 0.5),
          new T.MeshBasicMaterial({ color: colorNum(R.FACTIONS[0].color) }),
        );
        scene.add(box);
        v = { sprite: null, box };
        unitViews.set(u.id, v);
      }
      const w = A.cellToWorld(A.pos(u.col, u.row));
      const obj = v.sprite ? v.sprite.mesh : v.box;
      obj.position.set(w.x, groundY(u.col, u.row) + (v.sprite ? 0.6 : 0.5), w.z);
      if (v.sprite) {
        v.sprite.mesh.quaternion.copy(rig.camera.quaternion); // billboard：正交相机也正对
        v.sprite.play(u.moving ? 'run' : 'idle', time);
      }
    }
    for (const [id, v] of unitViews) {
      if (!alive.has(id)) { removeUnitView(v); unitViews.delete(id); }
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
      m.position.set(wa.x + (wb.x - wa.x) * t, groundY(a.col, a.row) + 0.4 + Math.sin(time * 4 + car.id) * 0.05, wa.z + (wb.z - wa.z) * t);
    }
  }

  /** 一只宝箱：木箱 + 金盖 + 锁扣 + 地上一圈金光（全用注入的具名 three 类） */
  function makeChest() {
    const g = new T.Group();
    // 俯视 50° 下模型本体只有 1 格大，放大一点才看得出是箱子而不是一枚金币
    g.scale.setScalar(1.35);
    const body = new T.Mesh(
      new T.BoxGeometry(0.8, 0.5, 0.6),
      new T.MeshStandardMaterial({ color: 0x8a5a28, roughness: 0.9, flatShading: true }),
    );
    body.position.y = 0.25;
    const lid = new T.Mesh(
      new T.BoxGeometry(0.86, 0.18, 0.66),
      new T.MeshStandardMaterial({ color: 0xfac775, roughness: 0.55, metalness: 0.35, flatShading: true }),
    );
    lid.position.y = 0.57;
    const lock = new T.Mesh(
      new T.BoxGeometry(0.16, 0.2, 0.08),
      new T.MeshBasicMaterial({ color: 0xfff0b8 }),
    );
    lock.position.set(0, 0.5, 0.33);
    const halo = new T.Mesh(
      new T.CircleGeometry(0.75, 20),
      new T.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.2, side: T.DoubleSide, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.02;
    g.add(halo, body, lid, lock);
    return g;
  }

  /** 每帧摆好宝箱；只要己方士兵跑进箱子那一格 ⇒ 占领开箱 */
  function syncChests(time) {
    const s = game.state;
    const alive = new Set(s.chests.map((ch) => ch.id));
    for (const [id, g] of chestMeshes) {
      if (!alive.has(id)) { scene.remove(g); chestMeshes.delete(id); }
    }
    for (const ch of [...s.chests]) {
      const cell = M.fromAbstract(ch.r, ch.c);
      const w = A.cellToWorld(A.pos(cell.col, cell.row));
      let g = chestMeshes.get(ch.id);
      if (!g) { g = makeChest(); scene.add(g); chestMeshes.set(ch.id, g); }
      g.position.set(w.x, groundY(cell.col, cell.row) + 0.02 + Math.sin(time * 2 + ch.id) * 0.08, w.z);
      const reached = rally.units.some(
        (u) => Math.hypot(u.col - cell.col, u.row - cell.row) < 0.85,
      );
      if (reached) {
        const res = R.collectChest(s, ch.id);
        if (res.ok) message(`占领宝箱 +${res.gold} 金（${res.before} → ${res.total}，可超过上限）`);
        break;
      }
    }
  }

  function paintTiles() {
    const s = game.state;
    const unlocked = hand.unlocked();
    const chestKeys = new Set(s.chests.map((ch) => {
      const c = M.fromAbstract(ch.r, ch.c);
      return key(c.col, c.row);
    }));
    const blocked = new Set(R.blockedSegments(s, 0));
    // 走主程序 GroundView.tintCells：同一份 fbm 抖动公式，和 1v1 的黄沙禁建带一样
    const groups = new Map();
    const put = (hex, col, row) => {
      if (!groups.has(hex)) groups.set(hex, []);
      groups.get(hex).push({ col, row });
    };
    terrain.forEach((c) => {
      const k = key(c.col, c.row);
      const kind = M.roadKindAt(c.col, c.row);
      // 中心公共区不整块染色：不是道路就正常草地（用户 2026-11-09 口径）
      let hex = GRASS;
      if (kind === 'main') hex = MAIN;
      else if (kind === 'star') hex = STAR;
      else if (kind === 'short') hex = SHORT;
      else if (kind === 'far') hex = FAR;
      const claim = hand.claims.get(k);
      if (claim) hex = FACTION_HEX[claim.owner];
      else if (unlocked.has(k)) hex = GRASS_LIT;
      if (chestKeys.has(k)) hex = CHEST;
      if (kind === 'main' && blocked.has(c.col - M.CENTER.col0)) hex = BLOCKED;
      put(hex, c.col, c.row);
    });
    for (const [hex, cells] of groups) ground.tintCells(cells, hex);
  }

  function render() {
    const s = game.state;
    modBank.set(s.factions[0].gold, R.SPEC.gold.cap);
    // 顶栏中间沿用主模式的时钟位（绝对居中），这里显示回合而不是倒计时
    clockEl.textContent = `${s.tick} / ${R.SPEC.endTick}`;
    infoEl.textContent = `档位 ${M.SIZES[M.SIZE].label} · 地图 ${M.MAP.cols}×${M.MAP.rows} · ` +
      `地形 ${terrain.length} 格 · 中心 ${M.CENTER.size}×${M.CENTER.size} · ` +
      `来车 ${s.pending.length} · 兵 ${rally.units.length} · 宝箱 ${s.chests.length} · 镜头 ${Math.round(rig.zoom)} 格`;
    const period = SKY_PERIODS[sky.periodIndex];
    tintEl.style.background = period.tint;
    ui.dataset['period'] = period.key;
    rallyBtn.dataset['on'] = rally.enabled ? '1' : '0';
    sizesEl.innerHTML = Object.entries(M.SIZES).map(([id, cfg]) =>
      `<button data-action="size" data-size="${id}" data-on="${M.SIZE === id ? 1 : 0}">${cfg.label}</button>`).join('');
    periodsEl.innerHTML = SKY_PERIODS.map((p, i) =>
      `<button data-action="period" data-i="${i}" data-on="${sky.periodIndex === i ? 1 : 0}">${p.label}</button>`).join('');
    const autoBtn = root.querySelector('[data-flag="auto"]');
    const skyBtn = root.querySelector('[data-flag="autosky"]');
    autoBtn.dataset['on'] = auto ? '1' : '0';
    autoBtn.textContent = auto ? '暂停' : '推进';
    skyBtn.dataset['on'] = autoSky ? '1' : '0';
    modHand.render(hand.cards, s.factions[0].gold, hand.selected);
    logEl.innerHTML = s.log.slice(0, 3).map((l) => `<div>[${l.tick}] ${esc(l.text)}</div>`).join('');
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
    get rally() { return rally; },
    get chests() { return game.state.chests; },
    get zoom() { return rig.zoom; },
    /** 探针钩子：规则和实际点击走的是同一条 spawnChest / collectChest */
    spawnChest() { const res = R.spawnChest(game.state); render(); return res; },
    collectChest(id) { const res = R.collectChest(game.state, id); render(); return res; },
    get dudesReady() { return !!gallery; },
    /** 地板诊断：给无头探针确认用的是主程序 GroundView 立体块，而不是 2D 薄贴片 */
    get floor() {
      return {
        engine: 'GroundView',
        land: ground.group.children[0].count,
        sea: ground.group.children[1].count,
        surfaceY: groundY(M.MAP.cx, M.MAP.cy),
      };
    },
    setOverview(on) {
      overview = !!on;
      rig.zoom = overview ? OVERVIEW : LOCAL_VIEW;
      if (!overview) rig.centerOnWorld(mid.x, mid.z);
      overviewBtn.dataset['on'] = overview ? '1' : '0';
      overviewBtn.textContent = overview ? '回局部' : '全图';
    },
    rallyAt,
    /** 无头探针走格子坐标，和点选/拖放共用同一条 hand.play 判据 */
    playCard(slot, col, row) {
      return afterPlay(slot, hand.play(slot, col, row), col, row);
    },
    frame(info) {
      hand.tick(info.delta);
      rally.tick(info.delta);
      // 宝箱按真实秒独立刷新，不依赖「推进 / 暂停」这个调试开关
      chestAcc += info.delta;
      if (chestAcc >= CHEST_EVERY) {
        chestAcc = 0;
        if (R.spawnChest(game.state).ok) render();
      }
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
      syncUnits(info.time);
      syncChests(info.time);
      composer.render(info.delta);
    },
    dispose() {
      root.removeEventListener('click', onClick);
      host.canvas.removeEventListener('click', onCanvasClick);
      host.canvas.removeEventListener('pointerdown', onDown);
      host.canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', resize);
      modHand.dispose();
      modBank.dispose();
      delete ui.dataset['period'];
      for (const v of unitViews.values()) removeUnitView(v);
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      gallery?.dispose();
      lighting.dispose(scene);
      renderer.dispose();
      root.remove();
      style.remove();
    },
  };
}
