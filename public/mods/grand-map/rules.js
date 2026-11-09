import { CENTER } from './map.js';

/**
 * 大地图规则层 —— 纯 JS，零 DOM / 零 three（只允许模组内 ./ 相对 import）。
 *
 * 为什么单独一层：这样 `node --test mods/grand-map/tests/*.mjs` 能直接验规则，
 * 不用开浏览器；视觉层（view.js）只是这层状态的一面镜子。
 *
 * 口径来源 `docs/工作笔记/大地图原型设计_20261108.md` 三轮规则。
 * 所有**占位数值**集中在 SPEC —— 草案 §4 里那些还待拍板的倍率/恢复速度，
 * 第一版给个能跑的默认值，调的时候只改这一张表，判据和文案都从它读。
 */

/** 原型占位数值：全部可调，不写死在逻辑里。 */
export const SPEC = {
  gold: { start: 50, cap: 50, regenTicks: 20, regenAmount: 1 },
  cost: { build: 6, caravan: 3, escort: 4 },
  trade: { near: 5, far: 14, travel: { near: 2, far: 4 } },
  seizeMultiplier: 2,
  allyLimit: 1,          // 联盟最多 2 人 ⇒ 玩家最多 1 个盟友
  // 中心抽象网格逐格跟着地图档位走，判据只在 map.js 的 CENTER 里算一次
  centerSize: CENTER.size,
  roadRow: CENTER.roadRow,
  endTick: 120,
  aiPeriod: 3,
};

export const REL = {
  HOSTILE: 'hostile',
  NEUTRAL: 'neutral',
  ALLIED: 'allied',
  FEUD: 'feud',
};

export const REL_LABEL = {
  hostile: '敌对',
  neutral: '中立',
  allied: '结盟',
  feud: '死仇',
};

export const FACTIONS = [
  { id: 0, name: '你', color: '#378add', isPlayer: true },
  { id: 1, name: '霜狼', color: '#1d9e75', isPlayer: false },
  { id: 2, name: '赤铜', color: '#d85a30', isPlayer: false },
  { id: 3, name: '沙盟', color: '#ba7517', isPlayer: false },
  { id: 4, name: '铁砧', color: '#7f77dd', isPlayer: false },
  { id: 5, name: '远帆', color: '#d4537e', isPlayer: false },
];

/** 每方在中心区的"抢滩起点"：第一栋楼必须落这里，之后按 4 邻域辐射。
 *  按中心区边长的相对位置铺开，三档都自动适配，且全部避开 roadRow。 */
const n = SPEC.centerSize;
export const SEEDS = [
  [0, Math.round(n * 0.12)],
  [0, Math.round(n * 0.88)],
  [Math.round(n * 0.35), 0],
  [Math.round(n * 0.35), n - 1],
  [n - 1, Math.round(n * 0.12)],
  [n - 1, Math.round(n * 0.88)],
];

/** 开局关系表：玩家面对 2 敌 3 中立，AI 之间基本中立（原型占位）。 */
const INITIAL_PAIRS = [
  [0, 1, REL.HOSTILE], [0, 2, REL.NEUTRAL], [0, 3, REL.HOSTILE],
  [0, 4, REL.NEUTRAL], [0, 5, REL.NEUTRAL],
  [1, 2, REL.HOSTILE], [2, 4, REL.HOSTILE], [3, 5, REL.HOSTILE],
];

/** 固定路网：6 条相邻边（近，钱少安全）+ 3 条对径弦（远，钱多要护）。 */
export const ROADS = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `n${i}`, a: i, b: (i + 1) % 6, kind: 'near',
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `f${i}`, a: i, b: i + 3, kind: 'far',
  })),
];

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const inGrid = (r, c) => r >= 0 && r < SPEC.centerSize && c >= 0 && c < SPEC.centerSize;
const isRoadCell = (r, c) => r === SPEC.roadRow;

/** 极简确定性 PRNG：原型要可复现，别用 Math.random。 */
function nextRandom(state) {
  state.rng = (state.rng * 1664525 + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

export function createGame(seed = 20261109) {
  const state = {
    tick: 0,
    rng: seed >>> 0,
    factions: FACTIONS.map((f) => ({ ...f, gold: SPEC.gold.start, alive: true })),
    relations: {},
    // 中心区格子：owner = 势力 id 或 null；building = 是否有楼
    cells: Array.from({ length: SPEC.centerSize }, () =>
      Array.from({ length: SPEC.centerSize }, () => ({ owner: null, building: false })),
    ),
    caravans: [],
    pending: [],       // 中立方向拉来的车，等玩家在集市界面决定贸易 / 扣押
    log: [],
    nextId: 1,
    finished: false,
    result: null,
  };
  for (const [a, b, rel] of INITIAL_PAIRS) state.relations[pairKey(a, b)] = rel;
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      const k = pairKey(a, b);
      if (!(k in state.relations)) state.relations[k] = REL.NEUTRAL;
    }
  }
  note(state, '开局：满金 50 / 上限 50 · 商路已固定 · 中心区待抢');
  return state;
}

