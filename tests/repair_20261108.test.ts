/**
 * P-081 **自动修复**锁（2026-11-08 用户改口径："这个修复不需要点按钮，就是自动修复，
 * 那个移动建造的 SVG 小一点，修复的时间要长一点"）。
 *
 * 上一版（P-078）是"脱战后冒小锤子按钮，点一下才修"；现在按钮整个删掉，
 * 脱战够久就**自动开工**，一段没修满自动接下一段，直到修满或再次挨打。
 *
 * 三条红线：
 *   ① 动画播的时候血必须真的在涨（判据 `repairLeft` 只在逻辑层，视图不设定时器）；
 *   ② 时长从 3.2s 拉到 8s，但**总回血量守恒**（8×0.064 = 3.2×0.16 = 51.2%），
 *      不许借"修久一点"偷偷改平衡；
 *   ③ 双方对称自动修（不再只给玩家侧），48 局台账实测 126 → 121 栋，只掉 4%。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { REPAIR } from '@arena/config';
import { damageOf } from '@game/data/units';
import type { ArenaBuilding } from '@arena/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const worldSrc = readFileSync(join(ROOT, 'src/arena/ArenaWorld.ts'), 'utf8');
const view = readFileSync(join(ROOT, 'src/arena/visuals/repairButtons.ts'), 'utf8');
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');

function scene() {
  const w = new ArenaWorld({ seed: 781 });
  w.auto.red = false;
  const b = w['place']('blue', 'house', 3, 3, 400);
  b.build = 1;
  return { w, b };
}

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

function hit(w: ArenaWorld, b: ArenaBuilding, attack = 100): void {
  w['hurtBuilding'](b, attack);
}

describe('维修数值：时间拉长 → 再放慢 (P-081 → P-105)', () => {
  it('脱战 4 秒自动开工、一段 8 秒、每秒 3.8%、大本营排除', () => {
    expect(REPAIR.idleSeconds).toBe(4);
    expect(REPAIR.seconds).toBe(8);
    // 2026-11-16 P-105：用户加了 150 伤导弹之后要"维修的速度更慢一点"，
    // fractionPerSecond 0.064 → 0.038
    expect(REPAIR.fractionPerSecond).toBe(0.038);
    expect(REPAIR.excludeCore).toBe(true);
  });

  /**
   * **P-081 与 P-105 是两件不同的事，别混起来**：
   * - P-081（11-08）只拉长**过程**，一段的总回血量守恒在 51.2%（8×0.064 = 3.2×0.16）；
   * - P-105（11-16）**真的降了总量**：8 × 0.038 = 30.4%，比 51.2% 少四成。
   *
   * 这一轮必须降总量：导弹 150 伤打箭塔（520 血）是 28.8% 一发，
   * 如果回血还是 51.2%/段，一发导弹不到两段就自己长回来了 —— 那张 20 金等于白打。
   */
  it('★ 现在一段的总回血量是 30.4%，**不再**守恒于旧版 51.2%', () => {
    const perSegment = REPAIR.seconds * REPAIR.fractionPerSecond;
    expect(perSegment).toBeCloseTo(0.304, 10);
    // 明确断言"和旧版不相等" —— 防止有人照着 P-081 那条注释又把它改回去
    expect(perSegment).not.toBeCloseTo(3.2 * 0.16, 3);
    expect(perSegment, '必须明显慢于旧版，否则导弹白打').toBeLessThan(0.4);
  });

  it('反证：回血确实慢过导弹的一发（150 伤 ≈ 箭塔 28.8%）', () => {
    // 一支箭塔 520 血：一发导弹掉 150×2.2/520 ≈ 63.5%？不 —— hurtBuilding 已含倍率，
    // 这里只用"一段能修回多少"对比"一发打掉多少"的**比例口径**
    const towerMax = 520;
    const missileDrop = 150 * 2.2;               // 走 hurtBuilding 的实际掉血
    const perSegmentHeal = towerMax * REPAIR.seconds * REPAIR.fractionPerSecond;
    expect(missileDrop, '一发导弹应该打掉超过"一段能修回来"的量').toBeGreaterThan(perSegmentHeal);
  });
});

