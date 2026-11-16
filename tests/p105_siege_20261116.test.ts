/**
 * 攻城器械的"白嫖走位"（2026-11-16，P-105）。
 *
 * 用户口径：
 * 「看一下移动火炮和移动弓弩，他们的 AI 更智能点，无论如何都不会进入塔的射程，
 *   并且这两个攻城器械，打人疼，打塔更疼，并且一直会保持在塔的外围射程，
 *   可以智能选择攻击塔和攻击靠近的敌方。并且是能白嫖塔楼」
 * 「就移动火炮提 8.6，弩箭提 8.2，移动火炮优先打塔，弩箭优先打兵」
 *
 * 这一族锁的是**行为**，不是数值：
 *   ① 射程真的超过了箭塔（否则"白嫖"是空话）；
 *   ② 目标优先级：火炮优先打塔、弩箭优先打兵；
 *   ③ 站在塔的射程外开火 —— 不是"射程够得着"，而是"实际站位在外围"；
 *   ④ 进了危险圈会主动后撤；
 *   ⑤ 普通兵种不受影响（不许把推兵线变成跳华尔兹）。
 *
 * ⚠️ **场景一律走真实落牌路径**（`playCard`）而不是手工 `units.push`：
 * 手工构造的单位会漏掉绕障/分兵需要的字段，表现为"单位根本不动"。
 * 写这一族测试时踩过这个坑 —— 以为是 AI 坏了，其实是场景不合法。
 */
import { describe, expect, it } from 'vitest';
import {
  BALLISTA, MOBILE, TOWER, SIEGE_AI, cardById,
} from '@arena/config';
import { ArenaWorld } from '@arena/ArenaWorld';
import { statsOf } from '@arena/types';

/** 用真实落牌路径在场上放一支部队（卡 → squad → 兵）。 */
function spawn(w: ArenaWorld, side: 'blue' | 'red', cardId: string, col: number, row: number): void {
  const p = w.players[side === 'blue' ? 0 : 1]!;
  p.gold = 999;
  p.hand[0] = cardById(cardId);
  p.cooldowns[0] = 0;
  const res = w.playCard(side, 0, col, row);
  expect(res.ok, `${cardId} 应该能落在 (${col},${row})：${res.reason ?? ''}`).toBe(true);
}

/** 造一座**完工**的楼（带齐 ArenaBuilding 的全部必需字段）。 */
function putBuilding(
  w: ArenaWorld,
  side: 'blue' | 'red',
  kind: 'arrowTower' | 'cannonTower' | 'mill',
  col: number,
  row: number,
) {
  const id = 7000 + w.buildings.size;
  const hp = kind === 'arrowTower' ? TOWER.arrow.hp
    : kind === 'cannonTower' ? TOWER.cannon.hp : 300;
  w.buildings.set(id, {
    id, side, kind, col, row, cols: 3, rows: 3,
    hp, maxHp: hp,
    build: 1, timer: 0, fireIn: 0, flag: null,
    lastHit: 'blade', lastHitAt: -99, repairLeft: 0,
  } as never);
  return w.buildings.get(id)!;
}

/** 兵到塔**心**的距离。`buildingCenter` 用的是 `col + cols/2`。 */
const distTo = (u: { x: number; z: number }, b: { col: number; row: number }): number =>
  Math.hypot(b.col + 1.5 - u.x, b.row + 1.5 - u.z);

/** 跑一段时间，每帧回调。 */
function run(w: ArenaWorld, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    w.update(0.05);
    each?.();
  }
}

describe('① 射程：白嫖窗口真的打开了', () => {
  it('移动火炮 8.6 / 弩箭 8.2，都超过箭塔 7.8', () => {
    expect(MOBILE.range).toBe(8.6);
    expect(BALLISTA.range).toBe(8.2);
    expect(MOBILE.range).toBeGreaterThan(TOWER.arrow.range);
    expect(BALLISTA.range).toBeGreaterThan(TOWER.arrow.range);
  });

  it('索敌半径 ≥ 射程（否则"看得见却够不着"会站桩发呆）', () => {
    expect(MOBILE.sight).toBeGreaterThanOrEqual(MOBILE.range);
    expect(BALLISTA.sight).toBeGreaterThanOrEqual(BALLISTA.range);
  });
});

