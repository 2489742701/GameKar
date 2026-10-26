/**
 * 读数层与存档的锁（P-011）。
 *
 * 两条最容易犯的错在这里各配一条反向断言：
 * ① 满血也挂血条 —— 一屏幕条等于没有信息；
 * ② 读档时把"盖楼"重放一遍 —— 会二次扣资源、二次扣许可，玩家凭空破产。
 */

import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { ROUNDS, type Difficulty } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { Combat } from '@game/systems/Combat';
import { barWorthies, hpOf, ammoOf, squadOf } from '@game/systems/Readouts';
import { applySave, parseSave, snapshot, SAVE_VERSION } from '@game/world/save';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';
import { buildingFacts } from '@ui/facts';

function arena(
  difficulty: Difficulty = 'normal',
): { world: GameWorld; combat: Combat; at: (i: number) => ReturnType<typeof pos> } {
  const world = new GameWorld(new TileMap({ cols: 40, rows: 40 }), { seed: 777 });
  world.grant('gold', 100_000);
  world.grant('crystal', 10_000);
  for (const id of ['hall', 'barracks', 'arrowTower', 'cannonTower', 'house', 'farm', 'mill', 'field']) {
    world.addPermits(id, 40);
  }
  const combat = new Combat({ world, maxUnits: 40, difficulty });
  world.raidActive = () => combat.engaged();
  return { world, combat, at: (i) => pos(4 + i * 3, 6) };
}

function build(world: GameWorld, id: string, at: ReturnType<typeof pos>): Building {
  const b = world.build(id, at);
  if (!b) throw new Error(`${id} 盖不下去`);
  b.built = true;
  return b;
}

describe('血条读数', () => {
  it('满血不挂条；掉一丝血也要亮一格', () => {
    const { world, combat, at } = arena();
    const b = build(world, 'farm', at(0));
    expect(hpOf(b).visible).toBe(false);
    expect(hpOf(b).steps).toBe(6);

    // 掉一半：少两格
    b.hp = Math.floor(b.def.hp / 2);
    const r = hpOf(b);
    expect(r.visible).toBe(true);
    expect(r.steps).toBe(3);
    expect(barWorthies(world, combat).map((x) => x.id)).toContain(b.id);

    // 只掉 1 点血也要挂条（六格里还是满 6 格，但"挨过打"这件事必须看得见）
    b.hp = b.def.hp - 1;
    expect(hpOf(b).visible).toBe(true);
    expect(hpOf(b).steps).toBe(6);
  });

  it('剩两格以下算"快塌了"；归零是 0 格', () => {
    const { world, at } = arena();
    const b = build(world, 'hall', at(0));
    b.hp = Math.ceil(b.def.hp * (2 / 6));
    expect(hpOf(b).steps).toBeLessThanOrEqual(2);
    b.hp = 0;
    expect(hpOf(b).steps).toBe(0);
  });

  it('满编满弹的楼不出现在条层里；打空一夹就出现', () => {
    const { world, combat, at } = arena();
    const tower = build(world, 'arrowTower', at(0));
    const spec = buildingDef('arrowTower').tower!;
    expect(barWorthies(world, combat).some((x) => x.id === tower.id)).toBe(false);

    combat.towerState(tower).magazine = spec.magazine - 1;
    expect(barWorthies(world, combat).some((x) => x.id === tower.id)).toBe(true);
  });
});

describe('兵营三态与塔的弹夹读数', () => {
  it('三态各说各的话：生产中（走读条）→ 满编 → 掉人后有储备', () => {
    const { world, combat, at } = arena();
    const bar = build(world, 'barracks', at(0));
    const total = combat.squadSize(bar);
    expect(total).toBe(3);

    // 开局先吃储备：一次 update 补一个（20Hz 下两下就到位），第 3 个要等读条
    combat.update(0.05);
    combat.update(0.05);
    const training = squadOf(combat, bar)!;
    expect(training.alive).toBe(2);
    expect(training.training).not.toBeNull();
    expect(training.line).toContain('生产中');

    // 一直打到满编
    for (let i = 0; i < 900 && squadOf(combat, bar)!.alive < total; i++) combat.update(0.05);
    const full = squadOf(combat, bar)!;
    expect(full.alive).toBe(total);
    expect(full.line).toContain('满编');
    expect(full.training).toBeNull();

    // 死一个 + 袋里还有储备：立刻补位，不出现读条
    for (const u of combat.liveUnits()) if (u.home === bar.id) { u.dead = true; u.hp = 0; break; }
    combat.barracksState(bar).stock = 1;
    const resupply = squadOf(combat, bar)!;
    expect(resupply.alive).toBe(total - 1);
    expect(resupply.training).toBeNull();
    expect(resupply.line).toContain('储备 1');
  });

  it('塔：满弹不写"装填"，空仓写还剩几秒，等级写 Lv', () => {
    const { world, combat, at } = arena();
    const tower = build(world, 'cannonTower', at(0));
    const st = combat.towerState(tower);
    const full = ammoOf(combat, tower)!;
    expect(full.line).not.toContain('装填');
    expect(full.line).toContain('Lv1');

    st.magazine = 0;
    st.reloading = 3.4;
    const dry = ammoOf(combat, tower)!;
    expect(dry.line).toContain('装填 3.4s');

    combat.setLevel(tower.id, 3);
    expect(ammoOf(combat, tower)!.level).toBe(3);
    // 超上限要夹住，别把等级读成 99
    combat.setLevel(tower.id, 99);
    expect(tower.level).toBe(3);
  });
});

