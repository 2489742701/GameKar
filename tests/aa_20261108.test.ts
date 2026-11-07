/**
 * P-076 对空判据锁（2026-11-08 用户："火炮理论上没办法射击，空军只有箭塔可以射击"）。
 *
 * 这一族锁的要点不是"某个数等于几"，而是**对空资格只有一张表**：
 * 炮塔 / 大本营水晶 / 所有地面兵 / 轰炸机投弹都得跳过飞行单位，
 * 只有箭塔能把它们选成靶子。最后一条用模块注入把判据打开，做反证 ——
 * 逻辑里如果藏了硬编码的 `if (flying) return`，反证会直接红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { AA_SOURCES, CORE, MOBILE, TOWER, canHitAir } from '@arena/config';
import type { ArenaUnit } from '@arena/types';

const ARENA_SRC = fileURLToPath(new URL('../src/arena/', import.meta.url));

function run(w: ArenaWorld, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    w.update(0.05);
    each?.();
  }
}

function instant(
  w: ArenaWorld,
  side: 'blue' | 'red',
  kind: 'arrowTower' | 'cannonTower' | 'house',
  col: number,
  row: number,
  hp: number,
) {
  const b = w['place'](side, kind, col, row, hp);
  b.build = 1; // 跳过施工，锁的是对空判据不是施工
  return b;
}

/** 钉死的飞行靶子：stun 让它不移动不还手，但**仍然可以被选为靶子**。 */
function flyer(w: ArenaWorld, id: number, side: 'blue' | 'red', x: number, z: number): ArenaUnit {
  w.units.push({
    id, side, defId: 'balloon', x, z,
    hp: 200, maxHp: 200, cooldown: 0, stun: 999,
    order: null, detour: 1 as const,
  });
  return w.units.find((u) => u.id === id)!;
}

/** 一座配齐民居的红方塔 + 一个站在它射程正中央的蓝方气球。 */
function towerVsFlyer(w: ArenaWorld, kind: 'arrowTower' | 'cannonTower') {
  const t = instant(w, 'red', kind, 28, 9, kind === 'arrowTower' ? 520 : 640);
  instant(w, 'red', 'house', 36, 9, 220);
  expect(w.isStaffed(t.id)).toBe(true);
  const cx = t.col + t.cols / 2;
  const cz = t.row + t.rows / 2;
  const u = flyer(w, 9501, 'blue', cx - 5, cz); // 距中心 5 格，两座塔的射程都够
  let fired = false;
  run(w, 3, () => {
    if (w.shots.some((s) => s.source === kind)) fired = true;
  });
  return { fired, hp: u.hp };
}

describe('P-076 射程：防御性建筑与主城都更远了，但没把白嫖窗口全关掉', () => {
  it('数值：箭塔 7.8、炮塔 6.8、主城 6.5（旧值 6.8 / 5.6 / 5.5）', () => {
    expect(TOWER.arrow.range).toBe(7.8);
    expect(TOWER.cannon.range).toBe(6.8);
    expect(CORE.attack.range).toBe(6.5);
    expect(TOWER.arrow.range).toBeGreaterThan(6.8);
    expect(TOWER.cannon.range).toBeGreaterThan(5.6);
    expect(CORE.attack.range).toBeGreaterThan(5.5);
  });

  it('箭塔反超移动火炮；炮塔和主城仍留在火炮之下（白嫖窗口只窄了，没消失）', () => {
    expect(TOWER.arrow.range).toBeGreaterThan(MOBILE.range);
    expect(TOWER.cannon.range).toBeLessThan(MOBILE.range);
    expect(CORE.attack.range).toBeLessThan(MOBILE.range);
  });

  it('箭塔卡面射程从 TOWER 读，不许留一个写死的 6.8', () => {
    const cfg = readFileSync(join(ARENA_SRC, 'config.ts'), 'utf8');
    expect(cfg).toContain('TOWER.arrow.range} 格');
    expect(cfg).not.toContain('射程 6.8 格');
  });
});

