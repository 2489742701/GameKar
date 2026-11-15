/**
 * 法术牌（2026-11-16，P-103）—— 用户："我们要加一个法术牌远程攻击"。
 *
 * 这一族锁的是**法术和另外三种卡的本质区别**，不是数值：
 *   ① 它是唯一能越过中线 / 黄区的卡；
 *   ② 它不生成任何实体（不占人口、面包、后勤名额、不留兵）；
 *   ③ 只打敌方，不打自己人；
 *   ④ 打不到大本营（否则"拆家靠推兵线"这条攻防抓手就废了）；
 *   ⑤ 命中走的是现有那两个伤害入口，不另开一条结算路径。
 *
 * 数值是基础版占位（用户："先做基础版，数值后调"），所以测试读 SPELL / CARDS，
 * 不写死 26 或 1.6 —— 改数值不该让这族锁变红。
 */
import { describe, expect, it } from 'vitest';
import {
  CARDS, SPELL, cardById, FIELD, NO_BUILD, BUILDING_DAMAGE_SCALE,
  type ArenaCard,
} from '@arena/config';
import { iconOf } from '@arena/cardIcons';
import { ArenaWorld } from '@arena/ArenaWorld';
import { statsOf } from '@arena/types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const SPELL_CARD = cardById('fireball');

/** 造一个已经跑起来的世界，并给它一张指定卡（跳过抽卡随机性）。 */
function worldWith(card: ArenaCard): ArenaWorld {
  const w = new ArenaWorld({ seed: 20261116 });
  w.players[0]!.gold = 999;
  w.players[0]!.hand[0] = card;
  return w;
}

/** 手工摆一个兵（和 `tests/arena.test.ts` 同一套写法：直接 push 进 world.units）。 */
function putUnit(w: ArenaWorld, side: 'blue' | 'red', col: number, row: number, defId = 'archer') {
  const st = statsOf(defId);
  const id = 9000 + w.units.length;
  w.units.push({
    id,
    side,
    defId,
    x: col,
    z: row,
    hp: st.hp,
    maxHp: st.hp,
    cooldown: 0,
    stun: 0,
    order: null, detour: 1 as const,
  });
  return w.units.find((u) => u.id === id)!;
}

/** 手工摆一栋楼（跳过施工，直接进 buildings）。 */
function putBuilding(w: ArenaWorld, side: 'blue' | 'red', kind: 'mill' | 'house', col: number, row: number) {
  const id = 8000 + w.buildings.size;
  const hp = 300;
  w.buildings.set(id, {
    id, side, kind, col, row,
    hp, maxHp: hp,
    buildLeft: 0,
    lastHit: 'blade',
    lastHitAt: -99,
    repairLeft: 0,
  } as never);
  return w.buildings.get(id)!;
}

describe('法术牌是卡池里的一等公民', () => {
  it('kind 是 spell，带 SPELL 里存在的法术 id，价格是真价格', () => {
    expect(SPELL_CARD.kind).toBe('spell');
    expect(SPELL_CARD.spell).toBe('fireball');
    expect(SPELL[SPELL_CARD.spell!]).toBeTruthy();
    expect(SPELL_CARD.cost).toBeGreaterThan(0);
    // 法术不挂 squad / building —— 挂了就说明又想让它生成实体
    expect(SPELL_CARD.squad).toBeUndefined();
    expect(SPELL_CARD.building).toBeUndefined();
  });

  it('卡池里有三种法术（火球 / 剑雨 / 导弹），且 id 唯一', () => {
    const spells = CARDS.filter((c) => c.kind === 'spell');
    expect(spells).toHaveLength(3);
    expect(spells.map((c) => c.spell).sort()).toEqual(['arrowRain', 'fireball', 'missile']);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
  });

  it('每张法术卡都带能画的卡面图标（不是虚线空框兜底）', () => {
    for (const c of CARDS.filter((x) => x.kind === 'spell')) {
      const svg = iconOf(c.id);
      expect(svg, `${c.id} 没有专属图标`).not.toContain('stroke-dasharray');
    }
  });

  it('SPELL 的每个键都被某张卡引用（没有孤立的法术数据）', () => {
    for (const key of Object.keys(SPELL)) {
      expect(CARDS.some((c) => c.spell === key), `SPELL.${key} 没有任何卡在用`).toBe(true);
    }
  });
});

