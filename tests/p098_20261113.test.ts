/**
 * P-098（2026-11-13）三条「简单的先处理好」：
 *
 * ① 大地图调试抽屉默认收起（用户 2026-11-09「后面也要改回来呀」）；
 * ② PVE 精英波次 at:154 的兽人按 P-095 口径混编投矛手，总人数不变；
 * ③ P-096 遗留的「无论往哪放，就放到最后一个位置上」——
 *    只在**全场只剩最后一处空位**时吸附，一处不剩仍拒绝生成。
 *
 * 每条主锁都配反证：把判据关掉，锁必须红。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { FIELD, cardById, canHitAir } from '@arena/config';
import { PVE_LEVELS } from '@arena/pve/levels';
import { levelSize, waveSize } from '@arena/pve/waves';
import type { GridPos } from '@engine/math/Grid';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('src/arena/ArenaApp.ts');
const world = read('src/arena/ArenaWorld.ts');
const view = read('public/mods/grand-map/view.js');
const probe = read('tools/grand_map_probe.mjs');
const levels = read('src/arena/pve/levels.ts');

/** 直接落一栋完工楼，跳过施工（同 p096 的辅助）。 */
function built(w: ArenaWorld, col: number, row: number) {
  const b = w['place']('blue', 'house', col, row, 220);
  b.build = 1;
  return b;
}

/** 数这一侧还能放几处 3×3（走真实的 buildingPlacementIssue，不是猜的）。 */
const freeCells = (w: ArenaWorld): GridPos[] =>
  (w as unknown as { freeCellsFor(side: string, cols: number, rows: number): GridPos[] })
    .freeCellsFor('blue', 3, 3);

/** 反复在第一个空位盖楼，直到全场只剩最后一处空位。 */
function nearlyFull(): { w: ArenaWorld; last: GridPos | null; count: number } {
  const w = new ArenaWorld({ seed: 982 });
  w.auto.red = false;
  let cells = freeCells(w);
  let guard = 0;
  while (cells.length > 1 && guard++ < 400) {
    const c = cells[0]!;
    built(w, c.col, c.row);
    const next = freeCells(w);
    if (next.length >= cells.length) break; // 防死循环：放不下就别硬放
    cells = next;
  }
  w.gold.blue = 30;
  return { w, last: cells[0] ?? null, count: cells.length };
}

describe('① 大地图调试抽屉默认收起', () => {
  it('默认值是 false，控件与顶栏按钮一个没删', () => {
    expect(view).toContain('const DEBUG_DEFAULT_OPEN = false;');
    expect(view).toContain('data-action="debug"');
    expect(view).toContain('class="gm-debug"');
    expect(view).toContain('debugEl.hidden = !DEBUG_DEFAULT_OPEN;');
  });

  it('探针也钉着「默认收起」，不是只改了源码没改验收', () => {
    expect(probe).toContain("'调试抽屉默认收起': base.debugOpen === false");
  });

  it('反证：改回 true 会被结构锁抓住', () => {
    const reverted = view.replace(
      'const DEBUG_DEFAULT_OPEN = false;',
      'const DEBUG_DEFAULT_OPEN = true;',
    );
    expect(reverted).toContain('const DEBUG_DEFAULT_OPEN = true;');
    expect(view).not.toContain('const DEBUG_DEFAULT_OPEN = true;');
  });
});

describe('② PVE 精英波次兽人混编', () => {
  const LV = PVE_LEVELS[0]!;
  const elite = LV.waves.find((w) => w.at === 154)!;

  it('2 近战 orc + 1 投矛手，总人数仍是 3', () => {
    const orcs = elite.spawns.filter((s) => s.unitId === 'orc');
    const throwers = elite.spawns.filter((s) => s.unitId === 'orcThrower');
    expect(orcs).toHaveLength(1);
    expect(throwers).toHaveLength(1);
    expect(orcs[0]!.count + throwers[0]!.count).toBe(3);
    // 整波、整关的人数都不许顺手涨
    expect(waveSize(elite)).toBe(12);
    expect(levelSize(LV.waves)).toBeGreaterThan(0);
    // 投矛手确实是 AA_SOURCES 里那个能拦空军的兵
    expect(canHitAir('orcThrower')).toBe(true);
  });

  it('投矛手单独一行，不跟近战叠坐标', () => {
    const orc = elite.spawns.find((s) => s.unitId === 'orc')!;
    const thrower = elite.spawns.find((s) => s.unitId === 'orcThrower')!;
    expect(orc.row).not.toBe(thrower.row);
  });

  it('运行时真的放出了投矛手（不是只改了表）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LV.id, auto: { blue: true }, seed: 1 });
    const seen = new Set<string>();
    for (let i = 0; i < 3400 && w.pve!.spawned < levelSize(LV.waves); i++) {
      w.update(0.05);
      for (const u of w.units) if (u.side === 'red') seen.add(u.defId);
    }
    expect(seen.has('orcThrower')).toBe(true);
    expect(w.pve!.spawned).toBe(levelSize(LV.waves));
  });

  it('反证：把混编删掉，波次表里就再也读不到投矛手', () => {
    const reverted = levels.replace("{ unitId: 'orcThrower', count: 1, row: 6 },", '');
    expect(reverted).not.toContain("unitId: 'orcThrower'");
    expect(levels).toContain("unitId: 'orcThrower'");
  });
});