export function note(state, text) {
  state.log.unshift({ tick: state.tick, text });
  if (state.log.length > 40) state.log.pop();
}

export function relationOf(state, a, b) {
  if (a === b) return REL.ALLIED;
  return state.relations[pairKey(a, b)] ?? REL.NEUTRAL;
}

/** 敌对判定：敌对和死仇都算"打得起"，但死仇永远不能回退。 */
export const isEnemyRel = (rel) => rel === REL.HOSTILE || rel === REL.FEUD;
export const isTradableRel = (rel) => rel === REL.NEUTRAL || rel === REL.ALLIED;

export function allyCount(state, factionId) {
  let n = 0;
  for (let i = 0; i < 6; i++) if (i !== factionId && relationOf(state, factionId, i) === REL.ALLIED) n++;
  return n;
}

/**
 * 改关系。三条硬规则：
 *  · 死仇永久，不能改回任何状态；
 *  · 联盟上限（玩家最多 allyLimit 个盟友）；
 *  · 背刺 = 死仇（从结盟直接掉到死仇）。
 */
export function setRelation(state, a, b, rel) {
  const key = pairKey(a, b);
  const old = state.relations[key] ?? REL.NEUTRAL;
  if (old === REL.FEUD) {
    note(state, `${FACTIONS[a].name} ↔ ${FACTIONS[b].name} 已是死仇，永不复盟`);
    return { ok: false, reason: 'feud' };
  }
  if (rel === REL.ALLIED) {
    if (allyCount(state, a) >= SPEC.allyLimit && old !== REL.ALLIED) {
      return { ok: false, reason: 'ally-limit' };
    }
    if (allyCount(state, b) >= SPEC.allyLimit && old !== REL.ALLIED) {
      return { ok: false, reason: 'ally-limit' };
    }
  }
  state.relations[key] = rel;
  note(state, `${FACTIONS[a].name} ↔ ${FACTIONS[b].name}：${REL_LABEL[old]} → ${REL_LABEL[rel]}`);
  return { ok: true, old };
}

/** 背刺：结盟关系直接转死仇（与扣押同级）。 */
export function backstab(state, a, b) {
  const key = pairKey(a, b);
  if ((state.relations[key] ?? REL.NEUTRAL) !== REL.ALLIED) {
    return { ok: false, reason: 'not-ally' };
  }
  state.relations[key] = REL.FEUD;
  note(state, `${FACTIONS[a].name} 背刺 ${FACTIONS[b].name} ⇒ 死仇，该方向商路永久封死`);
  return { ok: true };
}

/** 该势力当前能放楼的格子：种子格 + 与己方楼 4 邻相邻的非道路格。 */
export function unlockedCells(state, factionId) {
  const out = [];
  const hasBuilding = [];
  for (let r = 0; r < SPEC.centerSize; r++) {
    for (let c = 0; c < SPEC.centerSize; c++) {
      if (state.cells[r][c].building && state.cells[r][c].owner === factionId) hasBuilding.push([r, c]);
    }
  }
  const [sr, sc] = SEEDS[factionId];
  const seed = state.cells[sr][sc];
  if (!seed.building && (seed.owner === null || seed.owner === factionId)) out.push([sr, sc]);
  const nearOwn = (r, c) => hasBuilding.some(([br, bc]) => Math.abs(br - r) + Math.abs(bc - c) === 1);
  for (let r = 0; r < SPEC.centerSize; r++) {
    for (let c = 0; c < SPEC.centerSize; c++) {
      const cell = state.cells[r][c];
      if (isRoadCell(r, c) || cell.building) continue;
      // owner === factionId 正是"被辐射解锁"的标记，别把它当成不可放；
      // 只有被**别人**占掉的格子才拦住。
      if (cell.owner !== null && cell.owner !== factionId) continue;
      if (cell.owner === factionId || nearOwn(r, c)) out.push([r, c]);
    }
  }
  return out;
}

/**
 * 只写「占领 + 辐射」，不判据、不扣钱。
 *
 * 大六边形地图（map.js）自己有 4 邻域辐射判据，`hand.js` 落牌时用它；
 * 这里给模组提供一个**镜像入口**，把玩家在大地图上盖的楼同步进抽象网格，
 * 让封路 / 积分这些只看 `state.cells` 的规则继续有效。
 * 扣钱只准发生在一处（卡牌 cost），所以这个函数绝不碰金币。
 */
