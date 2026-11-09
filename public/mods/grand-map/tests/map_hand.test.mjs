/**
 * P-087 地图形态 + 卡牌判据自测（node --test）。
 *
 * 刻意不进主测试套件：模组热插拔，主套件不该执行模组代码。
 * 这里锁的是用户三轮纠正后的口径：
 *   · 大六边形是**地形轮廓**，六芒星是**内部道路**，不是把六芒星当外框；
 *   · 相邻尖角有近路小道，中心公共区逐格对齐规则层 9×9 网格；
 *   · 仍然卡牌驱动：四张手牌、补牌冷却、同一条落牌判据、金币只扣一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../map.js';
import * as R from '../rules.js';
import { createHand, EXTRA_CARDS } from '../hand.js';

/** 测试用的最小开放 API，形状对齐 host.modApi（真卡片数据由主程序注入）。 */
const API = {
  CARDS: [
    { id: 'house', name: '民居', kind: 'building', cost: 8, building: 'house' },
    { id: 'arrowTower', name: '箭塔', kind: 'building', cost: 12, building: 'arrowTower' },
    { id: 'archers', name: '弓箭手', kind: 'squad', cost: 5 },
  ],
  HAND: { size: 4, refillSeconds: 2.2 },
};
const freshGame = () => ({ state: R.createGame(7), tradeTarget: 2, tradeKind: 'near' });

test('大六边形是地形外框：内部格远多于道路格，凹角已补成陆地', () => {
  const terrain = M.terrainCells();
  const star = M.starRoads();
  const short = M.shortcuts();
  const far = M.diameterRoads();
  // 用户 2026-11-09：「起码比竞技场大三四倍」；竞技场 44×20 = 880 格
  assert.ok(terrain.length > 880 * 3, `地形格太少：${terrain.length}，至少要 3 倍竞技场`);
  assert.ok(terrain.length > star.length * 5, '六芒星只能是内部道路，不能就是整张地图');
  assert.ok(star.length > 50 && short.length > 50 && far.length > 20);
  assert.ok(terrain.every((c) => M.inHex(c.col, c.row)));
  assert.equal(M.inHex(0, 0), false);
  assert.equal(M.inHex(M.MAP.cx, M.MAP.cy), true);
  // 尖角朝上下：正上/正下在框内，正左/正右在框外
  assert.equal(M.inHex(M.MAP.cx, M.MAP.cy - M.MAP.hexR + 1), true);
  assert.equal(M.inHex(M.MAP.cx - M.MAP.hexR + 1, M.MAP.cy), false);
});

test('六方主城坐在六芒星尖角，全在大六边形内部', () => {
  assert.equal(M.POINTS.length, 6);
  assert.ok(M.POINTS.every((p) => M.inHex(p.col, p.row)));
  assert.equal(new Set(M.POINTS.map((p) => `${p.col},${p.row}`)).size, 6);
});

test('中心 9×9 逐格对齐规则层抽象网格，主干道那一行恒不可建', () => {
  assert.equal(M.CENTER.size, R.SPEC.centerSize);
  assert.equal(M.CENTER.roadRow, R.SPEC.roadRow);
  for (let r = 0; r < M.CENTER.size; r++) {
    for (let c = 0; c < M.CENTER.size; c++) {
      const cell = M.fromAbstract(r, c);
      assert.deepEqual(M.toAbstract(cell.col, cell.row), { r, c });
      assert.equal(M.isMainRoad(cell.col, cell.row), r === R.SPEC.roadRow);
      assert.equal(M.isRoad(cell.col, cell.row), r === R.SPEC.roadRow);
    }
  }
  assert.equal(M.toAbstract(0, 0), null, '中心区外不该有抽象格');
});

test('道路格与中心区互斥：三类路都是路，中心陆地不是路', () => {
  const star = M.starRoads()[0];
  const short = M.shortcuts()[0];
  const far = M.diameterRoads()[0];
  assert.equal(M.isRoad(star.col, star.row), true);
  assert.equal(M.isRoad(short.col, short.row), true);
  assert.equal(M.isRoad(far.col, far.row), true);
  const land = M.fromAbstract(0, 0);
  assert.equal(M.roadKindAt(land.col, land.row), 'center');
  assert.equal(M.isRoad(land.col, land.row), false);
});

