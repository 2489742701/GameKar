/**
 * 集合旗的锁（P-003 §4 那六条）。
 *
 * 旗子这套动作的坑是"点了没反应"和"点一下就没了一面旗"，
 * 所以每条负向判据都断两件事：**返回值不对，而且账没动**（格子没改、事件没发）。
 * 只断返回值的话，"改了格子但返回 false"这种更坏的写法反而测不出来。
 */

import { describe, expect, it } from 'vitest';
import { pos, footprintRect } from '@engine/math/Grid';
import { isStandable } from '@game/config';
import { buildingDef, hasRally } from '@game/data/buildings';
import { FlagPocket } from '@game/systems/FlagPocket';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';

/** 40x40 纯草地，中间挖一块水、戳一块岩：地形口径自己造，不靠随机图。 */
function flatWorld(): { map: TileMap; world: GameWorld } {
  const map = new TileMap({ cols: 40, rows: 40 });
  for (const c of [18, 19, 20]) for (const r of [18, 19, 20]) map.setTerrain(pos(c, r), 'water');
  map.setTerrain(pos(30, 30), 'rock');
  map.setTerrain(pos(31, 31), 'vein');
  const world = new GameWorld(map);
  world.grant('gold', 100_000);
  world.addPopulationCap(200);
  return { map, world };
}

function place(world: GameWorld, id: string, origin: ReturnType<typeof pos>): Building {
  world.addPermits(id, 4);
  const b = world.build(id, origin);
  if (!b) throw new Error(`${id} 没能盖在 ${origin.col},${origin.row}`);
  b.built = true;
  return b;
}

/** 数 'rally:changed' 发了几次：断"没动静"时要连事件一起断。 */
function rallyEvents(world: GameWorld): { value: number } {
  const box = { value: 0 };
  world.bus.on('rally:changed', () => box.value++);
  return box;
}

describe('地形能不能站人', () => {
  it('草地/沙地/晶脉能站，水与岩脊不能 —— 和"能不能盖楼"是两套判据', () => {
    expect(isStandable('grass')).toBe(true);
    expect(isStandable('sand')).toBe(true);
    expect(isStandable('vein')).toBe(true);
    expect(isStandable('water')).toBe(false);
    expect(isStandable('rock')).toBe(false);
  });
});

describe('默认集合点', () => {
  it('没挪过的楼指到自己占地里那一格，而且是靠镜头（东南）那格', () => {
    const { world } = flatWorld();
    const barracks = place(world, 'barracks', pos(10, 10));
    const house = place(world, 'house', pos(5, 5));

    expect(barracks.rally).toBeNull();
    expect(world.rallyOf(barracks)).toEqual(pos(11, 11));
    expect(world.rallyOf(house)).toEqual(pos(5, 5));

    for (const b of [barracks, house]) {
      const cell = world.rallyOf(b);
      const own = footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows });
      expect(own.some((c) => c.col === cell.col && c.row === cell.row)).toBe(true);
    }
  });

  it('只有产兵的楼算有旗子：四栋营有，民居/矿井没有', () => {
    const withRally = ['barracks', 'archery', 'warren', 'temple'];
    const without = ['hall', 'house', 'farm', 'tower', 'mine', 'market', 'refinery'];
    for (const id of withRally) expect(hasRally(buildingDef(id)), id).toBe(true);
    for (const id of without) expect(hasRally(buildingDef(id)), id).toBe(false);
  });
});

