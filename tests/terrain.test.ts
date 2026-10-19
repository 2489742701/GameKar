import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { TERRAIN_ORDER, WORLD, type TerrainType } from '@game/config';
import { findNearestClearSpot, generateTerrain } from '@game/world/TerrainGenerator';
import { TileMap } from '@game/world/TileMap';

const plan = (seed: number) => ({
  size: { cols: WORLD.cols, rows: WORLD.rows },
  seed,
  veins: 9,
  clearingRadius: 4,
});

function shares(map: TileMap): Record<TerrainType, number> {
  const out = Object.fromEntries(TERRAIN_ORDER.map((t) => [t, 0])) as Record<TerrainType, number>;
  for (const tile of map) out[tile.terrain]++;
  const total = map.size.cols * map.size.rows;
  for (const t of TERRAIN_ORDER) out[t] = out[t] / total;
  return out;
}

describe('地形生成', () => {
  it.each([1, 20261019, 777, 4242, 98765, 31337])('seed %i 的地块配比能玩', (seed) => {
    const pct = shares(generateTerrain(plan(seed)));

    // 配比由高程分位数决定，所以这几档在换 seed 时几乎不动。
    // 现量（6 个 seed）：水 15.8–16.0%、岸 10.6–11.0%、岩 7.3–15.0%、草 57.8–65.5%。
    // 下面留的余量比现量宽一档，够拦住"阈值写死又淹图"那类回归。
    expect(pct.water).toBeGreaterThan(0.13);
    expect(pct.water).toBeLessThan(0.2);
    expect(pct.sand).toBeGreaterThan(0.08);
    expect(pct.sand).toBeLessThan(0.15);
    expect(pct.rock).toBeGreaterThan(0.03);
    expect(pct.rock).toBeLessThan(0.2);
    expect(pct.grass).toBeGreaterThan(0.5);
    expect(pct.grass).toBeLessThan(0.72);
    expect(pct.vein).toBeGreaterThan(0.003);
  });

  it('出生点周围是干爽草地，且一定能放下一座 2x2', () => {
    const map = generateTerrain(plan(WORLD.seed));
    const home = pos(Math.floor(map.size.cols / 2), Math.floor(map.size.rows / 2));

    for (let d = -2; d <= 2; d++) {
      for (const p of [pos(home.col + d, home.row), pos(home.col, home.row + d)]) {
        expect(map.terrainAt(p)).toBe('grass');
      }
    }
    const spot = findNearestClearSpot(map, home, 2, 2);
    expect(spot).not.toBeNull();
    expect(map.isFree(spot!)).toBe(true);
  });

  it('晶脉按数量出现，且彼此不挤在一起', () => {
    const map = generateTerrain(plan(WORLD.seed));
    const veins: ReturnType<typeof pos>[] = [];
    for (const tile of map) if (tile.terrain === 'vein') veins.push(tile.pos);

    expect(veins.length).toBeGreaterThan(4);
    for (const a of veins) {
      for (const b of veins) {
        if (a === b) continue;
        expect(Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row))).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('同 seed 两次生成逐字节相同', () => {
    const a = generateTerrain(plan(55));
    const b = generateTerrain(plan(55));
    expect(a.rawTerrain).toEqual(b.rawTerrain);
  });
});

describe('TileMap 占位', () => {
  it('claim 只在全部格子可用时写入，否则一格都不动', () => {
    const map = generateTerrain(plan(WORLD.seed));
    const spot = findNearestClearSpot(map, pos(0, 0), 2, 2)!;

    expect(map.claim(spot, 2, 2, 101)).toBe(true);
    // 同一个 2x2 再claim：已被 101 占了，必须整块失败并保留原主
    const overlap = pos(spot.col + 1, spot.row + 1);
    expect(map.claim(overlap, 2, 2, 202)).toBe(false);
    expect(map.buildingAt(spot)).toBe(101);
    expect(map.buildingAt(pos(spot.col + 1, spot.row + 1))).toBe(101);

    map.release(101);
    expect(map.buildingAt(spot)).toBeNull();
  });

  it('水面和岩脊不可建造，越界一律 null', () => {
    const map = generateTerrain(plan(WORLD.seed));
    const water = [...map].find((t) => t.terrain === 'water');
    const rock = [...map].find((t) => t.terrain === 'rock');
    expect(water).toBeTruthy();
    expect(rock).toBeTruthy();
    expect(map.isFree(water!.pos)).toBe(false);
    expect(map.isFree(rock!.pos)).toBe(false);
    expect(map.terrainAt(pos(-1, 0))).toBeNull();
    expect(map.isFree(pos(-1, 0))).toBe(false);
  });
});