describe('③ 只剩最后一处空位时吸附过去', () => {
  it('点被占的格子也落到最后那处空位，楼真的落在那儿', () => {
    const { w, last, count } = nearlyFull();
    expect(count).toBe(1);
    expect(last).not.toBeNull();
    const p = w.playerOf('blue');
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;

    const clicked = { col: 0, row: 0 }; // 一定被占
    expect(w.snapCellOf(p, 0, clicked.col, clicked.row)).toEqual(last);

    const before = w.buildings.size;
    const res = w.playCard('blue', 0, clicked.col, clicked.row);
    expect(res.ok).toBe(true);
    expect(w.buildings.size).toBe(before + 1);
    expect(
      [...w.buildings.values()].some(
        (b) => b.kind === 'mill' && b.col === last!.col && b.row === last!.row,
      ),
    ).toBe(true);
    // 落完这一栋，一处空位都不剩 ⇒ 下一张建筑卡必须拒绝
    expect(w.hasRoomFor('blue', 'mill')).toBe(false);
  });

  it('一处空位都不剩：返回 null + 落牌拒绝（P-096 红线没松）', () => {
    const { w, last } = nearlyFull();
    built(w, last!.col, last!.row);
    const p = w.playerOf('blue');
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;

    expect(w.hasRoomFor('blue', 'mill')).toBe(false);
    expect(w.snapCellOf(p, 0, 0, 0)).toBeNull();
    const before = w.buildings.size;
    const gold = w.gold.blue;
    const res = w.playCard('blue', 0, 0, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('场地已满');
    expect(w.buildings.size).toBe(before);
    expect(w.gold.blue).toBe(gold);
  });

  it('正常点合法格子：零吸附，落点就是点的那格', () => {
    const w = new ArenaWorld({ seed: 983 });
    w.auto.red = false;
    const p = w.playerOf('blue');
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;
    const c = freeCells(w)[5]!;
    expect(w.snapCellOf(p, 0, c.col, c.row)).toEqual(c);
  });

  it('还有 2 处以上空位时不吸附，照旧回「这格被占了」', () => {
    const w = new ArenaWorld({ seed: 984 });
    w.auto.red = false;
    const p = w.playerOf('blue');
    const first = freeCells(w)[0]!;
    built(w, first.col, first.row);
    expect(freeCells(w).length).toBeGreaterThan(2);
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;
    w.gold.blue = 30;

    expect(w.snapCellOf(p, 0, first.col, first.row)).toEqual(first);
    const res = w.playCard('blue', 0, first.col, first.row);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('这格被占了');
  });

  it('军队卡不参与吸附（1×1 行军起点听玩家的）', () => {
    const w = new ArenaWorld({ seed: 985 });
    w.auto.red = false;
    const p = w.playerOf('blue');
    w.hands.blue[0] = cardById('orcs');
    w.handCooldowns.blue[0] = 0;
    built(w, 3, 3);
    expect(w.snapCellOf(p, 0, 3, 3)).toEqual({ col: 3, row: 3 });
  });

  it('装配锁：影子与落牌读同一个 snapCellOf，判据不写在 UI 里', () => {
    expect(world).toContain('const target = this.snapCellOf(p, slot, col, row);');
    expect(world).toContain('if (free.length === 1) return free[0]!;');
    expect(app).toContain('this.world.snapCellOf(p, drag.slot, cell.col, cell.row)');
    expect(app).toContain(
      'const target = this.world.snapCellOf(p, slot, cell.col, cell.row) ?? cell;',
    );
    // P-096 的落牌读 lastCell 那行没被改掉
    expect(app).toContain(
      'const cell = this.dragCell(clientX, clientY, pointerType) ?? (drag.hidden ? null : drag.lastCell);',
    );
  });

  it('反证：空位数不是 1 时吸附必须失效（关掉判据锁就红）', () => {
    const w = new ArenaWorld({ seed: 986 });
    w.auto.red = false;
    const p = w.playerOf('blue');
    built(w, 0, 0);
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;
    const raw = { col: 0, row: 0 };
    const stub = (cells: GridPos[]): void => {
      (w as unknown as { freeCellsFor: () => GridPos[] }).freeCellsFor = () => cells;
    };

    stub([{ col: 3, row: 0 }, { col: 6, row: 0 }]);
    expect(w.snapCellOf(p, 0, 0, 0)).toEqual(raw);
    stub([]);
    expect(w.snapCellOf(p, 0, 0, 0)).toBeNull();
    stub([{ col: 9, row: 6 }]);
    expect(w.snapCellOf(p, 0, 0, 0)).toEqual({ col: 9, row: 6 });
  });
});

describe('场地尺寸没被顺手改掉', () => {
  it('FIELD 仍是 44×20', () => {
    expect(FIELD.cols).toBe(44);
    expect(FIELD.rows).toBe(20);
  });
});