/**
 * P-104 三种法术的**分工** —— 用户口径：
 * 「火球可以砸建筑，剑雨更适合砸军队，我们额外会准备一个导弹，价值 20，
 *   可以炸毁敌人的一小片的建筑物」。
 *
 * 这一族不测数值大小（基础版可调），只测**打谁 / 不打谁**这条分工不能弄反。
 */
describe('★ 三种法术的分工：打兵还是打楼', () => {
  const spec = (id: string) => SPELL[cardById(id).spell!]!;

  it('火球：两样都打，但对兵打折（通用不专精）', () => {
    const s = spec('fireball');
    expect(s.vsUnits).toBe(true);
    expect(s.vsBuildings).toBe(true);
    expect(s.unitScale).toBeGreaterThan(0);
    expect(s.unitScale, '通用法术对兵要打折，否则专精的剑雨没有存在意义').toBeLessThan(1);
  });

  it('剑雨：只打兵，满伤，打不到楼', () => {
    const s = spec('arrowRain');
    expect(s.vsUnits).toBe(true);
    expect(s.vsBuildings, '剑雨不该能拆楼').toBe(false);
    expect(s.unitScale, '剑雨是专精，对兵满伤').toBe(1);
  });

  it('导弹：只打楼，打不到兵，且是最贵的（20 金）', () => {
    const s = spec('missile');
    expect(s.vsUnits, '导弹不该能打兵').toBe(false);
    expect(s.vsBuildings).toBe(true);
    expect(s.unitScale).toBe(0);
    const missile = cardById('missile');
    expect(missile.cost).toBe(20);
    // 三种里最贵，且明显贵一档（拆楼的代价）
    for (const other of CARDS.filter((c) => c.kind === 'spell' && c.id !== 'missile')) {
      expect(missile.cost).toBeGreaterThan(other.cost);
    }
  });

  it('导弹确实炸不动兵：数值打到兵身上是 0（不是被 max(1,…) 兜成 1）', () => {
    const w = worldWith(cardById('missile'));
    w.players[0]!.gold = 999;
    const foe = putUnit(w, 'red', FIELD.midCol + 6, 10);
    const before = foe.hp;
    w.playCard('blue', 0, FIELD.midCol + 6, 10);
    expect(foe.hp, '导弹打兵应该是 0 伤害').toBe(before);
  });

  it('剑雨确实拆不动楼', () => {
    const w = worldWith(cardById('arrowRain'));
    w.players[0]!.gold = 999;
    const mill = putBuilding(w, 'red', 'mill', FIELD.midCol + 6, 8);
    const before = mill.hp;
    w.playCard('blue', 0, mill.col + 1, mill.row + 1);
    expect(mill.hp, '剑雨不该拆楼').toBe(before);
  });

  it('火球两样都能打（和上面两条形成对照）', () => {
    const w1 = worldWith(cardById('fireball'));
    w1.players[0]!.gold = 999;
    const foe = putUnit(w1, 'red', FIELD.midCol + 6, 10);
    const hp0 = foe.hp;
    w1.playCard('blue', 0, FIELD.midCol + 6, 10);
    expect(foe.hp, '火球应该能打兵').toBeLessThan(hp0);

    const w2 = worldWith(cardById('fireball'));
    w2.players[0]!.gold = 999;
    const mill = putBuilding(w2, 'red', 'mill', FIELD.midCol + 6, 8);
    const mhp0 = mill.hp;
    w2.playCard('blue', 0, mill.col + 1, mill.row + 1);
    expect(mill.hp, '火球应该能砸楼').toBeLessThan(mhp0);
  });
});