describe('P-081 脱战到点自动开工（不用点任何按钮）', () => {
  it('反证：刚挨完打 / 3.9 秒时都还没开工；4 秒一过自动开始', () => {
    const { w, b } = scene();
    hit(w, b);
    expect(w.isRepairing(b.id), '刚挨打').toBe(false);
    run(w, REPAIR.idleSeconds - 0.1);
    expect(w.isRepairing(b.id), '还没脱战').toBe(false);
    run(w, 0.2);
    expect(w.isRepairing(b.id), '脱战即开工').toBe(true);
    expect(b.repairLeft).toBeGreaterThan(0);
  });

  it('血真的在涨：一秒回 maxHp × 3.8%，动画不是假读数', () => {
    const { w, b } = scene();
    hit(w, b);
    expect(b.hp).toBe(400 - damageOf(100 * 2.2, 0));
    run(w, REPAIR.idleSeconds + 0.2);
    const before = b.hp;
    run(w, 1);
    expect(b.hp - before).toBeCloseTo(400 * REPAIR.fractionPerSecond, 1);
  });

  it('反证：修到一半挨一下，立刻停工、血停涨、脱战重新计时', () => {
    const { w, b } = scene();
    hit(w, b, 40);
    run(w, REPAIR.idleSeconds + 1);
    expect(w.isRepairing(b.id)).toBe(true);
    const healing = b.hp;
    hit(w, b, 40);
    expect(b.repairLeft, '挨打打断').toBe(0);
    expect(w.isRepairing(b.id)).toBe(false);
    run(w, 1);
    expect(b.hp, '打断后不许继续回血').toBe(healing - damageOf(40 * 2.2, 0));
    expect(w.isRepairing(b.id), '脱战没到点不许又开工').toBe(false);
  });

  it('一段没修满会自动接下一段，直到修满才收工', () => {
    const { w, b } = scene();
    hit(w, b); // 掉 220 > 一段能回的 204.8
    run(w, REPAIR.idleSeconds + REPAIR.seconds + 0.2);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(w.isRepairing(b.id), '自动接力，不需要再点').toBe(true);
    run(w, REPAIR.seconds + 0.2);
    expect(b.hp).toBe(b.maxHp);
    expect(b.repairLeft).toBe(0);
    expect(w.isRepairing(b.id)).toBe(false);
    run(w, 3);
    expect(w.isRepairing(b.id), '满血不许再开工').toBe(false);
  });

  it('大本营 / 施工中 / 满血 都不自动开工', () => {
    const { w, b } = scene();
    const core = w.coreOf('blue')!;
    core.hp = 100;
    core.lastHitAt = -999;
    const under = w['place']('blue', 'house', 8, 3, 400);
    under.build = 0.5;
    under.hp = 200;
    under.lastHitAt = -999;
    // 施工进度会随 update() 自己涨到 1（完工后当然能修），所以这里锁的是**资格**，
    // 在还没推进世界时查一次，别拿"推进 4 秒后"当施工中的证据。
    expect(w.repairEligible(under), '施工中不修').toBe(false);
    expect(w.repairEligible(core), '大本营不修').toBe(false);
    run(w, REPAIR.idleSeconds + 0.5);
    expect(w.isRepairing(core.id), '大本营').toBe(false);
    expect(w.isRepairing(b.id), '满血').toBe(false);
  });
});

