/**
 * 金币上限 20 → 30 的锁（2026-11-07 用户："金币上限默认改到 30 个"）。
 *
 * 不只锁一个数字，还要锁住三件容易"改了主值却没跟"的事：
 *  ① 涨速**不许跟着变**（建筑协调经济是主约束，钱来得快会冲垮配给）；
 *  ② 金币条的刻度间距跟着 cap 算，不能写死 5%（cap 20 那版的写法）；
 *  ③ AI「攒到快封顶就别再等」的阈值跟着 cap 走，不能写死 16。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { ECONOMY } from '@arena/config';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('上限本身', () => {
  it('默认 30；涨速仍是 2 秒/格、开局 15（2026-11-07 傍晚从 8 提到 15）', () => {
    expect(ECONOMY.cap).toBe(30);
    expect(ECONOMY.tickSeconds).toBe(2);
    expect(ECONOMY.start).toBe(15);
  });

  it('实际涨到 30 就封顶（不是只改了显示数字）', () => {
    const w = new ArenaWorld({ seed: 1 });
    w.auto.red = false;
    expect(w.gold.blue).toBe(ECONOMY.start);
    for (let i = 0; i < 60 / 0.05; i++) w.update(0.05);
    expect(w.gold.blue).toBe(30);
    // 再多跑 20 秒也不许溢出
    for (let i = 0; i < 20 / 0.05; i++) w.update(0.05);
    expect(w.gold.blue).toBe(30);
    expect(w.summary().goldCap).toBe(30);
  });

  it('开局 15 → 30 需要 30 秒（2 秒/格 × 15 格），涨速没被偷偷加快', () => {
    const w = new ArenaWorld({ seed: 2 });
    w.auto.red = false;
    const need = (ECONOMY.cap - ECONOMY.start) * ECONOMY.tickSeconds; // 15 × 2 = 30
    expect(need).toBe(30);
    for (let i = 0; i < (need - 0.1) / 0.05; i++) w.update(0.05);
    expect(w.gold.blue).toBeLessThan(30);
    for (let i = 0; i < 0.2 / 0.05; i++) w.update(0.05);
    expect(w.gold.blue).toBe(30);
  });
});

describe('跟着 cap 走的三处（别改了主值漏掉它们）', () => {
  const css = read('src/styles/arena.css');
  const hud = read('src/arena/ArenaHud.ts');
  const ai = read('src/arena/ai.ts');

  it('金币条刻度读 --gold-tick，不再写死 5%', () => {
    expect(css).toContain('var(--gold-tick, 5%)');
    // 旧写法：calc(5% - 1px) 直接写死，cap 30 时每格会变成 1.5 金
    expect(css).not.toContain('transparent calc(5% - 1px)');
  });

  it('HUD 按 100 / ECONOMY.cap 设刻度，卡面读数也读同一个常量', () => {
    expect(hud).toContain('100 / ECONOMY.cap');
    expect(hud).toContain('${ECONOMY.cap}');
    expect(hud).toContain('(p.gold / ECONOMY.cap)');
    expect(hud).toContain('p.gold >= ECONOMY.cap');
  });

  it('AI 攒钱阈值是 cap - 4（30 ⇒ 26），不是写死的 16', () => {
    expect(ai).toContain('ECONOMY.cap - 4');
    expect(ai).not.toContain('view.gold >= 16');
  });
});
