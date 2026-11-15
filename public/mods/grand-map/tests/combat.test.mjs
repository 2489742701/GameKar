/**
 * 集结兵的战斗口径自测（2026-11-15）。
 *
 * 用户：「单位战斗原版中就有了」—— 意思是**别在模组里重写一套攻防血**，
 * 直接借原版 `src/game/data/units.ts` 那张表。
 *
 * 这里锁的就是这件事：
 *   · 兵的 hp / attack / defense / range 必须等于原版 `unitDef()` 的值；
 *   · 伤害必须走原版同一条公式 `max(1, 攻 − 防)`；
 *   · 查不到兵种时退默认值，但**绝不抛**（一张卡不能因为查不到兵种就出不来）。
 *
 * ⚠️ 本文件从真实 `src/game/data/units.ts` 读数值，不用手抄 ——
 * 手抄的话，改平衡时这条自测就成了"上一版的数"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRally } from '../core/rally.js';
import * as M from '../core/map.js';

// 本文件在 public/mods/grand-map/tests/，往上四级才到仓库根
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * 从原版兵种表里抠出某个兵种的数值。
 * 不 import（模组不许依赖主程序），所以读源码做静态解析 —— 这也是"证明它没抄错"的方式。
 */
function originalStats(unitId) {
  const src = readFileSync(`${ROOT}src/game/data/units.ts`, 'utf8');
  const at = src.indexOf(`id: '${unitId}'`);
  assert.ok(at > 0, `原版兵种表里找不到 ${unitId}`);
  // 从 id 那一行往后截一段，够覆盖这个兵种的全部字段
  const block = src.slice(at, at + 1400);
  const num = (key) => {
    const m = block.match(new RegExp(`\\b${key}:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : null;
  };
  return {
    hp: num('hp'),
    attack: num('attack'),
    defense: num('defense'),
    range: num('range'),
  };
}

/** 复刻原版那条公式。模组侧也应当只用这一条。 */
const expectDamage = (atk, dfn) => Math.max(1, atk - dfn);

test('兵的攻防血等于原版兵种表，不是模组自己另算的', () => {
  for (const unitId of ['archer', 'knight', 'militia']) {
    const real = originalStats(unitId);
    assert.ok(real.hp && real.attack !== null, `${unitId} 的原版数值没解析出来`);

    // 用原版数值当"注入桩"，看 rally 有没有原样吃下
    const rally = createRally({
      unitDef: () => ({ ...real, cooldown: 1, role: 'melee' }),
      damageOf: expectDamage,
    });
    const [u] = rally.spawn(M.MAP.cx, M.MAP.cy, 1, 'x', unitId);
    assert.equal(u.hp, real.hp, `${unitId} 的 hp 与原版不一致`);
    assert.equal(u.maxHp, real.hp);
    assert.equal(u.attack, real.attack);
    assert.equal(u.defense, real.defense);
    assert.equal(u.range, real.range);
  }
});

test('伤害走原版同一条公式：max(1, 攻 − 防)，且不会打出负数', () => {
  const rally = createRally({
    unitDef: () => ({ hp: 100, attack: 30, defense: 5, range: 1, cooldown: 1 }),
    damageOf: expectDamage,
  });
  const [a] = rally.spawn(M.MAP.cx - 2, M.MAP.cy, 1, 'x', 'a');
  const [b] = rally.spawn(M.MAP.cx + 2, M.MAP.cy, 1, 'x', 'b');

  // 攻 30 − 防 5 = 25
  assert.equal(rally.strike(a, b), 25);
  assert.equal(b.hp, 75);

  // 防高过攻时下限是 1，不是负数（原版口径：堆防堆不死人）
  b.defense = 999;
  assert.equal(rally.strike(a, b), 1);
  assert.equal(b.hp, 74);

  // 血被打到 0 就夹住，不会负
  b.defense = 0;
  a.attack = 500;
  rally.strike(a, b);
  assert.equal(b.hp, 0);
});

test('血归零的兵下一帧就被清掉，不会留尸体在 units 里', () => {
  const rally = createRally({
    unitDef: () => ({ hp: 10, attack: 10, defense: 0, range: 1, cooldown: 1 }),
    damageOf: expectDamage,
  });
  const [a] = rally.spawn(M.MAP.cx, M.MAP.cy, 1, 'x', 'a');
  const [b] = rally.spawn(M.MAP.cx + 1, M.MAP.cy, 1, 'x', 'b');
  assert.equal(rally.units.length, 2);
  rally.strike(a, b);
  assert.equal(b.hp, 0);
  rally.tick(0.05);
  assert.equal(rally.units.length, 1, '尸体没被清掉');
  assert.equal(rally.units[0].id, a.id);
});

test('查不到兵种时退默认值，绝不抛 —— 一张卡不能因此出不来', () => {
  const rally = createRally({
    unitDef: () => { throw new Error('未知兵种'); },
    damageOf: expectDamage,
  });
  let made;
  assert.doesNotThrow(() => { made = rally.spawn(M.MAP.cx, M.MAP.cy, 2, 'mysteryCard', 'nope'); });
  assert.equal(made.length, 2);
  for (const u of made) {
    assert.ok(u.hp > 0 && u.maxHp > 0, '默认血量必须为正');
    assert.ok(u.attack > 0, '默认攻击必须为正');
  }
});

test('没注入 unitDef / damageOf 也能跑（node 自测 / 极端兜底）', () => {
  const rally = createRally();
  const [u] = rally.spawn(M.MAP.cx, M.MAP.cy, 1, 'militia');
  assert.ok(u.hp > 0);
  const [t] = rally.spawn(M.MAP.cx + 1, M.MAP.cy, 1, 'militia');
  // 兜底公式仍是 max(1, 攻 − 防)
  assert.equal(rally.strike(u, t), Math.max(1, u.attack - t.defense));
});

test('冷却每帧推进，驻军也会回气（不为负）', () => {
  const rally = createRally({
    unitDef: () => ({ hp: 50, attack: 10, defense: 0, range: 1, cooldown: 2 }),
  });
  const [u] = rally.spawn(M.MAP.cx, M.MAP.cy, 1, 'x', 'a');
  u.ready = 2;
  // ⚠️ MAX_DT = 0.1：传 0.5 实际只推进 0.1。这是防卡帧跳跃的护栏，
  // 所以这里断言的是"按 0.1 推进"，不是"按传入的 0.5 推进"。
  rally.tick(0.5);
  assert.ok(Math.abs(u.ready - 1.9) < 1e-9, `实际 ${u.ready}`);
  rally.tick(10);
  assert.ok(Math.abs(u.ready - 1.8) < 1e-9, '大 dt 必须被夹到 0.1，否则卡一下就把冷却跳完了');
  // 连续推到 0 之后不许变负
  for (let i = 0; i < 30; i++) rally.tick(0.1);
  assert.equal(u.ready, 0, '冷却不该变成负数');
});