describe('P-076 对空资格：唯一来源是 AA_SOURCES', () => {
  it('表里只有 arrowTower，其余来源一律 false', () => {
    expect(AA_SOURCES.size).toBe(1);
    expect(AA_SOURCES.has('arrowTower')).toBe(true);
    expect(canHitAir('arrowTower')).toBe(true);
    for (const src of ['cannonTower', 'core', 'unit', 'siege', 'ballista', 'bomber']) {
      expect(canHitAir(src), `${src} 不该有对空资格`).toBe(false);
    }
  });

  it('反证：AA_SOURCES 里多一个来源，上面的 size / 资格断言就得红', () => {
    expect([...AA_SOURCES]).toEqual(['arrowTower']);
    expect(canHitAir('cannonTower')).not.toBe(canHitAir('arrowTower'));
  });

  it('判据只在 config.ts 里定义一次，逻辑层一律走 canHitAir()', () => {
    const files = readdirSync(ARENA_SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'));
    // 只认**定义语句**：注释里提一句表名不算第二个来源
    const owners = files.filter((f) => /export const AA_SOURCES/.test(readFileSync(join(ARENA_SRC, f), 'utf8')));
    expect(owners.map((f) => f.replace(/\\/g, '/'))).toEqual(['config.ts']);

    const world = readFileSync(join(ARENA_SRC, 'ArenaWorld.ts'), 'utf8');
    const uses = world.match(/canHitAir\(/g) ?? [];
    // tickCore / 炮塔溅射 / 塔索敌 / 兵索敌 / 轰炸机选靶 / 轰炸机溅射
    expect(uses.length, `逻辑层对空判断只剩 ${uses.length} 处，检查是不是有人开了硬编码旁路`).toBeGreaterThanOrEqual(5);
    expect(world).not.toMatch(/import[\s\S]{0,400}AA_SOURCES[\s\S]{0,80}from '\.\/config'/);
  });
});

describe('P-076 行为：只有箭塔打得到空军', () => {
  it('炮塔对空军完全不开火：气球一滴血不掉', () => {
    const w = new ArenaWorld({ seed: 761 });
    w.auto.red = false;
    expect(towerVsFlyer(w, 'cannonTower')).toEqual({ fired: false, hp: 200 });
  });

  it('箭塔能拦空军：同一摆法会开火并掉血', () => {
    const w = new ArenaWorld({ seed: 761 });
    w.auto.red = false;
    const r = towerVsFlyer(w, 'arrowTower');
    expect(r.fired).toBe(true);
    expect(r.hp).toBeLessThan(200);
  });

  it('大本营水晶不追空军：红方气球压到主城射程内也不出魔法弹', () => {
    const w = new ArenaWorld({ seed: 762 });
    w.auto.red = false;
    // 蓝方大本营中心 (2.5,9.5)，射程 = 6.5 + 1.5 = 8.0；靶子距中心 6.5，稳稳在内
    const u = flyer(w, 9502, 'red', 9, 9.5);
    let fired = false;
    run(w, 2.5, () => {
      if (w.shots.some((s) => s.source === 'core')) fired = true;
    });
    expect(fired).toBe(false);
    expect(u.hp).toBe(200);
  });

  it('地面兵不把空军当靶子，但同一个位置的地面兵照打不误（对照组）', () => {
    const air = new ArenaWorld({ seed: 763 });
    air.auto.red = false;
    const balloon = flyer(air, 9503, 'red', 13, 10);
    air.units.push({
      id: 9504, side: 'blue', defId: 'archer', x: 12, z: 10,
      hp: 200, maxHp: 200, cooldown: 0, stun: 0,
      order: null, detour: 1 as const,
    });
    run(air, 2.5);
    expect(balloon.hp, '气球不该挨地面兵的箭').toBe(200);

    const ground = new ArenaWorld({ seed: 763 });
    ground.auto.red = false;
    ground.units.push({
      id: 9505, side: 'red', defId: 'knight', x: 13, z: 10,
      hp: 200, maxHp: 200, cooldown: 0, stun: 999,
      order: null, detour: 1 as const,
    });
    const knight = ground.units[0]!;
    ground.units.push({
      id: 9506, side: 'blue', defId: 'archer', x: 12, z: 10,
      hp: 200, maxHp: 200, cooldown: 0, stun: 0,
      order: null, detour: 1 as const,
    });
    run(ground, 2.5);
    expect(knight.hp, '换成地面兵就得掉血，否则上面那条只是"谁都没开火"').toBeLessThan(200);
  });

  it('反证：把炮塔加回对空来源，同一摆法炮塔立刻会打气球（判据真的从表里读）', async () => {
    vi.resetModules();
    vi.doMock('@arena/config', async (orig) => {
      const actual = await orig<typeof import('@arena/config')>();
      const opened = new Set(['arrowTower', 'cannonTower']);
      return { ...actual, AA_SOURCES: opened, canHitAir: (s: string) => opened.has(s) };
    });
    try {
      const { ArenaWorld: OpenedWorld } = await import('@arena/ArenaWorld');
      const w = new OpenedWorld({ seed: 761 });
      w.auto.red = false;
      const r = towerVsFlyer(w, 'cannonTower');
      expect(r.fired).toBe(true);
      expect(r.hp).toBeLessThan(200);
    } finally {
      vi.doUnmock('@arena/config');
    }
  });
});
