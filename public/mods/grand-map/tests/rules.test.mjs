/**
 * 大地图规则层自测 —— 用 `npm run test:mod` 跑（已并入 `npm run check`）。
 *
 * 刻意不并进 vitest 主套件：模组是热插拔的，主套件不该执行模组代码
 * （见 `tests/mod_isolation_20261108.test.ts` 的隔离锁）。
 * 这里锁的是三轮口径里已经 `[定]` 的部分，数值一律从 SPEC 读，不写死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEC, REL, ROADS, FACTIONS, SEEDS,
  createGame, relationOf, setRelation, backstab, allyCount,
  unlockedCells, placeBuilding, blockedSegments, canTrade,
  sendCaravan, resolveIncoming, tick, score,
} from '../core/rules.js';

const fresh = () => createGame(42);

test('开局：6 方满金、固定路网 6 近 + 3 远', () => {
  const s = fresh();
  assert.equal(s.factions.length, 6);
  assert.ok(s.factions.every((f) => f.gold === SPEC.gold.start));
  assert.equal(ROADS.filter((r) => r.kind === 'near').length, 6);
  assert.equal(ROADS.filter((r) => r.kind === 'far').length, 3);
  assert.equal(FACTIONS.filter((f) => f.isPlayer).length, 1);
});

test('关系四态：结盟受上限约束，背刺 = 死仇且永不复盟', () => {
  const s = fresh();
  // 玩家开局与 0-2 中立，先结盟
  assert.equal(setRelation(s, 0, 2, REL.ALLIED).ok, true);
  assert.equal(allyCount(s, 0), SPEC.allyLimit);
  // 第二个盟友被挡（联盟最多 2 人）
  assert.equal(setRelation(s, 0, 4, REL.ALLIED).ok, false);
  assert.equal(setRelation(s, 0, 4, REL.ALLIED).reason, 'ally-limit');
  // 背刺
  assert.equal(backstab(s, 0, 2).ok, true);
  assert.equal(relationOf(s, 0, 2), REL.FEUD);
  // 反证：死仇不能改回中立/结盟
  assert.equal(setRelation(s, 0, 2, REL.NEUTRAL).ok, false);
  assert.equal(setRelation(s, 0, 2, REL.ALLIED).ok, false);
  assert.equal(relationOf(s, 0, 2), REL.FEUD);
});

test('商路只连中立与盟友；敌对 / 死仇发不出车', () => {
  const s = fresh();
  assert.equal(canTrade(s, 0, 1).ok, false);           // 0-1 开局敌对
  assert.equal(canTrade(s, 0, 2).ok, true);            // 0-2 中立
  assert.equal(sendCaravan(s, 0, 1, 'near').ok, false);
  assert.equal(sendCaravan(s, 0, 2, 'near').ok, true);
  setRelation(s, 0, 2, REL.FEUD);
  assert.equal(canTrade(s, 0, 2).ok, false);
});

test('近安全钱少、远钱多，且都从 SPEC 读', () => {
  const s = fresh();
  const near = sendCaravan(s, 0, 2, 'near').caravan;
  const far = sendCaravan(s, 0, 5, 'far').caravan;
  assert.equal(near.cargo, SPEC.trade.near);
  assert.equal(far.cargo, SPEC.trade.far);
  assert.ok(far.cargo > near.cargo);
  assert.ok(far.ticksLeft > near.ticksLeft);
});

test('中心区：道路格恒不可建，放楼后 4 邻域辐射解锁', () => {
  const s = fresh();
  const [sr, sc] = SEEDS[0];
  assert.equal(placeBuilding(s, 0, SPEC.roadRow, 2).ok, false);
  assert.equal(placeBuilding(s, 0, SPEC.roadRow, 2).reason, 'road');
  assert.equal(placeBuilding(s, 0, 8, 8).ok, false);        // 太远，没解锁
  assert.equal(placeBuilding(s, 0, sr, sc).ok, true);
  const unlocked = unlockedCells(s, 0).map(([r, c]) => `${r},${c}`);
  assert.ok(unlocked.includes(`${sr + 1},${sc}`));
  assert.ok(unlocked.includes(`${sr},${sc + 1}`));
  assert.ok(!unlocked.some((k) => k.startsWith(`${SPEC.roadRow},`)));
});

test('封路判据：路段上下两侧皆敌 ⇒ 封死；单侧敌不封', () => {
  const s = fresh();
  const col = 4;
  s.cells[SPEC.roadRow - 1][col] = { owner: 1, building: false };  // 0-1 敌对
  s.cells[SPEC.roadRow + 1][col] = { owner: 3, building: false };  // 0-3 敌对
  assert.ok(blockedSegments(s, 0).includes(col));
  s.cells[SPEC.roadRow + 1][col] = { owner: 2, building: false };  // 0-2 中立
  assert.ok(!blockedSegments(s, 0).includes(col));
});

test('商队到站结算；路段封死时无护航断供、有护航照过', () => {
  // 注意：tick() 会就地递减 car.ticksLeft，循环上界必须先存下来
  const s = fresh();
  // 满金开局时收益会被 cap 截断（钱是存量，得先花才有回补空间），先腾出空间再验
  s.factions[0].gold = 20;
  const before = s.factions[0].gold;
  const car = sendCaravan(s, 0, 2, 'near').caravan;
  const steps = car.ticksLeft;
  for (let i = 0; i < steps; i++) tick(s);
  assert.equal(s.factions[0].gold, before - SPEC.cost.caravan + car.cargo);

  const bothHostile = (st) => {
    st.cells[SPEC.roadRow - 1][4] = { owner: 1, building: false }; // 0-1 敌对
    st.cells[SPEC.roadRow + 1][4] = { owner: 3, building: false }; // 0-3 敌对
  };
  const s2 = fresh();
  bothHostile(s2);
  sendCaravan(s2, 0, 2, 'near');
  tick(s2);
  assert.equal(s2.caravans.length, 0, '两侧皆敌 ⇒ 无护航商队被挡回');

  const s3 = fresh();
  bothHostile(s3);
  sendCaravan(s3, 0, 2, 'near', true);
  tick(s3);
  assert.equal(s3.caravans.length, 1, '有护航 ⇒ 封死路段也照过');
});

test('极慢恢复 + 金币上限不越界', () => {
  const s = fresh();
  s.factions[0].gold = SPEC.gold.cap;
  for (let i = 0; i < SPEC.gold.regenTicks * 2; i++) tick(s);
  assert.equal(s.factions[0].gold, SPEC.gold.cap);
  s.factions[0].gold = 0;
  const t0 = s.tick;
  while (s.tick < t0 + SPEC.gold.regenTicks) tick(s);
  assert.equal(s.factions[0].gold, SPEC.gold.regenAmount);
});

test('扣押：一次性收益 + 立即死仇；死仇后不能再扣也不能复盟', () => {
  const s = fresh();
  s.factions[0].gold = 20; // 满金时扣押收益会被 cap 吃掉，先模拟已花钱的状态
  // 造一张中立势力发给玩家的车，跑到站进 pending
  const car = sendCaravan(s, 2, 0, 'near').caravan;
  const steps = car.ticksLeft;
  for (let i = 0; i < steps; i++) tick(s);
  const p = s.pending.find((x) => x.id === car.id);
  assert.ok(p, '中立来车应进入待处理队列');
  const before = s.factions[0].gold;
  assert.equal(resolveIncoming(s, car.id, 'seize').ok, true);
  assert.ok(s.factions[0].gold > before);
  assert.equal(relationOf(s, 0, 2), REL.FEUD);
  assert.equal(resolveIncoming(s, car.id, 'trade').ok, false); // 已处理掉
  assert.equal(setRelation(s, 0, 2, REL.ALLIED).ok, false);
});

test('盟友来车只能正常贸易，不能扣押', () => {
  const s = fresh();
  setRelation(s, 0, 2, REL.ALLIED);
  const car = sendCaravan(s, 2, 0, 'near').caravan;
  const steps = car.ticksLeft;
  for (let i = 0; i < steps; i++) tick(s);
  const p = s.pending.find((x) => x.id === car.id);
  assert.ok(p);
  assert.equal(resolveIncoming(s, car.id, 'seize').reason, 'not-neutral');
  assert.equal(relationOf(s, 0, 2), REL.ALLIED);
});

test('到点结算按积分排名（原型占位，暂无拆家战斗）', () => {
  const s = fresh();
  while (!s.finished) tick(s);
  const board = score(s);
  assert.equal(board.length, 6);
  assert.ok(board[0].total >= board[5].total);
});
