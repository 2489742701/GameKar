/**
 * 「点击地面集结军队」规则层自测（2026-11-09，P-087 续）。
 *
 * 老模式 /index.html 的链路是 `GameWorld.setRally` + 旗架；模组内复刻，
 * 位置一律用格坐标浮点，视图层自己 cellToWorld，所以这里零 three / 零 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../core/map.js';
import { createRally, MARCH_SPEED } from '../core/rally.js';

const center = () => ({ col: M.MAP.cx, row: M.MAP.cy });

test('默认启用，还没插旗时没有集结点', () => {
  const r = createRally();
  assert.equal(r.enabled, true);
  assert.equal(r.flag, null);
  assert.equal(r.units.length, 0);
});

test('点地面插旗：地图外的格子拒绝，旗子一个字不动', () => {
  const r = createRally();
  const before = r.flag;
  assert.equal(r.dropFlag(-1, -1).ok, false);
  assert.equal(r.flag, before);
  const c = center();
  const res = r.dropFlag(c.col, c.row);
  assert.equal(res.ok, true);
  assert.deepEqual(r.flag, c);
});

test('道路格可以插旗：道路不能盖楼，但军队能站上去拦路', () => {
  const r = createRally();
  const road = M.fromAbstract(M.CENTER.roadRow, 2);
  assert.equal(M.isRoad(road.col, road.row), true);
  assert.equal(r.dropFlag(road.col, road.row).ok, true);
});

test('关闭集结后点地面不再改旗；重新启用即可继续', () => {
  const r = createRally();
  r.setEnabled(false);
  const c = center();
  assert.equal(r.dropFlag(c.col, c.row).ok, false);
  assert.equal(r.flag, null);
  r.setEnabled(true);
  assert.equal(r.dropFlag(c.col, c.row).ok, true);
});

test('打出军队卡生成一队兵，逐帧朝旗子行进、到位后停住', () => {
  const r = createRally();
  const c = center();
  r.dropFlag(c.col, c.row);
  const made = r.spawn(c.col - 20, c.row, 5, 'archers');
  assert.equal(made.length, 5);
  assert.equal(r.units.length, 5);
  assert.ok(r.units.every((u) => !u.arrived));
  for (let i = 0; i < 200; i++) r.tick(0.05);
  assert.ok(r.units.every((u) => u.arrived), '10 秒足够走完 20 格');
  assert.ok(r.units.every((u) => !u.moving));
  for (const u of r.units) {
    assert.ok(Math.hypot(u.col - c.col, u.row - c.row) < 3.5, '到位后围着旗子散开，不许叠成一坨');
  }
  assert.ok(MARCH_SPEED > 0);
});

test('改集结点会让已经到位的兵重新开拔（点第二下地面 = 重新集结）', () => {
  const r = createRally();
  const a = center();
  r.dropFlag(a.col, a.row);
  r.spawn(a.col, a.row, 3, 'knights');
  for (let i = 0; i < 100; i++) r.tick(0.05);
  assert.ok(r.units.every((u) => u.arrived));
  const b = { col: a.col + 12, row: a.row + 6 };
  r.dropFlag(b.col, b.row);
  assert.ok(r.units.every((u) => !u.arrived));
  r.tick(0.05);
  assert.ok(r.units.some((u) => u.moving));
});

test('没插旗时出的兵原地待命，插旗后立刻开拔', () => {
  const r = createRally();
  const c = center();
  r.spawn(c.col - 8, c.row, 2, 'militia');
  r.tick(0.05);
  assert.ok(r.units.every((u) => !u.moving));
  r.dropFlag(c.col, c.row);
  r.tick(0.05);
  assert.ok(r.units.every((u) => u.moving));
});

test('reset 清旗、清兵、连 id 也从头来', () => {
  const r = createRally();
  const c = center();
  r.dropFlag(c.col, c.row);
  r.spawn(c.col, c.row, 4, 'archers');
  r.reset();
  assert.equal(r.flag, null);
  assert.equal(r.units.length, 0);
  const made = r.spawn(c.col, c.row, 1, 'archers');
  assert.equal(made[0].id, 1);
});

test('地图容量：至少 3 倍竞技场，中心公共区也够放很多楼', () => {
  const arenaCells = 44 * 20;
  assert.ok(M.terrainCells().length > arenaCells * 3);
  assert.ok(M.CENTER.size * M.CENTER.size > 200, '中心 17×17 = 289 格，不该放几栋就满');
});
