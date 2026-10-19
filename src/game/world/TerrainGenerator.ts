/**
 * 地形生成 —— 一张会自己长出湖、山脉和晶脉的地图。
 *
 * 没有美术资产也能立刻玩起来的关键：噪声负责"像那么回事"，
 * 规则负责"必须能玩"（出生点一定干爽，晶脉一定够得着）。
 */

import type { FlatSize, GridPos } from '@engine/math/Grid';
import { pos } from '@engine/math/Grid';
import { Random } from '@engine/math/Random';
import { fbm, remap } from '@engine/math/Noise';
import { TERRAIN_ORDER, type TerrainType } from '@game/config';
import { TileMap } from './TileMap';

export interface TerrainPlan {
  size: FlatSize;
  seed: number;
  /** 晶脉条数：经济上限的物理来源 */
  veins: number;
  /** 出生点周围强制变成草原的半径（格） */
  clearingRadius: number;
}

/**
 * 目标配比。阈值不是拍出来的绝对高度，而是"这张图的高程排序里的第几成"：
 * 换 seed、换噪声频率都不会让地图淹掉——分布本身说了算。
 */
const WATER_FRACTION = 0.16;
const SHORE_FRACTION = 0.26;
const ROCK_FRACTION = 0.84;
/** 岩脊还要看湿度：只有一半的"高山"会露石头，其余留给草地做山坡 */
const ROCK_MOISTURE = 0.46;

function codeOf(type: TerrainType): number {
  return TERRAIN_ORDER.indexOf(type);
}

export function generateTerrain(plan: TerrainPlan): TileMap {
  const { size, seed } = plan;
  const cell = (col: number, row: number) => row * size.cols + col;
  const total = size.cols * size.rows;
  const layer = new Uint8Array(total);
  const home = pos(Math.floor(size.cols / 2), Math.floor(size.rows / 2));

  // 第一遍：把高程摊平存下来（已经含"边缘下沉"）
  const elevation = new Float32Array(total);
  const moisture = new Float32Array(total);

  for (let row = 0; row < size.rows; row++) {
    for (let col = 0; col < size.cols; col++) {
      const e = fbm(col, row, { seed, frequency: 1 / 15, octaves: 5, gain: 0.52 });
      const m = fbm(col, row, { seed: seed + 7919, frequency: 1 / 10, octaves: 3 });

      // 越靠边越低：自然形成"世界尽头是海"，也省掉一套边界裁剪规则
      const edge = Math.min(col, row, size.cols - 1 - col, size.rows - 1 - row);
      elevation[cell(col, row)] = e - remap(edge, 0, 6, 0.22, 0);
      moisture[cell(col, row)] = m;
    }
  }

  // 第二遍：按分位数切档
  const sorted = Float32Array.from(elevation).sort();
  const quantile = (fraction: number) => sorted[Math.round(fraction * (sorted.length - 1))]!;
  const waterCut = quantile(WATER_FRACTION);
  const shoreCut = quantile(SHORE_FRACTION);
  const rockCut = quantile(ROCK_FRACTION);

  for (let row = 0; row < size.rows; row++) {
    for (let col = 0; col < size.cols; col++) {
      const i = cell(col, row);
      const e = elevation[i]!;
      let type: TerrainType;
      if (e < waterCut) type = 'water';
      else if (e < shoreCut) type = 'sand';
      else if (e > rockCut && moisture[i]! > ROCK_MOISTURE) type = 'rock';
      else type = 'grass';

      // 出生点圈定干爽腹地，并沿十字留一条通路
      const d = Math.max(Math.abs(col - home.col), Math.abs(row - home.row));
      if (d <= plan.clearingRadius && type !== 'grass') type = 'grass';
      if (d <= plan.clearingRadius + 1 && (col === home.col || row === home.row)) type = 'grass';

      layer[i] = codeOf(type);
    }
  }

  const map = new TileMap(size, layer);
  scatterVeins(map, plan, home);
  return map;
}

/** 晶脉散布：要求彼此隔开，且必须离出生点可达（不能孤在水里）。 */
function scatterVeins(map: TileMap, plan: TerrainPlan, home: GridPos): void {
  const rng = new Random(plan.seed ^ 0x5eed);
  const placed: GridPos[] = [];
  const maxTries = plan.veins * 60;

  for (let tries = 0; tries < maxTries && placed.length < plan.veins; tries++) {
    const p = pos(rng.int(2, map.size.cols - 2), rng.int(2, map.size.rows - 2));
    if (map.terrainAt(p) !== 'grass') continue;

    const tooClose = placed.some((q) => Math.max(Math.abs(q.col - p.col), Math.abs(q.row - p.row)) < 4);
    if (tooClose) continue;

    // 太远的矿脉等于没有：竖屏视野小，够不着的资源只会让人烦躁
    const distFromHome = Math.max(Math.abs(p.col - home.col), Math.abs(p.row - home.row));
    if (distFromHome > Math.min(map.size.cols, map.size.rows) / 2 - 2) continue;

    map.setTerrain(p, 'vein');
    // 矿点周围点缀沙地，视觉上像被开采过
    for (const d of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = pos(p.col + d[0], p.row + d[1]);
      if (map.terrainAt(n) === 'grass' && rng.chance(0.55)) map.setTerrain(n, 'sand');
    }
    placed.push(p);
  }
}

/** 找一个能放下 w x h 且最靠近出生点的落位，开局摆放起始建筑用。 */
export function findNearestClearSpot(
  map: TileMap,
  anchor: GridPos,
  cols: number,
  rows: number,
): GridPos | null {
  const order: GridPos[] = [];
  for (const tile of map) order.push(tile.pos);

  order.sort((a, b) => {
    const da = Math.hypot(a.col - anchor.col, a.row - anchor.row);
    const db = Math.hypot(b.col - anchor.col, b.row - anchor.row);
    return da - db;
  });

  for (const origin of order) {
    if (origin.col + cols > map.size.cols || origin.row + rows > map.size.rows) continue;
    let ok = true;
    for (let r = 0; r < rows && ok; r++) {
      for (let c = 0; c < cols; c++) {
        if (!map.isFree(pos(origin.col + c, origin.row + r))) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return origin;
  }
  return null;
}
