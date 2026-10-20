/**
 * 放置控制器 —— 它在 UI 与世界之间传话，最容易出的错是"话没传出去"。
 * 这里不需要 DOM：three 的 Group 在 node 里就能构造。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { pos } from '@engine/math/Grid';
import { VEIN_WORK } from '@game/config';
import { ModelLibrary } from '@game/models/registry';
import { GameWorld } from '@game/world/GameWorld';
import { MarkerLayer } from '@game/world/Markers';
import { TileMap } from '@game/world/TileMap';
import { PlacementController } from '@game/systems/Placement';
import { findNearestClearSpot, generateTerrain } from '@game/world/TerrainGenerator';

function harness(seed = 20261019) {
  const map = generateTerrain({ size: { cols: 46, rows: 46 }, seed, veins: 9, clearingRadius: 4 });
  const world = new GameWorld(map);
  const scene = new THREE.Scene();
  const markers = new MarkerLayer();
  const controller = new PlacementController(world, new ModelLibrary(), markers, scene);

  const log: (string | null)[] = [];
  controller.onActiveChange = (id) => log.push(id);

  world.grant('gold', 5_000);
  const home = { col: 23, row: 23 };
  const spot = findNearestClearSpot(map, home, 2, 2)!;
  // 避开议事厅自己的位置
  const away: GridPos = { col: spot.col + 8, row: spot.row };
  return { world, controller, scene, log, away };
}

describe('放置模式广播', () => {
  it('没有许可时 begin 失败，并且不会留下半开的模式', () => {
    const { controller, log } = harness();
    expect(controller.begin('farm')).toBe(false);
    expect(controller.isActive).toBe(false);
    expect(log).toEqual([]);
  });

  it('进入模式广播一次，取消再广播一次', () => {
    const { controller, world, log } = harness();
    world.addPermits('farm', 1);

    expect(controller.begin('farm')).toBe(true);
    expect(log).toEqual(['farm']);

    controller.cancel();
    expect(log).toEqual(['farm', null]);
  });

  it('许可用完那一刻的自动取消，也要把"已退出"广播出去', () => {
    // 曾经的症状：楼盖下去了、许可归零，建造槽却还亮着"取消 · 田庄"
    const { controller, world, log, away } = harness();
    world.addPermits('farm', 1);
    controller.begin('farm');
    log.length = 0;

    const placed = controller.commit(away);
    expect(placed).not.toBeNull();
    expect(world.permitCount('farm')).toBe(0);
    expect(controller.isActive).toBe(false);
    expect(log).toEqual([null]);
  });

  it('许可还有剩时留在放置模式，继续准备下一格', () => {
    const { controller, world, log, away } = harness();
    world.addPermits('farm', 3);
    controller.begin('farm');
    log.length = 0;

    controller.commit(away);
    expect(world.permitCount('farm')).toBe(2);
    expect(controller.isActive).toBe(true);
    expect(log).toEqual(['farm']);
  });

  it('幽灵跟着判定变色：空格绿、已被占红', () => {
    const { controller, world, scene, away } = harness();
    world.addPermits('farm', 2);
    controller.begin('farm');
    controller.preview(away);
    expect(ghost(scene)!.color.getHex()).toBe(0x63d98a);

    // 同一格盖上一栋之后，这里就变成"已被占用"
    expect(controller.commit(away)).not.toBeNull();
    controller.begin('farm');
    controller.preview(away);
    expect(ghost(scene)!.color.getHex()).toBe(0xff6b6b);
  });

  it('压着晶脉的那一格是第三种脸色：既不是放行，也不是拒绝', () => {
    const map = new TileMap({ cols: 30, rows: 30 });
    const world = new GameWorld(map);
    world.grant('gold', 9_000);
    world.addPopulationCap(50);
    const vein = pos(10, 10);
    map.setTerrain(vein, 'vein');

    const controller = new PlacementController(world, new ModelLibrary(), new MarkerLayer(), new THREE.Scene());
    const log: (string | null)[] = [];
    controller.onActiveChange = (id) => log.push(id);
    world.addPermits('farm', 1);
    controller.begin('farm');

    expect(controller.stateOf(vein)).toBe('warn');
    expect(controller.veinsAtRisk(vein)).toHaveLength(1);
    // 旁边一格没有矿，就是普通的可建造
    expect(controller.stateOf(pos(12, 10))).toBe('ok');

    // 没同意：盖不下去，许可也不扣
    expect(controller.commit(vein)).toBeNull();
    expect(world.permitCount('farm')).toBe(1);

    // 同意：楼起来、矿没了、许可用完自动退出放置
    expect(controller.commit(vein, true)).not.toBeNull();
    expect(map.terrainAt(vein)).toBe(VEIN_WORK.ruinedTerrain);
    expect(controller.isActive).toBe(false);
    expect(log.at(-1)).toBeNull();
  });
});

/** 控制器把预览体命名为 ghost，测试和调试都按这个名字取，不靠场景里数第几个。 */
function ghost(scene: THREE.Scene): THREE.MeshStandardMaterial | null {
  const group = scene.getObjectByName('ghost') as THREE.Group | undefined;
  const first = group?.children[0] as THREE.Mesh | undefined;
  return first ? (first.material as THREE.MeshStandardMaterial) : null;
}
