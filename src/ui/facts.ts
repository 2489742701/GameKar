/**
 * 建筑读数 —— 气泡和底部信息卡共用一份。
 *
 * 两处各写一遍的话，改产出口径时必然只改到一个，
 * 于是同一个建筑在屏幕上给出两个说法。
 */

import { RESOURCE_META, TERRAIN, type ResourceId } from '@game/config';
import type { Building, GameWorld } from '@game/world/GameWorld';

export function buildingFacts(world: GameWorld, b: Building): string[] {
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
  if (b.def.population > 0) out.push(`占人口 ${b.def.population}`);
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
