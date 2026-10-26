/**
 * 建筑读数 —— 气泡和底部信息卡共用一份。
 *
 * 两处各写一遍的话，改产出口径时必然只改到一个，
 * 于是同一个建筑在屏幕上给出两个说法。
 */

import { RESOURCE_META, TERRAIN, WORKER, type ResourceId } from '@game/config';
import { resourceIcon, type IconName } from './icons';
import { buildingName } from '@game/data/buildings';
import type { Combat } from '@game/systems/Combat';
import { readoutOf, squadNames } from '@game/systems/Readouts';
import type { Building, GameWorld } from '@game/world/GameWorld';

/**
 * 建筑的读数行。
 * `runnersOf` 由调用方给（小人数量是视图侧的状态，世界层不该知道它）；
 * `combat` 可空 —— 没有战斗内核时（早期夹具、素材未加载）血条/小队/弹夹这几行就不出，
 * 而不是给一堆 0 骗人。
 */
export function buildingFacts(
  world: GameWorld,
  b: Building,
  runnersOf?: (id: number) => number,
  combat?: Combat,
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
    out.push(
      `每回合面包 +${b.def.breadPerRound.base + b.def.breadPerRound.perAdjacentField * fields}（贴了 ${fields} 块田）`,
    );
  }
  if (b.def.requiresAdjacent) {
    out.push(`必须贴着${buildingName(b.def.requiresAdjacent)}`);
  }

  if (combat) {
    const r = readoutOf(world, combat, b);
    if (r.squad) out.push(`${squadNames(b)} · ${r.squad.line}`);
    if (r.ammo) out.push(r.ammo.line);
    if (r.hp.frac < 1) out.push(`血量 ${r.hp.hp}/${r.hp.max}`);
    // 头顶那把锤子和这一行读同一个判据：真补到了血才算"修理中"
    if (combat.isRepairing(b.id)) out.push(`修理中 +${WORKER.repairPerSecond}/s`);
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

/**
 * 信息卡右栏：**一行一件事**，每行带标签。
 *
 * 一条硬规矩：**资源一律画图标，不写"金币""面包"这几个字**。
 * 顶栏、托盘、造价用的都是同一套像素图标（`icons.ts` 里画出来的 SVG），
 * 卡片上再写一遍汉字，等于同一件事有三种长相；而且中文字宽，一行两个字就把卡片撑宽。
 *
 * 这一栏也是照着"别让人猜"重写的：
 * - 光写 `−110` 看不出是成本还是产出 → 标"成本"；
 * - 光写 `+0.50/秒` 不知道加的是什么 → 前面挂金币图标；
 * - "派人采 2 条晶脉""跑运输的小人 ×2（来回 6 格路）"这类过程信息不进卡 ——
 *   玩家要的是"这楼花多少、产多少、占几个人"，过程在战场上看。
 */
export interface StatItem {
  icon?: IconName;
  text: string;
}

export interface StatRow {
  label: string;
  items: StatItem[];
  /** 颜色语义：成本偏暗、产出偏亮、缺员警告 */
  tone?: 'cost' | 'gain' | 'warn';
}

export function buildingStats(world: GameWorld, b: Building, combat?: Combat): StatRow[] {
  const rows: StatRow[] = [];

  const cost = b.def.cost ?? {};
  const costs: StatItem[] = [];
  for (const res of ['gold', 'crystal', 'bread'] as const) {
    const amount = cost[res];
    if (!amount) continue;
    costs.push({ icon: resourceIcon[res] ?? 'gold', text: `−${amount}` });
  }
  if (costs.length > 0) rows.push({ label: '成本', items: costs, tone: 'cost' });

  const gains: StatItem[] = [];
  for (const [res, rate] of Object.entries(world.yieldOf(b))) {
    if (!rate) continue;
    gains.push({ icon: resourceIcon[res] ?? 'gold', text: `+${rate.toFixed(2)}/秒` });
  }
  if (b.def.breadPerRound) {
    const fields = world.adjacentOf(b, 'field');
    const per = b.def.breadPerRound.base + b.def.breadPerRound.perAdjacentField * fields;
    gains.push({ icon: 'bread', text: `+${per}/回合` });
  }
  if (gains.length > 0) rows.push({ label: '产出', items: gains, tone: 'gain' });

  if (b.def.population > 0) {
    const short = world.isUnderstaffed(b);
    rows.push({
      label: '人手',
      items: [{ icon: 'pop', text: short ? `${b.def.population}（缺员）` : String(b.def.population) }],
      tone: short ? 'warn' : undefined,
    });
  }
  if (b.def.populationCap) {
    rows.push({ label: '人口', items: [{ icon: 'pop', text: `+${b.def.populationCap}` }], tone: 'gain' });
  }

  if (b.hp < b.def.hp) {
    rows.push({
      label: '血量',
      items: [{ icon: 'heart', text: `${Math.round(b.hp)}/${b.def.hp}` }],
      tone: 'warn',
    });
  }

  if (combat) {
    const r = readoutOf(world, combat, b);
    if (r.squad) rows.push({ label: '兵力', items: [{ text: r.squad.line }] });
    if (r.ammo) rows.push({ label: '弹夹', items: [{ text: r.ammo.line }] });
  }
  return rows;
}
