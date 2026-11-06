/**
 * "大本营升级之后，其他建筑才能升级"这条门槛的锁。
 *
 * 为什么要单独一个文件：这条规矩散在三个地方（能不能升、菜单上写什么、点了之后说什么），
 * 只要有一处漏判，玩家看到的就是"按钮能点但没反应"或"写已满级其实才 Lv1"。
 * 所以每条都断**判据 + 账**（等级真的没动 / 真的动了），不只断返回值。
 */

import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { Combat } from '@game/systems/Combat';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';

function rig(): { world: GameWorld; combat: Combat } {
  const map = new TileMap({ cols: 30, rows: 30 });
  const world = new GameWorld(map);
  world.grant('gold', 100_000);
  world.grant('crystal', 1_000);
  world.addPopulationCap(200);
  return { world, combat: new Combat({ world }) };
}

function place(world: GameWorld, id: string, at: ReturnType<typeof pos>): Building {
  world.addPermits(id, 2);
  const b = world.build(id, at);
  if (!b) throw new Error(`${id} 没能盖在 ${at.col},${at.row}`);
  b.built = true;
  return b;
}

/** 收下所有 toast 文本（断言"点了之后说什么"靠它）。 */
function toasts(world: GameWorld): string[] {
  const box: string[] = [];
  world.bus.on('toast', (p) => box.push(p.text));
  return box;
}

describe('议事厅自己的阶梯', () => {
  it('最高 3 级，而且比别处贵得多：Lv2 要 450 金，Lv3 掺晶钻', () => {
    const { world, combat } = rig();
    const hall = place(world, 'hall', pos(14, 14));
    expect(combat.maxLevel(hall)).toBe(3);
    // 最贵的营/神龛造价 260，主城一级要 450：不是"随手点一下"能付的
    expect(combat.upgradePrice(hall)!.gold).toBeGreaterThan(260);
    expect(combat.upgradePrice(hall)).toEqual({ gold: 450, crystal: 0 });
    hall.level = 2;
    expect(combat.upgradePrice(hall)).toEqual({ gold: 1000, crystal: 60 });
    hall.level = 3;
    expect(combat.upgradePrice(hall)).toBeNull();
  });

  it('议事厅不受自己的门槛管（不然开局就永远升不动）', () => {
    const { world, combat } = rig();
    const hall = place(world, 'hall', pos(14, 14));
    expect(combat.hallGateBlocks(hall)).toBe(false);
    expect(combat.allowedLevel(hall)).toBe(3);
  });
});

describe('其它楼顶到主城等级就不许再升', () => {
  it('议事厅 Lv1：别人一级都升不了，且理由写的是"先把议事厅升到 Lv2"', () => {
    const { world, combat } = rig();
    place(world, 'hall', pos(14, 14));
    const farm = place(world, 'farm', pos(4, 4));
    const said = toasts(world);

    expect(combat.hallLevel()).toBe(1);
    expect(combat.allowedLevel(farm)).toBe(1);
    expect(combat.upgradePrice(farm)).toBeNull();
    expect(combat.hallGateBlocks(farm)).toBe(true);

    // 关键：钱够也不给升，而且等级不许动、钱不许少
    const before = world.resources.gold;
    expect(combat.upgrade(farm)).toBe(false);
    expect(farm.level).toBe(1);
    expect(said.some((t) => t.includes('议事厅') && t.includes('Lv2'))).toBe(true);
    expect(world.resources.gold).toBe(before);
  });

  it('议事厅升到 Lv2 之后，别人才能升到 Lv2；再往上又卡住', () => {
    const { world, combat } = rig();
    const hall = place(world, 'hall', pos(14, 14));
    const farm = place(world, 'farm', pos(4, 4));

    expect(combat.upgrade(hall)).toBe(true);
    expect(hall.level).toBe(2);

    expect(combat.hallGateBlocks(farm)).toBe(false);
    expect(combat.upgradePrice(farm)).not.toBeNull();
    expect(combat.upgrade(farm)).toBe(true);
    expect(farm.level).toBe(2);

    // 顶到主城等级了：又卡住，且这次要的是 Lv3
    expect(combat.allowedLevel(farm)).toBe(2);
    expect(combat.hallGateBlocks(farm)).toBe(true);
    const said = toasts(world);
    expect(combat.upgrade(farm)).toBe(false);
    expect(farm.level).toBe(2);
    expect(said.some((t) => t.includes('Lv3'))).toBe(true);

    // 主城升满，别人也就能升满
    expect(combat.upgrade(hall)).toBe(true);
    expect(hall.level).toBe(3);
    expect(combat.allowedLevel(farm)).toBe(3);
    expect(combat.upgrade(farm)).toBe(true);
    expect(farm.level).toBe(3);
    expect(combat.upgradePrice(farm)).toBeNull();
    expect(combat.hallGateBlocks(farm)).toBe(false); // 这次是**真满级**，不是被卡
  });

  it('主城还在打地基也算数 —— 不给"开局那几秒里其它楼随便升"留窗口', () => {
    const { world, combat } = rig();
    const hall = place(world, 'hall', pos(14, 14));
    hall.built = false;
    const farm = place(world, 'farm', pos(4, 4));
    expect(combat.hallLevel()).toBe(1);
    expect(combat.hallGateBlocks(farm)).toBe(true);
    expect(combat.upgrade(farm)).toBe(false);
  });

  it('塔同样受这条门槛管（塔有自己的价目表，但不该绕过主城）', () => {
    const { world, combat } = rig();
    place(world, 'hall', pos(14, 14));
    const tower = place(world, 'arrowTower', pos(8, 8));

    expect(combat.maxLevel(tower)).toBe(3);
    expect(combat.allowedLevel(tower)).toBe(1);
    expect(combat.upgrade(tower)).toBe(false);
    expect(tower.level).toBe(1);
  });
});

describe('没有议事厅的时候不设门槛', () => {
  // 夹具与读档的半截世界里常常还没盖主城。那种情况下"所有楼都升不了级"
  // 会把一堆与门槛无关的测试一起卡红 —— 所以缺主城 = 不拦，不是 = 全拦。
  it('场上没有议事厅时 hallLevel 返回 99，楼照常升', () => {
    const { world, combat } = rig();
    const farm = place(world, 'farm', pos(4, 4));
    expect(combat.hallLevel()).toBe(99);
    expect(combat.hallGateBlocks(farm)).toBe(false);
    expect(combat.upgrade(farm)).toBe(true);
    expect(farm.level).toBe(2);
  });
});
