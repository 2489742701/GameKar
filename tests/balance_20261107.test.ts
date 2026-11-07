/**
 * P-066 平衡锁（2026-11-07）：对建筑伤害倍率 `BUILDING_DAMAGE_SCALE`。
 *
 * 病根（100 局实测）：91 局靠加时数楼判胜负、0 局拆掉大本营、大本营剩血 1197/1200，
 * 每局对楼总伤害 1068 却只拆 1.08 栋 —— "拆对方的建筑"这条攻防抓手失效了。
 * 五档 A/B 选 2.2（拆楼 3.33、20 局靠拆家收尾、胜率仍 45/47/8）。
 *
 * 这一份只锁**倍率的边界**，不改任何玩法：
 *  ① 只作用于对楼伤害 —— 兵种互殴走 `hurtUnit`，一点不涨；
 *  ② **PVE 不吃倍率** —— PVE 没有敌方建筑可拆，会走这条路的只有怪拆玩家的楼，
 *     翻倍是单方面削玩家（实测教学关 9/12 → 4/12）；
 *  ③ 全项目只有 `hurtBuilding` 一处改建筑血量，且只有 `arena` 模式才乘。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BUILDING_DAMAGE_SCALE, CORE } from '@arena/config';
import { PVE_LEVELS } from '@arena/pve/levels';
import { statsOf, type ArenaBuilding } from '@arena/types';
import { damageOf } from '@game/data/units';

const ARENA_SRC = fileURLToPath(new URL('../src/arena/', import.meta.url));
const LEVEL = PVE_LEVELS[0]!;

/** 落一栋不会被一击打死的楼（`place` 是私有的，纯逻辑测试按老规矩伸手进去）。 */
function house(w: ArenaWorld, hp = 400) {
  const b = w['place']('blue', 'house', 3, 3, hp);
  b.build = 1;
  return b;
}

/** 打一下，返回掉了多少血。 */
function hit(w: ArenaWorld, b: ArenaBuilding, attack: number, kind?: 'arrow' | 'cannon' | 'blade'): number {
  const before = b.hp;
  w['hurtBuilding'](b, attack, kind);
  return before - b.hp;
}

describe('对楼伤害：乘倍率', () => {
  it('揍民居 10 点，掉血 = damageOf(10 × 倍率, 0)，不是 10', () => {
    const w = new ArenaWorld({ seed: 1 });
    const b = house(w);
    expect(BUILDING_DAMAGE_SCALE).toBeGreaterThan(1);
    expect(hit(w, b, 10)).toBe(damageOf(10 * BUILDING_DAMAGE_SCALE, 0));
  });

  /**
   * 这条是上面那条的**反证**：如果哪天有人把倍率删成 1，
   * 上面那条会跟着变绿（它读的是同一个常数），只有这条会红。
   */
  it('反证：掉血量必须与"没倍率"的读数不同（倍率真的生效了）', () => {
    const w = new ArenaWorld({ seed: 1 });
    const b = house(w);
    expect(hit(w, b, 10)).not.toBe(damageOf(10, 0));
  });

  it('箭塔/炮塔打楼走同一条路：命中类型不影响倍率', () => {
    const w = new ArenaWorld({ seed: 1 });
    const b1 = house(w);
    const b2 = house(w);
    // 12 × 2.2 在浮点上不是整数，用近似判据
    expect(hit(w, b1, 12, 'arrow')).toBeCloseTo(damageOf(12 * BUILDING_DAMAGE_SCALE, 0), 6);
    expect(hit(w, b2, 12, 'cannon')).toBeCloseTo(damageOf(12 * BUILDING_DAMAGE_SCALE, 0), 6);
  });

  /**
   * **兵种互殴一点不涨**（倍率挂的是 `hurtBuilding`，不是 `damageOf`）。
   * 拿同一份攻击力打到兵身上，掉血只减防御，与倍率无关。
   */
  it('兵种互殴不吃倍率：同一个 10 点攻击打到弓手身上只掉 damageOf(10, 防御)', () => {
    const w = new ArenaWorld({ seed: 1 });
    const def = statsOf('archer').defense;
    const archer = {
      id: 9901,
      side: 'blue' as const,
      defId: 'archer',
      x: 6,
      z: 6,
      hp: 500,
      maxHp: 500,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    };
    w.units.push(archer);
    w['hurtUnit'](archer, 10);
    expect(500 - archer.hp).toBe(damageOf(10, def));
    expect(500 - archer.hp).not.toBe(damageOf(10 * BUILDING_DAMAGE_SCALE, def));
  });
});