describe('② 目标优先级：火炮打塔、弩箭打兵', () => {
  it('statsOf 带上了 prefer 标记', () => {
    expect(statsOf('mobileCannon').prefer).toBe('building');
    expect(statsOf('ballista').prefer).toBe('unit');
    // 普通兵种不带 prefer（保持"贴脸的兵先还手"那条老规矩）
    expect(statsOf('archer').prefer).toBeUndefined();
    expect(statsOf('knight').prefer).toBeUndefined();
  });

  it('★ 火炮：射程内同时有兵和塔时，打的是塔', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    /**
     * 座位约束（踩坑记录）：黄区 18~26 列，蓝方合法 4~17、红方 27~39。
     * 两边最近的合法落点相距 10 格 —— 超过火炮射程 8.6，**跨半场一开始够不着**。
     *
     * 所以这条量的是"推进到位之后打谁"：火炮从 (17,9) 一路走到塔边，
     * 同时红方在塔**更近的位置**摆一队弓箭手（(27,12)，距塔心 3 格）。
     * 若没有 `prefer: 'building'`，火炮会先打那队更近的兵。
     *
     * ⚠️ **只跑 8 秒**：9 秒左右火炮会被那队弓箭手打死（90 血扛不住），
     * 之后塔开始自动回血，`tower.hp` 会涨回去，断言就测不到"打掉了"。
     * 这个时长是量出来的，不是拍脑袋。
     */
    const tower = putBuilding(w, 'red', 'arrowTower', 27, 9);
    spawn(w, 'blue', 'mobileCannon', 17, 9);
    spawn(w, 'red', 'archers', 27, 12);

    const enemy = w.units.find((u) => u.side === 'red' && u.defId === 'archer')!;
    const before = { tower: tower.hp, enemy: enemy.hp };

    run(w, 8);

    expect(tower.hp, '火炮应该优先打塔').toBeLessThan(before.tower);
    expect(enemy.hp, '更近的敌兵不该被优先打').toBe(before.enemy);
    /**
     * ⚠️ **不断言 `cannon.hp > 0`**：它被那队弓箭手集火，8 秒内基本必死
     * （0.05 步长实测约 7.5 秒倒地；0.5 步长能撑到 8 秒，差一点）。
     *
     * 这条测试要证明的是"它选择打塔而不是打兵"，不是"它能活着"。
     * 断言"它在死之前确实打掉过塔血"就够了 —— 上面那条已经证明了这件事。
     */
  });

  it('★ 弩箭：射程内同时有兵和楼时，打的是兵', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    putBuilding(w, 'red', 'mill', 30, 9);
    spawn(w, 'blue', 'ballista', 14, 9);
    spawn(w, 'red', 'archers', 28, 9);

    const enemy = w.units.find((u) => u.side === 'red' && u.defId === 'archer')!;
    const before = enemy.hp;
    run(w, 15);
    expect(enemy.hp, '弩箭应该优先打兵').toBeLessThan(before);
  });
});