describe('setRally 的判据', () => {
  it('放到草地上：格子改了、事件发了一次', () => {
    const { world } = flatWorld();
    const b = place(world, 'barracks', pos(10, 10));
    const fired = rallyEvents(world);
    expect(world.setRally(b.id, pos(14, 15))).toBe(true);
    expect(world.rallyOf(b)).toEqual(pos(14, 15));
    expect(fired.value).toBe(1);
  });

  it('水面与岩脊都要挡住，而且**账一点没动**（格子还是原来的、事件零次）', () => {
    const { world } = flatWorld();
    const b = place(world, 'barracks', pos(10, 10));
    const before = world.rallyOf(b);
    const fired = rallyEvents(world);

    expect(world.setRally(b.id, pos(19, 19))).toBe(false);
    expect(world.setRally(b.id, pos(30, 30))).toBe(false);

    expect(b.rally).toBeNull();
    expect(world.rallyOf(b)).toEqual(before);
    expect(fired.value).toBe(0);
  });

  it('越界挡住；晶脉能站（能站人不等于能盖楼）', () => {
    const { world } = flatWorld();
    const b = place(world, 'barracks', pos(10, 10));
    expect(world.setRally(b.id, pos(40, 40))).toBe(false);
    expect(world.setRally(b.id, pos(-1, 3))).toBe(false);
    expect(world.setRally(b.id, pos(31, 31))).toBe(true);
  });

  it('楼号不存在时返回 false，不抛 —— 旗子袋里可能存着一个刚被拆掉的楼', () => {
    const { world } = flatWorld();
    expect(world.setRally(9999, pos(12, 12))).toBe(false);
  });

  it('放旗子不许顺手改掉经济读数：incomeRates 与 populationCap 前后全等', () => {
    const { world } = flatWorld();
    const a = place(world, 'barracks', pos(10, 10));
    place(world, 'archery', pos(14, 10));
    const ratesBefore = { ...world.incomeRates() };
    const capBefore = world.populationCap;

    world.setRally(a.id, pos(20, 25));

    expect(world.incomeRates()).toEqual(ratesBefore);
    expect(world.populationCap).toBe(capBefore);
  });

  it('只改一栋：给 A 放旗，B 的集合点还是它自己的默认格', () => {
    const { world } = flatWorld();
    const a = place(world, 'barracks', pos(10, 10));
    const b = place(world, 'archery', pos(14, 10));
    const bDefault = world.rallyOf(b);

    world.setRally(a.id, pos(20, 25));

    expect(world.rallyOf(a)).toEqual(pos(20, 25));
    expect(b.rally).toBeNull();
    expect(world.rallyOf(b)).toEqual(bDefault);
  });
});

describe('旗子袋状态机', () => {
  it('三步走完整：take → arm → drop，之后袋子空、旗子在新格子上', () => {
    const { world } = flatWorld();
    const pocket = new FlagPocket();
    const b = place(world, 'barracks', pos(10, 10));

    pocket.take(b.id);
    expect(pocket.state).toBe('held');
    expect(pocket.held).toBe(b.id);

    expect(pocket.arm()).toBe(true);
    expect(pocket.state).toBe('placing');

    expect(world.setRally(pocket.held!, pos(12, 16))).toBe(true);
    pocket.release();
    expect(pocket.state).toBe('empty');
    expect(pocket.held).toBeNull();
    expect(world.rallyOf(b)).toEqual(pos(12, 16));
  });

  it('空袋点"旗子袋"不给进等落点状态（这才是"点了没反应"那种坑）', () => {
    const pocket = new FlagPocket();
    expect(pocket.arm()).toBe(false);
    expect(pocket.state).toBe('empty');
  });

  it('落点被地形挡住时，旗子必须还在手里 —— 不许一次点按吃掉一面旗', () => {
    const { world } = flatWorld();
    const pocket = new FlagPocket();
    const b = place(world, 'barracks', pos(10, 10));
    pocket.take(b.id);
    pocket.arm();

    expect(world.setRally(pocket.held!, pos(19, 19))).toBe(false);
    expect(pocket.held).toBe(b.id);
    expect(pocket.state).toBe('placing');
  });

  it('一次只握一面：收第二面时手里换成它，第一面那栋的集合点不动', () => {
    const { world } = flatWorld();
    const pocket = new FlagPocket();
    const a = place(world, 'barracks', pos(10, 10));
    const c = place(world, 'archery', pos(14, 10));

    pocket.take(a.id);
    world.setRally(a.id, pos(12, 16));
    pocket.release();

    pocket.take(a.id);
    pocket.take(c.id);
    expect(pocket.held).toBe(c.id);
    expect(world.rallyOf(a)).toEqual(pos(12, 16));
    expect(world.rallyOf(c)).toEqual(pos(15, 11));
  });

  it('Esc 分两层：等落点先退回握着；再按一次把旗放回原处', () => {
    const pocket = new FlagPocket();
    pocket.take(7);
    pocket.arm();
    pocket.disarm();
    expect(pocket.state).toBe('held');
    expect(pocket.held).toBe(7);
    pocket.release();
    expect(pocket.state).toBe('empty');
  });

  it('楼被拆了：手里那面旗跟着没，不留一个指向空楼的落点', () => {
    const { world } = flatWorld();
    const pocket = new FlagPocket();
    const b = place(world, 'barracks', pos(10, 10));
    pocket.take(b.id);
    pocket.arm();

    pocket.forget(b.id);
    expect(pocket.state).toBe('empty');
    world.demolish(b.id);
    expect(world.buildings.size).toBe(0);
  });

  it('forget 只动自己那面：手里握 B 时 A 没了也不撒手', () => {
    const pocket = new FlagPocket();
    pocket.take(11);
    pocket.forget(9);
    expect(pocket.held).toBe(11);
    expect(pocket.state).toBe('held');
  });
});