/**
 * ★ 发牌裁量：只打楼的卡在没有敌方建筑的模式里不该发。
 *
 * 踩过的坑：PVE **没有敌方建筑**，导弹发到手上是永远打不出去的废牌，
 * 白占一个手牌位。实测 12 局托管从 9 胜掉到 7 胜。
 */
describe('★ 只打楼的法术不会发到"对面没楼"的局里', () => {
  it('PVE：导弹退出卡池；剑雨要法术工厂（没工厂不发）', () => {
    const w = new ArenaWorld({ mode: 'pve', seed: 20261116 });
    expect(w.hasEnemyBuildingTarget('blue'), 'PVE 开局对面应该没有楼').toBe(false);
    expect(w.techAllows('blue', cardById('missile')), '导弹在 PVE 里是废牌（打不到兵也没有楼）').toBe(false);
    // 剑雨要法术工厂（2026-11-16 用户口径），PVE 里同样适用
    expect(w.techAllows('blue', cardById('arrowRain')), '没工厂不该发剑雨').toBe(false);
    // ⚠️ 火球是基础牌：对面没楼时它对兵仍能造成打折伤害 ⇒ **不该**被禁发
    expect(w.techAllows('blue', cardById('fireball'))).toBe(true);
  });

  it('盖好法术工厂后，剑雨就发得出来了', () => {
    const w = new ArenaWorld({ mode: 'pve', seed: 20261116 });
    expect(w.techAllows('blue', cardById('arrowRain'))).toBe(false);
    // 直接摆一座完工的工厂（不走施工，只验发牌判据）
    w.buildings.set(7001, {
      id: 7001, side: 'blue', kind: 'spellForge', col: 4, row: 4,
      hp: 420, maxHp: 420, build: 1, buildLeft: 0,
      lastHit: 'blade', lastHitAt: -99, repairLeft: 0,
    } as never);
    expect(w.techAllows('blue', cardById('arrowRain')), '工厂盖好后剑雨该放行了').toBe(true);
  });

  it('1v1：对面有楼时导弹正常发', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    // 1v1 开局双方各有一座大本营 —— 但大本营不算"可被法术打到"的目标
    expect(w.hasEnemyBuildingTarget('blue'), '大本营不算导弹目标').toBe(false);
    putBuilding(w, 'red', 'mill', FIELD.midCol + 6, 8);
    expect(w.hasEnemyBuildingTarget('blue')).toBe(true);
    expect(w.techAllows('blue', cardById('missile'))).toBe(true);
  });

  it('反证：判据不是"永远 false"（喂一栋楼必须翻成 true）', () => {
    const w = new ArenaWorld({ seed: 20261116 });
    const before = w.hasEnemyBuildingTarget('blue');
    putBuilding(w, 'red', 'house', FIELD.midCol + 7, 12);
    expect(w.hasEnemyBuildingTarget('blue')).toBe(!before);
  });
});

describe('① 能越过中线与黄区 —— 这是"远程"的全部意义', () => {
  it('可以落在对面半场', () => {
    const w = worldWith(SPELL_CARD);
    const enemyCol = FIELD.midCol + NO_BUILD.halfWidth + 2;
    expect(w.canPlaceAt('blue', 0, enemyCol, 10).ok, '法术必须能丢到对面').toBe(true);
  });

  it('可以落在黄区（禁建带）里', () => {
    const w = worldWith(SPELL_CARD);
    expect(w.canPlaceAt('blue', 0, FIELD.midCol, 10).ok, '黄区只是不能盖楼放兵，法术应该能打').toBe(true);
  });

  it('但仍然不许落到地图外', () => {
    const w = worldWith(SPELL_CARD);
    expect(w.canPlaceAt('blue', 0, -1, 10).ok).toBe(false);
    expect(w.canPlaceAt('blue', 0, FIELD.cols + 5, 10).ok).toBe(false);
    expect(w.canPlaceAt('blue', 0, 10, FIELD.rows + 5).ok).toBe(false);
  });

  it('反证：普通军队卡在同样位置会被拦（说明上一条不是判据失效）', () => {
    const w = worldWith(cardById('archers'));
    const enemyCol = FIELD.midCol + NO_BUILD.halfWidth + 2;
    expect(w.canPlaceAt('blue', 0, enemyCol, 10).ok).toBe(false);
  });
});

