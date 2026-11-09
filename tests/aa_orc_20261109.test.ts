/**
 * P-092 对空口径修正 + 兽人远程投矛手（2026-11-09）。
 *
 * 用户："兽人大军里面为什么没有远程单位啊？有远程兽人投矛手呀，缺防空，缺防空"
 *      "为什么这个弓箭手先打地面呢？弓箭手优先打空中单位啊"
 *
 * 确认后的口径（AskUserQuestion 三项全选推荐）：
 *   · AA_SOURCES 从「仅 arrowTower」放宽到「arrowTower + archer + orcThrower」，
 *     炮塔 / 水晶 / 近战 / 移动火炮 / 弩车 / 轰炸机投弹仍不对空；
 *   · 新增 orcThrower 远程投矛单位，混编进「兽人 / 兽人大队」；
 *   · 有对空资格的兵在射程内只要看到空中单位，无条件优先打它。
 *
 * 每条带反证：把判据关掉，锁必须红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { AA_SOURCES, canHitAir, cardById, armySupplyOf } from '@arena/config';
import { UNITS } from '@game/data/units';
import type { ArenaUnit } from '@arena/types';

const ARENA_SRC = fileURLToPath(new URL('../src/arena/', import.meta.url));

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

function unit(
  w: ArenaWorld,
  id: number,
  side: 'blue' | 'red',
  defId: string,
  x: number,
  z: number,
  stun = 999,
): ArenaUnit {
  w.units.push({
    id, side, defId, x, z,
    hp: 200, maxHp: 200, cooldown: 0, stun,
    order: null, detour: 1 as const,
  });
  return w.units.find((u) => u.id === id)!;
}

/** 弓箭手 / 投矛手站 (11,10)；更近的地面兵 (12,10)，稍远的空中 (15,10)。 */
function priorityWorld(shooter: string) {
  const w = new ArenaWorld({ seed: 9201 });
  w.auto.red = false;
  const ground = unit(w, 9601, 'red', 'knight', 12, 10);
  const air = unit(w, 9602, 'red', 'balloon', 15, 10);
  unit(w, 9603, 'blue', shooter, 11, 10, 0);
  return { w, ground, air };
}

describe('兽人阵营补远程 + 防空', () => {
  it('兽人 / 兽人大队是「近战 + 投矛手」混编，总人数不变', () => {
    const small = cardById('orcs');
    const big = cardById('orcsBig');
    expect(small.squad).toEqual([
      { unitId: 'orc', count: 1 }, { unitId: 'orcThrower', count: 1 },
    ]);
    expect(big.squad).toEqual([
      { unitId: 'orc', count: 2 }, { unitId: 'orcThrower', count: 2 },
    ]);
    const total = (c: { squad?: { count: number }[] }) =>
      (c.squad ?? []).reduce((n, s) => n + s.count, 0);
    expect(total(small)).toBe(2);
    expect(total(big)).toBe(4);
    expect(small.blurb).toContain('投矛手');
    expect(big.blurb).toContain('防空');
  });

  it('orcThrower 是兽人阵营的远程，能对空；近战 orc 不能', () => {
    const d = UNITS['orcThrower'];
    expect(d).toBeDefined();
    expect(d.role).toBe('ranged');
    expect(d.range).toBeGreaterThan(UNITS['orc']!.range);
    expect(d.projectile).toBe('arrow');
    expect(d.headBands).toEqual(UNITS['orc']!.headBands); // 还是兽人那张脸
    expect(canHitAir('orcThrower')).toBe(true);
    expect(canHitAir('orc')).toBe(false);
  });

  it('兽人卡的后勤口径没被混编改坏：不占人口、每人双份面包', () => {
    expect(armySupplyOf(cardById('orcs'))).toEqual({ popPerMan: 0, breadPerMan: 2 });
    expect(armySupplyOf(cardById('orcsBig'))).toEqual({ popPerMan: 0, breadPerMan: 2 });
  });

  it('出兵链路真的生成两种兵（不是只改了卡面数据）', () => {
    const w = new ArenaWorld({ seed: 9204 });
    w['spawnSquad']('blue', cardById('orcs').squad ?? [], 10, 10, false, 2, 0);
    expect(w.units.map((u) => u.defId).sort()).toEqual(['orc', 'orcThrower']);
    const big = new ArenaWorld({ seed: 9204 });
    big['spawnSquad']('blue', cardById('orcsBig').squad ?? [], 10, 10, false, 2, 0);
    expect(big.units.map((u) => u.defId).sort()).toEqual([
      'orc', 'orc', 'orcThrower', 'orcThrower',
    ]);
  });

  it('反证：AA_SOURCES 里没有的部分仍然一律 false', () => {
    expect(AA_SOURCES.size).toBe(3);
    for (const src of ['cannonTower', 'core', 'unit', 'siege', 'ballista', 'bomber', 'knight', 'orc']) {
      expect(canHitAir(src)).toBe(false);
    }
    expect(canHitAir('arrowTower')).toBe(true);
  });
});

