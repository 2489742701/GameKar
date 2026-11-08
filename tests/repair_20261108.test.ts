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

describe('P-081 数值：时间拉长，总回血量守恒', () => {
  it('脱战 4 秒自动开工、一段 8 秒、每秒 6.4%、大本营排除', () => {
    expect(REPAIR.idleSeconds).toBe(4);
    expect(REPAIR.seconds).toBe(8);
    expect(REPAIR.fractionPerSecond).toBe(0.064);
    expect(REPAIR.excludeCore).toBe(true);
  });

  /** 反证：谁要是把回血率也一起拉长，这条会红 —— 那就不是"时间变长"而是加平衡了。 */
  it('反证：8 × 0.064 与旧版 3.2 × 0.16 完全相等（都是 51.2%）', () => {
    expect(REPAIR.seconds * REPAIR.fractionPerSecond).toBeCloseTo(3.2 * 0.16, 10);
    expect(REPAIR.seconds).toBeGreaterThan(3.2);
    expect(REPAIR.fractionPerSecond).toBeLessThan(0.16);
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

  it('血真的在涨：一秒回 maxHp × 6.4%，动画不是假读数', () => {
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