describe('② 不生成任何实体', () => {
  it('打完法术：兵不变、楼不变、金币照扣、牌进冷却', () => {
    const w = worldWith(SPELL_CARD);
    const before = {
      gold: w.players[0]!.gold,
      units: w.units.length,
      buildings: w.buildings.size,
    };
    const res = w.playCard('blue', 0, FIELD.midCol, 10);
    expect(res.ok).toBe(true);
    expect(w.units.length, '法术不该造出任何兵').toBe(before.units);
    expect(w.buildings.size, '法术不该造出任何楼').toBe(before.buildings);
    expect(w.players[0]!.gold).toBe(before.gold - SPELL_CARD.cost);
    expect(w.players[0]!.hand[0]).toBeNull();
    expect(w.players[0]!.cooldowns[0]!).toBeGreaterThan(0);
  });

  it('不占人口、不吃面包（容器读数一分不动）', () => {
    const w = worldWith(SPELL_CARD);
    const before = w.staffedCount('blue');
    w.playCard('blue', 0, FIELD.midCol, 10);
    const after = w.staffedCount('blue');
    expect(after).toEqual(before);
  });
});

describe('③④ 只打敌方，且打不到大本营', () => {
  it('命中范围内的敌方部队，我方部队不掉血', () => {
    const w = worldWith(SPELL_CARD);
    const col = FIELD.midCol;
    const row = 10;
    // 敌方部队（红方）放在落点上，我方也放一个在旁边（会被误伤的话就说明判据写反了）
    const foe = putUnit(w, 'red', col, row);
    const own = putUnit(w, 'blue', col, row + 1);
    const foeHp = foe.hp;
    const ownHp = own.hp;

    w.playCard('blue', 0, col, row);

    expect(foe.hp, '敌方兵应该掉血').toBeLessThan(foeHp);
    expect(own.hp, '我方兵不该被自己的法术打到').toBe(ownHp);
  });

  it('★ 大本营吃不到法术伤害（拆家必须靠推兵线）', () => {
    const w = worldWith(SPELL_CARD);
    const core = [...w.buildings.values()].find((b) => b.kind === 'core' && b.side === 'red');
    expect(core, '开局应该有红方大本营').toBeTruthy();
    const before = core!.hp;
    // 直接往红方大本营头上丢
    w.playCard('blue', 0, core!.col, core!.row);
    expect(core!.hp, '法术不该能砸大本营').toBe(before);
    // 反证：这条判据不是"什么都没算"——施法事件应该照常产生
    expect(w.spellCasts.length).toBe(1);
  });

  it('命中范围内的敌方建筑会掉血（走拆楼倍率）', () => {
    const w = worldWith(SPELL_CARD);
    const mill = putBuilding(w, 'red', 'mill', FIELD.midCol + 6, 8);
    const before = mill.hp;
    // 落在磨坊占地中心
    w.playCard('blue', 0, mill.col + 1, mill.row + 1);
    expect(mill.hp, '敌方建筑应该吃到法术').toBeLessThan(before);
  });
});