describe('读数只有一处算（气泡与信息卡不会打架）', () => {
  it('给 combat 就多出行，不给就一句都不多', () => {
    const { world, combat, at } = arena();
    const b = build(world, 'farm', at(0));
    b.hp = 40;
    const withCombat = buildingFacts(world, b, undefined, combat);
    const without = buildingFacts(world, b);
    expect(withCombat.join('|')).toContain('血量 40/');
    expect(without.join('|')).not.toContain('血量 40/200');
  });
});

describe('存档：写下去的账本读回来必须一模一样', () => {
  it('盖几栋、升个级、挪面旗、掉点血，存 → 读 → 再存，两份 JSON 全等', () => {
    const { world, combat, at } = arena();
    const hall = build(world, 'hall', at(0));
    const tower = build(world, 'arrowTower', at(3));
    const bar = build(world, 'barracks', at(6));
    combat.setLevel(tower.id, 2);
    world.setRally(bar.id, pos(20, 21));
    hall.hp = 421;
    world.tick(ROUNDS.prepSeconds);
    world.tick(ROUNDS.raidMinSeconds);

    const first = JSON.stringify(snapshot(world, combat));

    // 新世界 + 同一份档
    const target = new GameWorld(new TileMap({ cols: 40, rows: 40 }), { seed: 777 });
    const combat2 = new Combat({ world: target, maxUnits: 40 });
    const saved = parseSave(first);
    expect(saved).not.toBeNull();
    const skipped = applySave(target, combat2, saved!);
    expect(skipped).toBe(0);

    expect(target.buildings.size).toBe(world.buildings.size);
    expect(JSON.stringify(snapshot(target, combat2))).toBe(first);
  });

  it('读档绝不重放"盖楼"：资源与许可一根手指都不许动', () => {
    const { world, combat, at } = arena();
    build(world, 'mill', at(0));
    build(world, 'house', at(3));
    const raw = JSON.stringify(snapshot(world, combat));

    const saved = parseSave(raw)!;
    const target = new GameWorld(new TileMap({ cols: 40, rows: 40 }), { seed: 777 });
    const combat2 = new Combat({ world: target, maxUnits: 40 });
    // 一个许可都不发、一分钱都不给：读档照样要把楼摆回来
    const skipped = applySave(target, combat2, saved);
    expect(skipped).toBe(0);
    expect(target.buildings.size).toBe(2);
    // 账本是"搬回来"的，不是"又付一次"的：金币与源局完全相等
    expect(target.resources.gold).toBe(saved.res.gold);
    // 源局各发 40 张、各花掉 1 张：搬回来还是 39，说明读档没再扣一次
    expect(target.permitCount('mill')).toBe(39);
    expect(target.permitCount('house')).toBe(39);
  });

  it('坏档一律不读：非 JSON、版本不符、表里没这栋楼', () => {
    expect(parseSave(null)).toBeNull();
    expect(parseSave('不是 JSON')).toBeNull();
    expect(parseSave(JSON.stringify({ v: SAVE_VERSION + 1, seed: 1, diff: 'normal', buildings: [], res: {}, round: {} }))).toBeNull();
    const bad = {
      v: SAVE_VERSION,
      seed: 1,
      // 带上一个合法档位：这样"红"只能是因为那栋不存在的楼，不是因为缺字段
      diff: 'normal',
      time: 0,
      res: { gold: 0, crystal: 0, bread: 0 },
      yields: { gold: 0, crystal: 0, bread: 0 },
      permits: [],
      seen: [],
      bonusCap: 0,
      round: { index: 1, phase: 'prep', left: 1, approved: 1 },
      buildings: [{ d: '不存在的楼', c: 0, r: 0, p: 1, built: true, hp: 1, rally: null, lv: 1, placedAt: 0 }],
    };
    expect(parseSave(JSON.stringify(bad))).toBeNull();
  });

  /** P-012：来敌节奏属于那一局，所以它必须进档、也必须从档里读回来。 */
  it('档位跟着存档走：简单档存下去，读进一个"默认正常"的新实例也是简单', () => {
    const { world, combat, at } = arena('easy');
    build(world, 'hall', at(0));
    expect(combat.difficulty).toBe('easy');
    const raw = JSON.stringify(snapshot(world, combat));

    const target = new GameWorld(new TileMap({ cols: 40, rows: 40 }), { seed: 777 });
    const combat2 = new Combat({ world: target, maxUnits: 40 }); // 没给档位 = 正常
    expect(combat2.difficulty).toBe('normal');
    applySave(target, combat2, parseSave(raw)!);
    expect(combat2.difficulty).toBe('easy');
    // 波次计划也得跟着翻：同一回合，两档不是一串人
    expect(combat2.raidPlan(1)).toHaveLength(2);
    expect(combat.raidPlan(1)).toHaveLength(2);

    // 档位写歪或干脆没有，整份丢掉，不替玩家猜一个档
    const withJunk = JSON.parse(raw);
    withJunk.diff = '噩梦';
    expect(parseSave(JSON.stringify(withJunk))).toBeNull();
    delete withJunk.diff;
    expect(parseSave(JSON.stringify(withJunk))).toBeNull();
  });

  it('格子被占或越界时 adopt 返回 null，不留下半个楼', () => {
    const { world, at } = arena();
    const a = build(world, 'hall', at(0));
    expect(world.adopt('house', a.origin, { progress: 1, built: true, hp: 200, rally: null, placedAt: 0 })).toBeNull();
    expect(world.adopt('house', pos(999, 999), { progress: 1, built: true, hp: 200, rally: null, placedAt: 0 })).toBeNull();
    expect(world.buildings.size).toBe(1);
  });
});