export function claimCell(state, factionId, r, c) {
  if (!inGrid(r, c)) return { ok: false, reason: 'out-of-grid' };
  if (isRoadCell(r, c)) return { ok: false, reason: 'road' };
  const cell = state.cells[r][c];
  if (cell.building || (cell.owner !== null && cell.owner !== factionId)) {
    return { ok: false, reason: 'occupied' };
  }
  cell.owner = factionId;
  cell.building = true;
  // 辐射：把 4 邻域里没主的格子标成己方可建（owner 只是标记，building 才是楼）
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = r + dr, nc = c + dc;
    if (!inGrid(nr, nc) || isRoadCell(nr, nc)) continue;
    const n = state.cells[nr][nc];
    if (n.owner === null && !n.building) n.owner = factionId;
  }
  return { ok: true };
}

/** 放楼 ⇒ 辐射解锁邻域（规则 3）。道路格恒不可建（规则 16）。 */
export function placeBuilding(state, factionId, r, c) {
  if (!inGrid(r, c)) return { ok: false, reason: 'out-of-grid' };
  if (isRoadCell(r, c)) return { ok: false, reason: 'road' };
  const cell = state.cells[r][c];
  if (cell.building || (cell.owner !== null && cell.owner !== factionId)) {
    return { ok: false, reason: 'occupied' };
  }
  if (!unlockedCells(state, factionId).some(([ur, uc]) => ur === r && uc === c)) {
    return { ok: false, reason: 'locked' };
  }
  const f = state.factions[factionId];
  if (f.gold < SPEC.cost.build) return { ok: false, reason: 'poor' };
  f.gold -= SPEC.cost.build;
  claimCell(state, factionId, r, c);
  note(state, `${f.name} 在中心 (${r},${c}) 落楼，邻域已辐射解锁`);
  return { ok: true };
}

/**
 * 封路判据（按 §1.5 的**路段级**解读，待用户核）：
 * 主干道切成 centerSize 个段，每段看它上下两侧格子的归属；
 * 两侧都被"对 owner 敌对/死仇"的势力占着 ⇒ 该段封死。
 * 单侧是敌人 ⇒ 路还通，但对方能派军队拦（见 sendCaravan 的 escorted）。
 */
export function blockedSegments(state, factionId) {
  const blocked = [];
  for (let c = 0; c < SPEC.centerSize; c++) {
    const up = state.cells[SPEC.roadRow - 1][c];
    const down = state.cells[SPEC.roadRow + 1][c];
    const hostile = (cell) =>
      cell.owner !== null && cell.owner !== factionId &&
      isEnemyRel(relationOf(state, factionId, cell.owner));
    if (hostile(up) && hostile(down)) blocked.push(c);
  }
  return blocked;
}

export function canTrade(state, from, to) {
  if (from === to) return { ok: false, reason: 'self' };
  const rel = relationOf(state, from, to);
  if (!isTradableRel(rel)) return { ok: false, reason: 'relation', rel };
  return { ok: true };
}

/** 发车：近路便宜安全钱少，远路钱多但要护航（规则 10）。 */
export function sendCaravan(state, from, to, kind, escorted = false) {
  const check = canTrade(state, from, to);
  if (!check.ok) return check;
  const f = state.factions[from];
  const fee = SPEC.cost.caravan + (escorted ? SPEC.cost.escort : 0);
  if (f.gold < fee) return { ok: false, reason: 'poor' };
  f.gold -= fee;
  const cargo = kind === 'far' ? SPEC.trade.far : SPEC.trade.near;
  const caravan = {
    id: state.nextId++,
    owner: from,
    from,
    to,
    kind,
    cargo,
    escorted,
    ticksLeft: kind === 'far' ? SPEC.trade.travel.far : SPEC.trade.travel.near,
    blocked: false,
  };
  state.caravans.push(caravan);
  note(state, `${f.name} 发车 → ${FACTIONS[to].name}（${kind === 'far' ? '远' : '近'}路 ${cargo} 金${escorted ? ' · 有护航' : ''}）`);
  return { ok: true, caravan };
}