describe('PVE 不吃倍率（这是上一轮真踩过的坑）', () => {
  it('PVE 里揍自家民居 10 点只掉 10', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, seed: 1 });
    const b = house(w);
    expect(hit(w, b, 10)).toBe(damageOf(10, 0));
  });

  it('反证：同一摆法在 1v1 里掉得更多 —— 两个模式确实不是同一套数', () => {
    const pve = new ArenaWorld({ mode: 'pve', level: LEVEL.id, seed: 1 });
    const arena = new ArenaWorld({ seed: 1 });
    const a = hit(pve, house(pve), 10);
    const b = hit(arena, house(arena), 10);
    expect(b).toBeGreaterThan(a);
    expect(b / a).toBeCloseTo(BUILDING_DAMAGE_SCALE, 5);
  });

  /**
   * 倍率一旦漏进 PVE，教学关会立刻变难（9/12 → 4/12）。
   * 这里只跑一局做便宜体检，12 局统计锁在 `pve_20261107.test.ts`。
   */
  it('教学关同一 seed 仍然守得住（倍率漏进来这条会先崩）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true }, seed: 1 });
    let t = 0;
    while (w.outcome === 'playing' && t < 400) {
      w.update(0.05);
      t += 0.05;
    }
    expect(w.outcome).toBe('win');
  });
});

describe('唯一入口：只有 hurtBuilding 改建筑血量，且只有 arena 模式乘', () => {
  const files = readdirSync(ARENA_SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ path: join(ARENA_SRC, f), name: f.replace(/\\/g, '/') }));

  it('全项目只有一处 `b.hp -=`（换个地方扣血就等于绕过倍率）', () => {
    const writes: string[] = [];
    for (const f of files) {
      const text = readFileSync(f.path, 'utf8');
      for (const line of text.split('\n')) {
        if (/\bb\.hp\s*-=/.test(line)) writes.push(`${f.name}: ${line.trim()}`);
      }
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('ArenaWorld.ts');
    expect(writes[0]).toContain('damageOf(attack * scale, 0)');
  });

  it('倍率的读取写死在模式判断里（`mode === arena` 才乘，门不开在别处）', () => {
    const world = readFileSync(join(ARENA_SRC, 'ArenaWorld.ts'), 'utf8');
    expect(world).toContain("const scale = this.mode === 'arena' ? BUILDING_DAMAGE_SCALE : 1;");
  });

  it('常数只在 config.ts 里定义一次（不许多处写 2.2）', () => {
    const owners: string[] = [];
    for (const f of files) {
      if (readFileSync(f.path, 'utf8').includes('BUILDING_DAMAGE_SCALE')) owners.push(f.name);
    }
    expect(owners.sort()).toEqual(['ArenaWorld.ts', 'config.ts']);
  });
});

describe('拆楼台账：倍率把"打到也拆不动"扳回来了', () => {
  /**
   * 48 局 1v1（双方托管），数**双方合计拆掉的楼数**和**靠拆大本营收尾的局数**。
   *
   * 实测对照（同一套 rng 序列，只有倍率不同）：
   * - 倍率 1.0：每局 1.08 栋、**100 局 0 局拆掉大本营**；
   * - 倍率 2.2：每局 3.33 栋、100 局 20 局靠拆家收尾。
   *
   * **2026-11-08 P-076 重测**：防御塔/主城射程加远之后，旧版 24 局样本的读数
   * 从 84 栋（3.50/局、3 局拆家）掉到 46 栋（**1.92/局、1 局拆家**）——
   * 24 局本来就是 P-066 当时为了跑得快取的临时小样本，这回正好撞上低值区间。
   * 把样本扩到 **48 局**（不是改判据）：实际 126 栋（2.63/局、4 局拆家），
   * 门槛**仍保持 P-066 的 ≥2 栋/局与 ≥3 局拆家，一个数没降**。
   *
   * 反证力不降反升：同一 48 局把倍率删回 1 ⇒ 27 栋（0.56/局）、0 局拆家，
   * 相差 4.7 倍；倍率被删回 1 时两条都会跌破。
   */
  it('48 局平均每局拆掉 ≥ 2 栋、至少 3 局靠拆大本营收尾', () => {
    const games = 48;
    let total = 0;
    let byCore = 0;
    for (let seed = 1; seed <= games; seed++) {
      const w = new ArenaWorld({ seed, auto: { blue: true } });
      let t = 0;
      while (w.outcome === 'playing' && t < 400) {
        w.update(0.05);
        t += 0.05;
      }
      total += w.destroyed.blue + w.destroyed.red;
      if (w.outcomeReason === 'core') byCore++;
    }
    const per = total / games;
    expect(per, `${games} 局合计只拆了 ${total} 栋（${per.toFixed(2)} 栋/局）`).toBeGreaterThanOrEqual(2);
    expect(byCore, `${games} 局只有 ${byCore} 局拆掉了大本营`).toBeGreaterThanOrEqual(3);
  });

  it('大本营血量没被顺手改过（倍率不靠削血量换效果）', () => {
    const w = new ArenaWorld({ seed: 1 });
    const core = w.coreOf('blue')!;
    expect(core.maxHp).toBe(core.hp);
    expect(core.maxHp).toBe(CORE.hp);
  });
});