describe('P-081 双方对称：自动修复是规则，不是玩家专属操作', () => {
  it('红方的残血楼脱战后也会自己开工', () => {
    const { w } = scene();
    const red = w['place']('red', 'house', 30, 3, 400);
    red.build = 1;
    hit(w, red);
    run(w, REPAIR.idleSeconds + 0.3);
    expect(w.isRepairing(red.id)).toBe(true);
    expect(red.hp).toBeGreaterThan(400 - damageOf(100 * 2.2, 0));
  });

  it('repairEligible 不带 side 时只看规则；带 side 时仍校验阵营', () => {
    const { w, b } = scene();
    hit(w, b);
    // 手工把脱战时刻拨远但不推进世界：否则 tickRepairs 已自动派单，
    // repairLeft>0 会让"资格"正确地返回 false，测的就不是 side 这一条了。
    b.lastHitAt = -999;
    expect(w.repairEligible(b)).toBe(true);
    expect(w.repairEligible(b, 'blue')).toBe(true);
    expect(w.repairEligible(b, 'red')).toBe(false);
  });

  it('手动派单入口仍在，但仍拒绝敌方 / 大本营 / 刚挨打', () => {
    const { w, b } = scene();
    expect(w.startRepair(999999, 'blue')).toBe(false);
    expect(w.startRepair(b.id, 'red'), '满血 + 敌方视角').toBe(false);
    hit(w, b);
    expect(w.startRepair(b.id, 'blue'), '刚挨打').toBe(false);
    const core = w.coreOf('blue')!;
    core.hp = 100;
    core.lastHitAt = -999;
    expect(w.startRepair(core.id, 'blue'), '大本营').toBe(false);
  });

  it('源码反证：自动派单必须不带 side，否则 AI 侧又变成不对称了', () => {
    expect(worldSrc).toContain('if (!this.repairEligible(b)) continue;');
    expect(worldSrc).toContain('repairEligible(b: ArenaBuilding, side?: Side)');
    expect(worldSrc).toContain('if (side && b.side !== side) return false;');
  });
});

describe('P-081 唯一入口与视图', () => {
  it('伤害仍然只有一处 b.hp -=（修复是 +=，不绕过倍率）', () => {
    const writes = worldSrc.split('\n').filter((l) => /\bb\.hp\s*-=/.test(l));
    expect(writes).toHaveLength(1);
    expect(worldSrc).toContain('b.repairLeft = 0;');
    expect(worldSrc).toContain('b.lastHitAt = this.elapsed;');
  });

  it('脱战判据读 REPAIR.idleSeconds，不许在逻辑层写死 4', () => {
    expect(worldSrc).toContain('this.elapsed - b.lastHitAt >= REPAIR.idleSeconds');
    expect(worldSrc).toContain('b.maxHp * REPAIR.fractionPerSecond * dt');
  });

  it('反证：视图不许再画按钮 / 派单 / 自设定时器', () => {
    expect(view).toContain('this.app.world.isRepairing(b.id)');
    expect(view).not.toMatch(/setTimeout\s*\(/);
    expect(view).not.toContain('rp__btn');
    expect(view).not.toContain('requestRepair');
    expect(view).not.toContain("addEventListener('click'");
    expect(app).not.toContain('requestRepair(');
    expect(css).not.toContain('data-state');
  });

  it('SVG 收小：40×32（短横屏 32×26），动画关键帧仍在', () => {
    expect(view).toContain('width="40" height="32"');
    expect(view).toContain('class="rp__hammer"');
    expect(view).toContain('class="rp__spark"');
    expect(css).toContain('.rp__svg { display: block; overflow: visible; width: 40px; height: 32px; }');
    expect(css).toContain('@keyframes rp-swing');
    expect(css).toContain('@keyframes rp-spark');
    expect(css).toContain('.rp__svg { width: 32px; height: 26px; }');
    expect(css).not.toContain('width: 64px');
  });

  it('覆盖层仍低于 .ahud，设置面板盖得住动画', () => {
    const layer = css.slice(css.indexOf('.rp-layer {'), css.indexOf('.rp {'));
    expect(layer).toContain('z-index: 19');
    expect(layer).toContain('pointer-events: none');
  });
});