describe('⑤ 命中走现有伤害入口，不另开一条结算路径', () => {
  it('源码里法术只调 hurtUnit / hurtBuilding，没有自己写掉血', () => {
    const src = stripComments(read('src/arena/ArenaWorld.ts'));
    const cast = src.slice(src.indexOf('private castSpell'), src.indexOf('private noteSpell'));
    expect(cast.length).toBeGreaterThan(400); // 切到了正确的函数
    // 伤害必须走这两个唯一入口（对兵那次带的是乘过倍率的 unitDamage）
    expect(cast).toContain('this.hurtUnit(u, unitDamage)');
    expect(cast).toContain("this.hurtBuilding(b, spec.damage, 'magic', side)");
    // 反证：自己写 hp -= 就是绕过了唯一入口
    expect(cast).not.toMatch(/\.hp\s*-=/);
    expect(cast).not.toMatch(/\.hp\s*=\s*Math\.max/);
  });

  it('施法会留一条视觉事件，含落点 / 半径 / 命中数（视图只读不判）', () => {
    const w = worldWith(SPELL_CARD);
    putUnit(w, 'red', FIELD.midCol, 10);
    w.playCard('blue', 0, FIELD.midCol, 10);
    const ev = w.spellCasts[0]!;
    expect(ev.spell).toBe('fireball');
    expect(ev.radius).toBe(SPELL.fireball!.radius);
    expect(ev.hitUnits).toBeGreaterThan(0);
    expect(ev.seconds).toBeGreaterThan(0);
    // 落点世界坐标要现成给好，视图不用再换算一次
    expect(typeof ev.x).toBe('number');
    expect(typeof ev.z).toBe('number');
  });

  it('视觉事件到点自己消失（不会无限堆积）', () => {
    const w = worldWith(SPELL_CARD);
    w.playCard('blue', 0, FIELD.midCol, 10);
    expect(w.spellCasts).toHaveLength(1);
    const life = w.spellCasts[0]!.seconds;
    w.update(life + 0.1);
    expect(w.spellCasts, '特效事件该被摘掉了').toHaveLength(0);
  });

  it('反证：法术 id 写错时不结算，但也不抛（配置错误交给测试抓）', () => {
    const bad = { ...SPELL_CARD, spell: 'no-such-spell' } as ArenaCard;
    const w = worldWith(bad);
    expect(() => w.playCard('blue', 0, FIELD.midCol, 10)).not.toThrow();
    expect(w.spellCasts).toHaveLength(0);
  });
});

describe('伤害数值跟着 SPELL 走（基础版可调）', () => {
  it('导弹是 150 伤（用户 2026-11-16："一发 150 伤"）', () => {
    expect(SPELL.missile!.damage).toBe(150);
    // 对楼实际伤害走 BUILDING_DAMAGE_SCALE：150 × 2.2 = 330
    // 一座箭塔 520 血吃两发、磨坊 300 血一发带走 —— 这是"20 金该有的分量"
    expect(SPELL.missile!.damage * BUILDING_DAMAGE_SCALE).toBeGreaterThan(300);
  });

  it('兵吃到的伤害 = damageOf(法术伤害 × 对兵倍率, 该兵防御)', () => {
    const w = worldWith(SPELL_CARD);
    const foe = putUnit(w, 'red', FIELD.midCol, 10);
    const def = statsOf('archer').defense;
    const before = foe.hp;
    w.playCard('blue', 0, FIELD.midCol, 10);
    // P-104 起对兵要乘 unitScale（通用法术打折、专精法术满伤）
    const scaled = SPELL.fireball!.damage * SPELL.fireball!.unitScale;
    const expectDmg = Math.max(1, scaled - def);
    expect(before - foe.hp).toBe(expectDmg);
  });

  it('剑雨是满伤：不乘折扣，打到兵身上就是 damage − 防御', () => {
    const w = worldWith(cardById('arrowRain'));
    w.players[0]!.gold = 999;
    const foe = putUnit(w, 'red', FIELD.midCol, 10);
    const def = statsOf('archer').defense;
    const before = foe.hp;
    w.playCard('blue', 0, FIELD.midCol, 10);
    expect(before - foe.hp).toBe(Math.max(1, SPELL.arrowRain!.damage - def));
  });

  it('楼吃到的伤害 = 法术伤害 × 拆楼倍率（和塔/兵同一档，不开小灶）', () => {
    const w = worldWith(SPELL_CARD);
    const mill = putBuilding(w, 'red', 'mill', FIELD.midCol + 6, 8);
    const before = mill.hp;
    w.playCard('blue', 0, mill.col + 1, mill.row + 1);
    // 不写死倍率：只断言"掉得比纯法术伤害多"，因为对楼要乘 BUILDING_DAMAGE_SCALE
    expect(before - mill.hp).toBeGreaterThan(SPELL.fireball!.damage);
  });
});
