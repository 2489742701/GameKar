/**
 * 大地图的地形与路网（2026-11-09，P-087 重新设计）。
 *
 * 用户口径：「整个地图是一个大的六边形，里面是六芒星形状的道路；
 * 六个人坐在六芒星的六个尖角，边角也合上了；相邻两人最近的那条路还有小道」。
 *
 * 所以：
 *  · 地形 = **大六边形**范围内的像素方块（尖角朝上下），凹角全部补成陆地；
 *  · 六芒星 = 两个交叠三角形的 6 条边，是**道路**，不是地形轮廓；
 *  · 内六边形 = 相邻尖角之间的近路小道（近、安全、钱少）；
 *  · 三条对径 = 穿过中心的远路（钱多，要护航）；
 *  · 中心公共区 = 9×9 方块，与 rules.js 的抽象网格**逐格一一对应**，
 *    主干道那一行恒不可建（道路格），两侧皆敌 ⇒ 封死。
 *
 * 纯数据层，无 three / DOM，可 node 直接测。
 */
export const MAP = {
  cols: 72,
  rows: 64,
  cx: 36,
  cy: 32,
  hexR: 30,       // 大六边形半径（格）
  starR: 22,      // 六芒星尖角半径（格，在六边形内部）
};

/**
 * 中心公共区：9×9，和 `rules.js` 的 `SPEC.centerSize` / `SPEC.roadRow` 对齐。
 * 结构锁会核这两处数值一致 —— 判据只在一处改，不许两份表各写各的。
 */
export const CENTER = {
  col0: MAP.cx - 4,
  row0: MAP.cy - 4,
  size: 9,
  roadRow: 4,
};

const SQRT3 = Math.sqrt(3);

/** 尖角朝上下的正六边形：|x| <= √3/2·R 且 |y| <= R − |x|/√3 */
export function inHex(col, row) {
  const x = col - MAP.cx;
  const y = row - MAP.cy;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  return ax <= (SQRT3 / 2) * MAP.hexR && ay <= MAP.hexR - ax / SQRT3;
}

/** 六芒星六个尖角（6 方主城所在格） */
export const POINTS = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return {
    col: Math.round(MAP.cx + Math.cos(a) * MAP.starR),
    row: Math.round(MAP.cy + Math.sin(a) * MAP.starR),
  };
});

/** 中心公共区（9×9 方块，落在六边形内） */
export function inCenter(col, row) {
  return col >= CENTER.col0 && col < CENTER.col0 + CENTER.size &&
         row >= CENTER.row0 && row < CENTER.row0 + CENTER.size &&
         inHex(col, row);
}

/** 地图格 -> 规则层抽象格 (r,c)；不在中心区返回 null */
export function toAbstract(col, row) {
  if (!inCenter(col, row)) return null;
  return { r: row - CENTER.row0, c: col - CENTER.col0 };
}

/** 规则层抽象格 (r,c) -> 地图格 */
export function fromAbstract(r, c) {
  return { col: CENTER.col0 + c, row: CENTER.row0 + r };
}

/**
 * 中心主干道：与 rules.js 的 roadRow 同一行，横贯整张六边形。
 * 中心 9×9 里的那一段正是规则层「道路格恒不可建 / 两侧皆敌封死」的判据所在，
 * 所以其余道路一律绕开中心公共区 —— 那片是**可以盖楼的公共地盘**。
 */
export function isMainRoad(col, row) {
  return inHex(col, row) && row === CENTER.row0 + CENTER.roadRow;
}

function lineCells(a, b) {
  const steps = Math.max(1, Math.abs(b.col - a.col), Math.abs(b.row - a.row));
  const out = [];
  for (let s = 0; s <= steps; s++) {
    out.push({
      col: Math.round(a.col + ((b.col - a.col) * s) / steps),
      row: Math.round(a.row + ((b.row - a.row) * s) / steps),
    });
  }
  return out;
}

const key = (c) => `${c.col},${c.row}`;

/** 路网统一过滤：六边形内、但不切进中心公共区（那片要能盖楼） */
const roadCell = (c) => inHex(c.col, c.row) && !inCenter(c.col, c.row);

/** 六芒星形状的道路：两个交叠三角形（0-2-4 与 3-5-1）的 6 条边 */
export function starRoads() {
  const seen = new Map();
  for (const tri of [[0, 2, 4], [3, 5, 1]]) {
    for (let i = 0; i < 3; i++) {
      for (const c of lineCells(POINTS[tri[i]], POINTS[tri[(i + 1) % 3]])) {
        if (roadCell(c)) seen.set(key(c), c);
      }
    }
  }
  return [...seen.values()];
}

/** 相邻尖角之间的近路小道（内六边形，近、安全、钱少） */
export function shortcuts() {
  const seen = new Map();
  for (let i = 0; i < 6; i++) {
    for (const c of lineCells(POINTS[i], POINTS[(i + 1) % 6])) {
      if (roadCell(c)) seen.set(key(c), c);
    }
  }
  return [...seen.values()];
}

/** 三条对径远路（钱多，要护航）：到中心公共区边缘为止，不切穿它 */
export function diameterRoads() {
  const seen = new Map();
  for (let i = 0; i < 3; i++) {
    for (const c of lineCells(POINTS[i], POINTS[i + 3])) {
      if (roadCell(c)) seen.set(key(c), c);
    }
  }
  return [...seen.values()];
}

/** 全部可渲染的地形格（六边形内，边角已补上） */
export function terrainCells() {
  const out = [];
  for (let row = 0; row < MAP.rows; row++) {
    for (let col = 0; col < MAP.cols; col++) {
      if (inHex(col, row)) out.push({ col, row });
    }
  }
  return out;
}

const STAR_SET = new Set(starRoads().map(key));
const SHORT_SET = new Set(shortcuts().map(key));
const FAR_SET = new Set(diameterRoads().map(key));

export const ROAD_SETS = { star: STAR_SET, short: SHORT_SET, far: FAR_SET };

/** 一格属于哪类道路：'main' 主干 / 'star' 六芒星 / 'short' 近路 / 'far' 对径 / 'center' 公共区 / null 陆地 */
export function roadKindAt(col, row) {
  const k = key({ col, row });
  if (isMainRoad(col, row)) return 'main';
  if (STAR_SET.has(k)) return 'star';
  if (SHORT_SET.has(k)) return 'short';
  if (FAR_SET.has(k)) return 'far';
  if (inCenter(col, row)) return 'center';
  return null;
}

/** 道路格恒不可建（军队可以站上去拦，见 rules.js 的封路判据） */
export function isRoad(col, row) {
  const k = roadKindAt(col, row);
  return k !== null && k !== 'center';
}