/** 中立来车的两种处理（规则 11/12）。盟友来车只能正常贸易。 */
export function resolveIncoming(state, caravanId, choice) {
  const idx = state.pending.findIndex((p) => p.id === caravanId);
  if (idx < 0) return { ok: false, reason: 'missing' };
  const car = state.pending[idx];
  const rel = relationOf(state, 0, car.owner);
  if (choice === 'seize') {
    if (rel !== REL.NEUTRAL) return { ok: false, reason: 'not-neutral' };
    const gain = Math.min(
      SPEC.gold.cap - state.factions[0].gold,
      car.cargo * SPEC.seizeMultiplier,
    );
    state.factions[0].gold += gain;
    state.relations[pairKey(0, car.owner)] = REL.FEUD;
    note(state, `扣押 ${FACTIONS[car.owner].name} 的来车：+${gain} 金，但立即死仇、永不复盟`);
  } else {
    const gain = Math.min(SPEC.gold.cap - state.factions[0].gold, Math.ceil(car.cargo / 2));
    state.factions[0].gold += gain;
    state.factions[car.owner].gold = Math.min(SPEC.gold.cap, state.factions[car.owner].gold + Math.ceil(car.cargo / 2));
    note(state, `与 ${FACTIONS[car.owner].name} 正常贸易：双方各 +${gain} 金`);
  }
  state.pending.splice(idx, 1);
  return { ok: true };
}

/** 简单 AI：每隔 aiPeriod tick，轮到一个势力做一件最朴素的事。 */
function aiStep(state) {
  const actor = 1 + (Math.floor(state.tick / SPEC.aiPeriod) % 5);
  const roll = nextRandom(state);
  if (roll < 0.34) {
    const cells = unlockedCells(state, actor);
    if (cells.length && state.factions[actor].gold >= SPEC.cost.build) {
      const [r, c] = cells[Math.floor(nextRandom(state) * cells.length)];
      placeBuilding(state, actor, r, c);
    }
  } else if (roll < 0.68) {
    // 找一条能通商的线路发车
    for (let to = 0; to < 6; to++) {
      if (to === actor) continue;
      if (!canTrade(state, actor, to).ok) continue;
      const kind = Math.abs(to - actor) === 3 ? 'far' : 'near';
      const r = sendCaravan(state, actor, to, kind, nextRandom(state) < 0.5);
      if (r.ok) break;
    }
  } else {
    const other = Math.floor(nextRandom(state) * 6);
    if (other !== actor) {
      const rel = relationOf(state, actor, other);
      if (rel === REL.NEUTRAL && nextRandom(state) < 0.5) {
        setRelation(state, actor, other, REL.ALLIED);
      } else if (rel === REL.HOSTILE) {
        setRelation(state, actor, other, REL.NEUTRAL);
      }
    }
  }
}

/** 推进一 tick：商队移动 / 到站结算 / 极慢回金 / AI / 结束判定。 */
export function tick(state) {
  if (state.finished) return state;
  state.tick++;
  if (state.tick % SPEC.gold.regenTicks === 0) {
    for (const f of state.factions) {
      f.gold = Math.min(SPEC.gold.cap, f.gold + SPEC.gold.regenAmount);
    }
  }

  for (const car of [...state.caravans]) {
    const blocked = blockedSegments(state, car.owner).length > 0;
    // 封死是地盘层判定：没护航的商队到段口就得回头（货损）
    if (blocked && !car.escorted) {
      state.caravans.splice(state.caravans.indexOf(car), 1);
      note(state, `${FACTIONS[car.owner].name} 的商队被封死路段挡回，损失 ${car.cargo} 金`);
      continue;
    }
    car.ticksLeft--;
    if (car.ticksLeft > 0) continue;
    state.caravans.splice(state.caravans.indexOf(car), 1);
    if (car.to === 0 && car.owner !== 0) {
      // 别人拉来的车：等玩家在集市界面决定贸易 / 扣押
      state.pending.push({ ...car });
      note(state, `${FACTIONS[car.owner].name} 的车到了你的集市，待处理（贸易 / 扣押）`);
    } else {
      const f = state.factions[car.owner];
      f.gold = Math.min(SPEC.gold.cap, f.gold + car.cargo);
      note(state, `${f.name} 的商队到站：+${car.cargo} 金`);
    }
  }

  if (state.tick % SPEC.aiPeriod === 0) aiStep(state);
  if (state.tick >= SPEC.endTick) {
    state.finished = true;
    state.result = score(state);
    note(state, `结算：${FACTIONS[state.result[0].id].name} 领先（原型用积分，暂无拆家战斗）`);
  }
  return state;
}

/** 原型结算：存活 + 金币 + 中心控制格数（战斗系统还没做，先积分）。 */
export function score(state) {
  return state.factions
    .map((f) => {
      let cells = 0;
      for (const row of state.cells) for (const c of row) if (c.owner === f.id) cells++;
      return { id: f.id, name: f.name, gold: f.gold, cells, total: f.gold + cells * 3 };
    })
    .sort((a, b) => b.total - a.total);
}
