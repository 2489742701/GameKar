/**
 * 建筑读数 —— 气泡和底部信息卡共用一份。
 *
 * 两处各写一遍的话，改产出口径时必然只改到一个，
 * 于是同一个建筑在屏幕上给出两个说法。
 */

import { RESOURCE_META, TERRAIN, type ResourceId } from '@game/config';
import { buildingName } from '@game/data/buildings';
import type { Building, GameWorld } from '@game/world/GameWorld';

/**
 * 建筑的读数行。
 * `runnersOf` 由调用方给（小人数量是视图侧的状态，世界层不该知道它）。
 */
export function buildingFacts(
  world: GameWorld,
  b: Building,
  runnersOf?: (id: number) => number,
): string[] {
  const out: string[] = [];
  const yields = world.yieldOf(b);
  for (const [res, rate] of Object.entries(yields)) {
    if (!rate) continue;
    out.push(`${RESOURCE_META[res as ResourceId].label} +${rate.toFixed(2)}/s`);
  }

  const claims = world.claimsOf(b);
  if (claims.length > 0) {
    out.push(`派人采 ${claims.length} 条晶脉：${claims.map((c) => `${c.tiles} 格`).join('、')}`);
  } else if (b.def.veinWork) {
    out.push(b.built ? '附近没有晶脉，没派人出去' : '建成后才会去附近找晶脉');
  }

  const runners = runnersOf?.(b.id) ?? 0;
  if (runners > 0) {
    out.push(`跑运输的小人 ×${runners}（来回 ${Math.max(...claims.map((c) => c.tiles), 1) * 2} 格路）`);
  }
  if (b.def.population > 0) {
    const short = world.isUnderstaffed(b);
    out.push(short ? `要 ${b.def.population} 人口 · 缺员，不干活` : `要 ${b.def.population} 人口 · 人手齐`);
  }
  if (b.def.breadPerRound) {
    const fields = world.adjacentOf(b, 'field');
    out.push(`每回合面包 +${b.def.breadPerRound.base + b.def.breadPerRound.perAdjacentField * fields}（贴了 ${fields} 块田）`);
  }
  if (b.def.requiresAdjacent) {
    out.push(`必须贴着${buildingName(b.def.requiresAdjacent)}`);
  }
  return out;
}

/** 一格地形对建造意味着什么：能不能盖、盖了会不会毁资源。 */
export function tileMeaning(world: GameWorld, p: { col: number; row: number }): string {
  const terrain = world.map.terrainAt(p);
  if (!terrain) return '边界外';
  const spec = TERRAIN[terrain];
  if (!spec.buildable) return '不可建造';
  if (spec.destructible) return '盖这里要毁掉矿脉';
  return world.map.buildingAt(p) === null ? '可建造' : '已被占用';
}