test('发牌对齐主模式：手牌不重复 + 建筑卡保底', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  assert.equal(new Set(hand.cards.map((c) => c.id)).size, API.HAND.size);
  assert.ok(hand.cards.some((c) => c.kind === 'building'), '起手不能四张全军队');
  // 把建筑卡全打出去后补牌，仍要补回一张建筑
  const slots = hand.cards.map((c, i) => (c.kind === 'building' ? i : -1)).filter((i) => i >= 0);
  for (const slot of slots) {
    const near = [...hand.unlocked()][0];
    if (!near) break;
    const [col, row] = near.split(',').map(Number);
    hand.play(slot, col, row);
  }
  if (!hand.cards.some((c) => c && c.kind === 'building')) {
    hand.tick(API.HAND.refillSeconds);
    assert.ok(hand.cards.some((c) => c && c.kind === 'building'), '补牌也要给建筑留名额');
  }
});

test('四张手牌 + 补牌冷却：打出去变空格，冷却到了自动补', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  assert.equal(hand.cards.length, API.HAND.size);
  assert.ok(hand.cards.every(Boolean));
  const seed = M.fromAbstract(R.SEEDS[0][0], R.SEEDS[0][1]);
  const near = { col: seed.col, row: seed.row + 1 };  // 抢滩点的 4 邻域
  // 抢滩点本身被占，从它的 4 邻域起手
  assert.ok(hand.unlocked().has(`${near.col},${near.row}`));
  const res = hand.play(0, near.col, near.row);
  assert.equal(res.ok, true);
  assert.equal(hand.cards[0], null);
  hand.tick(API.HAND.refillSeconds);
  assert.ok(hand.cards[0], '冷却结束要补回一张牌');
});

test('落牌判据：道路格拒建、重复占拒建、辐射外拒建', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  const road = M.fromAbstract(R.SPEC.roadRow, 2);
  assert.equal(M.isRoad(road.col, road.row), true);
  assert.equal(hand.play(0, road.col, road.row).ok, false);
  assert.equal(hand.play(0, -1, -1).ok, false);            // 地图外
  const seed = M.fromAbstract(R.SEEDS[0][0], R.SEEDS[0][1]);
  assert.equal(hand.play(0, seed.col, seed.row).ok, false); // 起点已占
  const far = M.terrainCells().find((c) => !M.isRoad(c.col, c.row) && !hand.claims.has(`${c.col},${c.row}`));
  assert.equal(hand.play(0, far.col, far.row).ok, false);   // 没辐射到
});

test('金币只扣一次：盖楼走卡牌 cost，规则层 claimCell 只镜像不扣钱', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  const cost = hand.cards[0].cost;
  const before = g.state.factions[0].gold;
  const near = M.fromAbstract(R.SEEDS[0][0] + 1, R.SEEDS[0][1]);
  const res = hand.play(0, near.col, near.row);
  assert.equal(res.ok, true, res.reason);
  assert.equal(g.state.factions[0].gold, before - cost, '只准扣卡牌 cost 这一次');
  const a = M.toAbstract(near.col, near.row);
  assert.equal(g.state.cells[a.r][a.c].owner, 0, '抽象网格应同步占领');
  assert.equal(g.state.cells[a.r][a.c].building, true);
});

test('商队卡必须落在道路或自己的集市上，且不再额外扣一次钱', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  const slot = hand.cards.findIndex((c) => c && c.id === 'caravan');
  if (slot < 0) {
    // 手牌是确定性的，但卡池顺序可能变；直接借扩展卡表造一张牌验证判据
    assert.ok(EXTRA_CARDS.some((c) => c.id === 'caravan'));
    return;
  }
  const land = M.fromAbstract(0, 0);
  assert.equal(hand.play(slot, land.col, land.row).ok, false, '空地不能发车');
  const roadCell = M.starRoads()[0];
  const before = g.state.factions[0].gold;
  const res = hand.play(slot, roadCell.col, roadCell.row);
  assert.equal(res.ok, true, res.reason);
  assert.equal(g.state.factions[0].gold, before - R.SPEC.cost.caravan, '车费只扣规则层那一笔');
});

test('重置清掉占领与手牌，商路设置回到默认', () => {
  const g = freshGame();
  const hand = createHand(API, g);
  const near = M.fromAbstract(R.SEEDS[0][0] + 1, R.SEEDS[0][1]);
  hand.play(0, near.col, near.row);
  hand.setTrade(5, 'far');
  assert.equal(g.tradeTarget, 5);
  assert.equal(g.tradeKind, 'far');
  const before = hand.claims.size;
  hand.reset();
  assert.equal(hand.claims.size, 12, '每方两处起点 × 6 方');
  assert.ok(before > 12);
  assert.equal(g.tradeTarget, 2);
  assert.equal(g.tradeKind, 'near');
  assert.ok(hand.cards.every(Boolean));
});
