/**
 * P-078 手动修复锁（2026-11-08 用户："建筑脱战一段时间后，上面冒出小锤子按钮，
 * 点一下有 SVG 小动画，锤子打板子，说明在修复"）。
 *
 * 最要紧的一条：**动画播的时候血要真的在涨**。按钮/动画读的是逻辑层的
 * `repairEligible / isRepairing`，不是视图自己设的定时器 —— 否则就是假读数。
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

describe('P-078 脱战计时', () => {
  it('数值只有一处：脱战 4 秒、一段 3.2 秒、每秒回 16% 最大血、大本营排除', () => {
    expect(REPAIR.idleSeconds).toBe(4);
    expect(REPAIR.seconds).toBe(3.2);
    expect(REPAIR.fractionPerSecond).toBe(0.16);
    expect(REPAIR.excludeCore).toBe(true);
  });

  it('刚挨完打没有锤子；3.9 秒还没有；再过 0.2 秒才冒出来', () => {
    const { w, b } = scene();
    hit(w, b);
    expect(b.lastHitAt).toBe(w.elapsed);
    expect(w.repairEligible(b, 'blue')).toBe(false);
    run(w, REPAIR.idleSeconds - 0.1);
    expect(w.repairEligible(b, 'blue')).toBe(false);
    run(w, 0.2);
    expect(w.repairEligible(b, 'blue')).toBe(true);
  });

  it('反证矩阵：满血 / 敌方楼 / 大本营 / 施工中 / 正在修 都不给按钮', () => {
    const { w, b } = scene();
    expect(w.repairEligible(b, 'blue'), '满血').toBe(false);
    expect(w.repairEligible(b, 'red'), '敌方视角').toBe(false);

    const enemy = w['place']('red', 'house', 30, 3, 400);
    enemy.build = 1;
    expect(w.repairEligible(enemy, 'blue'), '敌楼').toBe(false);

    const core = w.coreOf('blue')!;
    core.hp = 100;
    core.lastHitAt = -999;
    expect(w.repairEligible(core, 'blue'), '大本营').toBe(false);

    hit(w, b);
    run(w, REPAIR.idleSeconds + 0.2);
    b.build = 0.5;
    expect(w.repairEligible(b, 'blue'), '施工中').toBe(false);
    b.build = 1;
    expect(w.repairEligible(b, 'blue')).toBe(true);
    expect(w.startRepair(b.id, 'blue')).toBe(true);
    expect(w.repairEligible(b, 'blue'), '正在修不重复派单').toBe(false);
  });
});

describe('P-078 点一下真的在修（不是假动画）', () => {
  it('派单后 repairLeft = REPAIR.seconds，血量按 maxHp 比例逐帧回升', () => {
    const { w, b } = scene();
    hit(w, b);
    const hurtHp = b.hp;
    expect(hurtHp).toBe(400 - damageOf(100 * 2.2, 0));
    run(w, REPAIR.idleSeconds + 0.2);

    expect(w.startRepair(b.id, 'blue')).toBe(true);
    expect(b.repairLeft).toBeCloseTo(REPAIR.seconds, 6);
    expect(w.isRepairing(b.id)).toBe(true);

    const before = b.hp;
    run(w, 1);
    expect(b.hp, '一秒后血真的涨了').toBeGreaterThan(before);
    expect(b.hp - before).toBeCloseTo(400 * REPAIR.fractionPerSecond, 1);
  });

  it('反证：修复中挨一下，锤子立刻停、脱战重新计时', () => {
    const { w, b } = scene();
    hit(w, b, 40);
    run(w, REPAIR.idleSeconds + 0.2);
    expect(w.startRepair(b.id, 'blue')).toBe(true);
    run(w, 0.5);
    const healing = b.hp;
    expect(healing).toBeGreaterThan(b.maxHp - damageOf(40 * 2.2, 0));

    hit(w, b, 40);
    expect(b.repairLeft, '挨打打断修复').toBe(0);
    expect(w.isRepairing(b.id)).toBe(false);
    expect(w.repairEligible(b, 'blue'), '刚挨打不该冒按钮').toBe(false);
    const afterHit = b.hp;
    run(w, 1);
    expect(b.hp, '打断后不许继续回血').toBe(afterHit);
  });

  it('修满自动收工：repairLeft 归零、血量封顶、按钮消失', () => {
    const { w, b } = scene();
    hit(w, b, 10); // 只掉一点，一段就够修满
    run(w, REPAIR.idleSeconds + 0.2);
    expect(w.startRepair(b.id, 'blue')).toBe(true);
    run(w, REPAIR.seconds + 0.1);
    expect(b.hp).toBe(b.maxHp);
    expect(b.repairLeft).toBe(0);
    expect(w.isRepairing(b.id)).toBe(false);
    expect(w.repairEligible(b, 'blue')).toBe(false);
  });

  it('一段修不满时可以再点一次（锤子一下一下敲，不是一键满血）', () => {
    const { w, b } = scene();
    hit(w, b);
    run(w, REPAIR.idleSeconds + 0.2);
    expect(w.startRepair(b.id, 'blue')).toBe(true);
    run(w, REPAIR.seconds + 0.1);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(w.repairEligible(b, 'blue')).toBe(true);
    expect(w.startRepair(b.id, 'blue')).toBe(true);
  });

  it('不允许越过资格直接派单：敌方 / 刚挨打 / 大本营 都返回 false', () => {
    const { w, b } = scene();
    expect(w.startRepair(999999, 'blue')).toBe(false);
    expect(w.startRepair(b.id, 'red')).toBe(false);
    hit(w, b);
    expect(w.startRepair(b.id, 'blue'), '刚挨打').toBe(false);
    const core = w.coreOf('blue')!;
    core.hp = 100;
    core.lastHitAt = -999;
    expect(w.startRepair(core.id, 'blue'), '大本营').toBe(false);
  });
});

describe('P-078 唯一入口', () => {
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
});

describe('P-078 视图层：动画不是假的', () => {
  const view = readFileSync(join(ROOT, 'src/arena/visuals/repairButtons.ts'), 'utf8');
  const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');

  /**
   * 反证：如果哪天有人把动画改成"点一下自己 setTimeout 播 3 秒"，
   * 挨打时锤子还会继续敲 —— 这就是用户最讨厌的假读数。
   */
  it('出现条件与动画开关都读逻辑层，视图不设自己的定时器', () => {
    expect(view).toContain('this.app.world.repairEligible(b, this.side)');
    expect(view).toContain('this.app.world.isRepairing(b.id)');
    expect(view).not.toMatch(/setTimeout\s*\(/);
    expect(view).not.toMatch(/setInterval\s*\(/);
    expect(view).toContain("const state = working ? 'working' : 'ready';");
  });

  it('点击只做派单，能不能修由 world 说了算；每帧投影跟随相机', () => {
    expect(view).toContain('this.app.requestRepair(id)');
    expect(app).toContain("this.world.startRepair(id, 'blue')");
    expect(app).toContain('this.repairButtons.update()');
    expect(app).toContain('projectToScreen(p: { x: number; y: number; z: number })');
    expect(view).toContain('this.app.projectToScreen(anchor)');
  });

  it('SVG 里有板子、锤子、火星，CSS 有摆动/火星关键帧和 working 态', () => {
    expect(view).toContain('class="rp__hammer"');
    expect(view).toContain('class="rp__spark"');
    expect(view).toContain('rp__svg');
    expect(css).toContain('@keyframes rp-swing');
    expect(css).toContain('@keyframes rp-spark');
    expect(css).toContain(".rp[data-state='working'] .rp__fx");
  });

  it('反证：按钮的指针事件不许冒泡到画布手势（否则会被当成放牌/看血量）', () => {
    expect(view).toContain("addEventListener('pointerdown', (ev) => ev.stopPropagation())");
    expect(view).toContain('ev.stopPropagation()');
  });

  /**
   * 真踩到过：第一版把 .rp-layer 写成 z-index 24（想"比 HUD 高一层好点"），
   * 但设置面板挂在 .ahud 里，而 .ahud 自带 z-index 20 就是一层 stacking context ——
   * 面板内部写 55 也压不过外层 24，打开设置时锤子会浮在面板上。
   * 改回 19（低于 HUD）后实测 elementFromPoint 仍能命中按钮、面板也仍在顶层。
   */
  it('覆盖层必须低于 .ahud，设置/调试面板才盖得住锤子', () => {
    const layer = css.slice(css.indexOf('.rp-layer {'), css.indexOf('.rp {'));
    const hud = css.slice(css.indexOf('.ahud {'), css.indexOf('.ahud__top {'));
    expect(layer).toContain('z-index: 19');
    expect(layer).not.toContain('z-index: 24');
    expect(hud).toContain('z-index: 20');
    expect(layer).toContain('pointer-events: none');
  });
});
