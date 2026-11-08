/**
 * 大地图视图层 —— SVG 战略图 + DOM 面板，纯 DOM/SVG，不用 three。
 *
 * 第一版刻意不接 3D：原型要先验证「外交 ↔ 商路 ↔ 抢地」的闭环手感，
 * 俯视图比 3D 更容易看清关系。`modDeps.ts` 里的 three 注入面留着，
 * 等规则定稿、要上 2.5D 战场时再换这层，rules.js 一行不用改。
 *
 * 所有交互走事件委托（data-action），面板每次 render 重建也不会丢监听。
 */
import * as R from './rules.js';

const NS = 'http://www.w3.org/2000/svg';
const CX = 310, CY = 310, RAD = 250;
const G0 = 211, CELL = 22;
const SIZE = R.SPEC.centerSize;

const vertex = (i) => {
  const a = ((Math.PI / 3) * i) - Math.PI / 2;
  return [CX + Math.cos(a) * RAD, CY + Math.sin(a) * RAD];
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
.gk * { box-sizing: border-box; }
.gk { display:flex; width:100%; height:100%; background:#0b1220; color:#e8edf7;
      font:500 13px/1.55 system-ui,sans-serif; pointer-events:auto; }
.gk-map { flex:1; min-width:0; display:flex; align-items:center; justify-content:center; }
.gk-map svg { width:100%; height:100%; max-height:100vh; }
.gk-side { width:348px; flex:none; border-left:1px solid #26344a; overflow-y:auto;
           padding:14px 16px 24px; background:#101827; }
.gk h2 { font-size:15px; font-weight:500; margin:0 0 8px; }
.gk h3 { font-size:13px; font-weight:500; margin:16px 0 7px; color:#9fb2cc;
         border-bottom:1px solid #26344a; padding-bottom:5px; }
.gk button { font:inherit; cursor:pointer; border-radius:7px; border:1px solid #3b4d68;
             background:#1b2740; color:#e8edf7; padding:5px 10px; margin:2px 3px 2px 0; }
.gk button:hover { background:#263a5c; }
.gk button[data-on="1"] { background:#2f6d3f; border-color:#4fa564; }
.gk button.danger { background:#5a2730; border-color:#a3474f; }
.gk button.ghost { background:transparent; }
.gk .stat { display:flex; gap:14px; flex-wrap:wrap; align-items:baseline; margin-bottom:6px; }
.gk .gold { font-size:26px; color:#fac775; }
.gk .muted { color:#8fa2bd; font-size:12px; }
.gk .row { display:flex; align-items:center; gap:6px; margin:4px 0; }
.gk .tag { display:inline-block; min-width:38px; padding:1px 6px; border-radius:5px;
           font-size:12px; text-align:center; background:#22324c; }
.gk select, .gk input[type=checkbox] { font:inherit; }
.gk select { background:#1b2740; color:#e8edf7; border:1px solid #3b4d68;
             border-radius:7px; padding:5px 8px; }
.gk .log { max-height:168px; overflow-y:auto; font-size:12px; color:#b8c7dd; }
.gk .log div { padding:2px 0; border-bottom:1px solid #1c2a40; }
.gk .card { border:1px solid #2b3a54; border-radius:8px; padding:7px 9px; margin:5px 0; }
.gk .hint { font-size:12px; color:#8fa2bd; margin:4px 0 8px; }
@media (max-width:760px) {
  .gk { flex-direction:column; }
  .gk-map { height:52vh; flex:none; }
  .gk-side { width:100%; border-left:0; border-top:1px solid #26344a; }
}
`;

/** 生成 SVG 战略图内容（参数就是规则 state，别再套一层 game）。 */
function mapSvg(state) {
  const s = state;
  const parts = [];
  const blocked = new Set(R.blockedSegments(s, 0));
  const tradable = (a, b) => R.canTrade(s, a, b).ok;

  // 远弦（底层，穿过中心）+ 近边
  for (const road of R.ROADS) {
    const [x1, y1] = vertex(road.a);
    const [x2, y2] = vertex(road.b);
    const far = road.kind === 'far';
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${far ? '#6b5527' : '#2f4e73'}" stroke-width="${far ? 2 : 3}" ${far ? 'stroke-dasharray="7 6"' : ''}/>`);
  }

  // 中心区格子
  const unlock = new Set(R.unlockedCells(s, 0).map(([r, c]) => `${r},${c}`));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = s.cells[r][c];
      const x = G0 + c * CELL, y = G0 + r * CELL;
      let fill = '#111d30', stroke = '#22324c';
      if (r === R.SPEC.roadRow) {
        fill = blocked.has(c) ? '#5a2730' : '#3a3218';
        stroke = blocked.has(c) ? '#a3474f' : '#ba7517';
      } else if (cell.building) {
        fill = R.FACTIONS[cell.owner].color;
        stroke = '#e8edf7';
      } else if (cell.owner === 0) {
        fill = '#1b3350'; stroke = '#378add';
      } else if (cell.owner !== null) {
        fill = '#241c2c'; stroke = R.FACTIONS[cell.owner].color;
      } else if (unlock.has(`${r},${c}`)) {
        fill = '#16283f'; stroke = '#4d7fb5';
      }
      const clickable = r !== R.SPEC.roadRow && !cell.building && unlock.has(`${r},${c}`);
      parts.push(`<rect x="${x}" y="${y}" width="${CELL - 1}" height="${CELL - 1}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${clickable ? 1.6 : 0.6}" ${clickable ? `data-action="place" data-r="${r}" data-c="${c}" style="cursor:pointer"` : ''}/>`);
      if (cell.building) parts.push(`<rect x="${x + 6}" y="${y + 6}" width="${CELL - 13}" height="${CELL - 13}" fill="#0b1220" opacity=".55"/>`);
      if (r === R.SPEC.roadRow && blocked.has(c)) {
        parts.push(`<path d="M${x + 5} ${y + 5} L${x + 16} ${y + 16} M${x + 16} ${y + 5} L${x + 5} ${y + 16}" stroke="#ff8a8a" stroke-width="1.6"/>`);
      }
    }
  }

  // 商队（沿 from→to 直线插值）
  for (const car of s.caravans) {
    const [x1, y1] = vertex(car.from);
    const [x2, y2] = vertex(car.to);
    const total = car.kind === 'far' ? R.SPEC.trade.travel.far : R.SPEC.trade.travel.near;
    // 收进 0.08~0.92：t=0/1 时商队圆会被出发/到达城盖住，看着像没发车
    const t = 0.08 + 0.84 * Math.max(0, Math.min(1, 1 - car.ticksLeft / total));
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${R.FACTIONS[car.owner].color}" stroke="#fff" stroke-width="1.6"/>`);
  }

  // 六个主城
  for (const f of R.FACTIONS) {
    const [x, y] = vertex(f.id);
    const rel = R.relationOf(s, 0, f.id);
    parts.push(`<circle cx="${x}" cy="${y}" r="24" fill="${f.color}" stroke="${f.isPlayer ? '#fff' : '#0b1220'}" stroke-width="2" data-action="select" data-id="${f.id}" style="cursor:pointer"/>`);
    parts.push(`<text x="${x}" y="${y + 5}" text-anchor="middle" font-size="13" fill="#0b1220">${esc(f.name)}</text>`);
    if (!f.isPlayer) {
      parts.push(`<text x="${x}" y="${y + 40}" text-anchor="middle" font-size="11" fill="${rel === 'feud' ? '#ff8a8a' : '#9fb2cc'}">${esc(R.REL_LABEL[rel])}</text>`);
    }
  }
  // 说明放右侧面板，别写在 SVG 底部 —— 那里正好是第 3 号主城，会压成一团
  return parts.join('');
}

export function createView(host, game) {
  const ui = host.uiRoot;
  let selected = 1;
  let target = 2;
  let kind = 'near';
  let escorted = false;
  let auto = false;

  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'gk';
  root.innerHTML = `<div class="gk-map"><svg viewBox="0 0 620 620" preserveAspectRatio="xMidYMid meet"></svg></div><div class="gk-side"></div>`;
  ui.append(style, root);
  const svg = root.querySelector('svg');
  const side = root.querySelector('.gk-side');

  const onClick = (e) => {
    const node = e.target.closest('[data-action]');
    if (!node) return;
    const s = game.state;
    const a = node.dataset['action'];
    const id = Number(node.dataset['id'] ?? 0);
    if (a === 'select') { selected = id; render(); return; }
    if (a === 'place') {
      const res = R.placeBuilding(s, 0, Number(node.dataset['r']), Number(node.dataset['c']));
      if (!res.ok) R.note(s, `放楼失败：${res.reason}`);
      render(); return;
    }
    if (a === 'rel') { R.setRelation(s, 0, selected, node.dataset['rel']); render(); return; }
    if (a === 'backstab') { R.backstab(s, 0, selected); render(); return; }
    if (a === 'send') { R.sendCaravan(s, 0, target, kind, escorted); render(); return; }
    if (a === 'resolve') { R.resolveIncoming(s, id, node.dataset['choice']); render(); return; }
    if (a === 'step') { R.tick(s); render(); return; }
    if (a === 'auto') { auto = !auto; render(); return; }
    if (a === 'reset') { game.state = R.createGame(Date.now() & 0xffff); auto = false; render(); return; }
    if (a === 'exit') { host.exit(); return; }
  };
  root.addEventListener('click', onClick);

  const onChange = (e) => {
    const n = e.target;
    if (n.id === 'gk-target') target = Number(n.value);
    if (n.id === 'gk-escort') escorted = n.checked;
    if (n.name === 'gk-kind') kind = n.value;
    render();
  };
  side.addEventListener('change', onChange);

  function render() {
    const s = game.state;
    svg.innerHTML = mapSvg(s);
    const f = R.FACTIONS[selected];
    const rel = f.isPlayer ? '自己' : R.REL_LABEL[R.relationOf(s, 0, selected)];
    const blocked = R.blockedSegments(s, 0);
    const cells = s.cells.flat().filter((c) => c.owner === 0).length;
    const targets = R.FACTIONS.filter((x) => x.id !== 0 && R.canTrade(s, 0, x.id).ok);
    if (!targets.some((x) => x.id === target)) target = targets[0]?.id ?? 0;

    const relButtons = [
      ['allied', '结盟'], ['neutral', '中立'], ['hostile', '宣战'],
    ].map(([r, label]) => `<button data-action="rel" data-rel="${r}">${label}</button>`).join('');
    const canStab = !f.isPlayer && R.relationOf(s, 0, selected) === R.REL.ALLIED;

    const incoming = s.pending.length
      ? s.pending.map((p) => `<div class="card">${esc(R.FACTIONS[p.owner].name)} 的车 · ${p.cargo} 金<br>
          <button data-action="resolve" data-id="${p.id}" data-choice="trade">正常贸易</button>
          <button class="danger" data-action="resolve" data-id="${p.id}" data-choice="seize">扣押（+${p.cargo * R.SPEC.seizeMultiplier} · 立即死仇）</button></div>`).join('')
      : '<div class="hint">暂无来车。中立势力发车到站后可贸易或扣押。</div>';

    const log = s.log.slice(0, 9).map((l) => `<div>[${l.tick}] ${esc(l.text)}</div>`).join('');
    const board = s.finished
      ? `<div class="card">结算：${esc(R.score(s)[0].name)} 领先（原型积分，暂无拆家战斗）</div>` : '';

    side.innerHTML = `
      <h2>大地图 · 多方混战 <span class="muted">规则原型</span></h2>
      <div class="muted">六方六芒星 · 固定商路 · 中心辐射抢地 · 四态外交</div>
      <h3>局势</h3>
      <div class="stat"><span class="gold">${s.factions[0].gold}</span><span class="muted">/ ${R.SPEC.gold.cap} 金</span>
        <span class="muted">回合 ${s.tick}/${R.SPEC.endTick}</span></div>
      <div class="muted">回金 ${R.SPEC.gold.regenTicks} 回合 +${R.SPEC.gold.regenAmount} · 中心格 ${cells} · 封死路段 ${blocked.length}/${SIZE}</div>
      <div class="hint">钱是存量：满金时收益会被上限吃掉，先放楼 / 发车腾出空间。</div>
      ${board}
      <h3>外交 · 选中 ${esc(f.name)}（${esc(rel)}）</h3>
      <div class="hint">点左侧主城切换目标；联盟上限 ${R.SPEC.allyLimit} 个盟友，背刺 / 扣押 = 死仇且永不复盟。</div>
      <div class="row">${f.isPlayer ? '<span class="muted">自己</span>' : relButtons}</div>
      ${canStab ? '<div class="row"><button class="danger" data-action="backstab">背刺（⇒ 死仇）</button></div>' : ''}
      <h3>集市 · 发车</h3>
      <div class="row"><span class="muted">目的地</span>
        <select id="gk-target">${targets.map((x) => `<option value="${x.id}" ${x.id === target ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="row">
        <label><input type="radio" name="gk-kind" value="near" ${kind === 'near' ? 'checked' : ''}> 近 · ${R.SPEC.trade.near} 金（安全）</label>
        <label><input type="radio" name="gk-kind" value="far" ${kind === 'far' ? 'checked' : ''}> 远 · ${R.SPEC.trade.far} 金</label></div>
      <div class="row"><label><input type="checkbox" id="gk-escort" ${escorted ? 'checked' : ''}> 派兵护航（+${R.SPEC.cost.escort} 金，封死路段也照过）</label></div>
      <div class="row"><button data-action="send" ${targets.length ? '' : 'disabled'}>发车（${R.SPEC.cost.caravan + (escorted ? R.SPEC.cost.escort : 0)} 金）</button></div>
      <h3>待处理来车</h3>${incoming}
      <h3>控制</h3>
      <div class="row">
        <button data-action="step">单步</button>
        <button data-action="auto" data-on="${auto ? 1 : 0}">${auto ? '暂停自动' : '自动推进'}</button>
        <button class="ghost" data-action="reset">重置</button>
        <button class="ghost" data-action="exit">退出模组</button>
      </div>
      <div class="hint">在途商队 ${s.caravans.length} · 蓝框格可放楼（${R.SPEC.cost.build} 金，4 邻域辐射解锁）· 主干道红叉 = 两侧皆敌封死 · 点主城选外交</div>
      <h3>事件</h3><div class="log">${log}</div>
    `;
  }

  render();
  return {
    render,
    isAuto: () => auto,
    dispose() {
      root.removeEventListener('click', onClick);
      side.removeEventListener('change', onChange);
      root.remove();
      style.remove();
    },
  };
}
