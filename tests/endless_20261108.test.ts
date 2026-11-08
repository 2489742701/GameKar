/**
 * **1v1 无尽模式**（2026-11-08 用户纠正："我说的无尽模式是 1V1 无尽，
 * 就是不限时间一直打"）。
 *
 * 不是无限波次塔防！它和 `arena` 共用场地 / 双方 AI / 出牌 / 后勤 / 对楼倍率，
 * **唯一差别是没有时间出口**：不进加时、不按存活楼数积分，
 * 只有拆掉某一方大本营才结束。时钟改成向上计时。
 *
 * 最要紧的一条反证：把 MATCH.seconds 塞回无尽判据，下面"打过 5 分钟仍在进行"会红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BUILDING_DAMAGE_SCALE, FIELD, MATCH } from '@arena/config';
import { damageOf } from '@game/data/units';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const world = readFileSync(join(ROOT, 'src/arena/ArenaWorld.ts'), 'utf8');
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const menu = readFileSync(join(ROOT, 'src/arena/StartMenu.ts'), 'utf8');
const entry = readFileSync(join(ROOT, 'src/arena/main.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');
const types = readFileSync(join(ROOT, 'src/arena/types.ts'), 'utf8');
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

describe('1v1 无尽：骨架和对战完全一样', () => {
  it('字段/入口都认得 endless 这个模式', () => {
    expect(types).toContain("mode?: 'arena' | 'pve' | 'endless'");
    expect(world).toContain("readonly mode: 'arena' | 'pve' | 'endless'");
    expect(app).toContain("mode?: 'arena' | 'pve' | 'endless'");
  });

  it('用的是 1v1 场地、双方大本营、红方 AI 槽；不是 PVE 波次', () => {
    const w = new ArenaWorld({ seed: 41, mode: 'endless' });
    expect(w.field.cols).toBe(FIELD.cols);
    expect(w.pve).toBeNull();
    expect(w.players.map((p) => p.side)).toEqual(['blue', 'red']);
    expect(w.coreOf('blue')).not.toBeNull();
    expect(w.coreOf('red')).not.toBeNull();
  });

  it('对楼伤害吃和 1v1 相同的倍率（无尽只是去掉时限，不是换一套数值）', () => {
    const w = new ArenaWorld({ seed: 42, mode: 'endless' });
    const b = w['place']('blue', 'house', 3, 3, 400);
    w['hurtBuilding'](b, 10);
    expect(400 - b.hp).toBe(damageOf(10 * BUILDING_DAMAGE_SCALE, 0));
  });
});

describe('1v1 无尽：没有时间出口', () => {
  /**
   * 反证：同一个 seed、同样把 elapsed 拨到「常规 + 加时 + 60 秒」，
   * 对战会立刻结算，无尽必须还在打。这比"断言一个布尔常量"硬得多。
   */
  it('打过 5 分钟仍然 playing；同样条件下普通对战已经结算', () => {
    const endless = new ArenaWorld({ seed: 43, mode: 'endless' });
    endless.auto.red = false;
    endless.elapsed = MATCH.seconds + MATCH.overtimeSeconds + 60;
    endless.update(0.05);
    expect(endless.outcome).toBe('playing');
    expect(endless.overtime).toBe(false);

    const normal = new ArenaWorld({ seed: 43 });
    normal.auto.red = false;
    normal.elapsed = MATCH.seconds + MATCH.overtimeSeconds + 60;
    normal.update(0.05);
    expect(normal.outcome).not.toBe('playing');
  });

  it('没有倒计时：timeLeft 是 Infinity，summary 报「已打了多久」', () => {
    const w = new ArenaWorld({ seed: 44, mode: 'endless' });
    w.auto.red = false;
    expect(w.timeLeft).toBe(Number.POSITIVE_INFINITY);
    expect(w.summary().endless).toBe(true);
    expect(w.summary().elapsed).toBe(0);
    run(w, 6);
    expect(w.summary().elapsed).toBeGreaterThanOrEqual(6);
    expect(w.summary().overtime).toBe(false);
  });

  it('随机推进 90 秒（全场没人出牌）也不会冒出 win/lose/draw', () => {
    const w = new ArenaWorld({ seed: 45, mode: 'endless' });
    w.auto.red = false;
    run(w, 90);
    expect(w.outcome).toBe('playing');
    expect(w.outcomeReason).toBeNull();
  });

  it('反证：判据里不许出现时间比较 / 加时 / 楼数积分', () => {
    const block = world.slice(
      world.indexOf('private checkEndlessOutcome()'),
      world.indexOf('**PVE 判据**'),
    );
    // 分派在 checkOutcome() 里，不在这个方法体内，所以查全文
    expect(world).toContain("if (this.mode === 'endless') return this.checkEndlessOutcome();");
    expect(block).not.toMatch(/this\.elapsed\s*>=\s*MATCH\.seconds/);
    expect(block).not.toContain("'overtime'");
    expect(block).not.toContain('countBuildings(');
  });
});

describe('1v1 无尽：唯一的出口是拆家', () => {
  it('拆掉红方大本营 ⇒ win/core；拆掉蓝方 ⇒ lose/core', () => {
    const win = new ArenaWorld({ seed: 46, mode: 'endless' });
    win.auto.red = false;
    win.elapsed = 999; // 就算"打了一千年"也不影响判据
    win['hurtBuilding'](win.coreOf('red')!, 99999);
    win.update(0.05);
    expect(win.outcome).toBe('win');
    expect(win.outcomeReason).toBe('core');

    const lose = new ArenaWorld({ seed: 47, mode: 'endless' });
    lose.auto.red = false;
    lose['hurtBuilding'](lose.coreOf('blue')!, 99999);
    lose.update(0.05);
    expect(lose.outcome).toBe('lose');
    expect(lose.outcomeReason).toBe('core');
  });
});

describe('1v1 无尽：菜单 / URL / 时钟 / 结算文案', () => {
  it('菜单第四个模式 + 对应的 URL 切换', () => {
    expect(menu).toContain("export type MenuMode = 'arena' | 'pve1' | 'pve2' | 'endless'");
    expect(menu).toContain("{ key: 'endless', label: '1v1 无尽' }");
    expect(menu).toContain('1v1 无尽 · 不限时间，拆掉对面大本营才结束');
    expect(entry).toContain("modeParam === 'endless' ? 'endless'");
    expect(entry).toContain("location.search = '?mode=endless'");
  });

  it('时钟向上计时、不告急不进加时；结算第二行写时长与拆楼数', () => {
    expect(hud).toContain('if (s.endless) {');
    expect(hud).toContain('Math.floor(s.elapsed / 60)');
    expect(hud).toContain("this.clock.dataset['endless'] = '1'");
    expect(hud).toContain('无尽 · 打了');
    expect(css).toContain(".ahud__clock[data-endless='1'] .ahud__clock__ot");
  });
});