describe('③ 站位：开火时必须在塔的射程外', () => {
  it('★ 火炮能打到箭塔，且射击时距塔心 > 箭塔射程 + 占地半径', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    const tower = putBuilding(w, 'red', 'arrowTower', 30, 9);
    spawn(w, 'blue', 'mobileCannon', 14, 9);
    const cannon = w.units.find((u) => u.defId === 'mobileCannon')!;

    /** 塔心到塔射程边缘：塔的判定从**占地边缘**量，3×3 半宽 1.5 */
    const edge = TOWER.arrow.range + 1.5;

    let fireDist = Number.NaN;
    let prevHp = tower.hp;
    run(w, 40, () => {
      if (tower.hp < prevHp && Number.isNaN(fireDist)) fireDist = distTo(cannon, tower);
      prevHp = tower.hp;
    });

    expect(Number.isNaN(fireDist), '火炮应该开过火').toBe(false);
    expect(fireDist, `开火时距塔心 ${fireDist.toFixed(2)}，应该在 ${edge.toFixed(2)} 之外`)
      .toBeGreaterThan(edge);
  });

  it('★ 全程不进危险圈：每一帧都在塔的射程外', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    const tower = putBuilding(w, 'red', 'arrowTower', 30, 9);
    spawn(w, 'blue', 'mobileCannon', 14, 9);
    const cannon = w.units.find((u) => u.defId === 'mobileCannon')!;
    const danger = TOWER.arrow.range + 1.5;

    let minDist = Number.POSITIVE_INFINITY;
    run(w, 40, () => {
      /**
       * ⚠️ **只统计塔还活着的那些帧**：这台车在 40 秒里把塔**拆掉了**
       * （440 血 ÷ 20 dps ≈ 22 秒，实测 40 秒内倒地），塔一没
       * `nearestTowerRange()` 就返回 null，车自然继续往里走 —— 那不是"进了危险圈"，
       * 是"危险源已经不存在了"。
       *
       * 早先没加这个条件，断言读到的是塔倒塌之后的位置，红得莫名其妙。
       */
      if (!w.buildings.has(tower.id)) return;
      if (cannon.hp > 0) minDist = Math.min(minDist, distTo(cannon, tower));
    });

    // 留一点刹车余量（推车速度 0.5，一帧走 0.025 格）
    expect(minDist, `最近曾到 ${minDist.toFixed(2)}，不该进入 ${danger.toFixed(2)}`)
      .toBeGreaterThan(danger - 0.35);
  });

  it('④ 一开始就在危险圈里 ⇒ 主动后撤', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    /**
     * ⚠️ **落牌路径放不进危险圈**，所以这条只能靠"把车推进去"来构造：
     *
     * 黄区是 midCol ± 4（18~26 列），蓝方合法列 4~17、红方 27~39，
     * 两边最近的合法落点相距 10 格（27 − 17）—— 而危险半径只有 9.7。
     * 也就是说**刚下发牌的那个位置永远在圈外**。
     *
     * 这不是测试取巧：实战里攻城车是**走进去**的，
     * 这一条量的正是"走进去之后会不会退出来"。
     */
    const tower = putBuilding(w, 'red', 'arrowTower', 27, 9);
    spawn(w, 'blue', 'mobileCannon', 17, 9);
    const cannon = w.units.find((u) => u.defId === 'mobileCannon')!;

    // 手动推进危险圈（模拟"一路走过来"）：距塔心 6 格，远小于 9.7
    cannon.x = 27 + 1.5 - 6;
    const start = distTo(cannon, tower);
    expect(start, '起点必须在危险圈内，否则这条测不到东西')
      .toBeLessThan(TOWER.arrow.range + 1.5 + SIEGE_AI.safety);

    run(w, 8);
    const now = distTo(cannon, tower);
    expect(now, `起点 ${start.toFixed(2)} → 现在 ${now.toFixed(2)}，应该退出来`).toBeGreaterThan(start);
  });
});

describe('⑤ 普通兵种不受影响', () => {
  it('弓箭手照旧推线，不会被"后撤"逻辑拦住', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    putBuilding(w, 'red', 'arrowTower', 30, 9);
    spawn(w, 'blue', 'archers', 14, 9);
    const archer = w.units.find((u) => u.side === 'blue')!;
    const x0 = archer.x;
    run(w, 6);
    expect(archer.x, '普通兵不该后撤').toBeGreaterThan(x0);
  });

  it('反证：prefer / siege 只挂在攻城器械上（statsOf 是唯一判据）', () => {
    expect(statsOf('mobileCannon').siege).toBe(true);
    expect(statsOf('ballista').siege).toBe(true);
    expect(statsOf('archer').siege).toBe(false);
    expect(statsOf('archer').prefer).toBeUndefined();
    // SIEGE_AI 三个旋钮缺一个就是走位写残了
    expect(SIEGE_AI.safety).toBeGreaterThan(0);
    expect(SIEGE_AI.approach).toBeGreaterThan(0);
    expect(SIEGE_AI.approach).toBeLessThan(1);
    expect(SIEGE_AI.retreatBoost).toBeGreaterThan(1);
  });
});

describe('卡片仍然指向正确的兵种', () => {
  it('两张攻城卡的 squad 与 kind 对得上', () => {
    expect(cardById('mobileCannon').squad?.[0]?.unitId).toBe('mobileCannon');
    expect(cardById('ballista').squad?.[0]?.unitId).toBe('ballista');
    expect(cardById('mobileCannon').kind).toBe('siege');
    expect(cardById('ballista').kind).toBe('siege');
  });
});