describe('★ 弓箭手 / 投矛手优先打空中', () => {
  it('弓箭手：近处地面兵贴脸，仍先打稍远的气球', () => {
    const { w, ground, air } = priorityWorld('archer');
    run(w, 2.5);
    expect(air.hp, '气球必须掉血').toBeLessThan(200);
    expect(ground.hp, '贴脸的地面兵不该先挨打').toBe(200);
  });

  it('兽人投矛手：同样优先打空中，兽人阵营这才有了防空', () => {
    const { w, ground, air } = priorityWorld('orcThrower');
    run(w, 2.5);
    expect(air.hp).toBeLessThan(200);
    expect(ground.hp).toBe(200);
  });

  it('没有空中目标时，弓箭手照旧打地面兵（不能为了防空把地面输出弄丢）', () => {
    const w = new ArenaWorld({ seed: 9202 });
    w.auto.red = false;
    const ground = unit(w, 9611, 'red', 'knight', 12, 10);
    unit(w, 9612, 'blue', 'archer', 11, 10, 0);
    run(w, 2.5);
    expect(ground.hp).toBeLessThan(200);
  });

  it('不对空的兵（弩手 / 兽人 / 移动火炮 / 弩车）仍打不到气球', () => {
    for (const defId of ['crossbowman', 'orc', 'mobileCannon', 'ballista']) {
      const w = new ArenaWorld({ seed: 9203 });
      w.auto.red = false;
      const air = unit(w, 9620, 'red', 'balloon', 13, 10);
      unit(w, 9621, 'blue', defId, 12, 10, 0);
      run(w, 2.0);
      expect(air.hp, `${defId} 不该打得到空中`).toBe(200);
    }
  });

  it('反证：把 archer 从 AA_SOURCES 拿掉，弓箭手就不再打空中', async () => {
    vi.resetModules();
    vi.doMock('@arena/config', async (orig) => {
      const actual = await orig<typeof import('@arena/config')>();
      const opened = new Set(['arrowTower', 'orcThrower']);
      return { ...actual, AA_SOURCES: opened, canHitAir: (s: string) => opened.has(s) };
    });
    try {
      const { ArenaWorld: ClosedWorld } = await import('@arena/ArenaWorld');
      const w = new ClosedWorld({ seed: 9201 });
      w.auto.red = false;
      const air = unit(w, 9631, 'red', 'balloon', 15, 10);
      const ground = unit(w, 9632, 'red', 'knight', 12, 10);
      unit(w, 9633, 'blue', 'archer', 11, 10, 0);
      const steps = Math.round(2.5 / 0.05);
      for (let i = 0; i < steps; i++) w.update(0.05);
      expect(air.hp, '没有对空资格就不该掉血').toBe(200);
      expect(ground.hp, '这时该回头打地面兵').toBeLessThan(200);
    } finally {
      vi.doUnmock('@arena/config');
    }
  });
});

describe('结构锁：兵种索敌按 defId 查表，笼统的 unit 不许回来', () => {
  it('ArenaWorld 里兵索敌用 canHitAir(u.defId)，且优先段真的会 return', () => {
    const world = readFileSync(join(ARENA_SRC, 'ArenaWorld.ts'), 'utf8');
    expect(world).toContain('canHitAir(u.defId)');
    expect(world).toContain('if (air) return air;');
    // 反证：笼统的 'unit' 会把所有地面兵一刀切，弓箭手永远打不了空中
    expect(world).not.toContain("canHitAir('unit')");
    expect("if (!canHitAir('unit') && flying) continue;").toContain("canHitAir('unit')");
  });
});
