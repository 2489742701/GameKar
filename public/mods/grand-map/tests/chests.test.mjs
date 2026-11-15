/**
 * 中心区宝箱自测（2026-11-09，P-090）。
 *
 * 用户硬口径：「中间那个地方改成会定期刷新箱子，跑过去占领的时候会随机拿到金币。
 * 如果是箱子里的金币，即使到了 50 的上限也能接着加，不会因为到上限而被废弃或丢弃」。
 *
 * 这里锁的就是「不截断 / 不丢弃 / 不倒扣」三件事，纯规则层，node 直接跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEC, REL, createGame, spawnChest, collectChest, chestAt,
  resolveIncoming, sendCaravan, tick, placeBuilding, note,
} from '../core/rules.js';

const fresh = () => createGame(90);

test('开局没有箱子；spawnChest 刷在中心区非道路、非楼格，金币落在配置区间', () => {
  const s = fresh();
  assert.equal(s.chests.length, 0);
  const res = spawnChest(s);
  assert.equal(res.ok, true, res.reason);
  const ch = res.chest;
  assert.notEqual(ch.r, SPEC.roadRow, '主干道那一行不能刷箱子');
  assert.ok(ch.r >= 0 && ch.r < SPEC.centerSize);
  assert.ok(ch.c >= 0 && ch.c < SPEC.centerSize);
  assert.ok(ch.gold >= SPEC.chest.minGold && ch.gold <= SPEC.chest.maxGold);
  assert.equal(chestAt(s, ch.r, ch.c)?.id, ch.id);
});

test('箱子数量受 maxAlive 限制，重复格子不重刷', () => {
  const s = fresh();
  const cells = new Set();
  for (let i = 0; i < SPEC.chest.maxAlive; i++) {
    const res = spawnChest(s);
    assert.equal(res.ok, true);
    cells.add(`${res.chest.r},${res.chest.c}`);
  }
  assert.equal(s.chests.length, SPEC.chest.maxAlive);
  assert.equal(cells.size, SPEC.chest.maxAlive, '不该两个箱子叠在同一格');
  assert.equal(spawnChest(s).reason, 'full');
});

test('★ 满金 50 开箱照样加，绝不因上限被截断或丢弃', () => {
  const s = fresh();
  s.factions[0].gold = SPEC.gold.cap;
  const ch = spawnChest(s).chest;
  const res = collectChest(s, ch.id);
  assert.equal(res.ok, true);
  assert.equal(res.before, SPEC.gold.cap);
  assert.equal(res.total, SPEC.gold.cap + ch.gold, '一金都不能少');
  assert.ok(res.total > SPEC.gold.cap);
  assert.equal(s.factions[0].gold, res.total);
});

test('★ 连开多个箱子持续累加，超过上限后照样不丢', () => {
  const s = fresh();
  s.factions[0].gold = SPEC.gold.cap;
  let expected = SPEC.gold.cap;
  for (let i = 0; i < 4; i++) {
    const ch = spawnChest(s).chest;
    const res = collectChest(s, ch.id);
    expected += ch.gold;
    assert.equal(res.total, expected);
  }
  assert.ok(s.factions[0].gold > SPEC.gold.cap);
  assert.equal(s.chests.length, 0);
});

test('箱子被捡走后不能重复领；chestAt 也查不到', () => {
  const s = fresh();
  const ch = spawnChest(s).chest;
  assert.equal(collectChest(s, ch.id).ok, true);
  assert.equal(collectChest(s, ch.id).reason, 'missing');
  assert.equal(chestAt(s, ch.r, ch.c), null);
});

test('★ 超额之后，自然回金不许把多出来的金币抹回 50', () => {
  const s = fresh();
  s.factions[0].gold = SPEC.gold.cap;
  const ch = spawnChest(s).chest;
  collectChest(s, ch.id);
  const over = s.factions[0].gold;
  for (let i = 0; i < SPEC.gold.regenTicks * 2; i++) tick(s);
  assert.equal(s.factions[0].gold, over, '自然回金只能不涨，不能倒扣');
});

test('★ 超额之后，商队到站 / 扣押 / 贸易也不能倒扣', () => {
  const s = fresh();
  s.factions[0].gold = SPEC.gold.cap;
  collectChest(s, spawnChest(s).chest.id);
  const over = s.factions[0].gold;

  // 玩家自己发的车到站（发车先扣车费，满金时到站收益应该是 +0，不是负数）
  const car = sendCaravan(s, 0, 2, 'near').caravan;
  const afterFee = s.factions[0].gold;
  assert.equal(afterFee, over - SPEC.cost.caravan);
  const carSteps = car.ticksLeft; // tick 会就地递减 ticksLeft，上界必须先存
  for (let i = 0; i < carSteps; i++) tick(s);
  assert.ok(s.factions[0].gold >= afterFee, '商队到站不许倒扣');

  // 中立来车：扣押 / 正常贸易都走 Math.max(0, ...)
  const incoming = sendCaravan(s, 2, 0, 'near').caravan;
  const incomingSteps = incoming.ticksLeft;
  for (let i = 0; i < incomingSteps; i++) tick(s);
  const p = s.pending.find((x) => x.id === incoming.id);
  assert.ok(p);
  const beforeTrade = s.factions[0].gold;
  assert.equal(resolveIncoming(s, p.id, 'trade').ok, true);
  assert.ok(s.factions[0].gold >= beforeTrade, '贸易不许倒扣（车费已先扣过，基准不能拿开箱后的 over）');
});

test('金币低于上限时，普通回金仍按老规矩涨（没把原规则改坏）', () => {
  const s = fresh();
  s.factions[0].gold = 0;
  for (let i = 0; i < SPEC.gold.regenTicks; i++) tick(s);
  assert.equal(s.factions[0].gold, SPEC.gold.regenAmount);
});

test('箱子只刷在没盖楼的格上；盖了楼就不再往那儿刷', () => {
  const s = fresh();
  for (let r = 0; r < SPEC.centerSize; r++) {
    for (let c = 0; c < SPEC.centerSize; c++) {
      if (r !== SPEC.roadRow) s.cells[r][c].building = true;
    }
  }
  assert.equal(spawnChest(s).reason, 'no-space');
  // 反证：留一格空出来就能刷
  s.cells[0][1].building = false;
  assert.equal(spawnChest(s).ok, true);
});

test('note 只读 state，宝箱操作不改别的关系 / 车 / 格子', () => {
  const s = fresh();
  const before = JSON.stringify({ relations: s.relations, cells: s.cells, caravans: s.caravans });
  const ch = spawnChest(s).chest;
  collectChest(s, ch.id);
  note(s, 'noop');
  assert.equal(JSON.stringify({ relations: s.relations, cells: s.cells, caravans: s.caravans }), before);
  assert.ok(REL.FEUD);
  assert.ok(placeBuilding);
});
